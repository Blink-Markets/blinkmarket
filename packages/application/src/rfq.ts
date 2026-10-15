import {
  CHAIN_ID,
  DeploymentManifest,
  IdempotencyHeaders,
  PublicDeployment,
  RfqRequest,
  quoteTypes,
  type ConfigResponse,
} from "@blink/schemas";
import {
  askPriceBps,
  parseQuoteMessage,
  quoteCosts,
  quoteDomain,
  quoteValidity,
  SIGNING_POLICY_VERSION,
} from "@blink/domain";
import type {
  CallEncoder,
  ChainHead,
  ChainSnapshotReader,
  Hex,
  IdentityCrypto,
  IdentityPrincipal,
  IndexCursorRow,
  IndexedMarketRow,
  QuoteRecord,
  RestrictedSigner,
  TradingChainView,
  TradingCursor,
  TradingStore,
  TradingTransaction,
} from "@blink/ports";
import { authenticateIdentity, IdentityError } from "./identity.js";
import type { RouteService, ServiceResponse } from "./route-service.js";
import { quoteRequestHash } from "./signer.js";

const SCOPE = "POST /v1/rfqs";
const MAX_OUTSTANDING_QUOTES = 5;
// The indexer may trail the RPC head by at most this many blocks (its age rule is in the store).
const MAX_INDEXER_LAG_BLOCKS = 3n;

type Limiter = {
  take(
    key: string,
  ): { allowed: true } | { allowed: false; retryAfterSeconds: number };
};
export interface SnapshotSource {
  latest(
    deploymentId: string,
    marketId: string,
  ): Promise<{
    snapshotId: string;
    probabilitySumMillionths: number;
    deadline: Date;
  } | null>;
}

/**
 * The one lag rule: an indexer that is gated, silent for too long (`stale`, on the database clock)
 * or more than three blocks behind the head must not back a quote. A head below the cursor is a
 * lagging provider, which is a different failure.
 */
export function indexerStatus(
  cursor: TradingCursor | null,
  headNumber: bigint,
): "FRESH" | "INDEXER_LAG" | "CHAIN_UNAVAILABLE" {
  if (!cursor) return "INDEXER_LAG";
  if (headNumber < cursor.blockNumber) return "CHAIN_UNAVAILABLE";
  return cursor.gateReason ||
    cursor.stale ||
    headNumber - cursor.blockNumber > MAX_INDEXER_LAG_BLOCKS
    ? "INDEXER_LAG"
    : "FRESH";
}
const finalityOf = (finalized: bigint | null, blockNumber: bigint) =>
  finalized === null
    ? "UNKNOWN"
    : blockNumber <= finalized
      ? "FINALIZED"
      : "INCLUDED";

const rejection = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): ServiceResponse => ({
  status,
  body: { code, message: code, retryable: false, details },
});
const noQuote = (reason: string) => rejection(409, "NO_QUOTE", { reason });
// Transient: rolled back with the idempotency claim, so the same key can be tried again.
const unavailable = (code: string, reason?: string) =>
  new IdentityError(503, code, {
    retryable: true,
    retryAfterSeconds: 1,
    ...(reason ? { details: { reason } } : {}),
  });
type Rfq = ReturnType<typeof RfqRequest.parse>;

function quoteMessage(input: {
  marketId: bigint;
  specHash: string;
  maker: string;
  taker: string;
  side: "YES" | "NO";
  quantity: bigint;
  priceBps: number;
  validAfter: bigint;
  expiresAt: bigint;
  nonce: bigint;
  epoch: bigint;
}): Record<string, string> {
  return {
    marketId: String(input.marketId),
    specHash: input.specHash.toLowerCase(),
    maker: input.maker.toLowerCase(),
    taker: input.taker.toLowerCase(),
    side: input.side === "YES" ? "0" : "1",
    quantity: String(input.quantity),
    priceBps: String(input.priceBps),
    validAfter: String(input.validAfter),
    expiresAt: String(input.expiresAt),
    nonce: String(input.nonce),
    epoch: String(input.epoch),
  };
}

