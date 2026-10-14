import type { DeploymentManifest } from "@blink/schemas";

// Pure signer policy. Everything here decides from values the signer reloaded itself; nothing
// trusts a caller's claim of authorization. Rejection codes are part of the signer protocol.
export type SignRole = "maker" | "trader" | "keeper" | "faucet";
export type IntentKind =
  | "MAKER_QUOTE"
  | "APPROVE"
  | "FILL"
  | "REDEEM"
  | "MINT"
  | "FINALIZE_UNCHALLENGED"
  | "FINALIZE_TIMEOUT";
export const signRoles = ["maker", "trader", "keeper", "faucet"] as const;
export const intentKinds = [
  "MAKER_QUOTE",
  "APPROVE",
  "FILL",
  "REDEEM",
  "MINT",
  "FINALIZE_UNCHALLENGED",
  "FINALIZE_TIMEOUT",
] as const;
export const SIGNING_POLICY_VERSION = "signer-policy-v1";

export const signingLimits = {
  maxQuoteLifetimeSeconds: 60n,
  quoteClockMarginSeconds: 2n,
  maxQuoteQuantity: 100n,
  maxMintMicros: 1_000_000_000n,
  maxApproveMicros: 100_000_000n,
  // 0.0002 ETH per transaction and 0.002 ETH per role per UTC day, L1 data fee included.
  perTxCapWei: 200_000_000_000_000n,
  dailyCapWei: 2_000_000_000_000_000n,
} as const;

export type Rejection = { ok: false; code: string };
export type PolicyManifest = Pick<
  DeploymentManifest,
  "contracts" | "roles" | "tradingEnabled"
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
) => {
  const present = Object.keys(value);
  return (
    present.length === keys.length && keys.every((k) => Object.hasOwn(value, k))
  );
};
// Decimal strings only: the wire never carries JSON numbers for chain integers.
function uint(value: unknown, bits: bigint): bigint | null {
  if (
    typeof value !== "string" ||
    value.length > 78 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  )
    return null;
  const parsed = BigInt(value);
  return parsed < 1n << bits ? parsed : null;
}
const addressOf = (value: unknown) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
const lower = (value: string) => value.toLowerCase();

/** Stable JSON with sorted keys, used to hash request payloads. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((item) => canonicalJson(item)).join(",") + "]";
  if (isRecord(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]))
        .join(",") +
      "}"
    );
  throw new Error("CANONICAL_JSON_UNSUPPORTED");
}

export function intentRole(kind: IntentKind): SignRole {
  return kind === "MAKER_QUOTE"
    ? "maker"
    : kind === "MINT"
      ? "faucet"
      : kind === "FINALIZE_UNCHALLENGED" || kind === "FINALIZE_TIMEOUT"
        ? "keeper"
        : "trader";
}

export function quoteDomain(manifest: Pick<PolicyManifest, "contracts">) {
  return {
    name: "Blink RFQ",
    version: "0.1",
    chainId: 84532,
    verifyingContract: manifest.contracts.BlinkMarket as `0x${string}`,
  } as const;
}

export type QuoteMessage = {
  marketId: bigint;
  specHash: string;
  maker: string;
  taker: string;
  side: 0 | 1;
  quantity: bigint;
  priceBps: bigint;
  validAfter: bigint;
  expiresAt: bigint;
  nonce: bigint;
  epoch: bigint;
};
const quoteKeys = [
  "marketId",
  "specHash",
  "maker",
  "taker",
  "side",
  "quantity",
  "priceBps",
  "validAfter",
  "expiresAt",
  "nonce",
  "epoch",
] as const;

/** The Quote struct with decimal-string integers; null for anything else. */
export function parseQuoteMessage(input: unknown): QuoteMessage | null {
  if (!isRecord(input) || !hasExactKeys(input, quoteKeys)) return null;
  const marketId = uint(input.marketId, 256n);
  const quantity = uint(input.quantity, 64n);
  const priceBps = uint(input.priceBps, 16n);
  const validAfter = uint(input.validAfter, 64n);
  const expiresAt = uint(input.expiresAt, 64n);
  const nonce = uint(input.nonce, 256n);
  const epoch = uint(input.epoch, 256n);
  const maker = addressOf(input.maker);
  const taker = addressOf(input.taker);
  const specHash =
    typeof input.specHash === "string" &&
    /^0x[0-9a-fA-F]{64}$/.test(input.specHash)
      ? lower(input.specHash)
      : null;
  if (input.side !== "0" && input.side !== "1") return null;
  if (
    marketId === null ||
    quantity === null ||
    priceBps === null ||
    validAfter === null ||
    expiresAt === null ||
    nonce === null ||
    epoch === null ||
    maker === null ||
    taker === null ||
    specHash === null
  )
    return null;
  return {
    marketId,
    specHash,
    maker,
    taker,
    side: input.side === "0" ? 0 : 1,
    quantity,
    priceBps,
    validAfter,
    expiresAt,
    nonce,
    epoch,
  };
}

