import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { keccak256, toBytes } from "viem";
import {
  createTestDatabase,
  inviteAgent,
  bindWallet,
} from "../helpers/database.js";
import { startAnvil, deployBlink } from "../helpers/anvil.js";
import { seedDeployment, sha256Hex } from "../helpers/signer-fixture.js";
import {
  blinkMarketAbi,
  blinkTestUsdAbi,
} from "../../packages/adapters/src/blink-abi.js";
import { postgresSignerStore } from "../../packages/adapters/src/signing-store.js";
import { postgresFaucetStore } from "../../packages/adapters/src/faucet-store.js";
import { viemSignerRpc } from "../../packages/adapters/src/signing-rpc.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import { identityCrypto } from "../../packages/adapters/src/identity-crypto.js";
import { postgresJobQueue } from "../../packages/adapters/src/job-queue.js";
import { postgresChainIndexStore } from "../../packages/adapters/src/chain-index-store.js";
import { chainLogReader } from "../../packages/adapters/src/chain-log-reader.js";
import { createChainIndexer } from "../../packages/application/src/chain-indexer.js";
import { createSignerService } from "../../packages/application/src/signer.js";
import { createFaucetService } from "../../packages/application/src/faucet.js";
import { buildSignerServer } from "../../apps/signer/src/server.js";
import { buildApi } from "../../apps/api/src/server.js";
import { buildExecution } from "../../apps/worker/src/execution.js";
import { createTxDispatcher } from "../../packages/application/src/tx-dispatcher.js";
import { createExecutionDispatcher } from "../../packages/application/src/execution.js";
import { postgresDispatchStore } from "../../packages/adapters/src/signing-store.js";
import { signerClient } from "../../packages/adapters/src/signer-client.js";
import { viemDispatchRpc } from "../../packages/adapters/src/signing-rpc.js";
import { executionChainReader } from "../../packages/adapters/src/execution-chain-reader.js";

const TOKEN = "local-execution-fixture";
const signal = new AbortController().signal;

