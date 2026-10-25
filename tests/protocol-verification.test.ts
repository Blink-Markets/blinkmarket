import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeFunctionData,
  encodeFunctionResult,
  type Abi,
  type PublicClient,
} from "viem";
import { protocolAbi } from "../packages/adapters/src/protocol-abi.ts";
import { protocolLogReader } from "../packages/adapters/src/protocol-log-reader.ts";
import { postgresProtocolIndexStore } from "../packages/adapters/src/protocol-index-store.ts";
import {
  createChainIndexer,
  rebuildChainProjection,
} from "../packages/application/src/chain-indexer.ts";
import { foldProtocolEvents } from "../packages/domain/src/protocol-reducer.ts";
import {
  FakeChain,
  MARKET_ADDRESS,
  MAKER,
  makerDeposited,
} from "./helpers/fake-chain.ts";
import {
  protocolManifest,
  seedProtocolDeployment,
  address,
} from "./helpers/protocol-index.ts";
import { createTestDatabase } from "./helpers/database.ts";

function verifier(chain: FakeChain) {
  const manifest = protocolManifest();
  const calls: { fn: string; args: readonly unknown[] }[] = [];
  let active = 0,
    peak = 0;
  const client = {
    getBlock: async ({ blockHash }: { blockHash: string }) => {
      const b = [...chain.snapshot().blocks.values()].find(
        (b) => b.hash === blockHash,
      )!;
      return { ...b, parentHash: b.parentHash };
    },
    request: async ({ params }: any) => {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setImmediate(resolve));
        const key =
          params[0].to === manifest.shared.governor
            ? "governor"
            : params[0].to === manifest.generation.registry
              ? "registry"
              : "markets";
        const abi = protocolAbi[key] as Abi;
        const { functionName: fn, args = [] } = decodeFunctionData({
          abi,
          data: params[0].data,
        });
        calls.push({ fn, args });
        const b = [...chain.snapshot().blocks.values()].find(
          (b) => b.hash === params[1].blockHash,
        )!;
        const p = foldProtocolEvents(chain.allEvents(b.number));
        const latest = [...p.successors.values()].at(-1);
        const result =
          fn === "nextMarketId"
            ? 1n
            : fn === "pendingSuccessor"
              ? (latest?.registry ?? address(0))
              : fn === "successorEffectiveAt"
                ? BigInt(latest?.effectiveAt ?? 0)
                : fn === "successor"
                  ? ([...p.successors.values()]
                      .filter((s) => s.effectiveAt <= Number(b.timestamp))
                      .at(-1)?.registry ?? address(0))
                  : fn === "makerFree"
                    ? BigInt(
                        p.makers.get(String(args[0]).toLowerCase())
                          ?.freeMicros ?? "0",
                      )
                    : fn === "makerEpoch" ||
                        fn === "creditOf" ||
                        fn === "roleStake"
                      ? 0n
                      : fn === "isRegistered"
                        ? true
                        : fn === "hasRole"
                          ? Number(args[1]) === 6
                          : undefined;
        if (result === undefined) throw new Error("UNEXPECTED_RPC:" + fn);
        return encodeFunctionResult({ abi, functionName: fn, result } as any);
      } finally {
        active--;
      }
    },
  } as unknown as PublicClient;
  return {
    reader: protocolLogReader(client, manifest),
    calls,
    peak: () => peak,
  };
}

for (const replacement of [false, true])
  test(`governor ${replacement ? "replacement" : "first"} adoption survives pending small ranges and effectiveness`, async () => {
    const t = await createTestDatabase();
    try {
      await seedProtocolDeployment(t.pool);
      const chain = new FakeChain(9n);
      if (replacement) {
        chain.mine([
          {
            contract: "GOVERNOR",
            name: "SuccessorAdopted",
            args: { registry: address(21), effectiveAt: "1080" },
          },
        ]);
        chain.mineTo(40n);
      }
      const effectiveAt = replacement ? 1142 : 1080;
      const end = replacement ? 74n : 42n;
      const pending = chain.mine([
        {
          contract: "GOVERNOR",
          name: "SuccessorAdopted",
          args: { registry: address(22), effectiveAt: String(effectiveAt) },
        },
      ]);
      chain.mineTo(end);
      const store = postgresProtocolIndexStore(t.pool);
      const rpc = verifier(chain);
      const reader = { ...chain.reader(), agrees: rpc.reader.agrees };
      const indexer = createChainIndexer({
        store,
        reader,
        deploymentId: "d1",
        marketAddress: MARKET_ADDRESS,
        deploymentBlock: 10n,
        workerId: "governor",
        rangeSize: 1,
      });
      for (let i = 10n; i <= end; i++) {
        const result = await indexer.syncOnce();
        assert.equal(result.gateReason, null, `range ending ${i}`);
        assert.equal(result.advancedTo, i);
      }
      assert.ok(pending.timestamp < BigInt(effectiveAt));
      const p = await store.loadProjection("d1");
      assert.equal(
        await rpc.reader.agrees(
          pending.hash,
          foldProtocolEvents(chain.allEvents(pending.number)),
        ),
        true,
      );
      assert.equal(await rpc.reader.agrees(chain.at(end)!.hash, p), true);
    } finally {
      await t.close();
    }
  });

