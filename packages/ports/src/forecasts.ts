export type HorizonType = "DAILY" | "PRE_CLOSE";

export interface ForecastWindow {
  id: string;
  marketId: string;
  horizonType: HorizonType;
  scheduledAt: Date;
  openAt: Date;
  deadline: Date;
  /** The Merkle root of the window's leaves, once the worker stored it; null for a window with no answers. */
  merkleRoot: string | null;
  /** Set when the window was closed (root stored or found empty). */
  rootAt: Date | null;
}
export interface StoredForecast {
  submissionId: string;
  windowId: string;
  /** Lowercase wallet address. */
  forecaster: string;
  probabilityBps: number;
  contentHash: string;
  digest: string;
  signature: string;
  verifiedBlock: number;
  receivedAt: Date;
  withdrawnAt: Date | null;
}
export interface NewForecast {
  id: string;
  windowId: string;
  /** The API key and its owner, kept for the audit trail. */
  keyId: string;
  agentId: string;
  operatorId: string;
  requestId: string;
  forecaster: string;
  probabilityBps: number;
  contentHash: string;
  digest: string;
  signature: string;
  /** The block the signature check ran at. */
  verifiedBlock: bigint;
}
export type SubmitResult =
  | { state: "ADMITTED"; receivedAt: Date }
  | { state: "CLOSED" }
  | { state: "DUPLICATE" };
export type WithdrawResult =
  | { state: "WITHDRAWN"; withdrawnAt: Date }
  | { state: "NOT_FOUND" }
  | { state: "CLOSED" };

/** The latest scored LIVE submissions that count toward a forecaster's credit. */
export interface ForecasterStats {
  address: string;
  n: number;
  meanBrier: number | null;
}
export interface WindowCursor {
  scheduledAt: Date;
  horizonType: HorizonType;
}

/**
 * Forecast storage of one protocol deployment. Admission and withdrawal are decided by the
 * database clock under the window's row lock, so neither a slow signature check nor a slow request
 * can admit anything after the deadline.
 */
export interface ForecastStore {
  now(): Promise<Date>;
  windows(
    marketId: string,
    limit: number,
    after: WindowCursor | null,
  ): Promise<ForecastWindow[]>;
  windowById(id: string): Promise<ForecastWindow | null>;
  windowFor(
    marketId: string,
    horizonType: HorizonType,
    scheduledAt: Date,
  ): Promise<ForecastWindow | null>;
  submissionOf(
    windowId: string,
    forecaster: string,
  ): Promise<StoredForecast | null>;
  submit(input: NewForecast): Promise<SubmitResult>;
  withdraw(submissionId: string, forecaster: string): Promise<WithdrawResult>;
  /** Answers in id order; `forecaster` restricts them to one wallet (the sealed view). */
  submissions(
    windowId: string,
    forecaster: string | null,
    limit: number,
    after: string | null,
  ): Promise<StoredForecast[]>;
  /** Digests of the window's answers that were not withdrawn: the inputs of its tree. */
  digests(windowId: string): Promise<string[]>;
  /** Answers that count toward the consensus (not withdrawn). */
  answers(
    windowId: string,
  ): Promise<{ forecaster: string; probabilityBps: number }[]>;
  /**
   * Credit stats per forecaster that has submitted (or of `forecasters` only). With `at`, only
   * scores recorded by then count: the weights frozen at a window's deadline.
   */
  creditStats(
    forecasters: string[] | null,
    at: Date | null,
  ): Promise<ForecasterStats[]>;
  /** Adds a window the database clock says is still in the future; false when it exists already. */
  addWindow(
    window: Pick<
      ForecastWindow,
      "marketId" | "horizonType" | "scheduledAt" | "openAt" | "deadline"
    >,
  ): Promise<boolean>;
  /** Windows past their deadline whose root was not stored yet, oldest first. */
  dueWindows(limit: number): Promise<string[]>;
  /**
   * Stores the root of a due window under its lock. `rootOf` receives the digests of the answers
   * that stand; false when another worker closed the window first.
   */
  closeWindow(
    id: string,
    rootOf: (digests: string[]) => string | null,
  ): Promise<boolean>;
}
