import {
  CandidateInput,
  CandidateRevisionInput,
  IdempotencyHeaders,
  apiContracts,
} from "@blink/schemas";
import type { CandidateRecord } from "@blink/schemas";
import type {
  IdentityCrypto,
  IdentityResponse,
  PreparationStore,
} from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";

export const preparationPaths = [
  "/v1/candidates",
  "/v1/candidates/:id",
  "/v1/candidates/:id/revisions",
  "/v1/admin/candidates/:id/reject",
  "/v1/evidence/:id",
] as const;
const fail = (status: number, code: string): never => {
  throw new IdentityError(status, code);
};
export function createPreparationService(
  store: PreparationStore,
  crypto: IdentityCrypto,
) {
  return {
    async handle(
      path: string,
      request: {
        authorization: string | undefined;
        idempotencyKey: string | undefined;
        params: unknown;
        query: unknown;
        body: unknown;
        requestId: string;
      },
    ): Promise<IdentityResponse> {
      const contract = apiContracts.find((c) => c.path === path);
      if (
        !contract ||
        !preparationPaths.includes(path as (typeof preparationPaths)[number])
      )
        fail(404, "NOT_FOUND");
      const params = contract!.params.safeParse(request.params);
      if (!params.success || !contract!.query.safeParse(request.query).success)
        fail(400, "INVALID_REQUEST");
      const id = (params.data as { id?: string }).id?.toLowerCase();
      const write = contract!.method === "POST";
      const rejecting = path.endsWith("/reject");
      return store.run(async (tx) => {
        const principal =
          write || request.authorization !== undefined
            ? await authenticateIdentity(
                tx,
                crypto,
                request.authorization,
                write ? (rejecting ? "admin" : "candidate:write") : undefined,
              )
            : null;
        if (!write) {
          if (path === "/v1/evidence/:id") {
            const evidence = await tx.evidence(id!);
            if (
              !evidence ||
              (evidence.metadata.accessPolicy === "PRIVATE" &&
                evidence.operatorId !== principal?.operatorId &&
                !principal?.scopes.includes("admin"))
            )
              fail(404, "NOT_FOUND");
            return { status: 200, body: { ...evidence!.metadata } };
          }
          const history = await tx.candidate(id!, false);
          // Drafts are private. No candidate becomes public in this slice.
          if (
            !history ||
            (history.operatorId !== principal?.operatorId &&
              !principal?.scopes.includes("admin"))
          )
            fail(404, "NOT_FOUND");
          return {
            status: 200,
            body: {
              candidate: history!.candidate,
              revisions: history!.revisions,
            },
          };
        }
        if (
          !IdempotencyHeaders.safeParse({
            "idempotency-key": request.idempotencyKey,
          }).success
        )
          fail(400, "INVALID_REQUEST");
        const parsed = contract!.body!.safeParse(request.body);
        if (!parsed.success) fail(400, "INVALID_REQUEST");
        const scope = "POST " + path + (id ? "/" + id : "");
        const key = request.idempotencyKey!;
        const hash = crypto.hash(
          JSON.stringify({ keyId: principal!.keyId, body: parsed.data }),
        );
        const claim = await tx.claimRequest(
          principal!.operatorId,
          scope,
          key,
          hash,
        );
        if (claim.state === "BUSY") fail(409, "REQUEST_IN_PROGRESS");
        if (claim.state === "CONFLICT") fail(409, "IDEMPOTENCY_CONFLICT");
        if (claim.state === "DONE") return claim.result;
        let result: IdentityResponse;
        try {
          const current = id ? await tx.candidate(id, true) : null;
          // Expiry must be checked after waiting for the candidate row lock.
          await authenticateIdentity(
            tx,
            crypto,
            request.authorization,
            rejecting ? "admin" : "candidate:write",
          );
          if (
            id &&
            (!current ||
              (!rejecting && current.operatorId !== principal!.operatorId))
          )
            fail(404, "NOT_FOUND");
          const revision = current ? current.candidate.revision + 1 : 1;
          if (
            current &&
            (parsed.data as { expectedRevision: number }).expectedRevision !==
              current.candidate.revision
          )
            fail(409, "REVISION_CONFLICT");
          if (
            current &&
            !["DRAFT", "NEEDS_REVISION", "REJECTED"].includes(
              current.candidate.state,
            )
          )
            fail(409, "CANDIDATE_LOCKED");
          let next: CandidateRecord;
          let reason: string;
          if (rejecting) {
            if (current!.candidate.state === "REJECTED")
              fail(409, "CANDIDATE_LOCKED");
            next = { ...current!.candidate, revision, state: "REJECTED" };
            const rejection = parsed.data as {
              reason: string;
              reasonCode: string;
            };
            reason = JSON.stringify(rejection);
          } else {
            const input = id
              ? CandidateRevisionInput.parse(parsed.data)
              : CandidateInput.parse(parsed.data);
            // Stable ordering makes equivalent evidence sets idempotent after canonicalization at the schema boundary.
            for (const evidenceId of [...input.evidenceIds].sort()) {
              const evidence = await tx.evidence(evidenceId);
              if (
                !evidence ||
                (evidence.metadata.accessPolicy === "PRIVATE" &&
                  evidence.operatorId !== principal!.operatorId)
              )
                fail(404, "NOT_FOUND");
              if (!evidence!.enabled || evidence!.entityId !== input.entityId)
                fail(400, "EVIDENCE_NOT_ALLOWED");
            }
            const { expectedRevision: _, ...fields } = {
              expectedRevision: undefined,
              ...input,
            };
            next = {
              ...fields,
              candidateId: id ?? crypto.id(),
              revision,
              state: "DRAFT",
            };
            reason =
              "Candidate content submitted; not approved for market creation";
          }
          await tx.appendCandidate(
            current?.operatorId ?? principal!.operatorId,
            next,
            !current,
          );
          await tx.recordAudit(
            principal!.keyId,
            rejecting ? "candidate.rejected" : "candidate.revised",
            next.candidateId,
            reason,
            request.requestId,
          );
          result = {
            status: current ? 200 : 201,
            body: {
              candidateId: next.candidateId,
              revision,
              state: next.state,
            },
          };
        } catch (error) {
          if (!(error instanceof IdentityError)) throw error;
          result = {
            status: error.status,
            body: {
              code: error.code,
              message: error.code,
              retryable: false,
              details: {},
            },
          };
        }
        await tx.finishRequest(principal!.operatorId, scope, key, result);
        return result;
      });
    },
  };
}
export type PreparationService = ReturnType<typeof createPreparationService>;
