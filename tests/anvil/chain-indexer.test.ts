import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { chainLogReader } from "../../packages/adapters/src/chain-log-reader.js";
import {
  loadChainDeployment,
  postgresChainIndexStore,
} from "../../packages/adapters/src/chain-index-store.js";
import {
  createChainIndexer,
  rebuildChainProjection,
  startChainIndexer,
} from "../../packages/application/src/chain-indexer.js";
import { foldEvents } from "../../packages/domain/src/chain-reducer.ts";
import { quoteTypes } from "../../packages/schemas/src/index.js";
import { createTestDatabase } from "../helpers/database.js";
import { deployBlink, startAnvil, type Anvil } from "../helpers/anvil.js";

const DEPLOYMENT_ID = "local-anvil";
const STATES = ["OPEN", "PROPOSED", "DISPUTED", "FINAL"] as const;
const OUTCOMES = ["YES", "NO", "INVALID"] as const;

async function world(anvil: Anvil) {
  const deployed = await deployBlink(anvil);
  const t = await createTestDatabase();
  await t.db.query(
    "INSERT INTO markets.deployments(id,manifest,market_address) VALUES ($1,$2::jsonb,decode($3,'hex'))",
    [
      DEPLOYMENT_ID,
      JSON.stringify(deployed.manifest),
      deployed.market.slice(2).toLowerCase(),
    ],
  );
  await t.setRole("blink_indexer");
  const deployment = await loadChainDeployment(t.pool, DEPLOYMENT_ID);
  assert.equal(deployment.marketAddress, deployed.market.toLowerCase());
  assert.equal(deployment.deploymentBlock, deployed.deploymentBlock);
  const store = postgresChainIndexStore(t.pool);
  const reader = chainLogReader(anvil.publicClient);
  const indexer = createChainIndexer({
    store,
    reader,
    deploymentId: DEPLOYMENT_ID,
    marketAddress: deployment.marketAddress,
    deploymentBlock: deployment.deploymentBlock,
    workerId: "anvil-test",
    rangeSize: 7,
  });
  const market = deployed.market as Address;
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
  const call = (
    account: (typeof anvil.accounts)["admin"],
    functionName: string,
    args: readonly unknown[] = [],
  ) => send(account, market, blinkMarketAbi, functionName, args);
  const read = (functionName: string, args: readonly unknown[] = []) =>
    anvil.publicClient.readContract({
      address: market,
      abi: blinkMarketAbi,
      functionName,
      args,
    } as never) as Promise<any>;
  const syncToHead = async () => {
    let steps = 0;
    for (;;) {
      const { advancedTo, reorgedTo } = await indexer.syncOnce();
      if (advancedTo === null && reorgedTo === null) break;
      assert.ok(++steps < 100, "sync converges");
    }
    const cursor = (await store.loadCursor(DEPLOYMENT_ID))!;
    assert.equal(cursor.blockNumber, await anvil.publicClient.getBlockNumber());
    return cursor;
  };
  const signQuote = (quote: Record<string, unknown>) =>
    anvil.accounts.maker.signTypedData({
      domain: {
        name: "Blink RFQ",
        version: "0.1",
        chainId: 84532,
        verifyingContract: market,
      },
      types: quoteTypes,
      primaryType: "Quote",
      message: quote as never,
    });
  const quote = async (
    specHash: Hex,
    options: {
      side: 0 | 1;
      quantity: bigint;
      priceBps: number;
      nonce: bigint;
      epoch?: bigint;
    },
  ) => {
    const validAfter = (await anvil.publicClient.getBlock()).timestamp;
    const message = {
      marketId: 1n,
      specHash,
      maker: anvil.accounts.maker.address,
      taker: anvil.accounts.taker.address,
      side: options.side,
      quantity: options.quantity,
      priceBps: options.priceBps,
      validAfter,
      expiresAt: validAfter + 60n,
      nonce: options.nonce,
      epoch: options.epoch ?? 0n,
    };
    const digest = (await read("hashQuote", [message])) as Hex;
    return { message, signature: await signQuote(message), digest };
  };
  // Funds the maker, opens a REPLAY market and allows the taker.
  const setup = async () => {
    const { admin, maker, minter, taker } = anvil.accounts;
    for (const account of [maker, taker])
      await send(minter, deployed.token as Address, blinkTestUsdAbi, "mint", [
        account.address,
        1_000_000_000n,
      ]);
    await send(maker, deployed.token as Address, blinkTestUsdAbi, "approve", [
      market,
      1_000_000_000n,
    ]);
    await call(maker, "depositMaker", [1_000_000_000n]);
    const now = (await anvil.publicClient.getBlock()).timestamp;
    const schedule = {
      closeAt: now + 1000n,
      proposalDeadline: now + 2000n,
      hardDeadline: now + 4000n,
    };
    const specHash = keccak256(toBytes("anvil chain indexer market"));
    await call(admin, "createMarket", [
      specHash,
      "fixture://REPLAY/anvil",
      1,
      schedule.closeAt,
      schedule.proposalDeadline,
      schedule.hardDeadline,
      120,
      10000n,
      500n,
    ]);
    await call(admin, "setTakerAllowed", [taker.address, true]);
    return { specHash, ...schedule };
  };
  // Every projection equals what the contract itself reports.
  const expectProjectionMatchesContract = async (digests: {
    filled: Hex[];
    cancelled: Hex[];
    unseen: Hex[];
  }) => {
    const projection = await store.loadProjection(DEPLOYMENT_ID);
    const onchain = await read("getMarket", [1n]);
    const mine = projection.markets.get("1")!;
    assert.equal(mine.specHash, onchain.specHash.toLowerCase());
    assert.equal(mine.specUri, onchain.specURI);
    assert.equal(mine.mode, onchain.mode === 1 ? "REPLAY" : "LIVE");
    assert.equal(mine.closeAt, onchain.closeAt);
    assert.equal(mine.proposalDeadline, onchain.proposalDeadline);
    assert.equal(mine.hardDeadline, onchain.hardDeadline);
    assert.equal(mine.challengeSeconds, onchain.challengeSeconds);
    assert.equal(mine.maxPairs, onchain.maxPairs);
    assert.equal(mine.maxTakerShares, onchain.maxTakerShares);
    assert.equal(mine.state, STATES[onchain.state as number]);
    assert.equal(mine.paused, onchain.paused);
    assert.equal(mine.totalPairs, onchain.totalMintedPairs);
    assert.equal(mine.escrowMicros, onchain.escrowMicros);
    const proposed = onchain.state !== 0;
    assert.equal(
      mine.proposedOutcome,
      proposed ? OUTCOMES[onchain.proposedOutcome as number] : null,
    );
    assert.equal(mine.proposedAt, proposed ? onchain.proposedAt : null);
    assert.equal(
      mine.proposalEvidenceHash,
      proposed ? onchain.proposalEvidenceHash.toLowerCase() : null,
    );
    const final = onchain.state === 3;
    assert.equal(
      mine.finalOutcome,
      final ? OUTCOMES[onchain.finalOutcome as number] : null,
    );
    assert.equal(
      mine.finalEvidenceHash,
      final ? onchain.finalEvidenceHash.toLowerCase() : null,
    );
    for (const account of Object.values(anvil.accounts)) {
      const [yes, no] = (await read("getPosition", [1n, account.address])) as [
        bigint,
        bigint,
      ];
      const position = projection.positions.get(
        "1:" + account.address.toLowerCase(),
      );
      assert.equal(position?.yesShares ?? 0n, yes, "yes " + account.address);
      assert.equal(position?.noShares ?? 0n, no, "no " + account.address);
      assert.equal(
        projection.takers.get(account.address.toLowerCase()) ?? false,
        await read("takerAllowed", [account.address]),
      );
      const bought = (await read("cumulativeTakerShares", [
        1n,
        account.address,
      ])) as bigint;
      assert.equal(
        position?.takerBoughtShares ?? 0n,
        bought,
        "bought " + account.address,
      );
    }
    assert.equal(projection.maker.freeMicros, await read("makerFreeBalance"));
    assert.equal(projection.maker.epoch, await read("currentMakerEpoch"));
    assert.equal(
      projection.maker.globalPaused,
      await read("globalTradingPaused"),
    );
    for (const digest of digests.filled) {
      assert.equal(await read("consumed", [digest]), true);
      assert.equal(
        projection.digests.get(digest.toLowerCase())?.state,
        "FILLED",
      );
    }
    for (const digest of digests.cancelled) {
      assert.equal(await read("cancelled", [digest]), true);
      assert.equal(
        projection.digests.get(digest.toLowerCase())?.state,
        "CANCELLED",
      );
    }
    for (const digest of digests.unseen) {
      assert.equal(await read("consumed", [digest]), false);
      assert.equal(projection.digests.has(digest.toLowerCase()), false);
    }
    return projection;
  };
  return {
    t,
    store,
    reader,
    indexer,
    market,
    call,
    read,
    send,
    quote,
    setup,
    syncToHead,
    expectProjectionMatchesContract,
    close: () => t.close(),
  };
}

