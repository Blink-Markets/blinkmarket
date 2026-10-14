import { parseGrossMargin } from "@blink/domain";
import { apiContracts, IdempotencyHeaders } from "@blink/schemas";
import type {
  IdentityCrypto,
  ResolutionStore,
  ResolutionReportInput,
  ReportState,
} from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";
import type { RouteService } from "./route-service.js";
const paths = [
  "/v1/markets/:id/resolution-reports",
  "/v1/admin/resolution-reports",
  "/v1/admin/resolution-reports/:id/triage",
] as const;
const fail = (status: number, code: string): never => {
  throw new IdentityError(status, code);
};
export function createResolutionService({
  store,
  crypto,
}: {
  store: ResolutionStore;
  crypto: IdentityCrypto;
}): RouteService {
  return {
    paths,
    async handle(request) {
      const contract = apiContracts.find(
        (c) => c.path === request.path && c.method === request.method,
      );
      if (!contract) return fail(404, "NOT_FOUND");
      const query = contract.query.safeParse(request.query),
        params = contract.params.safeParse(request.params);
      const body = contract.body?.safeParse(request.body);
      if (
        !query.success ||
        !params.success ||
        (request.method === "POST" &&
          (!body?.success ||
            !IdempotencyHeaders.safeParse({
              "idempotency-key": request.idempotencyKey,
            }).success))
      )
        return fail(400, "INVALID_REQUEST");
      const deploymentId = String(query.data.deploymentId),
        id = String(params.data.id);
      return store.run(async (tx) => {
        const principal = await authenticateIdentity(
          tx,
          crypto,
          request.authorization,
          request.path === paths[0] ? "report:write" : "admin",
        );
        if (request.method === "GET") {
          const cursor = query.data.cursor as string | undefined;
          if (
            cursor &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              cursor,
            )
          )
            return fail(400, "INVALID_REQUEST");
          const limit = Number(query.data.limit);
          const rows = await tx.reports(
            deploymentId,
            (query.data.marketId as string) ?? null,
            (query.data.state as ReportState) ?? null,
            limit + 1,
            cursor ?? null,
          );
          const items = rows.slice(0, limit);
          return {
            status: 200,
            body: {
              items,
              nextCursor:
                rows.length > limit ? String(items.at(-1)!.reportId) : null,
            },
          };
        }
        const input = body!.data as ResolutionReportInput & {
          state: ReportState;
        };
        const scope = "POST " + request.path.replace(":id", id),
          key = request.idempotencyKey!;
        const hash = crypto.hash(
          JSON.stringify({
            keyId: principal.keyId,
            body: { ...query.data, ...input },
          }),
        );
        const claim = await tx.claimRequest(
          principal.operatorId,
          scope,
          key,
          hash,
        );
        if (claim.state === "DONE") return claim.result;
        if (claim.state !== "NEW")
          return fail(
            409,
            claim.state === "BUSY"
              ? "REQUEST_IN_PROGRESS"
              : "IDEMPOTENCY_CONFLICT",
          );
        let reportId = id,
          state: ReportState = input.state;
        if (request.path === paths[0]) {
          if (!(await tx.marketExists(deploymentId, id)))
            return fail(404, "NOT_FOUND");
          if (
            !(await tx.evidenceAllowed(input.evidenceIds, principal.operatorId))
          )
            return fail(409, "EVIDENCE_NOT_ALLOWED");
          reportId = crypto.id();
          state = "RECEIVED";
          await tx.submitReport(reportId, deploymentId, id, principal, input);
        } else if (!(await tx.reportExists(id))) return fail(404, "NOT_FOUND");
        await tx.appendEvent(reportId, state, principal.keyId, input.reason);
        await tx.audit(
          principal.keyId,
          state === "RECEIVED"
            ? "resolution.report_received"
            : "resolution.report_triaged",
          reportId,
          request.requestId,
        );
        const result = {
          status: state === "RECEIVED" ? 202 : 200,
          body: { reportId, state },
        };
        await tx.finishRequest(principal.operatorId, scope, key, result);
        return result;
      });
    },
  };
}

export function createResolutionAlertHandler(
  store: import("@blink/ports").ResolutionJobsStore,
): import("@blink/ports").JobHandler {
  return async ({ signal }) => {
    signal.throwIfAborted();
    await store.alertDeadlines(
      { LIVE: [86400, 3600, 600], REPLAY: [60, 30, 10] },
      signal,
    );
  };
}

export function createResolutionParseHandler(
  store: import("@blink/ports").ResolutionJobsStore,
  readText: (uri: string, hash: string) => Promise<string>,
): import("@blink/ports").JobHandler {
  return async ({ signal }) => {
    signal.throwIfAborted();
    await store.parseEvidence(
      "gm-lt-v1.1",
      async (evidence) => {
        signal.throwIfAborted();
        const result = parseGrossMargin(
          await readText(evidence.uri, evidence.hash),
        );
        if ("ambiguous" in result) return result;
        return {
          ...result,
          outcome: result.valueBps < evidence.thresholdBps ? "YES" : "NO",
        };
      },
      signal,
    );
  };
}
