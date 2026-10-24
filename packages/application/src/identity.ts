import {
  WalletChallengeRequest,
  WalletVerificationRequest,
} from "@blink/schemas";
import {
  SignatureCheckUnavailable,
  type IdentityCrypto,
  type IdentityPrincipal,
  type IdentityStore,
  type IdentityTransaction,
  type IdentityResponse,
  type KeyScope,
  type ProtocolReader,
  type SignatureVerifier,
} from "@blink/ports";

export class IdentityError extends Error {
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(
    readonly status: number,
    readonly code: string,
    options: {
      details?: Record<string, unknown>;
      retryable?: boolean;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(code);
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? code === "REQUEST_IN_PROGRESS";
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
export const identityPaths = [
  "/v1/auth/wallet-challenges",
  "/v1/auth/wallet-verifications",
] as const;

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PENDING_CHALLENGES = 5;
/** Verification attempts one challenge accepts before it is dead, spent before the signature check. */
export const MAX_VERIFICATION_ATTEMPTS = 5;

// The 30-day lifetime, four scopes and five-key limit live in the issuing SQL function.
/** What wallet proof needs beyond the database: a signature check and the indexed chain state. */
export interface WalletProof {
  verifier: SignatureVerifier;
  reader: Pick<ProtocolReader, "health" | "account">;
}

export async function authenticateIdentity(
  tx: IdentityTransaction,
  crypto: IdentityCrypto,
  authorization: string | undefined,
  requiredScope?: KeyScope,
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
    address: await tx.wallet(key.agentId),
    scopes: key.scopes,
  };
}

// Any doubt about the index fails closed: a reader error counts as a stale index.
const indexStale = () =>
  new IdentityError(503, "INDEX_STALE", {
    retryable: true,
    retryAfterSeconds: 5,
  });
/** Runs a read of the indexed chain state, refusing with 503 INDEX_STALE unless the index is fresh. */
export async function readFreshIndex<T>(
  reader: Pick<ProtocolReader, "health">,
  read: () => Promise<T>,
): Promise<T> {
  try {
    if ((await reader.health()).stale !== false) throw indexStale();
    return await read();
  } catch (error) {
    throw error instanceof IdentityError ? error : indexStale();
  }
}
export async function requireRegisteredAddress(
  reader: Pick<ProtocolReader, "health" | "account">,
  address: string,
) {
  const account = await readFreshIndex(reader, () => reader.account(address));
  if (account?.registered !== true)
    throw new IdentityError(403, "NOT_REGISTERED");
}

export function createIdentityService(
  store: IdentityStore,
  crypto: IdentityCrypto,
  configuredOrigin: string,
  proof?: WalletProof,
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
  const fail = (
    status: number,
    code: string,
    options?: ConstructorParameters<typeof IdentityError>[2],
  ): never => {
    throw new IdentityError(status, code, options);
  };

  async function createChallenge(
    body: unknown,
    clientIp: string,
  ): Promise<IdentityResponse> {
    const input = WalletChallengeRequest.safeParse(body);
    if (!input.success) return fail(400, "INVALID_REQUEST");
    const address = input.data.address.toLowerCase();
    const keyId = input.data.keyId?.toLowerCase() ?? null;
    return store.run(async (tx) => {
      await tx.lockAddress(address, clientIp);
      if (
        (await tx.pendingChallenges(address, clientIp)) >=
        MAX_PENDING_CHALLENGES
      )
        return fail(429, "RATE_LIMITED");
      const now = await tx.now();
      const id = crypto.id();
      const nonce = crypto.nonce();
      const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
      const message = [
        "Blink Market wallet identity binding v1",
        "This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.",
        `Origin: ${origin}`,
        "Chain ID: 84532",
        `Address: ${address}`,
        `Action: ${input.data.action}`,
        ...(keyId ? [`Key ID: ${keyId}`] : []),
        `Challenge ID: ${id}`,
        `Nonce: ${nonce}`,
        `Issued At: ${now.toISOString()}`,
        `Expires At: ${expiresAt.toISOString()}`,
      ].join("\n");
      await tx.addChallenge({
        id,
        address,
        action: input.data.action,
        targetKeyId: keyId,
        clientIp,
        origin,
        nonceHash: crypto.hash(nonce),
        message,
        issuedAt: now,
        expiresAt,
        consumedAt: null,
      });
      return {
        status: 201,
        body: { challengeId: id, message, expiresAt: expiresAt.toISOString() },
      };
    });
  }

  const requireRegistered = (wallet: WalletProof, address: string) =>
    requireRegisteredAddress(wallet.reader, address);

  async function checkSignature(
    wallet: WalletProof,
    address: string,
    message: string,
    signature: string,
  ) {
    try {
      const check = await wallet.verifier.verifyMessage({
        address,
        message,
        signature: signature as `0x${string}`,
      });
      if (!check.valid) fail(400, "INVALID_WALLET_SIGNATURE");
    } catch (error) {
      if (error instanceof SignatureCheckUnavailable)
        fail(503, "SIGNATURE_CHECK_UNAVAILABLE", {
          retryable: true,
          retryAfterSeconds: 1,
        });
      throw error;
    }
  }

  const outcomeError = (status: string): never =>
    status === "USED"
      ? fail(409, "WALLET_CHALLENGE_USED")
      : status === "EXPIRED"
        ? fail(409, "WALLET_CHALLENGE_EXPIRED")
        : status === "KEY_LIMIT"
          ? fail(409, "KEY_LIMIT_REACHED")
          : fail(404, "NOT_FOUND");

  async function verify(
    body: unknown,
    requestId: string,
  ): Promise<IdentityResponse> {
    const input = WalletVerificationRequest.safeParse(body);
    if (!input.success) return fail(400, "INVALID_REQUEST");
    const wallet = proof!;
    // The signature check calls the chain, so no database transaction stays open across it. The
    // SQL functions re-check use and expiry under the challenge row lock. One attempt is spent
    // (and committed) before the check, so a challenge cannot drive unlimited chain calls.
    const challenge = await store.run(async (tx) => {
      const found = await tx.challenge(input.data.challengeId);
      if (!found) return fail(404, "NOT_FOUND");
      if (found.origin !== origin) return fail(400, "INVALID_WALLET_SIGNATURE");
      if (found.consumedAt) return fail(409, "WALLET_CHALLENGE_USED");
      if (found.expiresAt <= (await tx.now()))
        return fail(409, "WALLET_CHALLENGE_EXPIRED");
      if (!(await tx.spendAttempt(found.id, MAX_VERIFICATION_ATTEMPTS)))
        return fail(429, "RATE_LIMITED");
      return found;
    });
    await checkSignature(
      wallet,
      challenge.address,
      challenge.message,
      input.data.signature,
    );
    if (challenge.action === "revoke") {
      // A refusal throws inside the transaction, so nothing it wrote can commit.
      const revoked = await store.run(async (tx) => {
        const outcome = await tx.revokeKey(challenge.id, requestId);
        return outcome.status === "OK" ? outcome : outcomeError(outcome.status);
      });
      return {
        status: 200,
        body: {
          keyId: revoked.keyId,
          revokedAt: revoked.revokedAt.toISOString(),
        },
      };
    }
    await requireRegistered(wallet, challenge.address);
    const keyId = crypto.id();
    const secret = crypto.nonce();
    const issued = await store.run(async (tx) => {
      const outcome = await tx.issueKey({
        challengeId: challenge.id,
        keyId,
        secretHash: crypto.hash(secret),
        operatorId: crypto.id(),
        agentId: crypto.id(),
        requestId,
      });
      return outcome.status === "OK" ? outcome : outcomeError(outcome.status);
    });
    // The secret leaves the process only here, in this response.
    return {
      status: 200,
      body: {
        apiKey: `blink_${keyId}.${secret}`,
        keyId,
        expiresAt: issued.expiresAt.toISOString(),
      },
    };
  }

  return {
    authenticate(authorization: string | undefined, scope?: KeyScope) {
      return store.run((tx) =>
        authenticateIdentity(tx, crypto, authorization, scope),
      );
    },
    /** Public: the address proves itself by signature, so there is no key to check. */
    async mutate(
      path: (typeof identityPaths)[number],
      request: { body: unknown; requestId: string; clientIp: string },
    ): Promise<IdentityResponse> {
      if (!proof) throw new Error("WALLET_PROOF_NOT_CONFIGURED");
      return path === identityPaths[0]
        ? createChallenge(request.body, request.clientIp)
        : verify(request.body, request.requestId);
    },
  };
}
export type IdentityService = ReturnType<typeof createIdentityService>;
