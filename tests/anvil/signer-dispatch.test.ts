import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { type Hex } from "viem";
import { blinkTestUsdAbi } from "../../packages/adapters/src/blink-abi.js";
import { signerClient } from "../../packages/adapters/src/signer-client.js";
import { encodeAllowedCall } from "../../packages/adapters/src/signing-calldata.js";
import {
  postgresDispatchStore,
  postgresSignerStore,
} from "../../packages/adapters/src/signing-store.js";
import {
  viemDispatchRpc,
  viemSignerRpc,
} from "../../packages/adapters/src/signing-rpc.js";
import {
  createSignerService,
  createTxDispatcher,
} from "../../packages/application/src/index.js";
import type { SignerStore } from "../../packages/ports/src/index.js";
import { buildSignerServer } from "../../apps/signer/src/server.js";
import { createTestDatabase } from "../helpers/database.js";
import { deployBlink, startAnvil } from "../helpers/anvil.js";
import {
  prepareRequest,
  seedDeployment,
  sha256Hex,
} from "../helpers/signer-fixture.js";

const TOKEN = "anvil-worker-token";

// Anvil's default fee market (1 gwei base and 1 gwei tip) makes a mint cost about 0.00025 ETH, above
// the production 0.0002 ETH cap, so these tests lift the caps; the cap logic has its own tests.
const anvilPolicy = {
  l1FeeMode: "local-none" as const, // Anvil has no Base GasPriceOracle predeploy.
  perTxCapWei: 10n ** 16n,
  dailyCapWei: 10n ** 17n,
};

async function setup(options: { replaceAfterMs?: number } = {}) {
  const anvil = await startAnvil();
  const deployed = await deployBlink(anvil);
  const manifest = deployed.manifest;
  const t = await createTestDatabase();
  await seedDeployment(t.db, manifest);
  const signerRpc = viemSignerRpc({ url: anvil.url });
  const sendLog: Hex[] = [];
  const realDispatchRpc = viemDispatchRpc({ url: anvil.url });
  const faults = { send: false };
  const dispatchRpc = {
    ...realDispatchRpc,
    async sendRawTransaction(raw: Hex) {
      sendLog.push(raw);
      if (faults.send) throw new Error("RPC_UNAVAILABLE");
      return realDispatchRpc.sendRawTransaction(raw);
    },
  };
  const baseStore = postgresSignerStore(t.pool);
  const faultsSign = { crashAfterArtifact: false };
  const insertedHashes: Hex[] = [];
  const store: SignerStore = {
    loadDeployment: (id) => baseStore.loadDeployment(id),
    run: (work) =>
      baseStore.run((tx) =>
        work({
          ...tx,
          async insertArtifact(input) {
            insertedHashes.push(input.artifactHash);
            await tx.insertArtifact(input);
          },
          async markSigned(signRequestId, intentId) {
            // The process dies after signing and persisting, before the transaction commits.
            if (faultsSign.crashAfterArtifact)
              throw new Error("CRASH_AFTER_SIGN");
            await tx.markSigned(signRequestId, intentId);
          },
        }),
      ),
  };
  const service = createSignerService({
    store,
    keys: {
      maker: anvil.accounts.maker,
      faucet: anvil.accounts.minter,
      keeper: anvil.accounts.keeper,
      trader: anvil.accounts.trader,
    },
    rpc: signerRpc,
    deployment: manifest,
    callers: [
      {
        name: "worker",
        tokenSha256: sha256Hex(TOKEN),
        roles: ["faucet", "keeper", "trader"],
      },
    ],
    policy: anvilPolicy,
    encodeCall: encodeAllowedCall,
  });
  const server = buildSignerServer(service);
  await server.listen({ port: 0, host: "127.0.0.1" });
  const signerUrl =
    "http://127.0.0.1:" + (server.server.address() as AddressInfo).port;
  const signer = signerClient({ url: signerUrl, token: TOKEN });
  const dispatcher = createTxDispatcher({
    store: postgresDispatchStore(t.pool),
    rpc: dispatchRpc,
    signer,
    replaceAfterMs: options.replaceAfterMs ?? 60_000,
  });
  const client = t.pool as unknown as Parameters<typeof prepareRequest>[0];
  const mintIntent = (amount = 1_000_000_000n) =>
    prepareRequest(client, manifest, {
      kind: "MINT",
      payload: {
        to: deployed.token,
        functionName: "mint",
        args: [anvil.accounts.taker.address, amount.toString()],
      },
    });
  const balance = () =>
    anvil.publicClient.readContract({
      address: deployed.token,
      abi: blinkTestUsdAbi,
      functionName: "balanceOf",
      args: [anvil.accounts.taker.address],
    });
  const rows = async (sql: string, params?: unknown[]) =>
    (await t.db.query(sql, params)).rows as Record<string, unknown>[];
  return {
    anvil,
    deployed,
    manifest,
    t,
    signer,
    dispatcher,
    mintIntent,
    balance,
    rows,
    sendLog,
    faults,
    faultsSign,
    insertedHashes,
    signerUrl,
    async close() {
      await server.close();
      await t.close();
      await anvil.stop();
    },
  };
}

