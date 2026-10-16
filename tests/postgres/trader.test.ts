import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { withDatabase } from "../helpers/postgres-database.js";
import { identityAdmin } from "../../packages/adapters/src/identity-admin.js";
import { postgresTraderStore } from "../../packages/adapters/src/trader-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { createTrader } from "../../packages/application/src/trader.js";
import {
  seedDeployment,
  testAccounts,
  testManifest,
} from "../helpers/signer-fixture.js";
import {
  blockHash,
  DEPLOYMENT,
  HEAD_NUMBER,
  seedSnapshotRows,
  writeCursor,
} from "../helpers/trading.js";

const MARKETS = 6;
const UNIT = 10_000_000n; // ten shares

// Six OPEN markets that each carry a closed window with an edge for FORECASTER_A, a fresh indexer
// cursor on the real clock, and one mandate whose caps the test sets.
async function seed(owner: pg.Pool, pool: (role: string) => pg.Pool) {
  const manifest = testManifest({ deploymentId: DEPLOYMENT });
  await seedDeployment(owner, manifest);
  const admin = identityAdmin(pool("blink_identity_admin"));
  const invite = (name: string, scopes: "forecast:write" | "trade:quote") =>
    admin.invite({
      operatorName: name,
      agentName: name,
      scopes: [scopes],
      reason: "isolated race fixture",
    });
  const a = await invite("fa", "forecast:write");
  const b = await invite("fb", "forecast:write");
  const trader = await invite("trader", "trade:quote");
  const ts = BigInt(Math.floor(Date.now() / 1000));
  for (let market = 1; market <= MARKETS; market += 1) {
    await owner.query(
      `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,hard_deadline,
        challenge_seconds,max_pairs,max_taker_shares,state,created_block_number,created_tx_hash,as_of_block_hash)
      VALUES($1,$2,decode($3,'hex'),'file://spec','REPLAY',$4,$5,$6,120,10000,500,'OPEN',1,decode($7,'hex'),decode($7,'hex'))`,
      [
        DEPLOYMENT,
        market,
        market.toString(16).padStart(64, "0"),
        String(ts + 100_000n),
        String(ts + 101_000n),
        String(ts + 105_000n),
        blockHash(1).slice(2),
      ],
    );
    await seedSnapshotRows(
      owner,
      { a, b },
      { a: 0.8, b: 0.5, marketId: market },
    );
  }
  await owner.query(
    `INSERT INTO chain.maker_state(deployment_id,free_balance_micros,epoch,as_of_block_hash)
    VALUES($1,1000000000,3,decode($2,'hex'))`,
    [DEPLOYMENT, blockHash(HEAD_NUMBER).slice(2)],
  );
  await writeCursor(owner, { number: HEAD_NUMBER, timestamp: ts });
  await owner.query(
    `INSERT INTO chain.takers(deployment_id,account,allowed,as_of_block_hash)
    VALUES($1,decode($2,'hex'),true,decode($3,'hex'))`,
    [DEPLOYMENT, testAccounts.trader.address.slice(2), blockHash(1).slice(2)],
  );
  await owner.query(
    `INSERT INTO trading.mandates(agent_id,wallet,forecaster_role,policy_version)
    VALUES($1,decode($2,'hex'),'FORECASTER_A','trader-v1')`,
    [trader.agentId, testAccounts.trader.address.slice(2)],
  );
  return { manifest, ts, agentId: trader.agentId };
}

const setCaps = (owner: pg.Pool, daily: bigint, open: bigint) =>
  owner.query(
    "UPDATE trading.mandates SET daily_notional_cap_micros=$1, open_notional_cap_micros=$2",
    [String(daily), String(open)],
  );
const rows = async (owner: pg.Pool) =>
  (
    await owner.query(
      "SELECT state,notional_micros::text AS n FROM trading.risk_reservations ORDER BY created_at,id",
    )
  ).rows;

