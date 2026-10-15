import { randomUUID } from "node:crypto";
import { SignedQuoteResponse } from "../../packages/schemas/src/index.js";
import { postgresTraderStore } from "../../packages/adapters/src/trader-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { createTrader } from "../../packages/application/src/trader.js";
import { TxDispatchError } from "../../packages/application/src/tx-dispatcher.js";
import type {
  TraderQuoteApi,
  TraderQuoteResult,
  TraderSignedQuote,
} from "../../packages/ports/src/index.js";
import { bindWallet, inviteAgent } from "./database.js";
import { poolAs } from "./research.js";
import { testAccounts } from "./signer-fixture.js";
import {
  blockHash,
  DEPLOYMENT,
  HEAD_NUMBER,
  seedSnapshotRows,
  tradingWorld,
  type TradingWorld,
} from "./trading.js";

export const TRADER_WALLET = testAccounts.trader.address;
export type Mode =
  "mine" | "pending" | "revert" | "reject" | "reverted-receipt";

/** Marks an intent as a block holds it: a signed artifact and an attempt with a receipt. */
export async function markMined(
  w: TradingWorld,
  intentId: string,
  input: {
    state: string;
    attempt: "INCLUDED" | "REVERTED";
    receipt: "success" | "reverted";
  },
) {
  await w.owner(async () => {
    const db = w.t.db;
    const artifact = randomUUID();
    await db.query(
      `INSERT INTO signing.artifacts(id,sign_request_id,artifact_hash,raw_transaction,max_cost_wei)
      SELECT $1,r.id,decode($2,'hex'),'0x02',1 FROM signing.sign_requests r
      WHERE r.intent_id=$3 AND r.artifact_version=1 ON CONFLICT DO NOTHING`,
      [artifact, randomUUID().replaceAll("-", "").repeat(2), intentId],
    );
    await db.query(
      "UPDATE signing.sign_requests SET state='SIGNED' WHERE intent_id=$1",
      [intentId],
    );
    await db.query(
      `INSERT INTO signing.tx_attempts(id,intent_id,artifact_id,tx_hash,nonce,gas_limit,max_fee_per_gas,
          max_priority_fee_per_gas,max_cost_wei,status,receipt_status,receipt_block_number,receipt_block_hash)
        SELECT $1,$2,a.id,decode($3,'hex'),0,1,1,1,1,$4,$5,100,decode($6,'hex')
        FROM signing.artifacts a JOIN signing.sign_requests r ON r.id=a.sign_request_id WHERE r.intent_id=$2
        ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        intentId,
        randomUUID().replaceAll("-", "").repeat(2),
        input.attempt,
        input.receipt,
        blockHash(HEAD_NUMBER).slice(2),
      ],
    );
    await db.query("UPDATE signing.economic_intents SET state=$2 WHERE id=$1", [
      intentId,
      input.state,
    ]);
  });
}

/** Stands in for the tx dispatcher: what each kind of intent comes to is scripted per test. */
export function fakeDispatcher(w: TradingWorld) {
  const modes: Record<string, Mode> = {
    APPROVE: "mine",
    FILL: "mine",
    REDEEM: "mine",
  };
  const calls: { intentId: string; kind: string }[] = [];
  /** Runs after a dispatch took effect and before the trader sees its answer: another run's move. */
  const hooks: {
    afterDispatch: null | ((kind: string, intentId: string) => Promise<void>);
  } = { afterDispatch: null };
  const settle = async (intentId: string, kind: string) => {
    {
      const mode = modes[kind]!;
      if (mode === "mine") {
        await markMined(w, intentId, {
          state: "INCLUDED",
          attempt: "INCLUDED",
          receipt: "success",
        });
        return "INCLUDED" as const;
      }
      if (mode === "reverted-receipt") {
        // A block holds it with a failed receipt, but that block is not final: not yet FAILED.
        await markMined(w, intentId, {
          state: "INCLUDED",
          attempt: "INCLUDED",
          receipt: "reverted",
        });
        return "INCLUDED" as const;
      }
      if (mode === "revert") {
        await markMined(w, intentId, {
          state: "FAILED",
          attempt: "REVERTED",
          receipt: "reverted",
        });
        return "REVERTED" as const;
      }
      if (mode === "reject") {
        await w.owner(() =>
          w.t.db.query(
            "UPDATE signing.economic_intents SET state='FAILED' WHERE id=$1",
            [intentId],
          ),
        );
        throw new TxDispatchError("SIGN_REJECTED:GAS_ESTIMATE_FAILED", false);
      }
      return "SUBMITTED" as const;
    }
  };
  return {
    modes,
    calls,
    hooks,
    kinds: () => calls.map((c) => c.kind),
    async dispatch(intentId: string) {
      const [row] = await w.query<{ kind: string }>(
        "SELECT kind FROM signing.economic_intents WHERE id=$1",
        [intentId],
      );
      calls.push({ intentId, kind: row!.kind });
      try {
        return await settle(intentId, row!.kind);
      } finally {
        await hooks.afterDispatch?.(row!.kind, intentId);
      }
    },
  };
}

/** Rewrites or replaces the API's answer, to play a hostile or broken API. */
export type Tamper = (
  quote: TraderSignedQuote,
) =>
  | TraderSignedQuote
  | TraderQuoteResult
  | Promise<TraderSignedQuote | TraderQuoteResult>;

/** The public RFQ API over the real RFQ service of the trading world, with the trader's key. */
export function apiOver(
  w: TradingWorld,
  agent: { apiKey: string },
  options: {
    tamper?: Tamper | undefined;
    /** Runs before the request reaches the API: another run's move while this one waits for it. */
    before?: ((key: string) => Promise<void>) | undefined;
  } = {},
) {
  const calls: { input: Record<string, unknown>; key: string }[] = [];
  const api: TraderQuoteApi = {
    async requestQuote(input, key) {
      calls.push({ input, key });
      await options.before?.(key);
      const res = await w.post(key, input, agent);
      const body = res.json();
      if (res.statusCode !== 200)
        return {
          ok: false,
          status: res.statusCode,
          code: String(body.code),
          retryable: body.retryable === true,
        };
      const quote = SignedQuoteResponse.parse(body);
      const out = options.tamper ? await options.tamper(quote) : quote;
      return "ok" in out ? out : { ok: true, quote: out };
    },
  };
  return { api, calls };
}

/**
 * The trading world moved onto the real clock (the trader judges close on block time and on the
 * business clock), with the two platform forecasters and a trader agent holding a mandate.
 */
export async function traderWorld(
  options: {
    tamper?: Tamper;
    before?: (key: string) => Promise<void>;
    a?: number;
    b?: number;
    window?: boolean;
  } = {},
) {
  const w = await tradingWorld({ snapshot: false });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ts = BigInt(nowSeconds);
  w.chain.state.head = {
    number: HEAD_NUMBER,
    hash: blockHash(HEAD_NUMBER),
    timestamp: ts,
  };
  w.chain.state.view.market.closeAt = ts + 100_000n;
  await w.owner(() =>
    w.t.db.query(
      "UPDATE chain.markets SET close_at=$1,proposal_deadline=$2,hard_deadline=$3",
      [String(ts + 100_000n), String(ts + 101_000n), String(ts + 105_000n)],
    ),
  );
  await w.setCursor({ number: HEAD_NUMBER, timestamp: ts });
  w.setSignerClock(nowSeconds * 1000 + 1000);

  const forecasters = {
    a: await inviteAgent(w.t, { name: "fa", scopes: ["forecast:write"] }),
    b: await inviteAgent(w.t, { name: "fb", scopes: ["forecast:write"] }),
  };
  const seedWindow = (input: {
    a?: number;
    b?: number;
    hoursAgo?: number;
    marketId?: number;
  }) =>
    w.owner(() =>
      seedSnapshotRows(w.t.db, forecasters, {
        a: options.a ?? 0.8,
        b: options.b ?? 0.5,
        ...input,
      }),
    );
  const windowId = options.window === false ? null : await seedWindow({});

  const agent = await inviteAgent(w.t, {
    name: "trader",
    scopes: ["trade:quote"],
  });
  await bindWallet(w.t, agent.agentId, TRADER_WALLET);
  await w.owner(async () => {
    await w.t.db.query(
      `INSERT INTO chain.takers(deployment_id,account,allowed,as_of_block_hash)
      VALUES($1,decode($2,'hex'),true,decode($3,'hex'))`,
      [DEPLOYMENT, TRADER_WALLET.slice(2), blockHash(HEAD_NUMBER).slice(2)],
    );
    await w.t.db.query(
      `INSERT INTO trading.mandates(agent_id,wallet,forecaster_role,policy_version)
      VALUES($1,decode($2,'hex'),'FORECASTER_A','trader-v1')`,
      [agent.agentId, TRADER_WALLET.slice(2)],
    );
  });
  const store = postgresTraderStore(poolAs(w.t, "blink_worker"));
  const dispatcher = fakeDispatcher(w);
  const { api, calls } = apiOver(w, agent, {
    tamper: options.tamper,
    before: options.before,
  });
  const tracked: string[] = [];
  // A clock that moves only when the trader sleeps: its time budget is exact and nothing really waits.
  const clock = { ms: 0 };
  const resumes = { count: 0 };
  const build = (overrides: Partial<Parameters<typeof createTrader>[0]> = {}) =>
    createTrader({
      store,
      api,
      dispatcher,
      chain: w.chain.reader,
      encodeCall: encodeAllowedCall,
      deploymentId: DEPLOYMENT,
      role: "FORECASTER_A",
      track: async (id) => void tracked.push(id),
      sleep: async (ms) => {
        clock.ms += ms;
      },
      now: () => clock.ms,
      resume: async () => {
        resumes.count += 1;
      },
      ...overrides,
    });
  const signal = new AbortController().signal;
  return {
    ...w,
    ts,
    agent,
    forecasters,
    windowId,
    seedWindow,
    store,
    dispatcher,
    api,
    apiCalls: calls,
    tracked,
    clock,
    resumes,
    build,
    trader: build(),
    run: () => build().evaluate(signal),
    signal,
    reservations: () =>
      w.query<{
        state: string;
        side: string;
        shares: number;
        ask_bps: number;
        release_reason: string | null;
        notional_micros: string;
      }>(
        `SELECT state,side,shares,ask_bps,release_reason,notional_micros::text FROM trading.risk_reservations ORDER BY created_at,id`,
      ),
    intents: () =>
      w.query<{ kind: string; state: string; payload: unknown }>(
        "SELECT kind,state,payload FROM signing.economic_intents WHERE role='trader' ORDER BY created_at,id",
      ),
    /** Plays the indexer: the trader's newest quote is filled (or cancelled) at block 100. */
    async fillDigest(state: "FILLED" | "CANCELLED" = "FILLED") {
      const filled = state === "FILLED";
      await w.owner(() =>
        w.t.db.query(
          `INSERT INTO chain.quote_digests(deployment_id,digest,state,market_id,taker,side,quantity,price_bps,
            taker_cost_micros,maker_cost_micros,block_number,block_hash,tx_hash)
          SELECT q.deployment_id,q.digest,$1,
            CASE WHEN $4 THEN q.market_id END,CASE WHEN $4 THEN q.taker END,CASE WHEN $4 THEN q.side END,
            CASE WHEN $4 THEN q.quantity END,CASE WHEN $4 THEN q.price_bps END,
            CASE WHEN $4 THEN q.taker_cost_micros END,CASE WHEN $4 THEN q.maker_cost_micros END,
            100,decode($2,'hex'),decode($2,'hex')
          FROM (SELECT * FROM trading.quotes WHERE agent_id=$3 ORDER BY created_at DESC LIMIT 1) q`,
          [state, blockHash(HEAD_NUMBER).slice(2), agent.agentId, filled],
        ),
      );
    },
    async unfill() {
      await w.owner(() => w.t.db.query("DELETE FROM chain.quote_digests"));
    },
  };
}
export type TraderWorld = Awaited<ReturnType<typeof traderWorld>>;
