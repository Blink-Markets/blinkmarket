import { validateReplayApproval } from "@blink/domain";
import type { SpecArchive } from "@blink/ports";

/** Internal preparation only: no authentication, DB approval, capacity reservation or outbox emission. */
export async function prepareReplayApproval(
  archive: SpecArchive,
  snapshot: Parameters<typeof validateReplayApproval>[0],
) {
  const validated = validateReplayApproval(snapshot);
  const frozen = await archive.freeze(
    validated.request.spec,
    snapshot.nowSeconds,
  );
  return {
    state: "PREPARED_NOT_APPROVED" as const,
    candidateId: validated.candidate.candidateId,
    expectedRevision: validated.candidate.revision,
    deploymentId: validated.request.deploymentId,
    budgetMicros: validated.request.budgetMicros,
    canonicalKey: validated.canonicalKey,
    activeSlotKey: validated.activeSlotKey,
    specHash: frozen.hash,
    specUri: frozen.uri,
    bytes: frozen.bytes,
  };
}
