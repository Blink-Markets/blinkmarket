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
  async () => {
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
      server = buildSignerServer(
        createSignerService({
          store: postgresSignerStore(t.pool),
          deployment: d.manifest,
          keys: {
            faucet: anvil.accounts.minter,
            keeper: anvil.accounts.keeper,
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
      const claim = await api.inject({
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
      const pending = await api.inject({
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
      assert.equal(await finalDispatcher.dispatch(intentId), "FINALIZED");

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
      await execution.tick();
      assert.equal(
        (
          await t.pool.query(
            "SELECT id FROM operations.jobs WHERE type='keeper.finalize'",
          )
        ).rows.length,
        1,
      );
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
      await execution.handlers["keeper.finalize"]!({
        job: { id: "fixture", payload: {} } as never,
        signal,
      });
      const keeperIntent = (
        await t.pool.query(
          "SELECT id FROM signing.economic_intents WHERE kind='FINALIZE_UNCHALLENGED'",
        )
      ).rows[0].id;
      await assert.rejects(
        execution.handlers["tx.dispatch"]!({
          job: { id: "fixture", payload: { intentId: keeperIntent } } as never,
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
        await api.inject({
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
      assert.equal(
        await finalDispatcher.dispatch(revertedClaim.intentId),
        "REVERTED",
      );
      assert.deepEqual(
        (
          await t.pool.query(
            "SELECT state,succeeded_at FROM faucet.claims WHERE id=$1",
            [revertedClaim.claimId],
          )
        ).rows[0],
        { state: "FAILED", succeeded_at: null },
      );
      await anvil.publicClient.request({
        method: "anvil_setCode" as never,
        params: [d.token, originalCode] as never,
      });
    } finally {
      await api?.close();
      await server?.close();
      await t.close();
      await anvil.stop();
    }
  },
);
