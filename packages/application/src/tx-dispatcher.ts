import { randomUUID } from "node:crypto";
import { keccak256 } from "viem";
import { minimumReplacementFees, SIGNING_POLICY_VERSION } from "@blink/domain";
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
  SignResult,
} from "@blink/ports";
import { decodeEip1559, transactionRequestHash } from "./signer.js";

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
const MAX_PASSES = 8;
// Attempts the dispatcher keeps looking at. REPLACED stays watched: after a reorg the other
// version may be the one that gets mined. FINALIZED and REVERTED are final and never revisited;
// a revert that is not yet final is INCLUDED (receipt status "reverted") and still watched.
const WATCHED: Status[] = [
  "SIGNED",
  "SUBMITTED",
  "UNKNOWN",
  "INCLUDED",
  "REORGED",
  "REPLACED",
];

type Change = { attempt: AttemptRecord; patch: AttemptPatch };

// The intent follows its attempts: final outcomes first, then a mined version, then the newest
// version that is still in play. Only states that were actually persisted are passed in.
function intentStateFor(attempts: { status: Status }[]): IntentState | null {
  const final = attempts.find(
    (a) => a.status === "FINALIZED" || a.status === "REVERTED",
  );
  if (final) return final.status === "FINALIZED" ? "FINALIZED" : "FAILED";
  if (attempts.some((a) => a.status === "INCLUDED")) return "INCLUDED";
  const latest = attempts.filter((a) => a.status !== "REPLACED").at(-1);
  if (latest?.status === "UNKNOWN") return "UNKNOWN";
  if (latest?.status === "SUBMITTED" || latest?.status === "REORGED")
    return "SUBMITTED";
  return null;
}

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
  async function askSigner(request: {
    id: string;
    requestHash: string;
  }): Promise<SignResult> {
    try {
      return await signer.sign({
        signRequestId: request.id,
        expectedRequestHash: request.requestHash,
      });
    } catch {
      return { state: "UNKNOWN", code: "SIGNER_ERROR" };
    }
  }

  function describe(artifact: ArtifactRecord) {
    if (!artifact.rawTransaction || artifact.maxCostWei === null)
      throw new TxDispatchError("ARTIFACT_NOT_A_TRANSACTION", false);
    if (
      keccak256(artifact.rawTransaction) !== artifact.artifactHash.toLowerCase()
    )
      throw new TxDispatchError("ARTIFACT_HASH_MISMATCH", false);
    const tx = decodeEip1559(artifact.rawTransaction);
    if (!tx) throw new TxDispatchError("ARTIFACT_NOT_EIP1559", false);
    return {
      nonce: tx.nonce,
      gasLimit: tx.gas,
      maxFeePerGas: tx.maxFeePerGas,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
      maxCostWei: artifact.maxCostWei,
    };
  }

  // One attempt row per artifact, in version order, before anything is sent. A new attempt holds
  // exactly the reservation the signer made for its artifact.
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
        const id = randomUUID();
        await tx.insertAttempt({
          id,
          intentId: snap.intent.id,
          artifactId: artifact.id,
          txHash: artifact.artifactHash,
          replacementOf: previous,
          ...describe(artifact),
        });
        previous = id;
      }
    });
    return true;
  }

  // Writes attempt changes and the intent state they imply in one transaction that holds the
  // intent lock. If any attempt moved since the caller read it, nothing is written and the caller
  // reloads: a stale observer can neither win a race nor overwrite a newer intent state.
  async function commit(snap: DispatchSnapshot, changes: Change[]) {
    return store.run(async (tx) => {
      const fresh = await tx.snapshot(snap.intent.id);
      if (!fresh) return false;
      const current = new Map(fresh.attempts.map((a) => [a.id, a]));
      if (
        changes.some(
          (c) => current.get(c.attempt.id)?.version !== c.attempt.version,
        )
      )
        return false;
      for (const { attempt, patch } of changes) {
        if (!(await tx.updateAttempt(attempt.id, attempt.version, patch)))
          throw new TxDispatchError("ATTEMPT_UPDATE_CONFLICT", true);
        // Idempotent ledger deltas: only the difference from what the attempt already holds.
        await tx.applyGasDelta(
          attempt.artifactId,
          (patch.gasReservedWei ?? attempt.gasReservedWei) -
            attempt.gasReservedWei,
          (patch.gasSpentWei ?? attempt.gasSpentWei) - attempt.gasSpentWei,
        );
      }
      const next = intentStateFor(
        fresh.attempts.map((a) => ({
          status:
            changes.find((c) => c.attempt.id === a.id)?.patch.status ??
            a.status,
        })),
      );
      if (next && next !== fresh.intent.state)
        await tx.setIntentState(snap.intent.id, next);
      return true;
    });
  }

  // Looks at every watched attempt's receipt and moves each attempt, and its gas ledger share, to
  // what the canonical chain says now. Returns true when it wrote anything or lost a race, so the
  // caller reloads before deciding more.
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
    const final = snap.attempts.find(
      (a) => a.status === "FINALIZED" || a.status === "REVERTED",
    );
    const decided = final ?? watched.find((a) => receipts.get(a.id));

    const changes: Change[] = [];
    for (const attempt of watched) {
      const receipt = receipts.get(attempt.id) ?? null;
      let patch: AttemptPatch | null = null;
      if (receipt) {
        // Final only once the provider says so; a revert is not FAILED before that.
        const isFinal = finalized != null && receipt.blockNumber <= finalized;
        const status: Status = !isFinal
          ? "INCLUDED"
          : receipt.status === "reverted"
            ? "REVERTED"
            : "FINALIZED";
        patch = {
          status,
          receiptBlockHash: receipt.blockHash,
          receiptBlockNumber: receipt.blockNumber,
          receiptStatus: receipt.status,
          gasReservedWei: 0n,
          gasSpentWei: receipt.gasSpentWei,
        };
      } else if (decided) {
        // Another version holds the nonce: this one can no longer be mined.
        patch = { status: "REPLACED", gasReservedWei: 0n, gasSpentWei: 0n };
      } else if (attempt.status === "INCLUDED") {
        // The block that held it is gone. Its spend is reversed and, being pending again, it
        // holds its reservation once more; its bytes are rebroadcast unchanged.
        patch = {
          status: "REORGED",
          gasReservedWei: attempt.maxCostWei,
          gasSpentWei: 0n,
        };
      }
      if (!patch) continue;
      const same =
        patch.status === attempt.status &&
        (patch.gasReservedWei ?? attempt.gasReservedWei) ===
          attempt.gasReservedWei &&
        (patch.gasSpentWei ?? attempt.gasSpentWei) === attempt.gasSpentWei &&
        (patch.receiptBlockHash === undefined ||
          patch.receiptBlockHash?.toLowerCase() ===
            attempt.receiptBlockHash?.toLowerCase()) &&
        (patch.receiptStatus === undefined ||
          patch.receiptStatus === attempt.receiptStatus);
      if (!same) changes.push({ attempt, patch });
    }
    if (!changes.length) return false;
    await commit(snap, changes);
    return true;
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
      // 2. Every artifact gets its attempt row before it is sent.
      if (await ensureAttempts(snap)) continue;

      // 3. Record what the chain says about every version, whatever the signer is doing.
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

      // 4. Nothing is mined: send the version that needs it. A version that was mined and then
      //    orphaned comes first (its persisted bytes, its nonce); otherwise the newest version
      //    if it was never sent.
      const active = snap.attempts.filter((a) => a.status !== "REPLACED");
      const candidate =
        [...active].reverse().find((a) => a.status === "REORGED") ??
        (active.at(-1)?.status === "SIGNED" ? active.at(-1) : undefined);
      if (candidate) {
        const artifact = snap.artifacts.find(
          (a) => a.id === candidate.artifactId,
        )!;
        let sent;
        try {
          sent = await rpc.sendRawTransaction(artifact.rawTransaction!);
        } catch (error) {
          // The attempt stays as it was, so the next run sends the same bytes again.
          throw new TxDispatchError(
            error instanceof Error && error.message === "RPC_UNAVAILABLE"
              ? "RPC_UNAVAILABLE"
              : "BROADCAST_FAILED",
            true,
          );
        }
        if (sent.state === "ACCEPTED") {
          if (sent.hash.toLowerCase() !== candidate.txHash.toLowerCase())
            throw new TxDispatchError("TX_HASH_MISMATCH", false);
          if (
            await commit(snap, [
              {
                attempt: candidate,
                patch: { status: "SUBMITTED", submittedAt: "now" },
              },
            ])
          )
            broadcast = true;
        } else {
          // Already known, nonce too low or underpriced against a pooled version is not a
          // failure: it may be this very transaction, so the next pass looks its hash up
          // instead of guessing.
          await commit(snap, [
            {
              attempt: candidate,
              patch: { status: "UNKNOWN", submittedAt: "now" },
            },
          ]);
        }
        continue;
      }

      // 5. A replacement was requested but not yet signed (signer outage or crash): finish it.
      const versions = snap.artifacts.length;
      const outstanding = snap.signRequests.find(
        (r) => r.artifactVersion > versions && r.state === "REQUESTED",
      );
      if (outstanding) {
        const result = await askSigner(outstanding);
        if (result.state === "SIGNED") continue;
        // An unanswered or refused replacement leaves the live version in place: the transaction
        // itself is known and pending, only the replacement is not.
      }

      // 6. Unmined for too long: request a higher-fee version of the same call.
      const newest = snap.attempts.at(-1)!;
      const live = active.at(-1);
      const waitedMs = live?.submittedAt
        ? snap.now.getTime() - live.submittedAt.getTime()
        : 0;
      const blocked = snap.signRequests.some(
        (r) => r.artifactVersion > versions,
      );
      const base = snap.signRequests.find((r) => r.artifactVersion === 1);
      if (
        !blocked &&
        base &&
        live &&
        (live.status === "SUBMITTED" || live.status === "UNKNOWN") &&
        waitedMs >= replaceAfterMs
      ) {
        // The newest signed version's fees are the floor, even if it was itself replaced.
        const fees = minimumReplacementFees({
          maxFeePerGas: newest.maxFeePerGas,
          maxPriorityFeePerGas: newest.maxPriorityFeePerGas,
        });
        const payload = {
          ...base.unsignedPayload,
          maxFeePerGas: fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
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
        const result = await askSigner({ id: signRequestId, requestHash });
        if (result.state === "SIGNED") continue;
      }
      if (broadcast) return "SUBMITTED";
      return live?.status === "UNKNOWN" ? "UNKNOWN" : "PENDING";
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