test(
  "real PostgreSQL: concurrent reservations admit exactly the daily cap, then exactly the open cap",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      await seed(owner, pool);
      const stores = Array.from({ length: 4 }, () =>
        postgresTraderStore(pool("blink_worker", 4)),
      );
      const mandate = (await stores[0]!.mandate("FORECASTER_A"))!;
      const windows = (
        await owner.query(
          "SELECT id,market_id::text AS market FROM forecasts.windows ORDER BY market_id",
        )
      ).rows;
      const reserveAll = (count: number) =>
        Promise.all(
          Array.from({ length: count }, (_, i) => {
            const window = windows[i % MARKETS]!;
            return stores[i % stores.length]!.reserve({
              mandate,
              intentId: randomUUID(),
              deploymentId: DEPLOYMENT,
              marketId: window.market,
              windowId: window.id,
              side: "YES",
              shares: 10,
              askBps: 6700,
              ownProbabilityMillionths: 800_000,
            });
          }),
        );

      // Room for two buys of ten shares in a day: of twelve racing, exactly two get it.
      await setCaps(owner, 2n * UNIT + 5_000_000n, 500_000_000n);
      const daily = await reserveAll(12);
      assert.equal(daily.filter((r) => r.state === "RESERVED").length, 2);
      assert.deepEqual(
        [
          ...new Set(
            daily
              .filter((r) => r.state === "SKIPPED")
              .map((r) => (r as { reason: string }).reason),
          ),
        ],
        ["DAILY_CAP_EXCEEDED"],
      );
      assert.deepEqual(await rows(owner), [
        { state: "HELD", n: "10000000" },
        { state: "HELD", n: "10000000" },
      ]);

      // The open cap binds on HELD buys too (and on ACCOUNTED ones, below): three fit, never a fourth.
      await owner.query("TRUNCATE trading.risk_reservations");
      await setCaps(owner, 1_000_000_000n, 3n * UNIT);
      const open = await reserveAll(12);
      assert.equal(open.filter((r) => r.state === "RESERVED").length, 3);
      assert.deepEqual(
        [
          ...new Set(
            open
              .filter((r) => r.state === "SKIPPED")
              .map((r) => (r as { reason: string }).reason),
          ),
        ],
        ["OPEN_CAP_EXCEEDED"],
      );
    });
  },
);

test(
  "real PostgreSQL: the open cap counts bought notional until its market is FINAL, under the worker login and a race",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const { agentId } = await seed(owner, pool);
      const stores = Array.from({ length: 4 }, () =>
        postgresTraderStore(pool("blink_worker", 4)),
      );
      const mandate = (await stores[0]!.mandate("FORECASTER_A"))!;
      const windows = (
        await owner.query(
          "SELECT id,market_id::text AS market FROM forecasts.windows ORDER BY market_id",
        )
      ).rows;
      // Five days of 100 bUSD fills, one open market each, none today.
      for (let day = 1; day <= 5; day += 1)
        await owner.query(
          `INSERT INTO trading.risk_reservations(id,agent_id,intent_id,day,notional_micros,state,deployment_id,market_id,
            window_id,side,shares,ask_bps,own_probability_millionths)
          VALUES (gen_random_uuid(),$1,gen_random_uuid(),(blink.now() AT TIME ZONE 'UTC')::date - $2::int,100000000,
            'ACCOUNTED',$3,$4,$5,'YES',100,6700,800000)`,
          [agentId, day, DEPLOYMENT, day, windows[day - 1]!.id],
        );
      await setCaps(owner, 10_000_000_000n, 500_000_000n);
      const buyAt = (
        store: ReturnType<typeof postgresTraderStore>,
        i: number,
      ) =>
        store.reserve({
          mandate,
          intentId: randomUUID(),
          deploymentId: DEPLOYMENT,
          marketId: windows[5]!.market,
          windowId: windows[5]!.id,
          side: "YES",
          shares: 10,
          askBps: 6700,
          ownProbabilityMillionths: 800_000,
        });
      assert.deepEqual(await buyAt(stores[0]!, 0), {
        state: "SKIPPED",
        reason: "OPEN_CAP_EXCEEDED",
      });

      // Two markets are FINAL: 300 bUSD stay open, so room for exactly twenty buys of ten shares.
      await owner.query(
        "UPDATE chain.markets SET state='FINAL' WHERE market_id IN (4,5)",
      );
      const race = await Promise.all(
        Array.from({ length: 24 }, (_, i) => buyAt(stores[i % 4]!, i)),
      );
      assert.equal(race.filter((r) => r.state === "RESERVED").length, 20);
      assert.deepEqual(
        [
          ...new Set(
            race
              .filter((r) => r.state === "SKIPPED")
              .map((r) => (r as { reason: string }).reason),
          ),
        ],
        ["OPEN_CAP_EXCEEDED"],
      );
    });
  },
);