test(
  "a full REPLAY lifecycle on Anvil is indexed into projections that equal the contract's own views",
  { timeout: 180_000 },
  async () => {
    const anvil = await startAnvil();
    const w = await world(anvil);
    try {
      const { admin, maker, proposer, keeper, taker } = anvil.accounts;
      // Anvil's finalized tag lags the head; the reader must see a real number, not "unknown".
      await anvil.mine(3);
      const finalized = await w.reader.finalized();
      assert.ok(
        finalized !== null && finalized <= (await w.reader.head()).number,
      );

      const { specHash, closeAt } = await w.setup();
      // Admin pauses are events too; both are lifted before trading.
      await w.call(admin, "setMarketTradingPaused", [1n, true]);
      await w.call(admin, "setMarketTradingPaused", [1n, false]);
      await w.call(admin, "setGlobalTradingPaused", [true]);
      await w.call(admin, "setGlobalTradingPaused", [false]);
      const yesQuote = await w.quote(specHash, {
        side: 0,
        quantity: 10n,
        priceBps: 6000,
        nonce: 1n,
      });
      const noQuote = await w.quote(specHash, {
        side: 1,
        quantity: 5n,
        priceBps: 4000,
        nonce: 2n,
      });

      let cursor = await w.syncToHead();
      assert.equal(cursor.gateReason, null);
      const early = await w.expectProjectionMatchesContract({
        filled: [],
        cancelled: [],
        unseen: [yesQuote.digest, noQuote.digest],
      });
      assert.equal(early.markets.get("1")!.state, "OPEN");

      // The taker approves exactly the 6 token cost and fills the YES quote.
      await w.send(
        taker,
        (await w.read("collateral")) as Address,
        blinkTestUsdAbi,
        "approve",
        [w.market, 6_000_000n],
      );
      await w.call(taker, "fillQuote", [yesQuote.message, yesQuote.signature]);
      await w.call(maker, "cancelQuote", [noQuote.message]);
      await w.call(maker, "withdrawMaker", [1_000_000n]);
      await w.call(maker, "incrementMakerEpoch");
      cursor = await w.syncToHead();
      const traded = await w.expectProjectionMatchesContract({
        filled: [yesQuote.digest],
        cancelled: [noQuote.digest],
        unseen: [],
      });
      assert.equal(
        traded.positions.get("1:" + taker.address.toLowerCase())!.yesShares,
        10n,
      );
      assert.equal(traded.maker.epoch, 1n);

      // Past the close the proposer proposes; past the challenge window anyone finalizes.
      await anvil.setNextTimestamp(closeAt + 1n);
      await w.call(proposer, "proposeOutcome", [
        1n,
        0,
        keccak256(toBytes("evidence")),
      ]);
      const proposedAt = (
        (await w.read("getMarket", [1n])) as { proposedAt: bigint }
      ).proposedAt;
      await w.syncToHead();
      assert.equal(
        (
          await w.expectProjectionMatchesContract({
            filled: [yesQuote.digest],
            cancelled: [noQuote.digest],
            unseen: [],
          })
        ).markets.get("1")!.state,
        "PROPOSED",
      );
      await anvil.setNextTimestamp(proposedAt + 121n);
      await w.call(keeper, "finalizeUnchallenged", [1n]);

      // The last transactions are picked up by the running poll loop, which reports readiness.
      const loop = startChainIndexer({
        indexer: w.indexer,
        pollIntervalMs: 20,
      });
      try {
        await w.call(taker, "redeem", [1n]);
        await w.call(maker, "redeem", [1n]);
        const head = await anvil.publicClient.getBlockNumber();
        const deadline = Date.now() + 15_000;
        let health = await loop.health();
        while (
          (BigInt(health.blockNumber) < head || !health.ready) &&
          Date.now() < deadline
        ) {
          await delay(25);
          health = await loop.health();
        }
        assert.equal(health.blockNumber, head.toString());
        assert.equal(health.ready, true);
      } finally {
        await loop.stop();
      }
      const done = await w.expectProjectionMatchesContract({
        filled: [yesQuote.digest],
        cancelled: [noQuote.digest],
        unseen: [],
      });
      const market = done.markets.get("1")!;
      assert.equal(market.state, "FINAL");
      assert.equal(market.finalOutcome, "YES");
      assert.equal(market.finalReason, "UNCHALLENGED");
      assert.equal(market.escrowMicros, 0n);
      assert.equal(
        done.positions.get("1:" + taker.address.toLowerCase())!
          .redeemedPayoutMicros,
        10_000_000n,
      );
      assert.equal(
        done.positions.get("1:" + maker.address.toLowerCase())!
          .redeemedPayoutMicros,
        0n,
      );

      // The stored projection is what a rebuild from the canonical events yields.
      const report = await rebuildChainProjection(w.store, DEPLOYMENT_ID, {
        verify: true,
        workerId: "verify",
      });
      assert.deepEqual(report.differences, []);
      assert.deepEqual(
        done,
        foldEvents(await w.store.loadCanonicalEvents(DEPLOYMENT_ID)),
      );
      cursor = (await w.store.loadCursor(DEPLOYMENT_ID))!;
      assert.equal(cursor.gateReason, null);
    } finally {
      await w.close();
      await anvil.stop();
    }
  },
);

