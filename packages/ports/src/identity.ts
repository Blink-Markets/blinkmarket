import type { ApiScope } from "@blink/schemas";

// A stored key can still carry a legacy operator scope (only the operator-status checks ask for
// it, and no flow can issue it). It is not an ApiScope.
export type KeyScope = ApiScope | "admin";

export interface IdentityKey {
  id: string;
  operatorId: string;
  agentId: string;
  secretHash: string;
  scopes: KeyScope[];
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface IdentityPrincipal {
  keyId: string;
  /** The agent's one-to-one internal container; no person manages it. */
  operatorId: string;
  agentId: string;
  /** The wallet the agent is bound to; null only for legacy rows that never bound one. */
  address: string | null;
  scopes: KeyScope[];
}
export interface WalletChallenge {
  id: string;
  address: string;
  action: "issue" | "revoke";
  targetKeyId: string | null;
  origin: string;
  nonceHash: string;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}
export type KeyIssueOutcome =
  | { status: "OK"; keyId: string; expiresAt: Date }
  | { status: "NOT_FOUND" | "USED" | "EXPIRED" | "KEY_LIMIT" };
export type KeyRevokeOutcome =
  | { status: "OK"; keyId: string; revokedAt: Date }
  | { status: "NOT_FOUND" | "USED" | "EXPIRED" };
export interface IdentityResponse {
  status: number;
  body: Record<string, unknown>;
}
export interface IdentityTransaction {
  now(): Promise<Date>;
  key(id: string): Promise<IdentityKey | null>;
  claimRequest(
    operatorId: string,
    scope: string,
    key: string,
    hash: string,
  ): Promise<
    | { state: "NEW" }
    | { state: "BUSY" | "CONFLICT" }
    | { state: "DONE"; result: IdentityResponse }
  >;
  finishRequest(
    operatorId: string,
    scope: string,
    key: string,
    result: IdentityResponse,
  ): Promise<void>;
  /** Serializes challenge creation for one address until commit. */
  lockAddress(address: string): Promise<void>;
  pendingChallenges(address: string): Promise<number>;
  addChallenge(challenge: WalletChallenge): Promise<void>;
  challenge(id: string): Promise<WalletChallenge | null>;
  /** Spends one verification attempt; false when the challenge's budget is already used up. */
  spendAttempt(challengeId: string, budget: number): Promise<boolean>;
  /** Atomically consumes the challenge, creates the agent on first use and issues the key. */
  issueKey(input: {
    challengeId: string;
    keyId: string;
    secretHash: string;
    operatorId: string;
    agentId: string;
    requestId: string;
  }): Promise<KeyIssueOutcome>;
  /** Atomically consumes the challenge and revokes the key if the signing address owns it. */
  revokeKey(challengeId: string, requestId: string): Promise<KeyRevokeOutcome>;
  wallet(agentId: string): Promise<string | null>;
}
export interface IdentityStore {
  run<T>(work: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}
export interface IdentityCrypto {
  id(): string;
  nonce(): string;
  hash(value: string): string;
  equalHash(a: string, b: string): boolean;
}
