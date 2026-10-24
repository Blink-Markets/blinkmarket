import assert from "node:assert/strict";
import { test } from "node:test";
import {
  keccak256,
  toBytes,
  erc20Abi,
  type Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { protocolLogReader } from "../../packages/adapters/src/protocol-log-reader.ts";
import {
  protocolAbi as typedAbi,
  type ProtocolContractName,
} from "../../packages/adapters/src/protocol-abi.ts";
import {
  postgresProtocolIndexStore,
  postgresProtocolReader,
} from "../../packages/adapters/src/protocol-index-store.ts";
import {
  createChainIndexer,
  rebuildChainProjection,
} from "../../packages/application/src/chain-indexer.ts";
import { foldProtocolEvents } from "../../packages/domain/src/protocol-reducer.ts";
import { quoteTypes, RoleName } from "../../packages/schemas/src/index.ts";
import { deployAlphaProtocol, startAnvil } from "../helpers/anvil.ts";
import { createTestDatabase } from "../helpers/database.ts";
import { seedProtocolDeployment } from "../helpers/protocol-index.ts";

const protocolAbi = typedAbi as unknown as Record<ProtocolContractName, Abi>;

test(
  "normal lifecycle projections equal contract views; rebuild equals incremental",
  { timeout: 180000 },
  async () => {
    const anvil = await startAnvil(),
      t = await createTestDatabase();
    try {
      const d = await deployAlphaProtocol(anvil);
      await seedProtocolDeployment(t.pool, d.deploymentId, d);
      const reader = protocolLogReader(anvil.publicClient as PublicClient, d),
        store = postgresProtocolIndexStore(t.pool),
        publicReader = postgresProtocolReader(t.pool, d.deploymentId);
      const indexer = createChainIndexer({
        store,
        reader: { ...reader, finalized: async () => null },
        deploymentId: d.deploymentId,
        marketAddress: d.generation.markets,
        deploymentBlock: BigInt(d.startBlock),
        workerId: "anvil",
      });
      // Small ranges can end before the generation contracts exist; constructor blocks still advance.
      const deploymentIndexer = createChainIndexer({
        store,
        reader: { ...reader, finalized: async () => null },
        deploymentId: d.deploymentId,
        marketAddress: d.generation.markets,
        deploymentBlock: BigInt(d.startBlock),
        workerId: "anvil",
        rangeSize: 1,
      });
      for (
        let n = d.startBlock;
        n <= Number(await anvil.publicClient.getBlockNumber());
        n++
      )
        assert.equal((await deploymentIndexer.syncOnce()).gateReason, null);
      const write = async (
        who: keyof typeof anvil.accounts,
        address: string,
        abi: Abi,
        functionName: string,
        args: readonly unknown[] = [],
      ) => {
        const receipt = await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil.wallet(anvil.accounts[who]).writeContract({
            address: address as Hex,
            abi,
            functionName,
            args,
            gas: 5000000n,
          }),
        });
        assert.equal(receipt.status, "success", functionName);
        return receipt;
      };
      const mread = (functionName: string, args: readonly unknown[] = []) =>
        anvil.publicClient.readContract({
          address: d.generation.markets as Hex,
          abi: protocolAbi.markets,
          functionName,
          args,
        } as never) as Promise<any>;
      const check = async () => {
        const result = await indexer.syncOnce();
        assert.equal(result.gateReason, null);
        const p = await store.loadProjection(d.deploymentId),
          cursor = (await store.loadCursor(d.deploymentId))!;
        assert.equal(await reader.agrees(cursor.blockHash, p), true);
        assert.deepEqual(
          p,
          foldProtocolEvents(await store.loadCanonicalEvents(d.deploymentId)),
        );
        for (const m of p.markets.values()) {
          const v = await mread("getMarket", [BigInt(m.marketId)]);
          assert.equal(m.escrowMicros, String(v.escrowMicros));
          assert.equal(m.mintedPairs, String(v.totalMintedPairs));
          assert.equal(
            m.feePoolMicros,
            String(await mread("feePool", [BigInt(m.marketId)])),
          );
        }
        for (const pos of p.positions.values())
          assert.deepEqual(
            await mread("getPosition", [BigInt(pos.marketId), pos.account]),
            [BigInt(pos.yesShares), BigInt(pos.noShares)],
          );
        for (const m of p.makers.values()) {
          assert.equal(
            (await publicReader.maker(m.address)).freeMicros,
            String(await mread("makerFree", [m.address])),
          );
          assert.equal(m.epoch, String(await mread("makerEpoch", [m.address])));
        }
        for (const [digest, status] of p.digests)
          assert.equal(
            await publicReader.digest(digest),
            (await mread("consumed", [digest]))
              ? "CONSUMED"
              : (await mread("cancelled", [digest]))
                ? "CANCELLED"
                : "UNUSED",
          );
        for (const a of p.accounts.values())
          for (const [i, role] of RoleName.options.entries()) {
            assert.equal(
              await publicReader.hasRole(a.address, role),
              await anvil.publicClient.readContract({
                address: d.generation.registry as Hex,
                abi: protocolAbi.registry,
                functionName: "hasRole",
                args: [a.address as Hex, i],
              }),
            );
            assert.equal(
              await publicReader.creditAt(
                a.address,
                role,
                Number(cursor.blockTimestamp),
              ),
              Number(
                await anvil.publicClient.readContract({
                  address: d.generation.registry as Hex,
                  abi: protocolAbi.registry,
                  functionName: "creditOf",
                  args: [a.address as Hex, i],
                }),
              ),
            );
          }
        return p;
      };
      for (const [who, role] of [
        ["admin", 0],
        ["maker", 1],
        ["trader", 1],
        ["taker", 2],
        ["proposer", 4],
        ["arbiter", 6],
      ] as const) {
        await write(who, d.shared.faucet, protocolAbi.faucet, "claim");
        for (const spender of [
          d.generation.registry,
          d.generation.markets,
          d.generation.resolution,
        ])
          await write(who, d.shared.busd, erc20Abi, "approve", [
            spender,
            2n ** 256n - 1n,
          ]);
        await write(
          who,
          d.generation.registry,
          protocolAbi.registry,
          "register",
        );
        if (role !== 6)
          await write(
            who,
            d.generation.registry,
            protocolAbi.registry,
            "joinRole",
            [role, BigInt(d.params.minRoleStake)],
          );
      }
      await write("arbiter", d.shared.token, erc20Abi, "approve", [
        d.generation.jurors,
        1000n * 10n ** 18n,
      ]);
      await write("arbiter", d.generation.jurors, protocolAbi.jurors, "stake", [
        1000n * 10n ** 18n,
      ]);
      for (const who of ["maker", "trader"] as const)
        await write(
          who,
          d.generation.markets,
          protocolAbi.markets,
          "depositMaker",
          [100000000n],
        );
      const parserHash = keccak256(toBytes("indexer-parser"));
      const templateReceipt = await write(
        "admin",
        d.generation.markets,
        protocolAbi.markets,
        "registerTemplate",
        [0, parserHash, "ipfs://template"],
      );
      const templateEvent = (
        await reader.logs(
          "",
          templateReceipt.blockNumber,
          templateReceipt.blockNumber,
        )
      ).find((e) => e.name === "TemplateRegistered")!;
      const templateId = templateEvent.args.templateId as Hex,
        specHash = keccak256(toBytes("indexer-spec"));
      const now = (await anvil.publicClient.getBlock()).timestamp;
      await write(
        "admin",
        d.generation.markets,
        protocolAbi.markets,
        "createMarket",
        [
          {
            templateId,
            specHash,
            specURI: "ipfs://spec",
            replay: true,
            closeAt: now + 600n,
            proposalDeadline: now + 700n,
            hardDeadline: now + 1200n,
            maxPairs: 100n,
          },
        ],
      );
      assert.equal((await check()).markets.get("1")?.state, "PENDING");
      const m = await mread("getMarket", [1n]);
      await anvil.setNextTimestamp(m.openAt);
      await write("keeper", d.generation.markets, protocolAbi.markets, "open", [
        1n,
      ]);
      for (const [nonce, who] of [
        [1n, "maker"],
        [2n, "trader"],
      ] as const) {
        const time = (await anvil.publicClient.getBlock()).timestamp;
        const q = {
          marketId: 1n,
          specHash,
          maker: anvil.accounts[who].address,
          taker: anvil.accounts.taker.address,
          side: 0,
          quantity: 10n,
          priceBps: 6000,
          validAfter: time,
          expiresAt: time + 60n,
          nonce,
          epoch: 0n,
        };
        const sig = await anvil.accounts[who].signTypedData({
          domain: {
            name: "Blink RFQ",
            version: "0.2",
            chainId: 84532,
            verifyingContract: d.generation.markets as Hex,
          },
          types: quoteTypes,
          primaryType: "Quote",
          message: q,
        });
        await write(
          "taker",
          d.generation.markets,
          protocolAbi.markets,
          "fillQuote",
          [q, sig],
        );
      }
      await write(
        "maker",
        d.generation.markets,
        protocolAbi.markets,
        "incrementMakerEpoch",
      );
      const filled = await check();
      assert.equal(filled.markets.get("1")?.escrowMicros, "20000000");
      assert.equal(
        filled.makers.get(anvil.accounts.maker.address.toLowerCase())
          ?.freeMicros,
        "96000000",
      );
      await anvil.setNextTimestamp(m.closeAt);
      await write(
        "proposer",
        d.generation.resolution,
        protocolAbi.resolution,
        "propose",
        [1n, 0, parserHash, "ipfs://evidence"],
      );
      await check();
      await anvil.setNextTimestamp(
        (await anvil.publicClient.getBlock()).timestamp +
          BigInt(d.params.resultChallengeWindow[0]),
      );
      await write(
        "keeper",
        d.generation.resolution,
        protocolAbi.resolution,
        "finalizeUnchallenged",
        [1n],
      );
      await write(
        "keeper",
        d.generation.markets,
        protocolAbi.markets,
        "distributeFees",
        [1n],
      );
      for (const who of ["maker", "trader", "taker"] as const)
        await write(who, d.generation.markets, protocolAbi.markets, "redeem", [
          1n,
        ]);
      const root = keccak256(toBytes("forecast-root"));
      await write("keeper", d.shared.anchor, protocolAbi.anchor, "anchor", [
        root,
      ]);
      const final = await check();
      assert.equal(final.markets.get("1")?.escrowMicros, "0");
      assert.equal(final.markets.get("1")?.feePoolMicros, "0");
      assert.ok(await publicReader.anchor(root));
      const rebuild = await rebuildChainProjection(store, d.deploymentId, {
        verify: true,
        workerId: "verify",
      });
      assert.deepEqual(rebuild.differences, []);
      // Removing every projection then replaying the immutable journal must recreate every row.
      for (const table of [
        "accounts",
        "account_roles",
        "credit",
        "templates",
        "markets",
        "positions",
        "makers",
        "quote_digests",
        "fills",
        "anchors",
        "successors",
      ])
        await t.pool.query(`DELETE FROM protocol.${table}`);
      const lease = await store.claimLease(d.deploymentId, "anvil", 30000);
      await store.releaseLease(lease!);
      const repaired = await rebuildChainProjection(store, d.deploymentId, {
        verify: false,
        workerId: "rebuild",
      });
      assert.equal(repaired.rewritten, true);
      assert.deepEqual(await store.loadProjection(d.deploymentId), final);
    } finally {
      await anvil.stop();
      await t.close();
    }
  },
);

test("unknown generation log fails closed before indexing", async () => {
  const { protocolManifest } = await import("../helpers/protocol-index.ts");
  const d = protocolManifest();
  const client = {
    getLogs: async () => [
      {
        address: d.generation.registry,
        removed: false,
        blockHash: "0x" + "1".repeat(64),
        blockNumber: 1n,
        transactionHash: "0x" + "2".repeat(64),
        transactionIndex: 0,
        logIndex: 0,
        topics: ["0x" + "f".repeat(64)],
        data: "0x",
      },
    ],
  } as unknown as PublicClient;
  await assert.rejects(
    protocolLogReader(client, d).logs("", 1n, 1n),
    /CHAIN_LOG_UNDECODABLE/,
  );
});