test(
  "an Anvil snapshot/revert reorg tombstones the orphaned fill and the projections follow the new branch",
  { timeout: 180_000 },
  async () => {
    const anvil = await startAnvil();
    const w = await world(anvil);
    try {
      const { maker, taker } = anvil.accounts;
      const { specHash } = await w.setup();
      const yesQuote = await w.quote(specHash, {
        side: 0,
        quantity: 10n,
        priceBps: 6000,
        nonce: 1n,
      });
      const noQuote = await w.quote(specHash, {
        side: 1,
        quantity: 4n,
        priceBps: 3000,
        nonce: 2n,
      });
      const token = (await w.read("collateral")) as Address;
      await w.send(taker, token, blinkTestUsdAbi, "approve", [
        w.market,
        100_000_000n,
      ]);
      await w.syncToHead();

      const snapshot = await anvil.snapshot();
      await w.call(taker, "fillQuote", [yesQuote.message, yesQuote.signature]);
      const orphaned = await anvil.publicClient.getBlock();
      await w.syncToHead();
      assert.equal(
        (await w.store.loadProjection(DEPLOYMENT_ID)).positions.get(
          "1:" + taker.address.toLowerCase(),
        )!.yesShares,
        10n,
      );

      await anvil.revert(snapshot);
      assert.equal(
        await w.read("consumed", [yesQuote.digest]),
        false,
        "the chain forgot the fill",
      );
      await w.call(taker, "fillQuote", [noQuote.message, noQuote.signature]);
      await anvil.mine(2);
      const replacement = await anvil.publicClient.getBlock({
        blockNumber: orphaned.number,
      });
      assert.notEqual(
        replacement.hash,
        orphaned.hash,
        "the branch replaced the block",
      );

      const rolledBack = await w.indexer.syncOnce();
      assert.ok(
        rolledBack.reorgedTo !== null && rolledBack.reorgedTo < orphaned.number,
        "rolled back to a common ancestor",
      );
      assert.equal(rolledBack.gateReason, "REORG_IN_PROGRESS");
      assert.equal(
        (await w.indexer.health()).ready,
        false,
        "the RFQ gate is closed during the reorg",
      );
      const cursor = await w.syncToHead();
      assert.equal(cursor.gateReason, null);

      const projection = await w.expectProjectionMatchesContract({
        filled: [noQuote.digest],
        cancelled: [],
        unseen: [yesQuote.digest],
      });
      assert.equal(
        projection.positions.get("1:" + taker.address.toLowerCase())!.yesShares,
        0n,
      );
      assert.equal(
        projection.positions.get("1:" + taker.address.toLowerCase())!.noShares,
        4n,
      );
      assert.equal(
        projection.positions.get("1:" + maker.address.toLowerCase())!.yesShares,
        4n,
      );
      assert.equal(projection.markets.get("1")!.totalPairs, 4n);

      // The orphaned fill is kept as a tombstone and the reorg was announced.
      const tombstones = await w.t.db.query<{
        canonical: boolean;
        name: string;
      }>(
        "SELECT canonical, name FROM chain.events WHERE name='QuoteFilled' ORDER BY canonical",
      );
      assert.deepEqual(
        tombstones.rows.map((r) => r.canonical),
        [false, true],
      );
      const orphanRow = await w.t.db.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM chain.blocks WHERE hash = decode($1,'hex') AND NOT canonical",
        [orphaned.hash.slice(2)],
      );
      assert.equal(orphanRow.rows[0]!.n, "1");
      const reorged = await w.t.db.query<{ payload: Record<string, string> }>(
        "SELECT payload FROM operations.outbox WHERE event_type='chain.reorged'",
      );
      assert.equal(reorged.rows.length, 1);
      assert.equal(reorged.rows[0]!.payload.deploymentId, DEPLOYMENT_ID);
      assert.equal(
        BigInt(reorged.rows[0]!.payload.ancestorNumber!),
        rolledBack.reorgedTo,
      );
    } finally {
      await w.close();
      await anvil.stop();
    }
  },
);
