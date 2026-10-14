import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData,
  keccak256,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildApi } from "../../apps/api/src/server.js";
import { tradingServices } from "../../apps/api/src/trading.js";
import { buildSignerServer } from "../../apps/signer/src/server.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { chainLogReader } from "../../packages/adapters/src/chain-log-reader.js";
import { postgresChainIndexStore } from "../../packages/adapters/src/chain-index-store.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresIdentityStore } from "../../packages/adapters/src/identity-store.js";
import { readKeyFile } from "../../packages/adapters/src/key-file.js";
import { postgresMarketReadStore } from "../../packages/adapters/src/market-read-store.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import { viemSignerRpc } from "../../packages/adapters/src/signing-rpc.js";
import {
  postgresReservationReader,
  postgresTradingStore,
} from "../../packages/adapters/src/trading-store.js";
import { createChainIndexer } from "../../packages/application/src/chain-indexer.js";
import { authenticateIdentity } from "../../packages/application/src/identity.js";
import { createMarketReadService } from "../../packages/application/src/market-read.js";
import { createQuoteReconciler } from "../../packages/application/src/quote-reconcile.js";
import {
  createReservationQuoteCheck,
  createSignerService,
  quoteTypedData,
} from "../../packages/application/src/signer.js";
import { parseQuoteMessage } from "../../packages/domain/src/signing-policy.js";
import { SignedQuoteResponse } from "../../packages/schemas/src/index.js";
import {
  bindWallet,
  createTestDatabase,
  inviteAgent,
} from "../helpers/database.js";
import { deployBlink, startAnvil } from "../helpers/anvil.js";
import { poolAs } from "../helpers/research.js";
import { privateKeyOf, sha256Hex } from "../helpers/signer-fixture.js";
import { DEPLOYMENT, rfqBody, seedSnapshotRows } from "../helpers/trading.js";

const TOKEN = "anvil-quote-api-token";