test(
  "real PostgreSQL: two evaluations racing over six markets never hold more than the daily cap",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const { manifest, ts } = await seed(owner, pool);
      await setCaps(owner, 2n * UNIT + 5_000_000n, 500_000_000n);
      const requests: string[] = [];
      const evaluator = () =>
        createTrader({
          store: postgresTraderStore(pool("blink_worker", 4)),
          // The API is unavailable: every buy stays pending, so what it holds is what the caps admitted.
          api: {
            async requestQuote(_input, key) {
              requests.push(key);
              return {
                ok: false,
                status: 503,
                code: "SERVICE_NOT_READY",
                retryable: true,
              };
            },
          },
          dispatcher: {
            async dispatch() {
              throw new Error("NOTHING_TO_DISPATCH");
            },
          },
          chain: {
            head: async () => ({
              number: HEAD_NUMBER,
              hash: blockHash(HEAD_NUMBER),
              timestamp: ts,
            }),
          },
          encodeCall: encodeAllowedCall,
          deploymentId: manifest.deploymentId,
          role: "FORECASTER_A",
          track: async () => undefined,
        });
      const signal = new AbortController().signal;
      const runs = await Promise.all([
        evaluator().evaluate(signal),
        evaluator().evaluate(signal),
        evaluator().evaluate(signal),
      ]);
      const reserved = await rows(owner);
      assert.equal(
        reserved.length,
        2,
        JSON.stringify(runs.map((r) => r.markets)),
      );
      assert.ok(reserved.every((r) => r.state === "HELD"));
      assert.equal(
        reserved.reduce((sum, r) => sum + BigInt(r.n), 0n),
        2n * UNIT,
      );
      // Only the two admitted buys ever reached the RFQ; every other market was skipped on the cap.
      assert.equal(new Set(requests).size, 2);
      const skipped = runs
        .flatMap((r) => Object.values(r.markets))
        .filter((m) => m === "SKIPPED:DAILY_CAP_EXCEEDED");
      assert.ok(
        skipped.length >= MARKETS - 2,
        "the rest were skipped on the cap",
      );
    });
  },
);

test(
  "real PostgreSQL: the worker login cannot widen its mandate and the transition guard holds",
  { timeout: 30_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      await seed(owner, pool);
      const worker = pool("blink_worker", 2);
      await assert.rejects(
        worker.query("UPDATE trading.mandates SET daily_notional_cap_micros=1"),
        /permission denied/,
      );
      await assert.rejects(
        worker.query("SELECT 1 FROM forecasts.submissions"),
        /permission denied/,
      );
      await worker.query("SELECT window_id FROM trading.trader_snapshots");
      const store = postgresTraderStore(worker);
      const mandate = (await store.mandate("FORECASTER_A"))!;
      const window = (
        await owner.query("SELECT id FROM forecasts.windows LIMIT 1")
      ).rows[0]!;
      const intentId = randomUUID();
      const reserved = await store.reserve({
        mandate,
        intentId,
        deploymentId: DEPLOYMENT,
        marketId: "1",
        windowId: window.id,
        side: "NO",
        shares: 10,
        askBps: 6700,
        ownProbabilityMillionths: 200_000,
      });
      assert.equal(reserved.state, "RESERVED");
      const { reservationId } = reserved as { reservationId: string };
      await store.release(reservationId, "TEST");
      await store.setAccounted(reservationId, true);
      assert.deepEqual(await rows(owner), [
        { state: "RELEASED", n: "10000000" },
      ]);
      await assert.rejects(
        worker.query(
          "UPDATE trading.risk_reservations SET state='HELD',release_reason=NULL",
        ),
        /illegal risk reservation transition/,
      );
    });
  },
);