test("batch verification checks only touched entities with bounded RPC concurrency", async () => {
  const chain = new FakeChain(9n);
  chain.mine(
    Array.from({ length: 12 }, (_, n) => ({
      contract: "REGISTRY" as const,
      name: "Registered",
      args: { account: address(30 + n), feePaid: "1" },
    })),
  );
  const b = chain.mine([
    {
      contract: "REGISTRY",
      name: "Registered",
      args: { account: address(50), feePaid: "1" },
    },
    {
      contract: "REGISTRY",
      name: "Registered",
      args: { account: address(51), feePaid: "1" },
    },
  ]);
  const rpc = verifier(chain);
  const events = chain.allEvents().filter((e) => e.blockNumber === b.number);
  assert.equal(
    await rpc.reader.agrees(
      b.hash,
      foldProtocolEvents(chain.allEvents()),
      events,
    ),
    true,
  );
  assert.ok(rpc.calls.length <= 42, `RPC calls: ${rpc.calls.length}`);
  assert.ok(
    rpc.calls.every(
      (c) => c.args[0] === address(50) || c.args[0] === address(51),
    ),
  );
  assert.ok(
    rpc.peak() > 1 && rpc.peak() <= 8,
    `concurrent calls: ${rpc.peak()}`,
  );
});

test("deleting the only maker row is repaired with the production verifier on an empty batch", async () => {
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool);
    const chain = new FakeChain(9n);
    chain.mine([makerDeposited(100n)]);
    const store = postgresProtocolIndexStore(t.pool),
      rpc = verifier(chain);
    const indexer = createChainIndexer({
      store,
      reader: { ...chain.reader(), agrees: rpc.reader.agrees },
      deploymentId: "d1",
      marketAddress: MARKET_ADDRESS,
      deploymentBlock: 10n,
      workerId: "deletion",
    });
    await indexer.syncOnce();
    await t.pool.query("DELETE FROM protocol.makers WHERE deployment_id='d1'");
    rpc.calls.length = 0;
    chain.mine();
    assert.equal((await indexer.syncOnce()).gateReason, null);
    assert.equal(
      (await store.loadProjection("d1")).makers.get(MAKER)?.freeMicros,
      "100",
    );
    assert.equal(
      rpc.calls.length,
      0,
      "membership repair must not RPC-check untouched history",
    );
    await rebuildChainProjection(store, "d1", {
      verify: true,
      workerId: "audit",
      reader: rpc.reader,
    });
    assert.ok(
      rpc.calls.some((c) => c.fn === "makerFree"),
      "rebuild audits all history",
    );
  } finally {
    await t.close();
  }
});

test("slow verification cannot refresh the age of an old head observation and an expired lease cannot commit", async () => {
  for (const compete of [false, true]) {
    const t = await createTestDatabase();
    try {
      await seedProtocolDeployment(t.pool);
      const chain = new FakeChain(9n);
      chain.mine([makerDeposited(100n)]);
      const store = postgresProtocolIndexStore(t.pool),
        rpc = verifier(chain);
      const reader = {
        ...chain.reader(),
        async agrees(...args: Parameters<typeof rpc.reader.agrees>) {
          const agrees = await rpc.reader.agrees(...args);
          chain.mineTo(30n);
          await t.db.exec("SET blink.test_clock_offset_seconds='31'");
          if (compete)
            assert.ok(await store.claimLease("d1", "competitor", 30_000));
          return agrees;
        },
      };
      const indexer = createChainIndexer({
        store,
        reader,
        deploymentId: "d1",
        marketAddress: MARKET_ADDRESS,
        deploymentBlock: 10n,
        workerId: "slow",
        leaseMs: compete ? 30_000 : 60_000,
      });
      if (compete) {
        await assert.rejects(indexer.syncOnce(), /CHAIN_LEASE_LOST/);
        assert.equal((await store.loadCursor("d1"))?.blockNumber, 9n);
      } else {
        await indexer.syncOnce();
        assert.equal((await indexer.health()).ready, false);
      }
    } finally {
      await t.close();
    }
  }
});
