import {
  IdempotencyHeaders,
  WalletChallengeRequest,
  WalletVerificationRequest,
  type ApiScope,
} from "@blink/schemas";
import type {
  IdentityCrypto,
  IdentityPrincipal,
  IdentityStore,
  IdentityTransaction,
  IdentityResponse,
} from "@blink/ports";

export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export const identityPaths = [
  "/v1/auth/wallet-challenges",
  "/v1/auth/wallet-verifications",
] as const;
type IdentityPath = (typeof identityPaths)[number];

export async function authenticateIdentity(
  tx: IdentityTransaction,
  crypto: IdentityCrypto,
  authorization: string | undefined,
  requiredScope?: ApiScope,
): Promise<IdentityPrincipal> {
  const match =
    /^Bearer blink_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{64})$/.exec(
      authorization ?? "",
    );
  if (!match) throw new IdentityError(401, "UNAUTHORIZED");
  const key = await tx.key(match[1]!);
  const correct = crypto.equalHash(
    crypto.hash(match[2]!),
    key?.secretHash ?? "0".repeat(64),
  );
  const now = await tx.now();
  if (!key || !correct || key.revokedAt || key.expiresAt <= now)
    throw new IdentityError(401, "UNAUTHORIZED");
  if (requiredScope && !key.scopes.includes(requiredScope))
    throw new IdentityError(403, "SCOPE_DENIED");
  return {
    keyId: key.id,
    operatorId: key.operatorId,
    agentId: key.agentId,
    scopes: key.scopes,
  };
}

export function createIdentityService(
  store: IdentityStore,
  crypto: IdentityCrypto,
  configuredOrigin: string,
) {
  const parsed = new URL(configuredOrigin);
  if (
    configuredOrigin !== parsed.origin ||
    parsed.username ||
    parsed.password ||
    !(
      parsed.protocol === "https:" ||
      (parsed.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    )
  ) {
    throw new Error("INVALID_WALLET_BINDING_ORIGIN");
  }
  const origin = parsed.origin;
  const fail = (status: number, code: string): never => {
    throw new IdentityError(status, code);
  };
  async function authenticate(
    tx: IdentityTransaction,
    authorization: string | undefined,
    requiredScope?: ApiScope,
  ) {
    return authenticateIdentity(tx, crypto, authorization, requiredScope);
  }
  return {
    authenticate(authorization: string | undefined, scope?: ApiScope) {
      return store.run((tx) => authenticate(tx, authorization, scope));
    },
    async mutate(
      path: IdentityPath,
      request: {
        authorization: string | undefined;
        idempotencyKey: string | undefined;
        body: unknown;
        requestId: string;
      },
    ): Promise<IdentityResponse> {
      return store.run(async (tx) => {
        // Keep a shared key lock until commit, so revocation cannot race a mutation.
        const principal = await authenticate(tx, request.authorization);
        if (
          !IdempotencyHeaders.safeParse({
            "idempotency-key": request.idempotencyKey,
          }).success
        )
          return fail(400, "INVALID_REQUEST");
        const challengeInput =
          path === identityPaths[0]
            ? WalletChallengeRequest.safeParse(request.body)
            : null;
        const verificationInput =
          path === identityPaths[1]
            ? WalletVerificationRequest.safeParse(request.body)
            : null;
        if (!(challengeInput?.success || verificationInput?.success))
          return fail(400, "INVALID_REQUEST");
        const body = challengeInput?.success
          ? { address: challengeInput.data.address.toLowerCase() }
          : {
              challengeId: verificationInput!.data!.challengeId,
              signature: verificationInput!.data!.signature.toLowerCase(),
            };
        const scope = "POST " + path;
        // Bind idempotency to the authenticated key and configured origin as well as payload.
        const hash = crypto.hash(
          JSON.stringify({ keyId: principal.keyId, origin, body }),
        );
        const key = request.idempotencyKey!;
        const claim = await tx.claimRequest(
          principal.operatorId,
          scope,
          key,
          hash,
        );
        if (claim.state === "BUSY") return fail(409, "REQUEST_IN_PROGRESS");
        if (claim.state === "CONFLICT")
          return fail(409, "IDEMPOTENCY_CONFLICT");
        if (claim.state === "DONE") return claim.result;
        await tx.lockAgent(principal.agentId);
        await authenticate(tx, request.authorization);
        let result: IdentityResponse;
        try {
          const now = await tx.now(); // After locks: queueing must not extend validity.
          if (challengeInput?.success) {
            if (await tx.wallet(principal.agentId))
              fail(409, "WALLET_ALREADY_BOUND");
            if ((await tx.pendingChallenges(principal.keyId)) >= 5)
              fail(429, "RATE_LIMITED");
            const address = challengeInput.data.address.toLowerCase();
            const id = crypto.id();
            const nonce = crypto.nonce();
            const expiresAt = new Date(now.getTime() + 5 * 60_000);
            const message = [
              "Blink Market wallet identity binding v1",
              "This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.",
              `Origin: ${origin}`,
              "Chain ID: 84532",
              `Address: ${address}`,
              `Key ID: ${principal.keyId}`,
              `Agent ID: ${principal.agentId}`,
              `Challenge ID: ${id}`,
              `Nonce: ${nonce}`,
              `Issued At: ${now.toISOString()}`,
              `Expires At: ${expiresAt.toISOString()}`,
            ].join("\n");
            await tx.addChallenge({
              id,
              keyId: principal.keyId,
              agentId: principal.agentId,
              address,
              origin,
              nonceHash: crypto.hash(nonce),
              message,
              issuedAt: now,
              expiresAt,
              consumedAt: null,
            });
            await tx.audit(
              principal.keyId,
              "identity.challenge_created",
              id,
              request.requestId,
            );
            result = {
              status: 201,
              body: {
                challengeId: id,
                message,
                expiresAt: expiresAt.toISOString(),
              },
            };
          } else {
            const input = verificationInput!.data!;
            const challenge = await tx.challenge(
              input.challengeId,
              principal.keyId,
              principal.agentId,
            );
            if (!challenge) return fail(404, "NOT_FOUND");
            if (challenge.origin !== origin)
              fail(400, "INVALID_WALLET_SIGNATURE");
            if (challenge.consumedAt) fail(409, "WALLET_CHALLENGE_USED");
            if (challenge.expiresAt <= now)
              fail(409, "WALLET_CHALLENGE_EXPIRED");
            if (
              !(await crypto.verifyMessage(
                challenge.address,
                challenge.message,
                input.signature,
              ))
            )
              fail(400, "INVALID_WALLET_SIGNATURE");
            // Recheck the DB clock after local signature verification as well.
            const verifiedAt = await tx.now();
            if (challenge.expiresAt <= verifiedAt)
              fail(409, "WALLET_CHALLENGE_EXPIRED");
            await authenticate(tx, request.authorization);
            if (
              !(await tx.bindWallet(
                principal.agentId,
                challenge.address,
                challenge.id,
              ))
            )
              fail(409, "WALLET_ALREADY_BOUND");
            await tx.consumeChallenge(challenge.id);
            await tx.audit(
              principal.keyId,
              "identity.wallet_bound",
              principal.agentId,
              request.requestId,
            );
            result = {
              status: 200,
              body: {
                wallet: challenge.address,
                verifiedAt: verifiedAt.toISOString(),
              },
            };
          }
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
        await tx.finishRequest(principal.operatorId, scope, key, result);
        return result;
      });
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