test(
  "real PostgreSQL: every store query runs under the worker login, including the intent and redeem lookups",
  { timeout: 30_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      const { agentId } = await seed(owner, pool);
      const store = postgresTraderStore(pool("blink_worker", 2));
      const mandate = (await store.mandate("FORECASTER_A"))!;
      assert.equal(mandate.agentId, agentId);
      const context = await store.context({
        deploymentId: DEPLOYMENT,
        mandate,
      });
      assert.equal(context.markets.length, MARKETS);
      assert.deepEqual(
        context.markets.map((m) => m.snapshot?.ownProbabilityMillionths),
        Array(MARKETS).fill(800_000),
      );
      assert.equal(
        context.markets[0]!.snapshot?.probabilitySumMillionths,
        1_300_000,
      );
      assert.equal(context.takerAllowed, true);
      assert.equal(context.cursor?.stale, false);

      const window = (
        await owner.query("SELECT id FROM forecasts.windows LIMIT 1")
      ).rows[0]!;
      const intentId = randomUUID();
      const reserved = await store.reserve({
        mandate,
        intentId,
        deploymentId: DEPLOYMENT,
        marketId: "1",
        windowId: window.id,
        side: "YES",
        shares: 10,
        askBps: 6700,
        ownProbabilityMillionths: 800_000,
      });
      assert.equal(reserved.state, "RESERVED");
      const { reservationId } = reserved as { reservationId: string };
      const trade = (await store.trade(intentId))!;
      assert.equal(trade.reservation.state, "HELD");
      assert.equal(trade.quote, null);
      assert.equal(trade.cursor?.gateReason, null);
      assert.equal(
        (await store.trades({ agentId, deploymentId: DEPLOYMENT })).length,
        1,
      );

      const approve = {
        reservationId,
        deploymentId: DEPLOYMENT,
        kind: "APPROVE" as const,
        dedupeKey: "trader:approve:" + intentId,
        payload: { tradeIntentId: intentId },
        unsignedPayload: {
          to: "0x00000000000000000000000000000000000000a2",
          functionName: "approve",
          args: ["0x00000000000000000000000000000000000000a1", "6700000"],
        },
      };
      assert.equal(await store.authorize(reservationId), true);
      const first = (await store.prepare(approve))!;
      assert.equal(
        (await store.prepare(approve))!.intentId,
        first.intentId,
        "one intent under one key",
      );
      assert.deepEqual(await store.intent(first.intentId), {
        intentId: first.intentId,
        state: "PREPARED",
        mined: null,
      });
      assert.equal(
        (await store.trade(intentId))!.approve?.intentId,
        first.intentId,
      );

      const wallet = testAccounts.trader.address;
      assert.deepEqual(
        await store.redeemable({ deploymentId: DEPLOYMENT, wallet }),
        [],
      );
      await owner.query(
        "UPDATE chain.markets SET state='FINAL' WHERE market_id=1",
      );
      await owner.query(
        `INSERT INTO chain.positions(deployment_id,market_id,account,yes_shares,no_shares,as_of_block_hash)
        VALUES($1,1,decode($2,'hex'),10,0,decode(repeat('22',32),'hex'))`,
        [DEPLOYMENT, wallet.slice(2)],
      );
      assert.deepEqual(
        await store.redeemable({ deploymentId: DEPLOYMENT, wallet }),
        [{ marketId: "1", intent: null }],
      );
      // One audit row per (action, resource, reason), however often it is raised.
      for (let i = 0; i < 3; i += 1)
        await store.audit({
          action: "trader.redeem_failed",
          resource: "r",
          reason: "x",
        });
      assert.equal(
        (
          await owner.query(
            "SELECT id FROM operations.audit_log WHERE action='trader.redeem_failed'",
          )
        ).rows.length,
        1,
      );
      await store.setAccounted(reservationId, true);
      await store.setAccounted(reservationId, false);
      await store.release(reservationId, "DONE");
      assert.deepEqual(await rows(owner), [
        { state: "RELEASED", n: "10000000" },
      ]);
      // A released buy is not authorized and nothing more can be prepared for it.
      assert.equal(await store.authorize(reservationId), false);
      assert.equal(
        await store.prepare({
          ...approve,
          kind: "FILL",
          dedupeKey: "trader:fill:" + intentId,
        }),
        null,
      );
      // A snapshot maps to the window it was made from; an unknown one maps to nothing.
      const snapshotId = randomUUID();
      await owner.query(
        `INSERT INTO forecasts.snapshots(id,window_id,forecaster_a_submission,forecaster_b_submission,probability_sum_millionths)
        SELECT $1,$2,
          (SELECT s.id FROM forecasts.submissions s JOIN forecasts.platform_agents p ON p.agent_id=s.agent_id WHERE s.window_id=$2 AND p.role='FORECASTER_A'),
          (SELECT s.id FROM forecasts.submissions s JOIN forecasts.platform_agents p ON p.agent_id=s.agent_id WHERE s.window_id=$2 AND p.role='FORECASTER_B'),
          1300000`,
        [snapshotId, window.id],
      );
      assert.equal(await store.snapshotWindow(snapshotId), window.id);
      assert.equal(await store.snapshotWindow(randomUUID()), null);
      await assert.rejects(
        pool("blink_worker", 1).query("SELECT 1 FROM forecasts.snapshots"),
        /permission denied/,
      );

      // Giving back a buy that spent nothing: refused once an intent or (unless allowed) a quote exists.
      const reserveOne = async () =>
        (
          (await store.reserve({
            mandate,
            intentId: randomUUID(),
            deploymentId: DEPLOYMENT,
            marketId: "1",
            windowId: window.id,
            side: "YES",
            shares: 1,
            askBps: 6700,
            ownProbabilityMillionths: 800_000,
          })) as { reservationId: string }
        ).reservationId;
      const unspent = await reserveOne();
      assert.equal(
        await store.releaseUnspent(unspent, "NOT_SPENT", {
          quoteAllowed: false,
        }),
        true,
      );
      assert.equal(
        await store.releaseUnspent(unspent, "AGAIN", { quoteAllowed: true }),
        false,
        "released is final",
      );
      const spent = await reserveOne();
      const spentIntent = (
        await owner.query(
          "SELECT intent_id FROM trading.risk_reservations WHERE id=$1",
          [spent],
        )
      ).rows[0]!.intent_id;
      await store.prepare({
        ...approve,
        reservationId: spent,
        dedupeKey: "trader:approve:" + spentIntent,
      });
      for (const quoteAllowed of [false, true])
        assert.equal(
          await store.releaseUnspent(spent, "SPENT", { quoteAllowed }),
          false,
        );
    });
  },
);

