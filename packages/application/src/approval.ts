import { CandidateApprovalRequest, IdempotencyHeaders } from "@blink/schemas";
import {
  validateReplayApproval,
  ApprovalPolicyError,
  type ApprovalEvidence,
} from "@blink/domain";
import type {
  ApprovalStore,
  ApprovalTransaction,
  IdentityCrypto,
  SpecArchive,
  CreationIntent,
} from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";

export const approvalPaths = [
  "/v1/admin/candidates/:id/approve",
  "/v1/admin/creation-intents/:id",
  "/v1/specs/:specHash",
  "/v1/admin/creation-intents/:id/chain-status",
] as const;
const fail = (status: number, code: string): never => {
  throw new IdentityError(status, code);
};
export function createApprovalService(options: {
  store: ApprovalStore;
  crypto: IdentityCrypto;
  archive: SpecArchive;
  publicOrigin: string;
  verifyEvidence(uri: string, hash: string): Promise<void>;
  encodeCreation(
    spec: CandidateApprovalRequest["spec"],
    hash: string,
    uri: string,
  ): string;
}) {
  const { store, crypto, archive } = options;
  const origin = new URL(options.publicOrigin);
  if (
    origin.origin !== options.publicOrigin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === "https:" ||
      (origin.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    )
  )
    throw new Error("INVALID_PUBLIC_SPEC_ORIGIN");
  async function snapshot(
    tx: ApprovalTransaction,
    id: string,
    request: CandidateApprovalRequest,
    lock: boolean,
  ) {
    const history = await tx.candidate(id, lock);
    if (!history) return fail(404, "NOT_FOUND");
    const evidence: ApprovalEvidence[] = [];
    const objects: { uri: string; hash: string }[] = [];
    for (const evidenceId of [...history.candidate.evidenceIds].sort()) {
      const e = await tx.evidence(evidenceId),
        object = await tx.evidenceObject(evidenceId);
      if (!e || !object) return fail(409, "EVIDENCE_NOT_ALLOWED");
      evidence.push({
        evidenceId,
        entityId: e.entityId,
        sourceUrl: e.metadata.sourceUrl,
        sourceEnabled: e.enabled,
        accessPolicy: e.metadata.accessPolicy,
      });
      objects.push(object);
    }
    const deployment = await tx.deployment(request.deploymentId);
    const now = await tx.now();
    if (
      !deployment?.enabled ||
      deployment.manifest.tradingEnabled ||
      deployment.verifiedAt > now ||
      now.getTime() - deployment.verifiedAt.getTime() > 600_000
    )
      return fail(409, "DEPLOYMENT_NOT_VERIFIED");
    const policy = validateReplayApproval({
      candidate: history.candidate,
      request,
      evidence,
      nowSeconds: BigInt(Math.floor(now.getTime() / 1000)),
    });
    return {
      history,
      objects,
      deployment,
      policy,
      nowSeconds: BigInt(Math.floor(now.getTime() / 1000)),
    };
  }
  return {
    async approve(
      id: string,
      request: {
        authorization: string | undefined;
        idempotencyKey: string | undefined;
        body: unknown;
        requestId: string;
      },
    ) {
      try {
        const parsed = CandidateApprovalRequest.safeParse(request.body);
        if (
          !parsed.success ||
          !IdempotencyHeaders.safeParse({
            "idempotency-key": request.idempotencyKey,
          }).success
        )
          return fail(400, "INVALID_REQUEST");
        const input = parsed.data,
          key = request.idempotencyKey!,
          scope = "POST /v1/admin/candidates/" + id + "/approve";
        const preflight = await store.run(async (tx) => {
          const principal = await authenticateIdentity(
            tx,
            crypto,
            request.authorization,
            "admin",
          );
          const hash = crypto.hash(
            JSON.stringify({ keyId: principal.keyId, body: input }),
          );
          const cached = await tx.cached(
            principal.operatorId,
            scope,
            key,
            hash,
          );
          if (cached) return { cached, principal, hash };
          return {
            snapshot: await snapshot(tx, id, input, false),
            principal,
            hash,
          };
        });
        if (preflight.cached) return preflight.cached;
        // No long SQL transaction is held across filesystem/object storage IO.
        for (const object of preflight.snapshot!.objects)
          await options.verifyEvidence(object.uri, object.hash);
        const frozen = await archive.freeze(
          input.spec,
          preflight.snapshot!.nowSeconds,
        );
        const publicUri = options.publicOrigin + "/v1/specs/" + frozen.hash;
        const calldata = options.encodeCreation(
          input.spec,
          frozen.hash,
          publicUri,
        );
        return await store.run(async (tx) => {
          const principal = await authenticateIdentity(
            tx,
            crypto,
            request.authorization,
            "admin",
          );
          const claim = await tx.claimRequest(
            principal.operatorId,
            scope,
            key,
            preflight.hash,
          );
          if (claim.state === "DONE") return claim.result;
          if (claim.state !== "NEW")
            return fail(
              409,
              claim.state === "BUSY"
                ? "REQUEST_IN_PROGRESS"
                : "IDEMPOTENCY_CONFLICT",
            );
          let fresh = await snapshot(tx, id, input, true);
          const creationIntentId = crypto.id(),
            approvalId = crypto.id();
          if (
            !(await tx.reserveSlot(
              fresh.policy.activeSlotKey,
              fresh.policy.canonicalKey,
              creationIntentId,
            ))
          )
            return fail(409, "MARKET_CAPACITY_CONFLICT");
          // A unique-slot insert may have waited. Recheck clock, key and all policy after locks.
          fresh = await snapshot(tx, id, input, true);
          await authenticateIdentity(
            tx,
            crypto,
            request.authorization,
            "admin",
          );
          const intent: CreationIntent = {
            creationIntentId,
            approvalId,
            deploymentId: input.deploymentId,
            state: "AWAITING_ADMIN_SIGNATURE",
            chainId: 84532,
            to: fresh.deployment.manifest.contracts.BlinkMarket,
            requiredSender: fresh.deployment.manifest.roles.admin,
            value: "0",
            specHash: frozen.hash,
            specUri: publicUri,
            calldata,
          };
          await tx.saveApproval({
            approvalId,
            candidateId: id,
            revision: input.expectedRevision,
            deploymentId: input.deploymentId,
            actorKeyId: principal.keyId,
            budgetMicros: input.budgetMicros,
            reason: input.reason,
            specHash: frozen.hash,
            objectUri: frozen.uri,
            publicUri,
            intent,
          });
          await tx.appendCandidate(
            fresh.history.operatorId,
            {
              ...fresh.history.candidate,
              revision: input.expectedRevision + 1,
              state: "DEPLOY_PENDING",
            },
            false,
          );
          await tx.recordAudit(
            principal.keyId,
            "candidate.approved",
            id,
            input.reason,
            request.requestId,
          );
          const result = {
            status: 202,
            body: {
              approvalId,
              specHash: frozen.hash,
              creationIntentId,
              state: "DEPLOY_PENDING",
            },
          };
          await tx.finishRequest(principal.operatorId, scope, key, result);
          return result;
        });
      } catch (error) {
        if (error instanceof ApprovalPolicyError)
          throw new IdentityError(
            error.code === "REVISION_CONFLICT" ||
              error.code === "CANDIDATE_NOT_APPROVABLE" ||
              error.code === "MARKET_CLOSED"
              ? 409
              : 400,
            error.code,
          );
        throw error;
      }
    },
    intent(id: string, authorization: string | undefined) {
      return store.run(async (tx) => {
        await authenticateIdentity(tx, crypto, authorization, "admin");
        return (await tx.intent(id)) ?? fail(404, "NOT_FOUND");
      });
    },
    chainStatus(id: string, authorization: string | undefined) {
      return store.run(async (tx) => {
        await authenticateIdentity(tx, crypto, authorization, "admin");
        return (await tx.creationStatus(id)) ?? fail(404, "NOT_FOUND");
      });
    },
    async spec(hash: string) {
      const row = await store.run((tx) => tx.spec(hash));
      if (!row) return fail(404, "NOT_FOUND");
      return archive.read(row.objectUri, hash);
    },
  };
}
export type ApprovalService = ReturnType<typeof createApprovalService>;