export function createRfqService(deps: {
  store: TradingStore;
  crypto: IdentityCrypto;
  signer: RestrictedSigner;
  /** Must match the signer transport timeout. */
  signerTimeoutMs?: number;
  chain: ChainSnapshotReader;
  snapshots: SnapshotSource;
  /** The one canonical calldata encoder; application code cannot import adapters. */
  encodeCall: CallEncoder;
  deploymentId: string;
  random(): bigint;
  limiter: Limiter;
}): RouteService {
  const finish = async (
    tx: TradingTransaction,
    principal: IdentityPrincipal,
    key: string,
    response: ServiceResponse,
  ) => {
    await tx.finishRequest(principal.operatorId, SCOPE, key, {
      status: response.status,
      body: response.body as Record<string, unknown>,
    });
    return { kind: "respond", response } as const;
  };

  /** The SignedQuoteResponse for a stored quote and the signature the signer produced. */
  async function envelopeOf(
    tx: TradingTransaction,
    quote: QuoteRecord,
    signature: string,
  ): Promise<Record<string, unknown>> {
    const dep = await tx.deployment(quote.deploymentId);
    const manifest = DeploymentManifest.parse(dep?.manifest);
    const market = await tx.market(quote.deploymentId, quote.marketId);
    const cursor = await tx.cursor(quote.deploymentId);
    if (!market || !cursor) throw new Error("QUOTE_CONTEXT_MISSING");
    const message = quoteMessage({
      ...quote,
      maker: manifest.roles.maker,
    });
    // The envelope must carry exactly what was signed.
    if (quoteRequestHash(manifest, message) !== quote.digest)
      throw new Error("QUOTE_DIGEST_MISMATCH");
    const domain = quoteDomain(manifest);
    return {
      deploymentId: quote.deploymentId,
      quoteId: quote.digest,
      marketId: String(quote.marketId),
      mode: market.mode,
      chainId: CHAIN_ID,
      verifyingContract: domain.verifyingContract,
      domain,
      types: quoteTypes,
      message,
      signature,
      takerCostMicros: String(quote.takerCostMicros),
      makerCostMicros: String(quote.makerCostMicros),
      expiresAt: String(quote.expiresAt),
      calldata: deps.encodeCall({
        to: domain.verifyingContract,
        functionName: "fillQuote",
        args: [parseQuoteMessage(message)!, signature],
      }),
      forecastSnapshotId: quote.forecastSnapshotId,
      chainCursor: {
        blockNumber: String(quote.snapshotBlockNumber),
        blockHash: quote.snapshotBlockHash,
        finality: finalityOf(cursor.finalizedNumber, quote.snapshotBlockNumber),
      },
    };
  }

  type Admission =
    | { kind: "respond"; response: ServiceResponse }
    | { kind: "sign"; quote: QuoteRecord };

  // Transaction A: everything up to and including the reservation, under one idempotency claim.
  async function admit(
    tx: TradingTransaction,
    caller: { principal: IdentityPrincipal; taker: Hex },
    key: string,
    body: Rfq,
    snapshot: Awaited<ReturnType<SnapshotSource["latest"]>>,
  ): Promise<Admission> {
    const { principal, taker } = caller;
    const payloadHash = deps.crypto.hash(
      JSON.stringify({
        keyId: principal.keyId,
        body: {
          deploymentId: body.deploymentId,
          marketId: body.marketId,
          side: body.side,
          quantity: body.quantity,
          maxCostMicros: body.maxCostMicros,
        },
      }),
    );
    const claim = await tx.claimRequest(
      principal.operatorId,
      SCOPE,
      key,
      payloadHash,
    );
    if (claim.state === "DONE")
      return { kind: "respond", response: claim.result };
    if (claim.state === "CONFLICT")
      throw new IdentityError(409, "IDEMPOTENCY_CONFLICT");
    if (claim.state === "BUSY") {
      const storedHash = await tx.requestPayloadHash(
        principal.operatorId,
        SCOPE,
        key,
      );
      if (storedHash === null)
        throw new IdentityError(409, "REQUEST_IN_PROGRESS");
      if (storedHash !== payloadHash)
        throw new IdentityError(409, "IDEMPOTENCY_CONFLICT");
      const existing = await tx.quoteByKey(principal.operatorId, key);
      // A crash can leave Transaction A committed without any signing outcome recorded.
      const staleRequested =
        existing?.status === "SIGN_REQUESTED" &&
        (await tx.now()).getTime() - existing.updatedAt.getTime() >
          (deps.signerTimeoutMs ?? 5000);
      if (existing?.status === "SIGN_UNKNOWN" || staleRequested)
        return { kind: "sign", quote: existing };
      // It expired (by block time) before a signature was ever seen: nothing can come of this key.
      if (
        existing &&
        !existing.envelope &&
        ["EXPIRED", "CANCELLED", "CONSUMED"].includes(existing.status)
      )
        return finish(tx, principal, key, noQuote("QUOTE_EXPIRED"));
      throw new IdentityError(409, "REQUEST_IN_PROGRESS");
    }
    const stop = (response: ServiceResponse) =>
      finish(tx, principal, key, response);

    // Deployment (Rule 3).
    if (body.deploymentId !== deps.deploymentId)
      return stop(rejection(409, "DEPLOYMENT_MISMATCH"));
    const dep = await tx.deployment(deps.deploymentId);
    const parsedManifest = DeploymentManifest.safeParse(dep?.manifest);
    if (
      !dep?.enabled ||
      !parsedManifest.success ||
      !parsedManifest.data.tradingEnabled
    )
      throw unavailable("SERVICE_NOT_READY", "TRADING_DISABLED");
    const manifest = parsedManifest.data;
    const marketId = BigInt(body.marketId);
    const market = await tx.market(deps.deploymentId, marketId);
    if (!market) return stop(rejection(404, "NOT_FOUND"));

    // Freshness (Rule 4).
    const cursor = await tx.cursor(deps.deploymentId);
    let head: ChainHead;
    try {
      head = await deps.chain.head();
    } catch {
      throw unavailable("CHAIN_UNAVAILABLE");
    }
    const status = indexerStatus(cursor, head.number);
    if (status !== "FRESH") throw unavailable(status);
    const fresh = cursor!;
    const gated = await tx.poolGate(deps.deploymentId);
    if (gated) throw unavailable("SERVICE_NOT_READY", gated);

    // The chain at the head's block (Rule 5).
    let view: TradingChainView;
    try {
      view = await deps.chain.read({ blockHash: head.hash, marketId, taker });
    } catch {
      throw unavailable("CHAIN_UNAVAILABLE");
    }
    const quantity = BigInt(body.quantity);
    if (view.globalTradingPaused || view.market.paused)
      return stop(rejection(409, "TRADING_PAUSED"));
    if (view.market.state !== "OPEN" || head.timestamp >= view.market.closeAt)
      return stop(rejection(409, "MARKET_CLOSED"));
    if (!view.takerAllowed) return stop(noQuote("TAKER_NOT_ALLOWED"));
    if (
      view.market.totalMintedPairs + quantity > view.market.maxPairs ||
      view.cumulativeTakerShares + quantity > view.market.maxTakerShares
    )
      return stop(noQuote("CAP_EXCEEDED"));
    const gates = await tx.openGates(deps.deploymentId, marketId);
    if (gates[0]) return stop(noQuote(gates[0]));

    // Price (Rule 6).
    if (!snapshot) return stop(rejection(409, "STALE_FORECAST"));
    const priceBps = askPriceBps({
      probabilitySumMillionths: snapshot.probabilitySumMillionths,
      side: body.side,
      spreadBps: manifest.parameters.makerSpreadBps,
    });
    const costs = quoteCosts(quantity, priceBps);
    if (costs.takerCostMicros > BigInt(body.maxCostMicros))
      return stop(
        rejection(409, "PRICE_LIMIT_EXCEEDED", {
          priceBps: String(priceBps),
          takerCostMicros: String(costs.takerCostMicros),
        }),
      );
    const validity = quoteValidity({
      headTimestamp: head.timestamp,
      closeAt: view.market.closeAt,
      ttlSeconds: BigInt(manifest.parameters.quoteDefaultTtlSeconds),
    });
    if (!validity.usable) return stop(noQuote("TOO_CLOSE_TO_CLOSE"));
    const nonce = deps.random();
    const message = quoteMessage({
      marketId,
      specHash: market.specHash,
      maker: manifest.roles.maker,
      taker,
      side: body.side,
      quantity,
      priceBps,
      validAfter: validity.validAfter,
      expiresAt: validity.expiresAt,
      nonce,
      epoch: view.makerEpoch,
    });
    const digest = quoteRequestHash(manifest, message);

    // The pool lock serializes quoting and reconciliation; what follows is decided under it.
    const pool = await tx.lockPool(deps.deploymentId);
    if (pool.gateReason)
      throw unavailable("SERVICE_NOT_READY", pool.gateReason);
    // A settled reservation whose block was reorged away is not evidence of anything yet.
    if (await tx.needsReconcile(deps.deploymentId))
      throw unavailable("SERVICE_NOT_READY", "RECONCILE_REQUIRED");
    const lockedGates = await tx.openGates(deps.deploymentId, marketId);
    if (lockedGates[0]) return stop(noQuote(lockedGates[0]));
    if (
      (await tx.outstandingQuotes(
        deps.deploymentId,
        taker,
        fresh.blockTimestamp,
      )) >= MAX_OUTSTANDING_QUOTES
    )
      return stop(noQuote("OUTSTANDING_QUOTE_LIMIT"));
    const available =
      view.makerFreeMicros -
      (await tx.reservedMicros(deps.deploymentId, head.number));
    if (costs.makerCostMicros > available)
      return stop(rejection(409, "INSUFFICIENT_MAKER_BALANCE"));

    const quote = {
      id: deps.crypto.id(),
      operatorId: principal.operatorId,
      idempotencyKey: key,
      deploymentId: deps.deploymentId,
      marketId,
      agentId: principal.agentId,
      keyId: principal.keyId,
      taker,
      side: body.side,
      quantity,
      priceBps,
      takerCostMicros: costs.takerCostMicros,
      makerCostMicros: costs.makerCostMicros,
      maxCostMicros: BigInt(body.maxCostMicros),
      validAfter: validity.validAfter,
      expiresAt: validity.expiresAt,
      nonce,
      epoch: view.makerEpoch,
      specHash: market.specHash,
      digest,
      forecastSnapshotId: snapshot.snapshotId,
      snapshotBlockNumber: head.number,
      snapshotBlockHash: head.hash,
    };
    const { signRequestId } = await tx.createQuote({
      ...quote,
      reservationId: deps.crypto.id(),
      message,
      policyVersion: SIGNING_POLICY_VERSION,
    });
    return {
      kind: "sign",
      quote: {
        ...quote,
        signRequestId,
        updatedAt: await tx.now(),
        status: "SIGN_REQUESTED",
        envelope: null,
      },
    };
  }

  // Transaction B, after the signer answered.
  async function conclude(
    caller: { principal: IdentityPrincipal },
    key: string,
    quote: QuoteRecord,
  ): Promise<ServiceResponse> {
    const { principal } = caller;
    const outcome = await deps.signer.sign({
      signRequestId: quote.signRequestId,
      expectedRequestHash: quote.digest,
    });
    if (outcome.state === "REJECTED") {
      // Never signed, so the collateral can go back at once.
      return deps.store.run(async (tx) => {
        await tx.markSignRejected(quote.id, outcome.code);
        return (
          await finish(
            tx,
            principal,
            key,
            rejection(409, "NO_QUOTE", {
              reason: "SIGNER_REJECTED",
              signerCode: outcome.code,
            }),
          )
        ).response;
      });
    }
    if (
      outcome.state !== "SIGNED" ||
      typeof outcome.signature !== "string" ||
      outcome.artifactHash.toLowerCase() !== quote.digest
    ) {
      // The signer may have signed and committed: the reservation stays, the same request is asked again.
      await deps.store.run((tx) => tx.markSignUnknown(quote.id));
      throw unavailable("SERVICE_NOT_READY", "SIGN_UNKNOWN");
    }
    const signature = outcome.signature;
    return deps.store.run(async (tx) => {
      const current = await tx.lockQuote(quote.id);
      if (!current) throw new Error("QUOTE_MISSING");
      // A concurrent retry may have finished first: its envelope is the answer.
      if (current.status === "SIGNED" && current.envelope)
        return (
          await finish(tx, principal, key, {
            status: 200,
            body: current.envelope,
          })
        ).response;
      if (
        current.status !== "SIGN_REQUESTED" &&
        current.status !== "SIGN_UNKNOWN"
      )
        return (await finish(tx, principal, key, noQuote("QUOTE_EXPIRED")))
          .response;
      const envelope = await envelopeOf(tx, current, signature);
      await tx.markSigned(current.id, envelope);
      return (await finish(tx, principal, key, { status: 200, body: envelope }))
        .response;
    });
  }

  async function createRfq(request: {
    body: unknown;
    authorization: string | undefined;
    idempotencyKey: string | undefined;
  }): Promise<ServiceResponse> {
    const parsed = RfqRequest.safeParse(request.body);
    if (
      !parsed.success ||
      !IdempotencyHeaders.safeParse({
        "idempotency-key": request.idempotencyKey,
      }).success
    )
      throw new IdentityError(400, "INVALID_REQUEST");
    const body = parsed.data;
    const key = request.idempotencyKey!;
    const caller = await deps.store.run(async (tx) => {
      const principal = await authenticateIdentity(
        tx,
        deps.crypto,
        request.authorization,
        "trade:quote",
      );
      const wallet = await tx.wallet(principal.agentId);
      if (!wallet) throw new IdentityError(403, "WALLET_NOT_VERIFIED");
      return { principal, taker: wallet.toLowerCase() as Hex };
    });
    const taken = deps.limiter.take(caller.principal.keyId);
    if (!taken.allowed)
      throw new IdentityError(429, "RATE_LIMITED", {
        retryable: true,
        retryAfterSeconds: taken.retryAfterSeconds,
      });
    // Read on its own connection, so it cannot be part of the admission transaction.
    const snapshot =
      body.deploymentId === deps.deploymentId
        ? await deps.snapshots.latest(deps.deploymentId, body.marketId)
        : null;
    const admission = await deps.store.run((tx) =>
      admit(tx, caller, key, body, snapshot),
    );
    if (admission.kind === "respond") return admission.response;
    return conclude(caller, key, admission.quote);
  }

  async function getQuote(request: {
    params: Record<string, string>;
    authorization: string | undefined;
  }): Promise<ServiceResponse> {
    return deps.store.run(async (tx) => {
      const principal = await authenticateIdentity(
        tx,
        deps.crypto,
        request.authorization,
      );
      const quote = await tx.quoteByDigest(
        deps.deploymentId,
        request.params.quoteId!,
      );
      // A quote that was never signed has no envelope to show; a stranger's quote does not exist.
      if (
        !quote?.envelope ||
        (quote.agentId !== principal.agentId &&
          !principal.scopes.includes("admin"))
      )
        throw new IdentityError(404, "NOT_FOUND");
      const cursor = await tx.cursor(deps.deploymentId);
      if (!cursor) throw unavailable("INDEXER_LAG");
      const chain = await tx.quoteChainState(deps.deploymentId, quote.digest);
      // Canonical state only: block time, never the host clock, ends a quote.
      const status =
        chain.digest === "FILLED"
          ? "CONSUMED"
          : chain.digest === "CANCELLED" ||
              (chain.makerEpoch !== null && chain.makerEpoch > quote.epoch)
            ? "CANCELLED"
            : cursor.blockTimestamp >= quote.expiresAt
              ? "EXPIRED"
              : "SIGNED";
      return {
        status: 200,
        body: {
          quote: quote.envelope,
          status,
          chainCursor: {
            blockNumber: String(cursor.blockNumber),
            blockHash: cursor.blockHash,
            finality: finalityOf(cursor.finalizedNumber, cursor.blockNumber),
          },
        },
      };
    });
  }

  return {
    paths: ["/v1/rfqs", "/v1/quotes/:quoteId"],
    handle: (request) =>
      request.path === "/v1/rfqs" ? createRfq(request) : getQuote(request),
  };
}