test(
  "real PostgreSQL: a spend and a release racing on one buy are serialized: an intent exists exactly when the spend won, and nothing is authorized after the release",
  { timeout: 60_000 },
  async () => {
    await withDatabase(async ({ owner, pool }) => {
      await seed(owner, pool);
      const stores = Array.from({ length: 4 }, () =>
        postgresTraderStore(pool("blink_worker", 4)),
      );
      const mandate = (await stores[0]!.mandate("FORECASTER_A"))!;
      const window = (
        await owner.query("SELECT id FROM forecasts.windows LIMIT 1")
      ).rows[0]!;
      for (let round = 0; round < 12; round += 1) {
        const intentId = randomUUID();
        const reserved = await stores[0]!.reserve({
          mandate,
          intentId,
          deploymentId: DEPLOYMENT,
          marketId: "1",
          windowId: window.id,
          side: "YES",
          shares: 1,
          askBps: 6700,
          ownProbabilityMillionths: 800_000,
        });
        const { reservationId } = reserved as { reservationId: string };
        const [spent, , released] = await Promise.all([
          stores[1]!.prepare({
            reservationId,
            deploymentId: DEPLOYMENT,
            kind: "APPROVE",
            dedupeKey: "trader:approve:" + intentId,
            payload: { tradeIntentId: intentId },
            unsignedPayload: {
              to: "0x00000000000000000000000000000000000000a2",
              functionName: "approve",
              args: ["0x00000000000000000000000000000000000000a1", "670000"],
            },
          }),
          stores[2]!.authorize(reservationId),
          stores[3]!.release(reservationId, "RACE"),
        ]);
        void released;
        const state = (
          await owner.query(
            "SELECT state FROM trading.risk_reservations WHERE id=$1",
            [reservationId],
          )
        ).rows[0]!.state;
        assert.equal(state, "RELEASED");
        // Whoever lost: after the release committed, nothing is authorized or prepared any more.
        assert.equal(await stores[1]!.authorize(reservationId), false);
        assert.equal(
          (
            await owner.query(
              "SELECT id FROM signing.economic_intents WHERE dedupe_key=$1",
              ["trader:approve:" + intentId],
            )
          ).rows.length,
          spent === null ? 0 : 1,
          "an intent exists exactly when the spend won the lock",
        );
      }
    });
  },
);
