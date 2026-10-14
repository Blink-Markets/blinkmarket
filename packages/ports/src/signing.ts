import type { AllowedCall, IntentKind, SignRole } from "@blink/domain";

export type { IntentKind, SignRole } from "@blink/domain";
export type Hex = `0x${string}`;

export type IntentState =
  | "PREPARED"
  | "SIGNED"
  | "SUBMITTED"
  | "UNKNOWN"
  | "INCLUDED"
  | "FINALIZED"
  | "FAILED"
  | "CANCELLED";

// UNKNOWN never means "not signed": the caller keeps its reservation and asks again with the
// same signRequestId, which returns the one persisted artifact.
export type SignResult =
  | {
      state: "SIGNED";
      artifactId: string;
      artifactHash: string;
      signature?: string;
      txHash?: string;
    }
  | { state: "REJECTED"; code: string }
  | { state: "UNKNOWN"; code: string };

export interface RestrictedSigner {
  sign(input: {
    signRequestId: string;
    expectedRequestHash: string;
  }): Promise<SignResult>;
}

/** The slice of a database client the intent writer needs (a pg PoolClient satisfies it). */
export interface SigningSqlClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

// Used inside another store's business transaction (API quote path, worker keeper/faucet/trader).
export interface SigningIntentWriter {
  createIntent(
    client: SigningSqlClient,
    input: {
      deploymentId: string;
      kind: IntentKind;
      role: SignRole;
      dedupeKey: string;
      payload: Record<string, unknown>;
      createdBy: string;
    },
  ): Promise<{ intentId: string; created: boolean }>;
  createSignRequest(
    client: SigningSqlClient,
    input: {
      intentId: string;
      role: SignRole;
      unsignedPayload: Record<string, unknown>;
      requestHash: string;
      policyVersion: string;
      artifactVersion?: number;
    },
  ): Promise<{ signRequestId: string }>;
}

export interface SignRequestRecord {
  id: string;
  intentId: string;
  artifactVersion: number;
  role: SignRole;
  requestHash: Hex;
  unsignedPayload: Record<string, unknown>;
  policyVersion: string;
  state: "REQUESTED" | "SIGNED" | "REJECTED";
  rejectCode: string | null;
}
export interface IntentRecord {
  id: string;
  deploymentId: string;
  kind: IntentKind;
  role: SignRole;
  payload: Record<string, unknown>;
  state: IntentState;
}
export interface ArtifactRecord {
  id: string;
  signRequestId: string;
  artifactVersion: number;
  artifactHash: Hex;
  signature: Hex | null;
  rawTransaction: Hex | null;
  maxCostWei: bigint | null;
  createdAt: Date;
}

/** Encodes a policy-approved call into calldata from the one canonical ABI (adapters own it). */
export type CallEncoder = (call: AllowedCall) => Hex;

export interface SignerRpc {
  chainId(): Promise<number>;
  estimateGas(input: { from: Hex; to: Hex; data: Hex }): Promise<bigint>;
  baseFeePerGas(): Promise<bigint>;
  maxPriorityFeePerGas(): Promise<bigint>;
  pendingNonce(address: Hex): Promise<bigint>;
  /** Base GasPriceOracle getL1Fee over the unsigned serialized transaction. */
  l1Fee(serializedUnsigned: Hex): Promise<bigint>;
}

export interface SignerTransaction {
  /** The underlying database client of this transaction, for the quoteCheck hook. */
  readonly client: unknown;
  lockSignRequest(id: string): Promise<SignRequestRecord | null>;
  lockIntent(id: string): Promise<IntentRecord | null>;
  artifactOf(signRequestId: string): Promise<ArtifactRecord | null>;
  /** Signed versions of an intent, oldest first, with the raw bytes that were signed. */
  signedVersions(
    intentId: string,
  ): Promise<(ArtifactRecord & { unsignedPayload: Record<string, unknown> })[]>;
  deploymentEnabled(deploymentId: string): Promise<boolean>;
  market(
    deploymentId: string,
    marketId: bigint,
  ): Promise<{ state: string; closeAt: bigint; specHash: Hex } | null>;
  makerEpoch(deploymentId: string): Promise<bigint | null>;
  /** Inserts the guard row if missing and locks it until the transaction ends. */
  lockSender(chainId: number, sender: Hex): Promise<void>;
  allocationOf(intentId: string): Promise<bigint | null>;
  maxAllocatedNonce(chainId: number, sender: Hex): Promise<bigint | null>;
  allocateNonce(input: {
    chainId: number;
    sender: Hex;
    nonce: bigint;
    intentId: string;
  }): Promise<void>;
  /** Locks today's (UTC, business clock) row for the role and returns its totals. */
  gasUsage(role: SignRole): Promise<{ reservedWei: bigint; spentWei: bigint }>;
  reserveGas(role: SignRole, amountWei: bigint): Promise<void>;
  insertArtifact(input: {
    id: string;
    signRequestId: string;
    artifactHash: Hex;
    signature: Hex | null;
    rawTransaction: Hex | null;
    maxCostWei: bigint | null;
  }): Promise<void>;
  /** Marks the request SIGNED and moves a PREPARED intent to SIGNED. */
  markSigned(signRequestId: string, intentId: string): Promise<void>;
  markRejected(signRequestId: string, code: string): Promise<void>;
  audit(input: {
    actor: string;
    action: string;
    resource: string;
    reason: string;
    requestId: string;
  }): Promise<void>;
}
export interface SignerStore {
  run<T>(work: (tx: SignerTransaction) => Promise<T>): Promise<T>;
  loadDeployment(
    deploymentId: string,
  ): Promise<{ manifest: unknown; enabled: boolean } | null>;
}