// The maker signs quotes only: no gas is spent by the signer here, so the gas caps are not in play.
// The taker's own transactions use Anvil's funded development account and its default fees.
async function world() {
  const anvil = await startAnvil();
  const deployed = await deployBlink(anvil);
  const manifest = { ...deployed.manifest, deploymentId: DEPLOYMENT };
  const market = deployed.market as Address;
  const t = await createTestDatabase();
  await t.db.query(
    "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,$2::jsonb,decode($3,'hex'))",
    [DEPLOYMENT, JSON.stringify(manifest), market.slice(2).toLowerCase()],
  );
  const keyDirectory = await mkdtemp(join(tmpdir(), "blink-rfq-"));
  const cleanup: (() => Promise<void>)[] = [];
  try {
    // --- chain setup: funded maker and taker, an OPEN REPLAY market, an allowed taker ---
    const send = async (
      account: (typeof anvil.accounts)["admin"],
      address: Address,
      abi: typeof blinkMarketAbi | typeof blinkTestUsdAbi,
      functionName: string,
      args: readonly unknown[],
    ) => {
      const hash = await anvil.wallet(account).writeContract({
        address,
        abi,
        functionName,
        args,
      } as never);
      const receipt = await anvil.publicClient.waitForTransactionReceipt({
        hash,
      });
      assert.equal(receipt.status, "success", functionName);
      return receipt;
    };
    const { admin, maker, minter, taker } = anvil.accounts;
    const token = deployed.token as Address;
    for (const account of [maker, taker])
      await send(minter, token, blinkTestUsdAbi, "mint", [
        account.address,
        1_000_000_000n,
      ]);
    await send(maker, token, blinkTestUsdAbi, "approve", [
      market,
      1_000_000_000n,
    ]);
    await send(maker, market, blinkMarketAbi, "depositMaker", [1_000_000_000n]);
    const now = (await anvil.publicClient.getBlock()).timestamp;
    const closeAt = now + 3600n;
    await send(admin, market, blinkMarketAbi, "createMarket", [
      keccak256(toBytes("anvil rfq market")),
      "fixture://REPLAY/anvil-rfq",
      1,
      closeAt,
      closeAt + 1000n,
      closeAt + 4000n,
      120,
      10000n,
      500n,
    ]);
    await send(admin, market, blinkMarketAbi, "setTakerAllowed", [
      taker.address,
      true,
    ]);

    // --- the indexer ---
    const indexer = createChainIndexer({
      store: postgresChainIndexStore(poolAs(t, "blink_indexer")),
      reader: chainLogReader(anvil.publicClient),
      deploymentId: DEPLOYMENT,
      marketAddress: market.toLowerCase(),
      deploymentBlock: deployed.deploymentBlock,
      workerId: "anvil-rfq",
      rangeSize: 50,
    });
    const sync = async () => {
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 100, "sync converges");
        const { advancedTo, reorgedTo } = await indexer.syncOnce();
        if (advancedTo === null && reorgedTo === null) return;
      }
    };

    // --- identities: two platform forecasters with a closed window, and a taker with a wallet ---
    const forecasters = {
      a: await inviteAgent(t, { name: "fa", scopes: ["forecast:write"] }),
      b: await inviteAgent(t, { name: "fb", scopes: ["forecast:write"] }),
    };
    await t.db.exec("RESET ROLE");
    await seedSnapshotRows(t.db, forecasters);
    const takerAgent = await inviteAgent(t, {
      name: "taker",
      scopes: ["trade:quote"],
    });
    await bindWallet(t, takerAgent.agentId, taker.address);
    const other = await inviteAgent(t, {
      name: "other",
      scopes: ["trade:quote"],
    });

    // --- the signer: its key comes from an owner-only file ---
    const keyPath = join(keyDirectory, "maker.key");
    await writeFile(keyPath, privateKeyOf(maker) + "\n", { mode: 0o600 });
    await chmod(keyPath, 0o600);
    const makerKey = privateKeyToAccount(await readKeyFile(keyPath));
    const signerService = createSignerService({
      store: postgresSignerStore(poolAs(t, "blink_signer")),
      keys: { maker: makerKey },
      rpc: viemSignerRpc({ url: anvil.url }),
      deployment: manifest,
      callers: [
        { name: "quote-api", tokenSha256: sha256Hex(TOKEN), roles: ["maker"] },
      ],
      policy: {
        l1FeeMode: "local-none",
        perTxCapWei: 10n ** 16n,
        dailyCapWei: 10n ** 17n,
      },
      encodeCall: encodeAllowedCall,
      quoteCheck: createReservationQuoteCheck(postgresReservationReader()),
    });
    const signerServer = buildSignerServer(signerService);
    await signerServer.listen({ port: 0, host: "127.0.0.1" });
    cleanup.push(() => signerServer.close());
    const signerUrl =
      "http://127.0.0.1:" + (signerServer.server.address() as AddressInfo).port;

    // --- the API, composed exactly as `apps/api` composes trading mode ---
    const apiPool = poolAs(t, "blink_api");
    const { rfq: rfqService, readiness } = await tradingServices(
      apiPool as never,
      {
        deploymentId: DEPLOYMENT,
        signerUrl,
        signerToken: TOKEN,
        rpcUrl: anvil.url,
      },
    );
    const identityStore = postgresIdentityStore(apiPool);
    const app = buildApi({
      stage: "m2-trading",
      config: readiness.config,
      services: [
        rfqService,
        createMarketReadService({
          store: postgresMarketReadStore(apiPool),
          archive: {
            freeze: async () => {
              throw new Error("UNUSED");
            },
            read: async () => {
              throw new Error("UNUSED");
            },
          },
          hooks: { canTrade: readiness.canTrade },
          identity: {
            authenticate: (authorization) =>
              identityStore.run(async (tx) => {
                const principal = await authenticateIdentity(
                  tx,
                  identityCrypto,
                  authorization,
                );
                return {
                  ...principal,
                  wallet: await tx.wallet(principal.agentId),
                };
              }),
          },
        }),
      ],
    });
    app.log.level = "silent";
    cleanup.push(() => app.close());
    const reconciler = createQuoteReconciler(
      postgresTradingStore(poolAs(t, "blink_worker")),
    );

    let keyCounter = 0;
    const rfq = (
      agent: { apiKey: string } = takerAgent,
      body: Record<string, unknown> = rfqBody,
    ) =>
      app.inject({
        method: "POST",
        url: "/v1/rfqs",
        headers: {
          authorization: "Bearer " + agent.apiKey,
          "idempotency-key": "anvil-" + ++keyCounter,
        },
        payload: body,
      });
    const get = (url: string, agent: { apiKey: string } = takerAgent) =>
      app.inject({
        method: "GET",
        url,
        headers: { authorization: "Bearer " + agent.apiKey },
      });
    const query = async <R = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => {
      await t.db.exec("RESET ROLE");
      return (await t.db.query<R>(sql, params)).rows;
    };
    const read = (functionName: string, args: readonly unknown[] = []) =>
      anvil.publicClient.readContract({
        address: market,
        abi: blinkMarketAbi,
        functionName,
        args,
      } as never) as Promise<any>;
    /** One fresh block, so the quote's time base is current for the signer's own clock. */
    const freshHead = async () => {
      await anvil.mine(1);
      await sync();
    };
    return {
      anvil,
      deployed,
      manifest,
      market,
      token,
      t,
      app,
      send,
      sync,
      reconciler,
      rfq,
      get,
      query,
      read,
      freshHead,
      takerAgent,
      other,
      closeAt,
      async close() {
        for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
        await t.close();
        await anvil.stop();
        await rm(keyDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
    await t.close();
    await anvil.stop();
    await rm(keyDirectory, { recursive: true, force: true });
    throw error;
  }
}
type World = Awaited<ReturnType<typeof world>>;

/** What a careful taker does with an envelope: re-derive, verify the maker's signature, fetch the digest from the chain. */
async function verify(
  w: World,
  envelope: ReturnType<typeof SignedQuoteResponse.parse>,
) {
  const message = parseQuoteMessage(envelope.message)!;
  assert.equal(
    await recoverTypedDataAddress({
      ...quoteTypedData(w.manifest, message),
      signature: envelope.signature as Hex,
    }),
    w.anvil.accounts.maker.address,
  );
  assert.equal(
    await w.read("hashQuote", [
      {
        ...message,
        priceBps: Number(message.priceBps),
      },
    ]),
    envelope.quoteId,
    "the contract computes the same digest",
  );
  const decoded = decodeFunctionData({
    abi: blinkMarketAbi,
    data: envelope.calldata as Hex,
  });
  assert.equal(decoded.functionName, "fillQuote");
  assert.equal(
    (decoded.args as unknown as [unknown, Hex])[1],
    envelope.signature,
  );
  assert.equal(
    BigInt(envelope.takerCostMicros) + BigInt(envelope.makerCostMicros),
    BigInt(envelope.message.quantity) * 1_000_000n,
  );
}
const fillWith = async (w: World, envelope: { calldata: string }) => {
  const hash = await w.anvil.wallet(w.anvil.accounts.taker).sendTransaction({
    to: w.market,
    data: envelope.calldata as Hex,
  });
  const receipt = await w.anvil.publicClient.waitForTransactionReceipt({
    hash,
  });
  assert.equal(receipt.status, "success");
  return receipt;
};
const reservation = async (w: World) =>
  (
    await w.query<{ state: string; block: string | null; quote: string }>(
      `SELECT r.state, r.state_block_number::text AS block, q.status AS quote
      FROM trading.collateral_reservations r JOIN trading.quotes q ON q.id=r.quote_id ORDER BY r.created_at DESC LIMIT 1`,
    )
  )[0]!;

test(
  "a quote from the ensemble is signed by the maker, filled on Anvil, accounted by reconciliation and visible as positions",
  { timeout: 180_000 },
  async () => {
    const w = await world();
    try {
      await w.freshHead();
      const config = await w.app.inject("/v1/config");
      assert.equal(config.json().stage, "m2-trading");
      assert.equal(config.json().tradingEnabled, true);
      assert.equal(config.json().deployment.deploymentId, DEPLOYMENT);
      const listed = await w.app.inject(
        `/v1/markets?deploymentId=${DEPLOYMENT}`,
      );
      assert.deepEqual(listed.json().items[0].reasons, []);
      assert.equal(listed.json().items[0].canTrade, true);

      const res = await w.rfq();
      assert.equal(res.statusCode, 200, res.body);
      const envelope = SignedQuoteResponse.parse(res.json());
      assert.equal(envelope.takerCostMicros, "6200000");
      assert.equal(envelope.makerCostMicros, "3800000");
      await verify(w, envelope);

      // The taker approves exactly the cost, then fills with the calldata the API returned.
      await w.send(
        w.anvil.accounts.taker,
        w.token,
        blinkTestUsdAbi,
        "approve",
        [w.market, BigInt(envelope.takerCostMicros)],
      );
      const fill = await fillWith(w, envelope);
      await w.sync();

      // Until reconciliation the reservation is held; afterwards the fill is accounted once.
      assert.equal((await reservation(w)).state, "HELD");
      assert.deepEqual(await w.reconciler.reconcileOnce(DEPLOYMENT), {
        accounted: 1,
        released: 0,
        reopened: 0,
      });
      assert.deepEqual(await reservation(w), {
        state: "ACCOUNTED",
        block: String(fill.blockNumber),
        quote: "CONSUMED",
      });
      assert.deepEqual(await w.reconciler.reconcileOnce(DEPLOYMENT), {
        accounted: 0,
        released: 0,
        reopened: 0,
      });
      const status = await w.get("/v1/quotes/" + envelope.quoteId);
      assert.equal(status.statusCode, 200, status.body);
      assert.equal(status.json().status, "CONSUMED");
      assert.equal(
        (await w.get("/v1/quotes/" + envelope.quoteId, w.other)).statusCode,
        404,
      );

      const positions = await w.get(
        `/v1/accounts/${w.anvil.accounts.taker.address}/positions?deploymentId=${DEPLOYMENT}`,
      );
      assert.equal(positions.json().items[0].yesShares, "10");
      assert.equal(positions.json().items[0].noShares, "0");
      const [yes] = (await w.read("getPosition", [
        1n,
        w.anvil.accounts.taker.address,
      ])) as [bigint];
      assert.equal(yes, 10n);
      // The maker's free balance fell by exactly its cost, and no reservation counts it a second time.
      assert.equal(
        await w.read("makerFreeBalance"),
        1_000_000_000n - 3_800_000n,
      );
      const next = await w.rfq(w.takerAgent, {
        ...rfqBody,
        quantity: "1",
        maxCostMicros: "1000000",
      });
      assert.equal(next.statusCode, 200, next.body);
    } finally {
      await w.close();
    }
  },
);

test(
  "an unfilled quote is released by block time, a cancelled one by the epoch bump",
  { timeout: 180_000 },
  async () => {
    const w = await world();
    try {
      await w.freshHead();
      const first = SignedQuoteResponse.parse((await w.rfq()).json());
      await w.reconciler.reconcileOnce(DEPLOYMENT);
      assert.equal((await reservation(w)).state, "HELD");
      // The block that carries the expiry second closes the quote on-chain terms and releases it.
      await w.anvil.setNextTimestamp(BigInt(first.expiresAt) + 1n);
      await w.freshHead();
      assert.deepEqual(await w.reconciler.reconcileOnce(DEPLOYMENT), {
        accounted: 0,
        released: 1,
        reopened: 0,
      });
      assert.equal((await reservation(w)).quote, "EXPIRED");
      assert.equal(
        (await w.get("/v1/quotes/" + first.quoteId)).json().status,
        "EXPIRED",
      );

      const second = SignedQuoteResponse.parse((await w.rfq()).json());
      await w.send(
        w.anvil.accounts.maker,
        w.market,
        blinkMarketAbi,
        "incrementMakerEpoch",
        [],
      );
      await w.sync();
      assert.equal(
        (await w.get("/v1/quotes/" + second.quoteId)).json().status,
        "CANCELLED",
      );
      assert.deepEqual(await w.reconciler.reconcileOnce(DEPLOYMENT), {
        accounted: 0,
        released: 1,
        reopened: 0,
      });
      assert.equal((await reservation(w)).quote, "CANCELLED");
      // The next quote is signed under the new epoch.
      const third = SignedQuoteResponse.parse((await w.rfq()).json());
      assert.equal(third.message.epoch, "1");
    } finally {
      await w.close();
    }
  },
);

test(
  "a reorg that removes an accounted fill reopens the reservation, shuts the gate until reconciled and never double counts positions",
  { timeout: 180_000 },
  async () => {
    const w = await world();
    try {
      await w.freshHead();
      const envelope = SignedQuoteResponse.parse((await w.rfq()).json());
      await w.send(
        w.anvil.accounts.taker,
        w.token,
        blinkTestUsdAbi,
        "approve",
        [w.market, BigInt(envelope.takerCostMicros)],
      );
      const snapshot = await w.anvil.snapshot();
      await fillWith(w, envelope);
      await w.sync();
      assert.equal((await w.reconciler.reconcileOnce(DEPLOYMENT)).accounted, 1);
      assert.equal((await reservation(w)).state, "ACCOUNTED");

      // The fill's block is orphaned: the chain returns to the state before it.
      await w.anvil.revert(snapshot);
      await w.anvil.mine(3);
      await w.sync();
      assert.equal(
        (await w.read("makerFreeBalance")) as bigint,
        1_000_000_000n,
      );
      const cursor = (
        await w.query<{ gate_reason: string | null }>(
          "SELECT gate_reason FROM chain.cursors",
        )
      )[0]!;
      assert.equal(cursor.gate_reason, null);
      // The indexer is fresh again, but the accounted fill no longer exists: no new quotes yet.
      const blocked = await w.rfq();
      assert.equal(blocked.statusCode, 503, blocked.body);
      assert.equal(blocked.json().details.reason, "RECONCILE_REQUIRED");
      assert.deepEqual(await w.reconciler.reconcileOnce(DEPLOYMENT), {
        accounted: 0,
        released: 0,
        reopened: 1,
      });
      assert.deepEqual(await reservation(w), {
        state: "RECONCILE_REQUIRED",
        block: null,
        quote: "SIGNED",
      });
      const positions = await w.get(
        `/v1/accounts/${w.anvil.accounts.taker.address}/positions?deploymentId=${DEPLOYMENT}`,
      );
      assert.deepEqual(
        positions.json().items,
        [],
        "the orphaned fill is not a position",
      );
      // The reopened reservation holds the maker's collateral again.
      assert.equal((await w.rfq()).statusCode, 200);

      // The quote is still valid on the new branch: the same fill lands again, and counts once.
      const refill = await fillWith(w, envelope);
      await w.sync();
      assert.equal((await w.reconciler.reconcileOnce(DEPLOYMENT)).accounted, 1);
      const accounted = (
        await w.query<{ block: string }>(
          `SELECT r.state_block_number::text AS block FROM trading.collateral_reservations r
          JOIN trading.quotes q ON q.id=r.quote_id WHERE q.digest=decode($1,'hex')`,
          [envelope.quoteId.slice(2)],
        )
      )[0]!;
      assert.equal(accounted.block, String(refill.blockNumber));
      const again = await w.get(
        `/v1/accounts/${w.anvil.accounts.taker.address}/positions?deploymentId=${DEPLOYMENT}`,
      );
      assert.equal(again.json().items[0].yesShares, "10");
    } finally {
      await w.close();
    }
  },
);
