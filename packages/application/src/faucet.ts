import { apiContracts, IdempotencyHeaders } from "@blink/schemas";
import type { FaucetStore, IdentityCrypto } from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";
import type { RouteService } from "./route-service.js";

const path = "/v1/faucet/claims";
export function createFaucetService(deps: {
  store: FaucetStore;
  crypto: IdentityCrypto;
  deploymentId: string;
}): RouteService {
  return {
    paths: [path],
    async handle(request) {
      const contract = apiContracts.find((c) => c.path === path)!;
      const parsed = contract.body!.safeParse(request.body);
      if (
        request.method !== "POST" ||
        request.path !== path ||
        !parsed.success ||
        !IdempotencyHeaders.safeParse({
          "idempotency-key": request.idempotencyKey,
        }).success
      )
        throw new IdentityError(400, "INVALID_REQUEST");
      const body = parsed.data as { deploymentId: string };
      return deps.store.run(async (tx) => {
        const principal = await authenticateIdentity(
          tx,
          deps.crypto,
          request.authorization,
          "faucet:claim",
        );
        const scope = "POST " + path;
        const key = request.idempotencyKey!;
        const claim = await tx.claimRequest(
          principal.operatorId,
          scope,
          key,
          deps.crypto.hash(JSON.stringify({ keyId: principal.keyId, body })),
        );
        if (claim.state === "DONE") return claim.result;
        if (claim.state !== "NEW")
          throw new IdentityError(
            409,
            claim.state === "BUSY"
              ? "REQUEST_IN_PROGRESS"
              : "IDEMPOTENCY_CONFLICT",
            claim.state === "BUSY" ? { retryAfterSeconds: 1 } : {},
          );
        if (body.deploymentId !== deps.deploymentId)
          throw new IdentityError(409, "DEPLOYMENT_MISMATCH");
        const address = await tx.wallet(principal.agentId);
        if (!address) throw new IdentityError(403, "WALLET_NOT_VERIFIED");
        await tx.lockAddress(body.deploymentId, address);
        if (!(await tx.allowed(body.deploymentId, address)))
          throw new IdentityError(409, "FAUCET_NOT_ALLOWED");
        const window = await tx.window(body.deploymentId, address);
        if (window.pending) throw new IdentityError(409, "FAUCET_PENDING");
        if (window.retryAfterSeconds > 0)
          throw new IdentityError(429, "RATE_LIMITED", {
            retryAfterSeconds: window.retryAfterSeconds,
          });
        const claimId = deps.crypto.id();
        const intentId = await tx.createClaim({
          claimId,
          deploymentId: body.deploymentId,
          agentId: principal.agentId,
          address,
          actor: principal.keyId,
        });
        const result = {
          status: 202,
          body: { claimId, intentId, state: "QUEUED" },
        };
        await tx.finishRequest(principal.operatorId, scope, key, result);
        return result;
      });
    },
  };
}
