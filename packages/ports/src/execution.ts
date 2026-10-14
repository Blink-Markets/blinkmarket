import type { KeeperMarket, KeeperDecision } from "@blink/domain";
import type { IdentityTransaction } from "./identity.js";
import type { SignResult } from "./signing.js";

export interface FaucetTransaction extends IdentityTransaction {
  lockAddress(deploymentId: string, address: string): Promise<void>;
  allowed(deploymentId: string, address: string): Promise<boolean>;
  window(
    deploymentId: string,
    address: string,
  ): Promise<{ pending: boolean; retryAfterSeconds: number }>;
  createClaim(input: {
    claimId: string;
    deploymentId: string;
    agentId: string;
    address: string;
    actor: string;
  }): Promise<string>;
}
export interface ExecutionRequest {
  intentId: string;
  signRequestId: string;
  requestHash: string;
}
export interface FaucetStore {
  run<T>(work: (tx: FaucetTransaction) => Promise<T>): Promise<T>;
  mintRequest(claimId: string): Promise<ExecutionRequest | null>;
  signed(claimId: string, result: SignResult): Promise<void>;
  settle(
    intentId: string,
    outcome: {
      state: "SUCCEEDED" | "FAILED" | "UNKNOWN" | "SUBMITTED";
      succeededAt?: Date;
      attempt?: { id: string; version: number };
    },
  ): Promise<void>;
}
export interface KeeperCandidate extends KeeperMarket {
  marketId: string;
  nowChain: bigint;
}
export interface KeeperRequest extends ExecutionRequest {
  marketId: string;
  kind: KeeperDecision;
}
export interface KeeperStore {
  candidates(deploymentId: string): Promise<KeeperCandidate[]>;
  prepare(
    deploymentId: string,
    marketId: string,
    kind: KeeperDecision,
  ): Promise<void>;
  pending(deploymentId: string): Promise<KeeperRequest[]>;
  cancel(request: KeeperRequest): Promise<void>;
  signed(request: KeeperRequest, result: SignResult): Promise<void>;
}
export interface ExecutionChainReader {
  marketState(marketId: string): Promise<KeeperMarket["state"]>;
  blockTimestamp(number: bigint): Promise<bigint>;
}

export { canonicalJson, SIGNING_POLICY_VERSION } from "@blink/domain";