export function checkMakerQuote(input: {
  manifest: PolicyManifest;
  makerAddress: string;
  deploymentEnabled: boolean;
  nowMs: number;
  message: unknown;
  market: { state: string; closeAt: bigint; specHash: string } | null;
  epoch: bigint | null;
}): { ok: true; quote: QuoteMessage } | Rejection {
  const reject = (code: string): Rejection => ({ ok: false, code });
  if (!input.deploymentEnabled) return reject("DEPLOYMENT_DISABLED");
  if (!input.manifest.tradingEnabled) return reject("TRADING_DISABLED");
  const quote = parseQuoteMessage(input.message);
  if (!quote) return reject("QUOTE_INVALID");
  const maker = lower(input.makerAddress);
  if (quote.maker !== maker || maker !== lower(input.manifest.roles.maker))
    return reject("MAKER_NOT_ALLOWED");
  const lifetime = quote.expiresAt - quote.validAfter;
  if (lifetime < 1n || lifetime > signingLimits.maxQuoteLifetimeSeconds)
    return reject("QUOTE_LIFETIME_INVALID");
  // The signer clock must be strictly below expiresAt minus the margin.
  const latestMs =
    (quote.expiresAt - signingLimits.quoteClockMarginSeconds) * 1000n;
  if (BigInt(Math.floor(input.nowMs)) >= latestMs)
    return reject("QUOTE_EXPIRED");
  if (!input.market) return reject("MARKET_NOT_FOUND");
  if (input.market.state !== "OPEN") return reject("MARKET_NOT_OPEN");
  if (quote.expiresAt > input.market.closeAt)
    return reject("QUOTE_AFTER_CLOSE");
  if (lower(input.market.specHash) !== quote.specHash)
    return reject("SPEC_HASH_MISMATCH");
  if (input.epoch === null || input.epoch !== quote.epoch)
    return reject("EPOCH_MISMATCH");
  if (quote.quantity < 1n || quote.quantity > signingLimits.maxQuoteQuantity)
    return reject("QUANTITY_NOT_ALLOWED");
  if (quote.priceBps < 1n || quote.priceBps > 9999n)
    return reject("PRICE_NOT_ALLOWED");
  return { ok: true, quote };
}

type CallShape = { to: string; functionName: string; args: unknown[] };
export type AllowedCall =
  | {
      to: string;
      functionName: "approve";
      args: [spender: string, amount: bigint];
    }
  | { to: string; functionName: "mint"; args: [to: string, amount: bigint] }
  | {
      to: string;
      functionName: "fillQuote";
      args: [quote: QuoteMessage, signature: string];
    }
  | {
      to: string;
      functionName: "redeem" | "finalizeUnchallenged" | "finalizeTimeout";
      args: [id: bigint];
    };
type TransactionKind = Exclude<IntentKind, "MAKER_QUOTE">;
const kindRules: Record<
  TransactionKind,
  { target: "token" | "market"; functionName: AllowedCall["functionName"] }
> = {
  APPROVE: { target: "token", functionName: "approve" },
  MINT: { target: "token", functionName: "mint" },
  FILL: { target: "market", functionName: "fillQuote" },
  REDEEM: { target: "market", functionName: "redeem" },
  FINALIZE_UNCHALLENGED: {
    target: "market",
    functionName: "finalizeUnchallenged",
  },
  FINALIZE_TIMEOUT: { target: "market", functionName: "finalizeTimeout" },
};
const callKeys = ["to", "functionName", "args"] as const;
const feeKeys = ["maxFeePerGas", "maxPriorityFeePerGas"] as const;

function callShape(payload: unknown): CallShape | null {
  if (!isRecord(payload) || !hasExactKeys(payload, callKeys)) return null;
  const { to, functionName, args } = payload;
  if (
    addressOf(to) === null ||
    typeof functionName !== "string" ||
    !Array.isArray(args)
  )
    return null;
  return { to: lower(to as string), functionName, args };
}

export type FeeFields = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
/**
 * A sign request's payload is exactly {to, functionName, args}; a replacement version adds
 * the two fee fields and nothing else. Returns null for any other shape.
 */
export function parseTransactionPayload(
  payload: unknown,
  replacement: boolean,
): { call: Record<string, unknown>; fees: FeeFields | null } | null {
  if (!isRecord(payload)) return null;
  if (!replacement) {
    return hasExactKeys(payload, callKeys)
      ? { call: payload, fees: null }
      : null;
  }
  if (!hasExactKeys(payload, [...callKeys, ...feeKeys])) return null;
  const maxFee = uint(payload.maxFeePerGas, 256n);
  const priority = uint(payload.maxPriorityFeePerGas, 256n);
  // Presence, not positivity: a zero tip is a valid EIP-1559 field. Whether the pair is an
  // acceptable replacement is replacementFeesAccepted's call.
  if (maxFee === null || priority === null) return null;
  const { maxFeePerGas: _a, maxPriorityFeePerGas: _b, ...call } = payload;
  return {
    call,
    fees: { maxFeePerGas: maxFee, maxPriorityFeePerGas: priority },
  };
}

