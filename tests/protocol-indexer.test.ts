import assert from "node:assert/strict";
import { test } from "node:test";
import {
  postgresProtocolIndexStore,
  postgresProtocolReader,
} from "../packages/adapters/src/protocol-index-store.ts";
import { createChainIndexer } from "../packages/application/src/chain-indexer.ts";
import { createTestDatabase } from "./helpers/database.ts";
import {
  FakeChain,
  TAKER,
  MAKER,
  MARKET_ADDRESS,
  marketCreated,
  makerDeposited,
  quoteFilled,
} from "./helpers/fake-chain.ts";
import { seedProtocolDeployment } from "./helpers/protocol-index.ts";
test("test_reorgRevokesRegistrationEligibility", async () => {
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool, "d1");
    const chain = new FakeChain(9n);
    chain.mine([
      marketCreated(1),
      { name: "MarketOpened", args: { marketId: "1", openAt: "1020" } },
      makerDeposited(100000000n),
    ]);
    const store = postgresProtocolIndexStore(t.pool);
    const reader = postgresProtocolReader(t.pool, "d1");
    const indexer = createChainIndexer({
      store,
      reader: chain.reader(),
      deploymentId: "d1",
      marketAddress: MARKET_ADDRESS,
      deploymentBlock: 10n,
      workerId: "test",
    });
    await indexer.syncOnce();
    chain.mine([
      {
        contract: "REGISTRY",
        name: "Registered",
        args: { account: TAKER, feePaid: "1" },
      },
      {
        contract: "REGISTRY",
        name: "RoleJoined",
        args: { account: TAKER, role: "2", amount: "100000000" },
      },
      quoteFilled(1),
    ]);
    await indexer.syncOnce();
    assert.equal(await reader.hasRole(TAKER, "TAKER"), true);
    assert.equal((await reader.maker(MAKER)).freeMicros, "96000000");
    chain.rewind(10n);
    chain.mine();
    await indexer.syncOnce();
    await indexer.syncOnce();
    assert.equal(await reader.hasRole(TAKER, "TAKER"), false);
    assert.equal(await reader.account(TAKER), null);
    assert.equal((await reader.maker(MAKER)).freeMicros, "100000000");
    assert.equal((await store.loadProjection("d1")).positions.size, 0);
  } finally {
    await t.close();
  }
});
test("postgresProtocolReader passes the same contract as the fake", async () => {
  const { assertReaderContract, readerContractState, jurorRow } =
    await import("./helpers/protocol-reader-contract.ts");
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool);
    const state = readerContractState();
    for (const [table, values, key] of [
      ["accounts", state.accounts!, "address"],
      ["markets", state.markets!, "marketId"],
      ["makers", state.makers!, "address"],
      ["anchors", state.anchors!, "root"],
      ["proposals", state.proposals!, "marketId"],
      ["disputes", state.disputes!, "disputeId"],
      ["rounds", state.rounds!, (v: any) => `${v.disputeId}:${v.round}`],
      [
        "votes",
        state.votes!,
        (v: any) => `${v.disputeId}:${v.round}:${v.juror}`,
      ],
      ["jurors", state.jurors!.map(jurorRow), "address"],
      ["fees", state.fees!, "marketId"],
      ["templates", state.templates!, "templateId"],
      ["positions", state.positions!, (v: any) => `${v.marketId}:${v.account}`],
    ] as const)
      for (const v of values)
        await t.pool.query(
          `INSERT INTO protocol.${table}(deployment_id,key,data,as_of_block_hash) VALUES('d1',$1,$2,decode(repeat('11',32),'hex'))`,
          [typeof key === "string" ? (v as any)[key] : key(v), v],
        );
    for (const [key, data] of Object.entries(state.digests!))
      await t.pool.query(
        "INSERT INTO protocol.quote_digests(deployment_id,key,data,as_of_block_hash) VALUES('d1',$1,$2::jsonb,decode(repeat('11',32),'hex'))",
        [key, JSON.stringify(data)],
      );
    await assertReaderContract(postgresProtocolReader(t.pool, "d1"));
  } finally {
    await t.close();
  }
});