test(
  "a faucet MINT intent is signed, dispatched and INCLUDED, and the balance is +1000 bUSD",
  { timeout: 60000 },
  async () => {
    const h = await setup();
    try {
      const intent = await h.mintIntent();
      assert.equal(await h.balance(), 0n);
      // The dispatcher asks the signer (over HTTP, with the bearer token) and broadcasts the artifact.
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      assert.equal(await h.balance(), 1_000_000_000n);

      const [attempt] = await h.rows(
        `SELECT status, nonce::int AS nonce, '0x' || encode(tx_hash, 'hex') AS tx_hash, gas_spent_wei::text AS spent,
        max_cost_wei::text AS max_cost, receipt_block_number::int AS block FROM signing.tx_attempts`,
      );
      assert.equal(attempt!.status, "INCLUDED");
      assert.equal(attempt!.nonce, 0);
      const receipt = await h.anvil.publicClient.getTransactionReceipt({
        hash: attempt!.tx_hash as Hex,
      });
      assert.equal(receipt.status, "success");
      assert.equal(
        receipt.from.toLowerCase(),
        h.anvil.accounts.minter.address.toLowerCase(),
      );
      assert.equal(
        BigInt(attempt!.spent as string),
        receipt.gasUsed * receipt.effectiveGasPrice,
      );
      assert.equal(attempt!.block, Number(receipt.blockNumber));
      // The reservation moved into spent, once.
      const [gas] = await h.rows(
        "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend WHERE role = 'faucet'",
      );
      assert.deepEqual(gas, { reserved: "0", spent: attempt!.spent });
      assert.equal(
        (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
        "INCLUDED",
      );

      // Dispatching again is a no-op: no new transaction, signature, nonce or block.
      const head = await h.anvil.publicClient.getBlockNumber();
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      assert.equal(h.sendLog.length, 1);
      assert.equal(await h.anvil.publicClient.getBlockNumber(), head);
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.tx_attempts")).length,
        1,
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
        1,
      );
      assert.equal(await h.balance(), 1_000_000_000n);
    } finally {
      await h.close();
    }
  },
);

test(
  "crash simulation: sign, roll back the persistence, sign again gives the same tx hash and nonce",
  { timeout: 60000 },
  async () => {
    const h = await setup();
    try {
      const intent = await h.mintIntent();
      h.faultsSign.crashAfterArtifact = true;
      const lost = await h.signer.sign({
        signRequestId: intent.signRequestId,
        expectedRequestHash: intent.requestHash,
      });
      assert.deepEqual(lost, { state: "UNKNOWN", code: "SIGNER_ERROR" });
      assert.equal(
        h.insertedHashes.length,
        1,
        "a signature existed in the dying process",
      );
      // Nothing committed: no artifact, no nonce, no reservation, request still open.
      assert.equal((await h.rows("SELECT 1 FROM signing.artifacts")).length, 0);
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
        0,
      );
      assert.equal(
        Number(
          (
            await h.rows(
              "SELECT coalesce(sum(reserved_wei), 0)::int AS n FROM signing.gas_spend",
            )
          )[0]!.n,
        ),
        0,
      );
      assert.equal(
        (await h.rows("SELECT state FROM signing.sign_requests"))[0]!.state,
        "REQUESTED",
      );

      h.faultsSign.crashAfterArtifact = false;
      const again = await h.signer.sign({
        signRequestId: intent.signRequestId,
        expectedRequestHash: intent.requestHash,
      });
      assert.equal(again.state, "SIGNED");
      if (again.state !== "SIGNED") return;
      assert.equal(
        again.txHash,
        h.insertedHashes[0],
        "re-signing is deterministic: the same tx hash",
      );
      assert.equal(h.insertedHashes[1], h.insertedHashes[0]);
      assert.equal(
        Number(
          (
            await h.rows(
              "SELECT nonce::int AS nonce FROM signing.nonce_allocations",
            )
          )[0]!.nonce,
        ),
        0,
      );

      // And the persisted artifact is what gets mined, exactly once.
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      const [attempt] = await h.rows(
        "SELECT '0x' || encode(tx_hash, 'hex') AS tx_hash FROM signing.tx_attempts",
      );
      assert.equal(attempt!.tx_hash, again.txHash);
      assert.equal(await h.balance(), 1_000_000_000n);
    } finally {
      await h.close();
    }
  },
);