export function checkTransactionCall(input: {
  manifest: PolicyManifest;
  addresses: Partial<Record<SignRole, string>>;
  role: SignRole;
  kind: IntentKind;
  payload: unknown;
}): { ok: true; call: AllowedCall } | Rejection {
  const reject = (code: string): Rejection => ({ ok: false, code });
  const { manifest, kind, role } = input;
  if (kind === "MAKER_QUOTE" || intentRole(kind) !== role)
    return reject("INTENT_MISMATCH");
  const shape = callShape(input.payload);
  if (!shape) return reject("PAYLOAD_INVALID");
  const rule = kindRules[kind];
  if (shape.functionName !== rule.functionName)
    return reject("SELECTOR_NOT_ALLOWED");
  const market = lower(manifest.contracts.BlinkMarket);
  const token = lower(manifest.contracts.BlinkTestUSD);
  const target = rule.target === "market" ? market : token;
  if (shape.to !== target) return reject("TARGET_NOT_ALLOWED");
  const { args } = shape;
  switch (rule.functionName) {
    case "redeem":
    case "finalizeUnchallenged":
    case "finalizeTimeout": {
      const id = args.length === 1 ? uint(args[0], 256n) : null;
      if (id === null || id === 0n) return reject("PAYLOAD_INVALID");
      return {
        ok: true,
        call: { to: target, functionName: rule.functionName, args: [id] },
      };
    }
    case "mint": {
      const to = args.length === 2 ? addressOf(args[0]) : null;
      const amount = args.length === 2 ? uint(args[1], 256n) : null;
      if (to === null || amount === null) return reject("PAYLOAD_INVALID");
      if (amount > signingLimits.maxMintMicros)
        return reject("AMOUNT_NOT_ALLOWED");
      return {
        ok: true,
        call: { to: target, functionName: "mint", args: [to, amount] },
      };
    }
    case "approve": {
      const spender = args.length === 2 ? addressOf(args[0]) : null;
      const amount = args.length === 2 ? uint(args[1], 256n) : null;
      if (spender === null || amount === null) return reject("PAYLOAD_INVALID");
      if (spender !== market) return reject("TARGET_NOT_ALLOWED");
      // Never unlimited: a bounded, strictly positive allowance only.
      if (amount === 0n || amount > signingLimits.maxApproveMicros)
        return reject("AMOUNT_NOT_ALLOWED");
      return {
        ok: true,
        call: { to: target, functionName: "approve", args: [spender, amount] },
      };
    }
    case "fillQuote": {
      const quote = args.length === 2 ? parseQuoteMessage(args[0]) : null;
      const signature = args.length === 2 ? args[1] : null;
      if (
        quote === null ||
        typeof signature !== "string" ||
        !/^0x[0-9a-fA-F]{130}$/.test(signature)
      )
        return reject("PAYLOAD_INVALID");
      const trader = input.addresses.trader;
      if (!trader || quote.taker !== lower(trader))
        return reject("TAKER_NOT_ALLOWED");
      if (quote.maker !== lower(manifest.roles.maker))
        return reject("MAKER_NOT_ALLOWED");
      return {
        ok: true,
        call: {
          to: target,
          functionName: "fillQuote",
          args: [quote, signature],
        },
      };
    }
  }
}

export const gasLimitFor = (estimate: bigint) => (estimate * 12n) / 10n;
export const maxFeePerGas = (baseFee: bigint, priorityFee: bigint) =>
  2n * baseFee + priorityFee;

export function checkGasCaps(input: {
  maxCost: bigint;
  reservedWei: bigint;
  spentWei: bigint;
  perTxCapWei: bigint;
  dailyCapWei: bigint;
}): "GAS_CAP_EXCEEDED" | "GAS_DAILY_CAP_EXCEEDED" | null {
  if (input.maxCost > input.perTxCapWei) return "GAS_CAP_EXCEEDED";
  if (input.reservedWei + input.spentWei + input.maxCost > input.dailyCapWei)
    return "GAS_DAILY_CAP_EXCEEDED";
  return null;
}

/** The smallest tip a replacement of a zero-tip transaction may use (1 gwei). */
export const minReplacementTipWei = 1_000_000_000n;
const ceilBump = (value: bigint) => (value * 1125n + 999n) / 1000n;

/**
 * The cheapest acceptable replacement of a transaction: both fee fields up by at least 12.5
 * percent (rounded up), a zero tip replaced by the 1 gwei minimum, and never a fee cap below
 * the tip. The dispatcher asks for exactly this; the signer accepts anything at least this high.
 */
export function minimumReplacementFees(prev: FeeFields): FeeFields {
  const tip =
    prev.maxPriorityFeePerGas === 0n
      ? minReplacementTipWei
      : ceilBump(prev.maxPriorityFeePerGas);
  const cap = ceilBump(prev.maxFeePerGas);
  return {
    maxFeePerGas: cap > tip ? cap : tip,
    maxPriorityFeePerGas: tip,
  };
}

export function replacementFeesAccepted(prev: FeeFields, next: FeeFields) {
  const min = minimumReplacementFees(prev);
  return (
    next.maxFeePerGas >= min.maxFeePerGas &&
    next.maxPriorityFeePerGas >= min.maxPriorityFeePerGas &&
    next.maxFeePerGas >= next.maxPriorityFeePerGas
  );
}