export type AttemptStatus =
  | "SIGNED"
  | "SUBMITTED"
  | "INCLUDED"
  | "FINALIZED"
  | "REVERTED"
  | "REPLACED"
  | "UNKNOWN"
  | "REORGED";
export interface AttemptRecord {
  id: string;
  intentId: string;
  artifactId: string;
  txHash: Hex;
  nonce: bigint;
  replacementOf: string | null;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  maxCostWei: bigint;
  status: AttemptStatus;
  receiptBlockHash: Hex | null;
  receiptBlockNumber: bigint | null;
  gasSpentWei: bigint | null;
  submittedAt: Date | null;
  version: number;
}
export interface DispatchSnapshot {
  intent: IntentRecord;
  signRequests: SignRequestRecord[];
  artifacts: ArtifactRecord[];
  attempts: AttemptRecord[];
  /** The store clock (business time) at read time. */
  now: Date;
}
export interface AttemptPatch {
  status: AttemptStatus;
  receiptBlockHash?: Hex | null;
  receiptBlockNumber?: bigint | null;
  gasSpentWei?: bigint;
  /** Stamps the store (business) clock; only a broadcast sets it. */
  submittedAt?: "now";
}
export interface DispatchTransaction {
  /** Locks the intent row until the transaction ends. */
  snapshot(intentId: string): Promise<DispatchSnapshot | null>;
  /** Idempotent on artifact_id and tx_hash. */
  insertAttempt(
    attempt: Omit<
      AttemptRecord,
      | "status"
      | "receiptBlockHash"
      | "receiptBlockNumber"
      | "gasSpentWei"
      | "submittedAt"
      | "version"
    >,
  ): Promise<void>;
  /** Optimistic update; false when another dispatcher moved the attempt first. */
  updateAttempt(
    id: string,
    expectedVersion: number,
    patch: AttemptPatch,
  ): Promise<boolean>;
  setIntentState(intentId: string, state: IntentState): Promise<void>;
  /** Moves the attempt's reservation into spent: reserved -= maxCost, spent += spentWei. */
  settleGas(
    artifactId: string,
    maxCostWei: bigint,
    spentWei: bigint,
  ): Promise<void>;
  createSignRequest(input: {
    intentId: string;
    role: SignRole;
    unsignedPayload: Record<string, unknown>;
    requestHash: string;
    policyVersion: string;
    artifactVersion: number;
  }): Promise<{ signRequestId: string }>;
}
export interface DispatchStore {
  run<T>(work: (tx: DispatchTransaction) => Promise<T>): Promise<T>;
}

export type SendRawResult =
  | { state: "ACCEPTED"; hash: Hex }
  | { state: "ALREADY_KNOWN" }
  | { state: "NONCE_TOO_LOW" };
export interface DispatchReceipt {
  status: "success" | "reverted";
  blockHash: Hex;
  blockNumber: bigint;
  /** gasUsed * effectiveGasPrice plus the L1 data fee when the receipt reports one. */
  gasSpentWei: bigint;
}
export interface DispatchRpc {
  sendRawTransaction(raw: Hex): Promise<SendRawResult>;
  getReceipt(hash: Hex): Promise<DispatchReceipt | null>;
  /** The canonical block hash at a height, or null when the chain is shorter. */
  blockHashAt(number: bigint): Promise<Hex | null>;
  /** null when the provider reports no finalized block. */
  finalizedBlockNumber(): Promise<bigint | null>;
}