test(
  "a replacement keeps the nonce and raises fees; only one version is included and the other is REPLACED",
  { timeout: 60000 },
  async () => {
    const h = await setup({ replaceAfterMs: 30_000 });
    try {
      const intent = await h.mintIntent();
      await h.anvil.publicClient.request({
        method: "evm_setAutomine" as never,
        params: [false] as never,
      });
      // v1 is signed and broadcast but nothing mines it.
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
      assert.equal(
        await h.dispatcher.dispatch(intent.intentId),
        "PENDING",
        "not yet old enough to replace",
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.tx_attempts")).length,
        1,
      );

      // The business clock moves past replaceAfterMs; the dispatcher asks for a higher-fee version.
      await h.t.db.exec("SET blink.test_clock_offset_seconds = '120'");
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "SUBMITTED");
      const attempts = await h.rows(
        `SELECT id, status, nonce::int AS nonce, max_fee_per_gas::text AS max_fee, max_priority_fee_per_gas::text AS priority,
        gas_limit::text AS gas_limit, replacement_of FROM signing.tx_attempts ORDER BY created_at`,
      );
      assert.equal(attempts.length, 2);
      const [v1, v2] = attempts as [
        Record<string, string | number>,
        Record<string, string | number>,
      ];
      assert.equal(v2.nonce, v1.nonce, "same nonce");
      assert.equal(v2.replacement_of, v1.id);
      assert.equal(v2.gas_limit, v1.gas_limit);
      assert.ok(
        BigInt(v2.max_fee as string) * 1000n >=
          BigInt(v1.max_fee as string) * 1125n,
      );
      assert.ok(
        BigInt(v2.priority as string) * 1000n >=
          BigInt(v1.priority as string) * 1125n,
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
        1,
        "never a new nonce",
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.economic_intents")).length,
        1,
        "never a new intent",
      );

      // Mining includes only the replacement; the original can never be mined.
      await h.anvil.mine(1);
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      const after = await h.rows(
        "SELECT status, gas_spent_wei::text AS spent FROM signing.tx_attempts ORDER BY created_at",
      );
      assert.deepEqual(
        after.map((a) => a.status),
        ["REPLACED", "INCLUDED"],
      );
      assert.equal(after[0]!.spent, "0");
      assert.equal(await h.balance(), 1_000_000_000n, "the mint happened once");
      assert.equal(
        await h.anvil.publicClient.getTransactionCount({
          address: h.anvil.accounts.minter.address,
        }),
        1,
      );
      // Both reservations are released; only the included version's real cost is spent.
      const [gas] = await h.rows(
        "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend WHERE role = 'faucet'",
      );
      assert.deepEqual(gas, { reserved: "0", spent: after[1]!.spent });
    } finally {
      await h.close();
    }
  },
);

