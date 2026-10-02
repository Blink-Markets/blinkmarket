import type { ApiScope } from "@blink/schemas";

export interface IdentityKey {
  id: string;
  operatorId: string;
  agentId: string;
  secretHash: string;
  scopes: ApiScope[];
  expiresAt: Date;
  revokedAt: Date | null;
}
export interface IdentityPrincipal {
  keyId: string;
  operatorId: string;
  agentId: string;
  scopes: ApiScope[];
}
export interface WalletChallenge {
  id: string;
  keyId: string;
  agentId: string;
  address: string;
  origin: string;
  nonceHash: string;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}
export interface IdentityResponse {
  status: number;
  body: Record<string, unknown>;
}
export interface IdentityTransaction {
  now(): Promise<Date>;
  key(id: string): Promise<IdentityKey | null>;
  lockAgent(id: string): Promise<void>;
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
  addChallenge(challenge: WalletChallenge): Promise<void>;
  pendingChallenges(keyId: string): Promise<number>;
  challenge(
    id: string,
    keyId: string,
    agentId: string,
  ): Promise<WalletChallenge | null>;
  consumeChallenge(id: string): Promise<void>;
  bindWallet(
    agentId: string,
    address: string,
    challengeId: string,
  ): Promise<boolean>;
  wallet(agentId: string): Promise<string | null>;
  audit(
    actor: string,
    action: string,
    resource: string,
    requestId: string,
  ): Promise<void>;
}
export interface IdentityStore {
  run<T>(work: (tx: IdentityTransaction) => Promise<T>): Promise<T>;
}
export interface IdentityCrypto {
  id(): string;
  nonce(): string;
  hash(value: string): string;
  equalHash(a: string, b: string): boolean;
  verifyMessage(
    address: string,
    message: string,
    signature: string,
  ): Promise<boolean>;
}