/**
 * What the public surface says about trading: `/v1/config` and the markets' `canTrade`. Both use
 * the same gates as an RFQ, judged from the database (the indexer's last observed head stands in
 * for the RPC head, so these reads never call the RPC).
 */
export function createTradingReadiness(deps: {
  store: TradingStore;
  snapshots: SnapshotSource;
  deploymentId: string;
}) {
  async function deploymentGates(tx: TradingTransaction, deploymentId: string) {
    const dep = await tx.deployment(deploymentId);
    const parsed = DeploymentManifest.safeParse(dep?.manifest);
    const manifest = parsed.success ? parsed.data : null;
    const reasons: string[] = [];
    if (!dep?.enabled || !manifest?.tradingEnabled)
      reasons.push("TRADING_DISABLED");
    const cursor = await tx.cursor(deploymentId);
    if (indexerStatus(cursor, cursor?.headNumber ?? 0n) !== "FRESH")
      reasons.push("INDEXER_LAG");
    if (await tx.poolGate(deploymentId)) reasons.push("SERVICE_NOT_READY");
    return { manifest, reasons };
  }
  return {
    async config(): Promise<ConfigResponse> {
      const { manifest, reasons } = await deps.store.run((tx) =>
        deploymentGates(tx, deps.deploymentId),
      );
      return {
        chainId: CHAIN_ID,
        stage: "m2-trading",
        tradingEnabled: reasons.length === 0,
        deployment: manifest
          ? PublicDeployment.parse({
              deploymentId: manifest.deploymentId,
              chainId: manifest.chainId,
              deploymentBlock: manifest.deploymentBlock,
              contracts: manifest.contracts,
              artifacts: {
                abiHashes: manifest.artifacts.abiHashes,
                bytecodeHashes: manifest.artifacts.bytecodeHashes,
              },
              roles: manifest.roles,
              parameters: manifest.parameters,
            })
          : null,
        asset: {
          name: "Blink Test USD",
          symbol: "bUSD",
          decimals: 6,
          hasValue: false,
        },
      };
    },
    /** The market read service's `hooks.canTrade`. */
    async canTrade(
      market: IndexedMarketRow,
      _cursor: IndexCursorRow | null,
    ): Promise<{ canTrade: boolean; reasons: string[] }> {
      const { reasons, gates } = await deps.store.run(async (tx) => ({
        ...(await deploymentGates(tx, market.deploymentId)),
        gates: await tx.openGates(market.deploymentId, BigInt(market.marketId)),
      }));
      if (market.effectiveState !== "OPEN") reasons.push("MARKET_CLOSED");
      if (market.paused) reasons.push("TRADING_PAUSED");
      reasons.push(...gates);
      if (!(await deps.snapshots.latest(market.deploymentId, market.marketId)))
        reasons.push("NO_FORECAST");
      return { canTrade: reasons.length === 0, reasons };
    },
  };
}
