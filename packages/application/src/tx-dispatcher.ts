import { randomUUID } from "node:crypto";
import { keccak256, parseTransaction } from "viem";
import { SIGNING_POLICY_VERSION } from "@blink/domain";
import type {
  ArtifactRecord,
  AttemptPatch,
  AttemptRecord,
  DispatchReceipt,
  DispatchRpc,
  DispatchSnapshot,
  DispatchStore,
  IntentState,
  RestrictedSigner,
  SignRequestRecord,
} from "@blink/ports";
import { transactionRequestHash } from "./signer.js";

export type DispatchResult =
  "SUBMITTED" | "INCLUDED" | "FINALIZED" | "REVERTED" | "UNKNOWN" | "PENDING";

export class TxDispatchError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
  }
}

// Structural type of a Task 2 job handler; wired into apps/worker once the job runtime merges.
export type TxDispatchHandler = (ctx: {
  job: { id: string; payload: Record<string, unknown> };
  signal: AbortSignal;
}) => Promise<void>;

type Status = AttemptRecord["status"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PASSES = 6;
// Attempts the dispatcher keeps looking at. REPLACED stays watched: after a reorg the other
// version may be the one that gets mined. FINALIZED and REVERTED are settled and never revisited.
const WATCHED: Status[] = [
  "SIGNED",
  "SUBMITTED",
  "UNKNOWN",
  "INCLUDED",
  "REORGED",
  "REPLACED",
];
const bump = (value: bigint) => (value * 1125n + 999n) / 1000n;

/**
 * Broadcasts only persisted artifacts and tracks them to a receipt. It never allocates a nonce:
 * every transaction of an intent shares the one nonce the signer allocated, and a replacement is
 * a new signed version of the same call with higher fees, requested from the signer.
 */
export function createTxDispatcher(deps: {
  store: DispatchStore;
  rpc: DispatchRpc;
  signer: RestrictedSigner;
  replaceAfterMs?: number;
}) {
  const { store, rpc, signer } = deps;
  const replaceAfterMs = deps.replaceAfterMs ?? 60_000;

  async function failFirstVersion(
    intentId: string,
    code: string,
  ): Promise<never> {
    await store.run((tx) => tx.setIntentState(intentId, "FAILED"));
    throw new TxDispatchError("SIGN_REJECTED:" + code, false);
  }

  // The signer is idempotent per sign request, so asking again after a timeout is always safe.
  const askSigner = (request: SignRequestRecord) =>
    signer.sign({
      signRequestId: request.id,
      expectedRequestHash: request.requestHash,
    });

  function describe(artifact: ArtifactRecord) {
    if (!artifact.rawTransaction || artifact.maxCostWei === null)
      throw new TxDispatchError("ARTIFACT_NOT_A_TRANSACTION", false);
    if (
      keccak256(artifact.rawTransaction) !== artifact.artifactHash.toLowerCase()
    )
      throw new TxDispatchError("ARTIFACT_HASH_MISMATCH", false);
    const tx = parseTransaction(artifact.rawTransaction);
    if (
      tx.type !== "eip1559" ||
      tx.nonce === undefined ||
      !tx.gas ||
      !tx.maxFeePerGas ||
      !tx.maxPriorityFeePerGas
    )
      throw new TxDispatchError("ARTIFACT_NOT_EIP1559", false);
    return {
      nonce: BigInt(tx.nonce),
      gasLimit: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxCostWei: artifact.maxCostWei,
    };
  }

  // One attempt row per artifact, in version order, before anything is broadcast.
  async function ensureAttempts(snap: DispatchSnapshot) {
    const attemptOf = new Map(snap.attempts.map((a) => [a.artifactId, a.id]));
    if (snap.artifacts.every((a) => attemptOf.has(a.id))) return false;
    await store.run(async (tx) => {
      let previous: string | null = null;
      for (const artifact of snap.artifacts) {
        const existing = attemptOf.get(artifact.id);
        if (existing) {
          previous = existing;
          continue;
        }
        const info = describe(artifact);
        const id = randomUUID();
        await tx.insertAttempt({
          id,
          intentId: snap.intent.id,
          artifactId: artifact.id,
          txHash: artifact.artifactHash,
          replacementOf: previous,
          ...info,
        });
        previous = id;
      }
    });
    return true;
  }

  // Looks at every watched attempt's receipt and records what the canonical chain says.
  // Returns true when anything was written, so the caller reloads before deciding more.
  async function observe(snap: DispatchSnapshot): Promise<boolean> {
    const watched = snap.attempts.filter((a) => WATCHED.includes(a.status));
    const receipts = new Map<string, DispatchReceipt | null>();
    let finalized: bigint | null | undefined;
    for (const attempt of watched) {
      const receipt = await rpc.getReceipt(attempt.txHash);
      // A receipt counts only while its block is still the canonical block at that height.
      const canonical =
        receipt !== null &&
        (await rpc.blockHashAt(receipt.blockNumber))?.toLowerCase() ===
          receipt.blockHash.toLowerCase();
      receipts.set(attempt.id, canonical ? receipt : null);
      if (canonical && finalized === undefined)
        finalized = await rpc.finalizedBlockNumber();
    }
    const settled = snap.attempts.find(
      (a) => a.status === "FINALIZED" || a.status === "REVERTED",
    );
    const mined = watched.find((a) => receipts.get(a.id));
    const decided = settled ?? mined;

    type Change = {
      attempt: AttemptRecord;
      status: Status;
      patch: AttemptPatch;
      spent: bigint | null;
    };
    const changes: Change[] = [];
    for (const attempt of watched) {
      const receipt = receipts.get(attempt.id) ?? null;
      const unsettled = attempt.gasSpentWei === null;
      if (receipt) {
        const status: Status =
          receipt.status === "reverted"
            ? "REVERTED"
            : finalized != null && receipt.blockNumber <= finalized
              ? "FINALIZED"
              : "INCLUDED";
        if (
          attempt.status !== status ||
          attempt.receiptBlockHash?.toLowerCase() !==
            receipt.blockHash.toLowerCase()
        )
          changes.push({
            attempt,
            status,
            spent: unsettled ? receipt.gasSpentWei : null,
            patch: {
              status,
              receiptBlockHash: receipt.blockHash,
              receiptBlockNumber: receipt.blockNumber,
              ...(unsettled ? { gasSpentWei: receipt.gasSpentWei } : {}),
            },
          });
      } else if (decided) {
        // Same nonce as the decided version: this one can no longer be mined.
        if (attempt.status !== "REPLACED")
          changes.push({
            attempt,
            status: "REPLACED",
            spent: unsettled ? 0n : null,
            patch: {
              status: "REPLACED",
              ...(unsettled ? { gasSpentWei: 0n } : {}),
            },
          });
      } else if (attempt.status === "INCLUDED") {
        // The block that held it is gone; its bytes are rebroadcast unchanged.
        changes.push({
          attempt,
          status: "REORGED",
          spent: null,
          patch: { status: "REORGED" },
        });
      }
    }
    if (!changes.length) return false;

    const finalStatus = (a: AttemptRecord): Status =>
      changes.find((c) => c.attempt.id === a.id)?.status ?? a.status;
    await store.run(async (tx) => {
      for (const change of changes) {
        // A false result means another dispatcher already moved it; the next pass re-reads.
        if (
          !(await tx.updateAttempt(
            change.attempt.id,
            change.attempt.version,
            change.patch,
          ))
        )
          continue;
        if (change.spent !== null)
          await tx.settleGas(
            change.attempt.artifactId,
            change.attempt.maxCostWei,
            change.spent,
          );
      }
      const next = intentStateFor(
        snap.attempts.map((a) => ({ id: a.id, status: finalStatus(a) })),
      );
      if (next && next !== snap.intent.state)
        await tx.setIntentState(snap.intent.id, next);
    });
    return true;
  }

  function intentStateFor(
    attempts: { id: string; status: Status }[],
  ): IntentState | null {
    const decided =
      attempts.find(
        (a) => a.status === "FINALIZED" || a.status === "REVERTED",
      ) ?? attempts.find((a) => a.status === "INCLUDED");
    if (decided)
      return decided.status === "FINALIZED"
        ? "FINALIZED"
        : decided.status === "REVERTED"
          ? "FAILED"
          : "INCLUDED";
    const latest = attempts.at(-1);
    if (latest?.status === "UNKNOWN") return "UNKNOWN";
    if (latest?.status === "SUBMITTED" || latest?.status === "REORGED")
      return "SUBMITTED";
    return null;
  }

  async function dispatch(
    intentId: string,
    signal?: AbortSignal,
  ): Promise<DispatchResult> {
    let broadcast = false;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      if (signal?.aborted) throw new TxDispatchError("DISPATCH_ABORTED", true);
      const snap = await store.run((tx) => tx.snapshot(intentId));
      if (!snap) throw new TxDispatchError("INTENT_NOT_FOUND", false);
      const { intent } = snap;
      if (intent.kind === "MAKER_QUOTE" || intent.state === "CANCELLED")
        throw new TxDispatchError("INTENT_NOT_DISPATCHABLE", false);
      if (intent.state === "FINALIZED") return "FINALIZED";
      if (intent.state === "FAILED") {
        if (snap.attempts.some((a) => a.status === "REVERTED"))
          return "REVERTED";
        throw new TxDispatchError("INTENT_NOT_DISPATCHABLE", false);
      }

      // 1. Nothing signed yet: ask the signer for the first version.
      if (!snap.artifacts.length) {
        const first = snap.signRequests.find((r) => r.artifactVersion === 1);
        if (!first) return "PENDING";
        if (first.state === "REJECTED")
          return failFirstVersion(intent.id, first.rejectCode ?? "REJECTED");
        const result = await askSigner(first);
        if (result.state === "UNKNOWN") return "UNKNOWN";
        if (result.state === "REJECTED")
          return failFirstVersion(intent.id, result.code);
        continue;
      }
      // 2. A replacement was requested but not yet signed (signer outage or crash): finish it.
      const versions = snap.artifacts.length;
      const outstanding = snap.signRequests.find(
        (r) => r.artifactVersion > versions && r.state === "REQUESTED",
      );
      if (outstanding) {
        const result = await askSigner(outstanding);
        if (result.state === "UNKNOWN") return "UNKNOWN";
        if (result.state === "SIGNED") continue;
        // A refused replacement leaves the live version in place; no further replacement is tried.
      }
      // 3. Every artifact gets its attempt row before it is sent.
      if (await ensureAttempts(snap)) continue;

      // 4. Record what the chain says about every version.
      if (await observe(snap)) continue;
      const decided = snap.attempts.find(
        (a) =>
          a.status === "INCLUDED" ||
          a.status === "FINALIZED" ||
          a.status === "REVERTED",
      );
      if (decided)
        return decided.status === "REVERTED"
          ? "REVERTED"
          : decided.status === "FINALIZED"
            ? "FINALIZED"
            : "INCLUDED";

      // 5. Nothing is mined: (re)send the newest version if it was never sent or was reorged out.
      const latest = snap.attempts.at(-1)!;
      if (latest.status === "SIGNED" || latest.status === "REORGED") {
        const artifact = snap.artifacts.find(
          (a) => a.id === latest.artifactId,
        )!;
        let sent;
        try {
          sent = await rpc.sendRawTransaction(artifact.rawTransaction!);
        } catch (error) {
          // The attempt stays SIGNED/REORGED, so the next run sends the same bytes again.
          throw new TxDispatchError(
            error instanceof Error && error.message === "RPC_UNAVAILABLE"
              ? "RPC_UNAVAILABLE"
              : "BROADCAST_FAILED",
            true,
          );
        }
        if (sent.state === "ACCEPTED") {
          if (sent.hash.toLowerCase() !== latest.txHash.toLowerCase())
            throw new TxDispatchError("TX_HASH_MISMATCH", false);
          await store.run(async (tx) => {
            if (
              await tx.updateAttempt(latest.id, latest.version, {
                status: "SUBMITTED",
                submittedAt: "now",
              })
            )
              await tx.setIntentState(intentId, "SUBMITTED");
          });
          broadcast = true;
        } else {
          // Already known or nonce too low is not a failure: it may be this very transaction,
          // so the next pass looks its hash up instead of guessing.
          await store.run(async (tx) => {
            if (
              await tx.updateAttempt(latest.id, latest.version, {
                status: "UNKNOWN",
                submittedAt: "now",
              })
            )
              await tx.setIntentState(intentId, "UNKNOWN");
          });
        }
        continue;
      }

      // 6. Unmined for too long: request a higher-fee version of the same call.
      const waitedMs = latest.submittedAt
        ? snap.now.getTime() - latest.submittedAt.getTime()
        : 0;
      const blocked = snap.signRequests.some(
        (r) => r.artifactVersion > versions,
      );
      const base = snap.signRequests.find((r) => r.artifactVersion === 1);
      if (!blocked && base && waitedMs >= replaceAfterMs) {
        const payload = {
          ...base.unsignedPayload,
          maxFeePerGas: bump(latest.maxFeePerGas).toString(),
          maxPriorityFeePerGas: bump(latest.maxPriorityFeePerGas).toString(),
        };
        const requestHash = transactionRequestHash(payload);
        const { signRequestId } = await store.run((tx) =>
          tx.createSignRequest({
            intentId,
            role: base.role,
            unsignedPayload: payload,
            requestHash,
            policyVersion: SIGNING_POLICY_VERSION,
            artifactVersion: versions + 1,
          }),
        );
        // The signer enforces the gas caps; a rejection simply leaves the current version live.
        const result = await signer.sign({
          signRequestId,
          expectedRequestHash: requestHash,
        });
        if (result.state === "SIGNED") continue;
      }
      if (broadcast) return "SUBMITTED";
      return latest.status === "UNKNOWN" ? "UNKNOWN" : "PENDING";
    }
    return broadcast ? "SUBMITTED" : "PENDING";
  }

  return { dispatch };
}

/** The `tx.dispatch` job handler: payload `{intentId}`; retries until the transaction is final. */
export function createTxDispatchHandler(dispatcher: {
  dispatch(intentId: string, signal?: AbortSignal): Promise<DispatchResult>;
}): TxDispatchHandler {
  return async ({ job, signal }) => {
    const intentId = job.payload.intentId;
    if (typeof intentId !== "string" || !UUID.test(intentId))
      throw new TxDispatchError("INVALID_JOB_PAYLOAD", false);
    const result = await dispatcher.dispatch(intentId, signal);
    if (result === "FINALIZED" || result === "REVERTED") return;
    // INCLUDED is not final: keep watching for a reorg until the block is finalized.
    throw new TxDispatchError("TX_PENDING", true);
  };
}