test(
  "a reorg after inclusion is REORGED, the same bytes are rebroadcast, and the intent is INCLUDED again",
  { timeout: 60000 },
  async () => {
    const h = await setup();
    try {
      const intent = await h.mintIntent();
      const snapshot = await h.anvil.snapshot();
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      const [first] = await h.rows(
        "SELECT '0x' || encode(receipt_block_hash, 'hex') AS block, '0x' || encode(tx_hash, 'hex') AS hash FROM signing.tx_attempts",
      );
      assert.equal(await h.balance(), 1_000_000_000n);

      await h.anvil.revert(snapshot);
      assert.equal(await h.balance(), 0n);
      // With the broadcast failing, the dispatcher still records that the block is gone.
      h.faults.send = true;
      await assert.rejects(
        h.dispatcher.dispatch(intent.intentId),
        /RPC_UNAVAILABLE/,
      );
      assert.equal(
        (await h.rows("SELECT status FROM signing.tx_attempts"))[0]!.status,
        "REORGED",
      );
      assert.equal(
        (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
        "SUBMITTED",
      );

      h.faults.send = false;
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      assert.equal(await h.balance(), 1_000_000_000n);
      const [second] = await h.rows(
        "SELECT status, '0x' || encode(receipt_block_hash, 'hex') AS block, '0x' || encode(tx_hash, 'hex') AS hash FROM signing.tx_attempts",
      );
      assert.equal(second!.status, "INCLUDED");
      assert.equal(
        second!.hash,
        first!.hash,
        "the same transaction was re-included",
      );
      assert.notEqual(second!.block, first!.block, "in a different block");
      assert.equal(h.sendLog.length, 3);
      assert.equal(
        h.sendLog[2],
        h.sendLog[0],
        "rebroadcast the same raw bytes",
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.tx_attempts")).length,
        1,
      );
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
        1,
      );
      // The reorged inclusion was already counted once; re-inclusion does not double count.
      const [gas] = await h.rows(
        "SELECT reserved_wei::text AS reserved, spent_wei::text AS spent FROM signing.gas_spend",
      );
      assert.equal(gas!.reserved, "0");
      assert.equal(BigInt(gas!.spent as string) > 0n, true);
    } finally {
      await h.close();
    }
  },
);

test(
  "a transaction that is already in the pool is UNKNOWN, never re-nonced, and is found once mined",
  { timeout: 60000 },
  async () => {
    const h = await setup();
    try {
      const intent = await h.mintIntent();
      await h.anvil.publicClient.request({
        method: "evm_setAutomine" as never,
        params: [false] as never,
      });
      // The signer signs, then a previous dispatcher run broadcasts and dies before recording it.
      const signed = await h.signer.sign({
        signRequestId: intent.signRequestId,
        expectedRequestHash: intent.requestHash,
      });
      assert.equal(signed.state, "SIGNED");
      const raw = (
        await h.rows("SELECT raw_transaction FROM signing.artifacts")
      )[0]!.raw_transaction as Hex;
      assert.equal(
        (await viemDispatchRpc({ url: h.anvil.url }).sendRawTransaction(raw))
          .state,
        "ACCEPTED",
      );

      assert.equal(await h.dispatcher.dispatch(intent.intentId), "UNKNOWN");
      assert.equal(
        (await h.rows("SELECT status FROM signing.tx_attempts"))[0]!.status,
        "UNKNOWN",
      );
      assert.equal(
        (await h.rows("SELECT state FROM signing.economic_intents"))[0]!.state,
        "UNKNOWN",
      );
      // A restarted dispatcher does the same thing: no new nonce, intent, attempt or signature.
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "UNKNOWN");
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.tx_attempts")).length,
        1,
      );
      assert.equal((await h.rows("SELECT 1 FROM signing.artifacts")).length, 1);
      assert.equal(
        (await h.rows("SELECT 1 FROM signing.nonce_allocations")).length,
        1,
      );

      await h.anvil.mine(1);
      assert.equal(await h.dispatcher.dispatch(intent.intentId), "INCLUDED");
      assert.equal(await h.balance(), 1_000_000_000n);
    } finally {
      await h.close();
    }
  },
);

test(
  "the HTTP signer client treats an unreachable signer as UNKNOWN and a bad token as REJECTED",
  { timeout: 60000 },
  async () => {
    const h = await setup();
    try {
      const intent = await h.mintIntent();
      const stranger = signerClient({
        url: "http://127.0.0.1:1",
        token: "x",
        timeoutMs: 500,
      });
      // Nothing listens there: a network error is UNKNOWN, never REJECTED.
      assert.deepEqual(
        await stranger.sign({
          signRequestId: intent.signRequestId,
          expectedRequestHash: intent.requestHash,
        }),
        { state: "UNKNOWN", code: "SIGNER_TIMEOUT" },
      );
      const wrongToken = signerClient({ url: h.signerUrl, token: "wrong" });
      assert.deepEqual(
        await wrongToken.sign({
          signRequestId: intent.signRequestId,
          expectedRequestHash: intent.requestHash,
        }),
        { state: "REJECTED", code: "UNAUTHORIZED" },
      );
      assert.equal((await h.rows("SELECT 1 FROM signing.artifacts")).length, 0);
    } finally {
      await h.close();
    }
  },
);