test("protocol log reader covers all seven addresses and strictly decodes event arguments", async () => {
  const { protocolLogReader } =
      await import("../packages/adapters/src/protocol-log-reader.ts"),
    { protocolAbi } = await import("../packages/adapters/src/protocol-abi.ts"),
    { protocolManifest, address, hash } =
      await import("./helpers/protocol-index.ts");
  const { encodeEventTopics, encodeAbiParameters } = await import("viem");
  const d = protocolManifest();
  let requested: string[] = [];
  const client = {
    getLogs: async (args: any) => {
      requested = args.address;
      assert.equal(args.fromBlock, 10n);
      assert.equal(args.toBlock, 11n);
      return [
        {
          address: d.generation.registry,
          removed: false,
          blockHash: hash(10),
          blockNumber: 10n,
          transactionHash: hash(11),
          transactionIndex: 0,
          logIndex: 0,
          topics: encodeEventTopics({
            abi: protocolAbi.registry as import("viem").Abi,
            eventName: "Registered",
            args: { account: address(1) as `0x${string}` },
          }),
          data: encodeAbiParameters([{ type: "uint256" }], [10n]),
        },
      ];
    },
    getBlock: async () => ({
      number: 10n,
      hash: hash(10),
      parentHash: hash(9),
      timestamp: 1000n,
    }),
  } as unknown as import("viem").PublicClient;
  const events = await protocolLogReader(client, d).logs("", 10n, 11n);
  assert.equal(requested.length, 7);
  assert.equal(new Set(requested).size, 7);
  assert.deepEqual(events[0]?.args, { account: address(1), feePaid: "10" });
  assert.equal(events[0]?.contract, "REGISTRY");
  assert.equal(events[0]?.emitter, d.generation.registry);
});
test("unsupported finality is unknown; transport failures propagate", async () => {
  const { protocolLogReader } =
      await import("../packages/adapters/src/protocol-log-reader.ts"),
    { protocolManifest } = await import("./helpers/protocol-index.ts");
  let error: unknown = { code: -32602 };
  const client = {
    getBlock: async () => {
      throw error;
    },
  } as unknown as import("viem").PublicClient;
  const reader = protocolLogReader(client, protocolManifest());
  assert.equal(await reader.finalized(), null);
  error = new Error("TIMEOUT");
  await assert.rejects(reader.finalized(), /TIMEOUT/);
});
test("indexed-reader health refuses missing, lagged, gated and stopped indexes", async () => {
  const t = await createTestDatabase();
  try {
    await seedProtocolDeployment(t.pool);
    const reader = postgresProtocolReader(t.pool, "d1");
    assert.equal((await reader.health()).stale, true);
    const chain = new FakeChain(9n);
    chain.mine();
    const store = postgresProtocolIndexStore(t.pool),
      indexer = createChainIndexer({
        store,
        reader: chain.reader(),
        deploymentId: "d1",
        marketAddress: MARKET_ADDRESS,
        deploymentBlock: 10n,
        workerId: "health",
      });
    await indexer.syncOnce();
    assert.equal((await reader.health()).stale, false);
    await t.pool.query(
      "UPDATE chain.cursors SET head_timestamp=block_timestamp+30",
    );
    assert.equal((await reader.health()).stale, false);
    await t.pool.query(
      "UPDATE chain.cursors SET head_timestamp=block_timestamp+31",
    );
    assert.equal((await reader.health()).stale, true);
    await t.pool.query(
      "UPDATE chain.cursors SET head_timestamp=block_timestamp,gate_reason='REORG_IN_PROGRESS'",
    );
    assert.equal((await reader.health()).stale, true);
    await t.pool.query(
      "UPDATE chain.cursors SET gate_reason=NULL,synced_at=blink.now()-interval '31 seconds'",
    );
    assert.equal((await reader.health()).stale, true);
  } finally {
    await t.close();
  }
});
test("ABI string fields preserve hex-looking text verbatim", async () => {
  const { protocolLogReader } =
      await import("../packages/adapters/src/protocol-log-reader.ts"),
    { protocolAbi } = await import("../packages/adapters/src/protocol-abi.ts"),
    { protocolManifest, hash } = await import("./helpers/protocol-index.ts");
  const { encodeAbiParameters, encodeEventTopics } = await import("viem");
  const d = protocolManifest();
  const client = {
    getLogs: async () => [
      {
        address: d.generation.markets,
        removed: false,
        blockHash: hash(10),
        blockNumber: 10n,
        transactionHash: hash(11),
        transactionIndex: 0,
        logIndex: 0,
        topics: encodeEventTopics({
          abi: protocolAbi.markets as import("viem").Abi,
          eventName: "TemplateRegistered",
          args: { templateId: hash(9) as `0x${string}` },
        }),
        data: encodeAbiParameters(
          [{ type: "uint8" }, { type: "bytes32" }, { type: "string" }],
          [0, hash(8) as `0x${string}`, "0xAbCd"],
        ),
      },
    ],
    getBlock: async () => ({
      number: 10n,
      hash: hash(10),
      parentHash: hash(9),
      timestamp: 1000n,
    }),
  } as unknown as import("viem").PublicClient;
  assert.equal(
    (await protocolLogReader(client, d).logs("", 10n, 10n))[0]?.args.uri,
    "0xAbCd",
  );
});