test(
  "Anvil: faucet API mints 1,000 bUSD and periodic keeper finalizes a proposal observed by the indexer",
  { timeout: 180000 },
  async (suite) => {
    const anvil = await startAnvil();
    const t = await createTestDatabase();
    let server: ReturnType<typeof buildSignerServer> | undefined;
    let api: ReturnType<typeof buildApi> | undefined;
    try {
      const d = await deployBlink(anvil);
      const deploymentId = d.manifest.deploymentId;
      await seedDeployment(t.db, d.manifest);
      const agent = await inviteAgent(t, {
        name: "anvil-faucet",
        scopes: ["faucet:claim"],
      });
      await bindWallet(t, agent.agentId, anvil.accounts.taker.address);
      const call = async (
        account: typeof anvil.accounts.admin,
        functionName: string,
        args: readonly unknown[],
      ) => {
        const hash = await anvil.wallet(account).writeContract({
          address: d.market,
          abi: blinkMarketAbi,
          functionName,
          args,
        } as never);
        const receipt = await anvil.publicClient.waitForTransactionReceipt({
          hash,
        });
        assert.equal(receipt.status, "success");
        return receipt;
      };
      const now = (await anvil.publicClient.getBlock()).timestamp;
      const closeAt = now + 1000n;
      await call(anvil.accounts.admin, "createMarket", [
        keccak256(toBytes("keeper fixture")),
        "fixture://keeper",
        1,
        closeAt,
        now + 2000n,
        now + 4000n,
        120,
        10000n,
        500n,
      ]);
      await call(anvil.accounts.admin, "setTakerAllowed", [
        anvil.accounts.taker.address,
        true,
      ]);
      const indexer = createChainIndexer({
        store: postgresChainIndexStore(t.pool),
        reader: chainLogReader(anvil.publicClient),
        deploymentId,
        marketAddress: d.market.toLowerCase(),
        deploymentBlock: d.deploymentBlock,
        workerId: "keeper-fixture",
      });
      const sync = async () => {
        for (let i = 0; i < 100; i++) {
          const result = await indexer.syncOnce();
          if (result.advancedTo === null && result.reorgedTo === null) return;
        }
        assert.fail("indexer did not converge");
      };
      await sync();
      const signerRpc = viemSignerRpc({ url: anvil.url });
      let signerOutage = false;
      let crashAfterPlan = false;
      let crashedKeeperInput: unknown;
      server = buildSignerServer(
        createSignerService({
          store: postgresSignerStore(t.pool),
          deployment: d.manifest,
          keys: {
            faucet: anvil.accounts.minter,
            keeper: {
              ...anvil.accounts.keeper,
              async signTransaction(input) {
                if (crashAfterPlan) {
                  crashedKeeperInput = input;
                  throw new Error("CRASH_AFTER_PLAN");
                }
                if (crashedKeeperInput) {
                  assert.deepEqual(
                    input,
                    crashedKeeperInput,
                    "retry signs identical planned transaction bytes",
                  );
                  crashedKeeperInput = undefined;
                }
                return anvil.accounts.keeper.signTransaction(input);
              },
            },
          },
          rpc: {
            ...signerRpc,
            async baseFeePerGas() {
              if (signerOutage) throw new Error("RPC_UNAVAILABLE");
              return signerRpc.baseFeePerGas();
            },
          },
          encodeCall: encodeAllowedCall,
          callers: [
            {
              name: "execution",
              tokenSha256: sha256Hex(TOKEN),
              roles: ["faucet", "keeper"],
            },
          ],
          // Only the isolated Anvil lifts gas caps; production caps are unchanged.
          policy: {
            l1FeeMode: "local-none",
            perTxCapWei: 10n ** 16n,
            dailyCapWei: 10n ** 17n,
          },
        }),
      );
      await server.listen({ port: 0, host: "127.0.0.1" });
      const signerUrl =
        "http://127.0.0.1:" + (server.server.address() as AddressInfo).port;
      const queue = postgresJobQueue(t.pool);
      const execution = await buildExecution({
        pool: t.pool,
        queue,
        config: {
          deploymentId,
          signerUrl,
          signerToken: TOKEN,
          rpcUrl: anvil.url,
        },
      });
      api = buildApi({
        services: [
          createFaucetService({
            store: postgresFaucetStore(t.pool),
            crypto: identityCrypto,
            deploymentId,
          }),
        ],
      });
      const faucetApi = api;
      const claim = await faucetApi.inject({
        method: "POST",
        url: "/v1/faucet/claims",
        headers: {
          authorization: "Bearer " + agent.apiKey,
          "idempotency-key": "mint",
        },
        payload: { deploymentId },
      });
      assert.equal(claim.statusCode, 202, claim.body);
      const { claimId, intentId } = claim.json();
      const beforeMint = await anvil.snapshot();
      await execution.handlers["faucet.mint"]!({
        job: { id: "fixture", payload: { claimId } } as never,
        signal,
      });
      // Anvil reports finalized block 0; INCLUDED is intentionally retried by the job handler.
      await assert.rejects(
        execution.handlers["tx.dispatch"]!({
          job: { id: "fixture", payload: { intentId } } as never,
          signal,
        }),
        /TX_PENDING/,
      );
      assert.equal(
        await anvil.publicClient.readContract({
          address: d.token,
          abi: blinkTestUsdAbi,
          functionName: "balanceOf",
          args: [anvil.accounts.taker.address],
        }),
        1_000_000_000n,
      );
      const minted = (
        await t.pool.query(
          "SELECT state,succeeded_at FROM faucet.claims WHERE id=$1",
          [claimId],
        )
      ).rows[0];
      assert.equal(minted.state, "SUCCEEDED");
      const receiptBlock = (
        await t.pool.query(
          "SELECT receipt_block_number FROM signing.tx_attempts WHERE intent_id=$1",
          [intentId],
        )
      ).rows[0].receipt_block_number;
      assert.equal(
        new Date(minted.succeeded_at).getTime(),
        Number(
          (
            await anvil.publicClient.getBlock({
              blockNumber: BigInt(receiptBlock),
            })
          ).timestamp,
        ) * 1000,
      );

      const firstAttempt = (
        await t.pool.query(
          "SELECT id,version FROM signing.tx_attempts WHERE intent_id=$1",
          [intentId],
        )
      ).rows[0];

      // Orphan the mint: it must become pending again and keep the address locked.
      await anvil.revert(beforeMint);
      await anvil.publicClient.request({
        method: "anvil_setAutomine" as never,
        params: [false] as never,
      });
      await anvil.mine(2);
      await assert.rejects(
        execution.handlers["tx.dispatch"]!({
          job: { id: "fixture", payload: { intentId } } as never,
          signal,
        }),
        /TX_PENDING/,
      );
      assert.equal(
        (
          await t.pool.query(
            "SELECT state,succeeded_at FROM faucet.claims WHERE id=$1",
            [claimId],
          )
        ).rows[0].state,
        "SUBMITTED",
      );
      const pending = await faucetApi.inject({
        method: "POST",
        url: "/v1/faucet/claims",
        headers: {
          authorization: "Bearer " + agent.apiKey,
          "idempotency-key": "pending-reorg",
        },
        payload: { deploymentId },
      });
      assert.equal(pending.json().code, "FAUCET_PENDING");
      await anvil.publicClient.request({
        method: "anvil_setAutomine" as never,
        params: [true] as never,
      });
      await anvil.mine();
      await assert.rejects(
        execution.handlers["tx.dispatch"]!({
          job: { id: "fixture", payload: { intentId } } as never,
          signal,
        }),
        /TX_PENDING/,
      );
      assert.equal(
        (
          await t.pool.query("SELECT state FROM faucet.claims WHERE id=$1", [
            claimId,
          ])
        ).rows[0].state,
        "SUCCEEDED",
      );
      assert.equal(
        (
          await t.pool.query(
            "SELECT id FROM signing.economic_intents WHERE kind='MINT'",
          )
        ).rows.length,
        1,
      );
      assert.equal(
        await anvil.publicClient.readContract({
          address: d.token,
          abi: blinkTestUsdAbi,
          functionName: "balanceOf",
          args: [anvil.accounts.taker.address],
        }),
        1_000_000_000n,
      );

      await t.pool.query(
        "UPDATE operations.jobs SET state='DEAD' WHERE type='tx.dispatch' AND payload->>'intentId'=$1",
        [intentId],
      );
      await execution.tick();
      assert.equal(
        (
          await t.pool.query(
            "SELECT id FROM operations.jobs WHERE type='tx.dispatch' AND payload->>'intentId'=$1",
            [intentId],
          )
        ).rows.length,
        2,
        "a dead dispatch job recovers the same intent",
      );
      assert.deepEqual(
        (
          await t.pool.query(
            "SELECT max_attempts FROM operations.jobs WHERE type='tx.dispatch' AND payload->>'intentId'=$1 AND state='QUEUED'",
            [intentId],
          )
        ).rows.map((r) => Number(r.max_attempts)),
        [20],
        "the recovered dispatch job gets the finality-lag attempt budget",
      );
      assert.deepEqual(
        (
          await t.pool.query(
            "SELECT DISTINCT max_attempts FROM operations.jobs WHERE type='faucet.mint'",
          )
        ).rows.map((r) => Number(r.max_attempts)),
        [10],
        "faucet.mint keeps its own budget",
      );

      await postgresFaucetStore(t.pool).settle(intentId, {
        state: "FAILED",
        attempt: { id: firstAttempt.id, version: Number(firstAttempt.version) },
      });
      assert.equal(
        (
          await t.pool.query("SELECT state FROM faucet.claims WHERE id=$1", [
            claimId,
          ])
        ).rows[0].state,
        "SUCCEEDED",
        "stale attempt cannot overwrite the new inclusion",
      );

      // Fake only the finalized tag: Anvil's tag stays at 0. Real receipts and gas still apply.
      const dispatchStore = postgresDispatchStore(t.pool);
      const reader = executionChainReader({
        url: anvil.url,
        marketAddress: d.market,
      });
      const finalizedRpc = {
        ...viemDispatchRpc({ url: anvil.url }),
        finalizedBlockNumber: () => anvil.publicClient.getBlockNumber(),
      };
      const finalDispatcher = createExecutionDispatcher({
        dispatcher: createTxDispatcher({
          store: dispatchStore,
          signer: signerClient({ url: signerUrl, token: TOKEN }),
          rpc: finalizedRpc,
        }),
        store: dispatchStore,
        faucet: postgresFaucetStore(t.pool),
        reader,
      });
      const recoverSettlement = async (
        stuckIntent: string,
        stuckClaim: string,
        terminal: "FINALIZED" | "FAILED",
      ) => {
        // Simulate settlement being unavailable since the last pending observation.
        await t.pool.query(
          "UPDATE faucet.claims SET state='SUBMITTED',succeeded_at=NULL WHERE id=$1",
          [stuckClaim],
        );
        await t.pool.query(
          "UPDATE operations.jobs SET state='DEAD' WHERE type='tx.dispatch'",
        );
        const counts = (
          await t.pool.query(
            "SELECT (SELECT count(*) FROM signing.economic_intents WHERE kind='MINT')::int AS intents,(SELECT count(*) FROM signing.artifacts)::int AS artifacts",
          )
        ).rows[0];
        const unavailable = createExecutionDispatcher({
          dispatcher: createTxDispatcher({
            store: dispatchStore,
            signer: signerClient({ url: signerUrl, token: TOKEN }),
            rpc: finalizedRpc,
          }),
          store: dispatchStore,
          faucet:
            terminal === "FAILED"
              ? {
                  ...postgresFaucetStore(t.pool),
                  settle: async () => {
                    throw new Error("SETTLEMENT_UNAVAILABLE");
                  },
                }
              : postgresFaucetStore(t.pool),
          reader: {
            blockTimestamp: async () => {
              throw new Error("SETTLEMENT_UNAVAILABLE");
            },
          },
        });
        await queue.enqueue({
          type: "tx.dispatch",
          dedupeKey: "settlement-fixture:" + stuckIntent,
          payload: { intentId: stuckIntent },
          maxAttempts: 10,
        });
        for (let attempt = 1; attempt <= 10; attempt++) {
          const job = await queue.lease(
            "settlement-fixture",
            ["tx.dispatch"],
            60000,
          );
          assert.ok(job);
          assert.equal(job.payload.intentId, stuckIntent);
          await assert.rejects(
            unavailable.dispatch(stuckIntent),
            /SETTLEMENT_UNAVAILABLE/,
          );
          assert.equal(
            await queue.fail(job, {
              code: "SETTLEMENT_UNAVAILABLE",
              retryable: true,
            }),
            attempt === 10 ? "DEAD" : "RETRY",
          );
          await t.pool.query(
            "UPDATE operations.jobs SET next_run_at=blink.now() WHERE id=$1",
            [job.id],
          );
        }
        assert.equal(
          (
            await t.pool.query(
              "SELECT state FROM signing.economic_intents WHERE id=$1",
              [stuckIntent],
            )
          ).rows[0].state,
          terminal,
        );
        // Recovery resumes in a new 15-second bucket after the exhausted job.
        await t.db.exec("SET blink.test_clock_offset_seconds='15'");
        await execution.tick();
        const recovery = await queue.lease(
          "settlement-recovery",
          ["tx.dispatch"],
          60000,
        );
        assert.ok(
          recovery,
          "terminal intent with a pending claim gets recovery work",
        );
        assert.equal(recovery.payload.intentId, stuckIntent);
        await execution.handlers["tx.dispatch"]!({ job: recovery, signal });
        assert.equal(await queue.complete(recovery), true);
        await t.db.exec("SET blink.test_clock_offset_seconds='0'");
        // Replaying recovery is idempotent and does not sign or mint again.
        await execution.handlers["tx.dispatch"]!({ job: recovery, signal });
        assert.equal(
          (
            await t.pool.query("SELECT state FROM faucet.claims WHERE id=$1", [
              stuckClaim,
            ])
          ).rows[0].state,
          terminal === "FINALIZED" ? "SUCCEEDED" : "FAILED",
        );
        assert.deepEqual(
          (
            await t.pool.query(
              "SELECT (SELECT count(*) FROM signing.economic_intents WHERE kind='MINT')::int AS intents,(SELECT count(*) FROM signing.artifacts)::int AS artifacts",
            )
          ).rows[0],
          counts,
        );
      };
      await suite.test(
        "FINALIZED faucet claim recovers after ten failed settlement attempts",
        async () => {
          await recoverSettlement(intentId, claimId, "FINALIZED");
          const afterRecovery = await faucetApi.inject({
            method: "POST",
            url: "/v1/faucet/claims",
            headers: {
              authorization: "Bearer " + agent.apiKey,
              "idempotency-key": "recovered-success",
            },
            payload: { deploymentId },
          });
          assert.equal(afterRecovery.statusCode, 429);
          assert.equal(afterRecovery.json().code, "RATE_LIMITED");
        },
      );

      await anvil.setNextTimestamp(closeAt + 1n);
      await call(anvil.accounts.proposer, "proposeOutcome", [
        1n,
        0,
        keccak256(toBytes("evidence")),
      ]);
      const market = (await anvil.publicClient.readContract({
        address: d.market,
        abi: blinkMarketAbi,
        functionName: "getMarket",
        args: [1n],
      })) as { proposedAt: bigint };
      await anvil.setNextTimestamp(market.proposedAt + 120n);
      await anvil.mine();
      await sync();
      await execution.tick();
      const keeperJobs = (
        await t.pool.query(
          "SELECT id FROM operations.jobs WHERE type='keeper.finalize'",
        )
      ).rows.length;
      await execution.tick();
      assert.equal(
        (
          await t.pool.query(
            "SELECT id FROM operations.jobs WHERE type='keeper.finalize'",
          )
        ).rows.length,
        keeperJobs,
        "same time bucket deduplicates the keeper job",
      );
      await suite.test(
        "allocated keeper plan survives FINAL and consumes its nonce after recovery",
        async () => {
          signerOutage = true;
          await execution.handlers["keeper.finalize"]!({
            job: { id: "fixture", payload: {} } as never,
            signal,
          });
          assert.equal(
            (
              await t.pool.query(
                "SELECT state FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED'",
              )
            ).rows[0].state,
            "UNKNOWN",
          );
          signerOutage = false;
          crashAfterPlan = true;
          await execution.handlers["keeper.finalize"]!({
            job: { id: "fixture", payload: {} } as never,
            signal,
          });
          const keeperIntent = (
            await t.pool.query(
              "SELECT id FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED'",
            )
          ).rows[0].id;
          const plan = (
            await t.pool.query(
              "SELECT p.* FROM signing.signing_plans p WHERE intent_id=$1",
              [keeperIntent],
            )
          ).rows[0];
          assert.ok(plan, "crash leaves a committed plan");
          assert.equal(
            (
              await t.pool.query(
                "SELECT id FROM signing.artifacts WHERE sign_request_id=$1",
                [plan.sign_request_id],
              )
            ).rows.length,
            0,
          );
          await call(anvil.accounts.admin, "finalizeUnchallenged", [1n]);
          await sync();
          crashAfterPlan = false;
          await t.pool.query(
            "UPDATE operations.jobs SET state='DEAD' WHERE type='keeper.finalize'",
          );
          await t.db.exec("SET blink.test_clock_offset_seconds='30'");
          await execution.tick();
          const recoveredKeeper = await queue.lease(
            "keeper-recovery",
            ["keeper.finalize"],
            60000,
          );
          assert.ok(
            recoveredKeeper,
            "periodic recovery includes allocated plans without artifacts",
          );
          await execution.handlers["keeper.finalize"]!({
            job: recoveredKeeper,
            signal,
          });
          assert.equal(await queue.complete(recoveredKeeper), true);
          await t.db.exec("SET blink.test_clock_offset_seconds='0'");
          assert.equal(
            (
              await t.pool.query(
                "SELECT state FROM signing.economic_intents WHERE id=$1",
                [keeperIntent],
              )
            ).rows[0].state,
            "SIGNED",
            "allocated work stays live and re-requests signing",
          );
          assert.equal(
            (
              await t.pool.query(
                "SELECT sign_request_id,nonce FROM signing.signing_plans WHERE intent_id=$1",
                [keeperIntent],
              )
            ).rows[0].sign_request_id,
            plan.sign_request_id,
          );
          await assert.rejects(
            execution.handlers["tx.dispatch"]!({
              job: {
                id: "fixture",
                payload: { intentId: keeperIntent },
              } as never,
              signal,
            }),
            /TX_PENDING/,
          );
          await sync();
          assert.equal(
            (
              await t.pool.query(
                "SELECT state,final_reason FROM chain.markets WHERE market_id=1",
              )
            ).rows[0].state,
            "FINAL",
          );
          assert.equal(
            (
              await t.pool.query(
                "SELECT final_reason FROM chain.markets WHERE market_id=1",
              )
            ).rows[0].final_reason,
            "UNCHALLENGED",
          );

          assert.equal(
            await finalDispatcher.dispatch(keeperIntent),
            "REVERTED",
          );
          assert.equal(
            (
              await t.pool.query(
                "SELECT state FROM signing.economic_intents WHERE id=$1",
                [keeperIntent],
              )
            ).rows[0].state,
            "FAILED",
          );
          assert.equal(
            BigInt(
              await anvil.publicClient.getTransactionCount({
                address: anvil.accounts.keeper.address,
              }),
            ),
            BigInt(plan.nonce) + 1n,
            "revert consumes the allocated nonce",
          );
          assert.equal(
            (
              await t.pool.query(
                "SELECT count(*)::int AS n FROM signing.nonce_allocations WHERE intent_id=$1",
                [keeperIntent],
              )
            ).rows[0].n,
            1,
          );
        },
      );

      // A signed unchallenged call can cross the hard deadline while pending. Its revert fails
      // that intent; a distinct, deduplicated timeout call finishes the market permissionlessly.
      const secondNow = (await anvil.publicClient.getBlock()).timestamp;
      const secondClose = secondNow + 1000n;
      const hardDeadline = secondNow + 4000n;
      await call(anvil.accounts.admin, "createMarket", [
        keccak256(toBytes("keeper timeout fixture")),
        "fixture://timeout",
        1,
        secondClose,
        secondNow + 2000n,
        hardDeadline,
        120,
        10000n,
        500n,
      ]);
      await anvil.setNextTimestamp(secondClose + 1n);
      await call(anvil.accounts.proposer, "proposeOutcome", [
        2n,
        0,
        keccak256(toBytes("timeout evidence")),
      ]);
      const secondMarket = (await anvil.publicClient.readContract({
        address: d.market,
        abi: blinkMarketAbi,
        functionName: "getMarket",
        args: [2n],
      })) as { proposedAt: bigint };
      await anvil.setNextTimestamp(secondMarket.proposedAt + 120n);
      await anvil.mine();
      await sync();
      await execution.handlers["keeper.finalize"]!({
        job: { id: "fixture", payload: {} } as never,
        signal,
      });
      const lateIntent = (
        await t.pool.query(
          "SELECT id FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED' AND payload->>'marketId'='2'",
        )
      ).rows[0].id;
      await anvil.publicClient.request({
        method: "anvil_setAutomine" as never,
        params: [false] as never,
      });
      await assert.rejects(
        execution.handlers["tx.dispatch"]!({
          job: { id: "fixture", payload: { intentId: lateIntent } } as never,
          signal,
        }),
        /TX_PENDING/,
      );
      await anvil.setNextTimestamp(hardDeadline);
      await anvil.mine();
      assert.equal(await finalDispatcher.dispatch(lateIntent), "REVERTED");
      assert.equal(
        (
          await t.pool.query(
            "SELECT state FROM signing.economic_intents WHERE id=$1",
            [lateIntent],
          )
        ).rows[0].state,
        "FAILED",
      );
      await anvil.publicClient.request({
        method: "anvil_setAutomine" as never,
        params: [true] as never,
      });
      await sync();
      await execution.handlers["keeper.finalize"]!({
        job: { id: "fixture", payload: {} } as never,
        signal,
      });
      const timeoutIntent = (
        await t.pool.query(
          "SELECT id FROM signing.economic_intents WHERE kind='FINALIZE_TIMEOUT' AND payload->>'marketId'='2'",
        )
      ).rows[0].id;
      assert.equal(await finalDispatcher.dispatch(timeoutIntent), "FINALIZED");
      await sync();
      assert.deepEqual(
        (
          await t.pool.query(
            "SELECT state,final_reason FROM chain.markets WHERE market_id=2",
          )
        ).rows[0],
        { state: "FINAL", final_reason: "TIMEOUT" },
      );

      // Sign a second wallet's mint against valid code, then make the token revert before broadcast.
      // The reverted receipt must fail its claim, with no rolling-window success timestamp.
      await call(anvil.accounts.admin, "setTakerAllowed", [
        anvil.accounts.taker2.address,
        true,
      ]);
      await sync();
      const secondAgent = await inviteAgent(t, {
        name: "reverted-faucet",
        scopes: ["faucet:claim"],
      });
      await bindWallet(t, secondAgent.agentId, anvil.accounts.taker2.address);
      const revertedClaim = (
        await faucetApi.inject({
          method: "POST",
          url: "/v1/faucet/claims",
          headers: {
            authorization: "Bearer " + secondAgent.apiKey,
            "idempotency-key": "reverted-mint",
          },
          payload: { deploymentId },
        })
      ).json();
      await execution.handlers["faucet.mint"]!({
        job: {
          id: "fixture",
          payload: { claimId: revertedClaim.claimId },
        } as never,
        signal,
      });
      const originalCode = await anvil.publicClient.getCode({
        address: d.token,
      });
      await anvil.publicClient.request({
        method: "anvil_setCode" as never,
        params: [d.token, "0x60006000fd"] as never,
      });
      await suite.test(
        "FAILED faucet claim recovers after ten failed settlement attempts",
        async () => {
          await recoverSettlement(
            revertedClaim.intentId,
            revertedClaim.claimId,
            "FAILED",
          );
          const afterFailure = await faucetApi.inject({
            method: "POST",
            url: "/v1/faucet/claims",
            headers: {
              authorization: "Bearer " + secondAgent.apiKey,
              "idempotency-key": "recovered-failure",
            },
            payload: { deploymentId },
          });
          assert.equal(afterFailure.statusCode, 202, afterFailure.body);
          assert.deepEqual(
            (
              await t.pool.query(
                "SELECT state,succeeded_at FROM faucet.claims WHERE id=$1",
                [revertedClaim.claimId],
              )
            ).rows[0],
            { state: "FAILED", succeeded_at: null },
          );
        },
      );
      await anvil.publicClient.request({
        method: "anvil_setCode" as never,
        params: [d.token, originalCode] as never,
      });

      // Keep the original successful unchallenged-finalization coverage as well as the nonce regression.
      const thirdNow = (await anvil.publicClient.getBlock()).timestamp;
      await call(anvil.accounts.admin, "createMarket", [
        keccak256(toBytes("keeper successful fixture")),
        "fixture://successful",
        1,
        thirdNow + 1000n,
        thirdNow + 2000n,
        thirdNow + 4000n,
        120,
        10000n,
        500n,
      ]);
      await anvil.setNextTimestamp(thirdNow + 1001n);
      await call(anvil.accounts.proposer, "proposeOutcome", [
        3n,
        0,
        keccak256(toBytes("successful evidence")),
      ]);
      const thirdMarket = (await anvil.publicClient.readContract({
        address: d.market,
        abi: blinkMarketAbi,
        functionName: "getMarket",
        args: [3n],
      })) as { proposedAt: bigint };
      await anvil.setNextTimestamp(thirdMarket.proposedAt + 120n);
      await anvil.mine();
      await sync();
      await execution.handlers["keeper.finalize"]!({
        job: { id: "fixture", payload: {} } as never,
        signal,
      });
      const successfulIntent = (
        await t.pool.query(
          "SELECT id FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED' AND payload->>'marketId'='3'",
        )
      ).rows[0].id;
      assert.equal(
        await finalDispatcher.dispatch(successfulIntent),
        "FINALIZED",
      );
      await sync();
      assert.deepEqual(
        (
          await t.pool.query(
            "SELECT state,final_reason FROM chain.markets WHERE market_id=3",
          )
        ).rows[0],
        { state: "FINAL", final_reason: "UNCHALLENGED" },
      );
    } finally {
      await api?.close();
      await server?.close();
      await t.close();
      await anvil.stop();
    }
  },
);
