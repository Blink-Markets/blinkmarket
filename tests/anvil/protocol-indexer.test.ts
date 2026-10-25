import assert from "node:assert/strict";
import { test } from "node:test";
import {
  encodeAbiParameters,
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
          foldProtocolEvents(
            await store.loadCanonicalEvents(d.deploymentId),
            d.params,
          ),
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
        reader,
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
        "proposals",
        "disputes",
        "rounds",
        "votes",
        "jurors",
        "reward_pool",
        "fees",
      ])
        await t.pool.query(`DELETE FROM protocol.${table}`);
      const lease = await store.claimLease(d.deploymentId, "anvil", 30000);
      await store.releaseLease(lease!);
      const repaired = await rebuildChainProjection(store, d.deploymentId, {
        verify: false,
        workerId: "rebuild",
        reader,
      });
      assert.equal(repaired.rewritten, true);
      assert.deepEqual(await store.loadProjection(d.deploymentId), final);
    } finally {
      await anvil.stop();
      await t.close();
    }
  },
);

const commitment = (
  disputeId: bigint,
  round: bigint,
  juror: Hex,
  choice: number,
  salt: Hex,
) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [disputeId, round, juror, choice, salt],
    ),
  );

test(
  "resolution, juror, credit and fee read models equal the contracts after a restarted and appealed dispute",
  { timeout: 240000 },
  async (tt) => {
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
      const A = anvil.accounts;
      const addr = (who: keyof typeof A) => A[who].address.toLowerCase();
      const write = async (
        who: keyof typeof A,
        address: string,
        abi: Abi,
        functionName: string,
        args: readonly unknown[] = [],
        at?: bigint,
      ) => {
        if (at !== undefined) await anvil.setNextTimestamp(at);
        const receipt = await anvil.publicClient.waitForTransactionReceipt({
          hash: await anvil.wallet(A[who]).writeContract({
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
      const res = (fn: string, args: readonly unknown[], who: keyof typeof A, at?: bigint) =>
        write(who, d.generation.resolution, protocolAbi.resolution, fn, args, at);
      const jur = (fn: string, args: readonly unknown[], who: keyof typeof A, at?: bigint) =>
        write(who, d.generation.jurors, protocolAbi.jurors, fn, args, at);
      const view = (contract: "registry" | "resolution" | "jurors" | "markets", fn: string, args: readonly unknown[] = []) =>
        anvil.publicClient.readContract({
          address: d.generation[contract] as Hex,
          abi: protocolAbi[contract],
          functionName: fn,
          args,
        } as never) as Promise<any>;
      const balance = (who: string, blockNumber: bigint) =>
        anvil.publicClient.readContract({
          address: d.shared.busd as Hex,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [who as Hex],
          blockNumber,
        });
      const sync = async () => {
        assert.equal((await indexer.syncOnce()).gateReason, null);
        const p = await store.loadProjection(d.deploymentId),
          cursor = (await store.loadCursor(d.deploymentId))!;
        assert.equal(await reader.agrees(cursor.blockHash, p), true);
        return { p, cursor };
      };
      const stamp = async () => (await anvil.publicClient.getBlock()).timestamp;

      // ---- setup: every actor registered, funded and staked ----
      for (const [who, role] of [
        ["admin", 0],
        ["maker", 1],
        ["trader", 1],
        ["taker", 2],
        ["proposer", 4],
        ["challenger", 5],
        ["arbiter", 6],
        ["minter", 6],
      ] as const) {
        await write(who, d.shared.faucet, protocolAbi.faucet, "claim");
        for (const spender of [d.generation.registry, d.generation.markets, d.generation.resolution])
          await write(who, d.shared.busd, erc20Abi, "approve", [spender, 2n ** 256n - 1n]);
        await write(who, d.generation.registry, protocolAbi.registry, "register");
        if (role !== 6)
          await write(who, d.generation.registry, protocolAbi.registry, "joinRole", [
            role,
            BigInt(d.params.minRoleStake),
          ]);
      }
      const STAKE = 1000n * 10n ** 18n;
      for (const who of ["arbiter", "minter"] as const) {
        await write(who, d.shared.token, erc20Abi, "approve", [d.generation.jurors, STAKE]);
        await jur("stake", [STAKE], who);
      }
      for (const who of ["maker", "trader"] as const)
        await write(who, d.generation.markets, protocolAbi.markets, "depositMaker", [100000000n]);
      const parserHash = keccak256(toBytes("resolution-parser"));
      const templateReceipt = await write("admin", d.generation.markets, protocolAbi.markets, "registerTemplate", [
        0,
        parserHash,
        "ipfs://template",
      ]);
      const templateId = (
        await reader.logs("", templateReceipt.blockNumber, templateReceipt.blockNumber)
      ).find((e) => e.name === "TemplateRegistered")!.args.templateId as Hex;
      const specHash = keccak256(toBytes("resolution-spec"));
      const now = await stamp();
      await write("admin", d.generation.markets, protocolAbi.markets, "createMarket", [
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
      ]);
      const m = await view("markets", "getMarket", [1n]);
      await write("keeper", d.generation.markets, protocolAbi.markets, "open", [1n], m.openAt);
      for (const [nonce, who] of [
        [1n, "maker"],
        [2n, "trader"],
      ] as const) {
        const time = await stamp();
        const q = {
          marketId: 1n,
          specHash,
          maker: A[who].address,
          taker: A.taker.address,
          side: 0,
          quantity: 10n,
          priceBps: 6000,
          validAfter: time,
          expiresAt: time + 60n,
          nonce,
          epoch: 0n,
        };
        const sig = await A[who].signTypedData({
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
        await write("taker", d.generation.markets, protocolAbi.markets, "fillQuote", [q, sig]);
      }

      // ---- dispute: round 0 ties and restarts, round 1 leads NO, the proposer appeals, round 2 leads YES ----
      const salts = {
        a: keccak256(toBytes("salt-a")),
        m: keccak256(toBytes("salt-m")),
      };
      const arbiter = A.arbiter.address as Hex,
        minter = A.minter.address as Hex;
      await res("propose", [1n, 0, parserHash, "ipfs://evidence"], "proposer", m.closeAt);
      const opened = await res("challengeResult", [1n, keccak256(toBytes("challenge"))], "challenger", m.closeAt + 5n);
      const T0 = (await anvil.publicClient.getBlock({ blockNumber: opened.blockNumber })).timestamp;
      const vote = async (round: bigint, base: bigint, aChoice: number, mChoice: number, revealM: boolean) => {
        await res("commitVote", [1n, commitment(1n, round, arbiter, aChoice, salts.a)], "arbiter", base + 2n);
        await res("commitVote", [1n, commitment(1n, round, minter, mChoice, salts.m)], "minter", base + 3n);
        await res("revealVote", [1n, aChoice, salts.a], "arbiter", base + 31n);
        if (revealM) await res("revealVote", [1n, mChoice, salts.m], "minter", base + 32n);
      };
      await vote(0n, T0, 1, 0, true);
      await res("settleRound", [1n], "keeper", T0 + 61n); // tie: restarts at the same level
      let mid = await sync();
      assert.equal(mid.p.disputes.get("1")?.currentRound, 1);
      assert.equal(mid.p.rounds.get("1:0")?.restarted, true);
      const T1 = T0 + 61n;
      await vote(1n, T1, 1, 1, true);
      await res("settleRound", [1n], "keeper", T1 + 61n);
      await res("appeal", [1n], "proposer", T1 + 65n);
      const T2 = T1 + 65n;
      await vote(2n, T2, 0, 0, false);
      await res("settleRound", [1n], "keeper", T2 + 61n);
      // The minter never revealed: it can be settled (slashed) before the dispute is final.
      await res("settleVote", [1n, 2n, minter], "keeper", T2 + 62n);
      mid = await sync();
      assert.equal(mid.p.votes.get(`1:2:${addr("minter")}`)?.settled, true);
      await res("finalizeDispute", [1n], "keeper", T2 + 91n);
      for (const [round, juror] of [
        [0n, arbiter], [0n, minter], [1n, arbiter], [1n, minter], [2n, minter], [2n, arbiter],
      ] as const)
        await res("settleVote", [1n, round, juror], "keeper");
      const settled = await sync();

      await tt.test("rounds and votes equal getDispute and events", async () => {
        const [dispute, round] = await view("resolution", "getDispute", [1n]);
        const pd = settled.p.disputes.get("1")!,
          pr = settled.p.rounds.get(`1:${dispute.currentRound}`)!;
        assert.deepEqual(
          [pd.settled, pd.timedOut, pd.currentRound, pd.appealRound, pd.challenger],
          [dispute.settled, dispute.timedOut, Number(dispute.currentRound), Number(dispute.appealRound), dispute.challenger.toLowerCase()],
        );
        assert.deepEqual(
          [pr.snapshotAt, pr.commitEnd, pr.revealEnd, pr.appealEnd, pr.committedWeight, pr.revealedWeight, pr.committers, pr.revealers, pr.leadingChoice, pr.level, pr.settled, pr.restarted],
          [Number(round.snapshotAt), Number(round.commitEnd), Number(round.revealEnd), Number(round.appealEnd), String(round.committedWeight), [String(round.revealedWeight[0]), String(round.revealedWeight[1])], Number(round.committers), Number(round.revealers), Number(round.leadingChoice), Number(round.level), round.settled, round.restarted],
        );
        assert.equal(pd.finalChoice, 0);
        assert.deepEqual(
          [...settled.p.rounds.values()].map((r) => [r.round, r.level, r.restarted, r.settled]),
          [[0, 0, true, true], [1, 0, false, true], [2, 1, false, true]],
        );
        // Votes recomputed from the event log alone.
        const events = (await store.loadCanonicalEvents(d.deploymentId)).filter(
          (e) => e.contract === "RESOLUTION" && String(e.args.disputeId) === "1",
        );
        const expected = new Map<string, any>();
        for (const e of events) {
          const key = `1:${e.args.round}:${String(e.args.juror).toLowerCase()}`;
          if (e.name === "VoteCommitted")
            expected.set(key, { weight: String(e.args.weight), revealed: false, choice: null, settled: false, slashed: 0n, reward: 0n });
          if (e.name === "VoteRevealed") Object.assign(expected.get(key), { revealed: true, choice: Number(e.args.choice) });
          if (e.name === "VoteSettled") {
            const v = expected.get(key);
            v.settled = true;
            v.slashed += BigInt(String(e.args.slash));
            v.reward += BigInt(String(e.args.reward));
          }
        }
        assert.equal(settled.p.votes.size, 6);
        for (const [key, v] of settled.p.votes) {
          const e = expected.get(key);
          assert.deepEqual(
            [v.weight, v.revealed, v.choice, v.settled, v.slashed, v.reward],
            [e.weight, e.revealed, e.choice, e.settled, e.slashed.toString(), e.reward.toString()],
            key,
          );
        }
        assert.ok(BigInt(settled.p.votes.get(`1:2:${addr("arbiter")}`)!.reward) > 0n, "the winner earned the non-revealer's slash");
        assert.ok(BigInt(settled.p.votes.get(`1:2:${addr("minter")}`)!.slashed) > 0n);
        // A reader never serves a choice before its reveal, however the projection rows look.
        for (const v of (await publicReader.votes("1", { limit: 100 })).items)
          assert.equal(v.choice === null, !v.revealed);
        assert.deepEqual(
          (await publicReader.rounds("1")).map((r) => r.round),
          [0, 1, 2],
        );
      });

      await tt.test("credit read model equals registry.creditOf", async () => {
        const ts = Number(settled.cursor.blockTimestamp);
        assert.ok(settled.p.accounts.size >= 8);
        for (const a of settled.p.accounts.values())
          for (const [i, role] of RoleName.options.entries())
            assert.equal(
              await publicReader.creditAt(a.address, role, ts),
              Number(await view("registry", "creditOf", [a.address, i])),
              `${a.address} ${role}`,
            );
        // The dispute moved credit: the winning proposer gained and the losing challenger lost.
        assert.ok(
          (await publicReader.creditAt(addr("proposer"), "PROPOSER", ts)) >
            (await publicReader.creditAt(addr("challenger"), "CHALLENGER", ts)),
        );
      });

      await tt.test("fees read model equals balance deltas", async () => {
        const before = (await anvil.publicClient.getBlockNumber());
        const keeperTipper = "taker2" as const;
        const receipt = await write(keeperTipper, d.generation.markets, protocolAbi.markets, "distributeFees", [1n]);
        const after = receipt.blockNumber;
        assert.equal(after, before + 1n);
        const delta = async (who: string) => (await balance(who, after)) - (await balance(who, before));
        const { p } = await sync();
        const f = p.fees.get("1")!;
        assert.ok(f, "fee breakdown recorded");
        const event = (await store.loadCanonicalEvents(d.deploymentId)).find((e) => e.name === "FeesDistributed")!;
        assert.equal(f.poolMicros, String(event.args.amount));
        assert.equal(f.keeperTip, String(event.args.keeperTip));
        assert.equal(f.keeper, addr(keeperTipper));
        assert.equal(BigInt(f.keeperTip), await delta(A[keeperTipper].address));
        assert.equal(BigInt(f.creator), await delta(A.admin.address));
        assert.equal(BigInt(f.resolution), await delta(A.proposer.address));
        assert.equal(BigInt(f.treasury), await delta(d.treasury)); // the treasury is the keeper account
        assert.equal(BigInt(f.jurors), await delta(d.generation.jurors));
        assert.equal(BigInt(f.bounty), 0n);
        assert.equal(f.bountyWinner, null);
        assert.equal(
          BigInt(f.treasury) + BigInt(f.creator) + BigInt(f.resolution) + BigInt(f.keeperTip) + BigInt(f.jurors) + BigInt(f.bounty),
          BigInt(f.poolMicros),
        );
        assert.deepEqual(await publicReader.fees("1"), f);
        assert.ok(BigInt(f.poolMicros) > 0n);
      });

      await tt.test("juror state follows unstake, withdrawal and reward claims", async () => {
        const check = async () => {
          const { p } = await sync();
          for (const j of p.jurors.values()) {
            const pending = await view("jurors", "pendingUnstake", [j.address]);
            assert.deepEqual(
              [j.staked, j.pendingUnstake, j.unstakeReadyAt, j.openVotes],
              [
                String(await view("jurors", "slashableStake", [j.address]) - pending[0]),
                String(pending[0]),
                Number(pending[1]),
                Number(await view("jurors", "openVotes", [j.address])),
              ],
            );
          }
          return p;
        };
        const slashed = await check();
        assert.equal(slashed.jurors.get(addr("arbiter"))?.openVotes, 0);
        assert.ok(BigInt(slashed.jurors.get(addr("minter"))!.staked) < STAKE, "slashed for not revealing");
        const unstake = 100n * 10n ** 18n;
        await jur("requestUnstake", [unstake], "arbiter");
        const requested = await check();
        assert.equal(requested.jurors.get(addr("arbiter"))?.pendingUnstake, unstake.toString());
        assert.ok(requested.jurors.get(addr("arbiter"))!.unstakeReadyAt > 0);
        const ready = BigInt(requested.jurors.get(addr("arbiter"))!.unstakeReadyAt);
        await jur("withdrawUnstaked", [], "arbiter", ready + 1n);
        const withdrawn = await check();
        assert.equal(withdrawn.jurors.get(addr("arbiter"))?.pendingUnstake, "0");
        assert.equal(withdrawn.jurors.get(addr("arbiter"))?.unstakeReadyAt, 0);
        await jur("requestUnstake", [50n * 10n ** 18n], "arbiter");
        await check();
        // The reward stream finishes after seven days; the claim pays what the index says is owed.
        const claimAt = (await stamp()) + 604_900n;
        const claimed = await jur("claimRewards", [], "arbiter", claimAt);
        const { p } = await sync();
        const claim = (await store.loadCanonicalEvents(d.deploymentId)).find(
          (e) => e.name === "RewardsClaimed" && String(e.args.juror).toLowerCase() === addr("arbiter"),
        )!;
        assert.ok(BigInt(String(claim.args.amount)) > 0n);
        assert.equal(claimed.status, "success");
        assert.equal(p.jurors.get(addr("arbiter"))?.rewardsOwed, String(await view("jurors", "rewards", [arbiter])));
        // Folding a zero claim at the same time shows the simulated balance equalled the paid amount.
        const events = await store.loadCanonicalEvents(d.deploymentId);
        const upTo = events.slice(0, events.indexOf(claim));
        const probe = foldProtocolEvents(
          [...upTo, { ...claim, args: { ...claim.args, amount: "0" } }],
          d.params,
        );
        assert.equal(probe.jurors.get(addr("arbiter"))?.rewardsOwed, String(claim.args.amount));
      });

      // The whole read model survives a rebuild from the journal alone.
      const final = await store.loadProjection(d.deploymentId);
      const rebuilt = await rebuildChainProjection(store, d.deploymentId, {
        verify: true,
        workerId: "verify",
        reader,
      });
      assert.deepEqual(rebuilt.differences, []);
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
