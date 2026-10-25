import {
  apiContracts,
  IdempotencyHeaders,
  parseMarketSpec,
  RoleName,
  type ProtocolDeployment,
  type ProtocolMarket,
  type SpecResult,
} from "@blink/schemas";
import type {
  ContentStore,
  IdentityPrincipal,
  MarketReadStore,
  ProtocolReader,
  TransactionHint,
} from "@blink/ports";
import type { RouteService, ServiceRequest } from "./route-service.js";
import { IdentityError } from "./identity.js";
import { storedContentResponse } from "./content.js";

const readPaths = [
  "/v1/deployment",
  "/v1/markets",
  "/v1/markets/:id",
  "/v1/markets/:id/spec",
  "/v1/markets/:id/disputes",
  "/v1/disputes/:id",
  "/v1/markets/:id/fees",
  "/v1/accounts/:address",
  "/v1/accounts/:address/positions",
  "/v1/templates",
] as const;
const SPEC_UNAVAILABLE: SpecResult = { ok: false, error: "SPEC_UNAVAILABLE" };

// --- transaction hints: unchanged by the read-model work; Task 9 moves them to protocol tx tracking ---
const hintBody = apiContracts.find(
  (c) => c.method === "POST" && c.path === "/v1/transactions",
)!.body!;
const transactionPaths = ["/v1/transactions", "/v1/transactions/:txHash"];
type TransactionDeps = {
  store: Pick<MarketReadStore, "hint" | "transaction">;
  identity: {
    authenticate(
      authorization: string | undefined,
    ): Promise<IdentityPrincipal & { wallet: string | null }>;
  };
};
async function handleTransaction(deps: TransactionDeps, req: ServiceRequest) {
  const deployment = req.query.deploymentId as string;
  if (req.path === "/v1/transactions") {
    const principal = await deps.identity.authenticate(req.authorization);
    const parsed = hintBody.safeParse(req.body);
    if (
      !parsed.success ||
      !IdempotencyHeaders.safeParse({
        "idempotency-key": req.idempotencyKey,
      }).success
    )
      throw new IdentityError(400, "INVALID_REQUEST");
    const b = parsed.data as TransactionHint;
    const body = {
      deploymentId: b.deploymentId,
      txHash: b.txHash.toLowerCase(),
      action: b.action,
      ...(b.quoteId ? { quoteId: b.quoteId.toLowerCase() } : {}),
    };
    return await deps.store.hint(principal, body, req.idempotencyKey!);
  }
  const t = await deps.store.transaction(deployment, req.params.txHash!);
  if (!t) throw new IdentityError(404, "NOT_FOUND");
  return {
    status: 200,
    body: {
      deploymentId: t.deploymentId,
      txHash: t.txHash,
      status: t.status,
      replacementOf: null,
      chainCursor: t.chainCursor,
      rejectReason: t.rejectReason,
    },
  };
}
// --- end of the transaction-hint group ---

const payout = (m: ProtocolMarket, yes: bigint, no: bigint) =>
  m.state !== "FINAL"
    ? null
    : (m.finalOutcome === "YES"
        ? yes * 1_000_000n
        : m.finalOutcome === "NO"
          ? no * 1_000_000n
          : (yes + no) * 500_000n
      ).toString();

export function createMarketReadService(
  deps: TransactionDeps & {
    reader: ProtocolReader;
    content: Pick<ContentStore, "get">;
    /** The registered manifest of the one deployment this API serves. */
    deployment: () => Promise<ProtocolDeployment | null>;
    /** Unix seconds; credit is decayed to this. */
    now?: () => number;
  },
): RouteService {
  const { reader } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const found = async <T>(value: Promise<T | null>) => {
    const v = await value;
    if (v === null) throw new IdentityError(404, "NOT_FOUND");
    return v;
  };
  // Never throws: a market whose spec cannot be read is still a market.
  async function specOf(m: ProtocolMarket) {
    try {
      const stored = await deps.content.get(m.specHash);
      if (!stored) return { result: SPEC_UNAVAILABLE, stored: null };
      const parsed = parseMarketSpec(stored.bytes);
      return {
        result: parsed.ok
          ? ({ ok: true, spec: parsed.spec } as const)
          : ({ ok: false, error: parsed.reason } as const),
        stored,
      };
    } catch {
      return { result: SPEC_UNAVAILABLE, stored: null };
    }
  }
  const page = (req: ServiceRequest) => ({
    limit: req.query.limit as number,
    ...(req.query.after === undefined
      ? {}
      : { after: req.query.after as string }),
  });
  async function read(req: ServiceRequest) {
    const id = req.params.id,
      address = req.params.address;
    switch (req.path) {
      case "/v1/deployment":
        return {
          deployment: await found(deps.deployment()),
          index: await reader.health(),
        };
      case "/v1/markets": {
        const state = req.query.state as ProtocolMarket["state"] | undefined;
        const { items, next } = await reader.markets({
          ...page(req),
          ...(state ? { states: [state] } : {}),
        });
        return {
          items: await Promise.all(
            items.map(async (market) => ({
              market,
              spec: (await specOf(market)).result,
            })),
          ),
          next,
          index: await reader.health(),
        };
      }
      case "/v1/markets/:id": {
        const market = await found(reader.market(id!));
        return {
          market,
          spec: (await specOf(market)).result,
          proposal: await reader.proposal(market.marketId),
          index: await reader.health(),
        };
      }
      case "/v1/markets/:id/disputes": {
        await found(reader.market(id!));
        return {
          ...(await reader.disputes(id!, page(req))),
          index: await reader.health(),
        };
      }
      case "/v1/disputes/:id": {
        const dispute = await found(reader.dispute(id!)),
          votes = await reader.votes(dispute.disputeId, {
            ...page(req),
            ...(req.query.round === undefined
              ? {}
              : { round: req.query.round as number }),
          });
        return {
          dispute,
          rounds: await reader.rounds(dispute.disputeId),
          // Defence in depth: whatever the reader returned, an unrevealed vote shows no choice.
          votes: votes.items.map((v) => (v.revealed ? v : { ...v, choice: null })),
          next: votes.next,
          index: await reader.health(),
        };
      }
      case "/v1/markets/:id/fees": {
        const market = await found(reader.market(id!));
        return {
          marketId: market.marketId,
          fees: await reader.fees(market.marketId),
          index: await reader.health(),
        };
      }
      case "/v1/accounts/:address": {
        const account = await found(reader.account(address!));
        // The chain clock can run ahead of this host's; never decay to a time before a stored credit.
        const at = Math.max(
          now(),
          ...Object.values(account.credit).map((c) => c.updatedAt),
        );
        const roles = Object.fromEntries(
          await Promise.all(
            RoleName.options.map(async (role) => [
              role,
              {
                hasRole: await reader.hasRole(account.address, role),
                ...account.roles[role]!,
                credit: await reader.creditAt(account.address, role, at),
              },
            ]),
          ),
        );
        return {
          address: account.address.toLowerCase(),
          registered: account.registered,
          creditAt: at,
          roles,
          juror: await reader.juror(account.address),
          index: await reader.health(),
        };
      }
      case "/v1/accounts/:address/positions": {
        const { items, next } = await reader.positions(address!, page(req));
        return {
          items: await Promise.all(
            items.map(async (p) => {
              const market = (await reader.market(p.marketId))!;
              return {
                ...p,
                marketState: market.state,
                finalOutcome: market.finalOutcome,
                payoutMicros: payout(market, BigInt(p.yesShares), BigInt(p.noShares)),
              };
            }),
          ),
          next,
          index: await reader.health(),
        };
      }
      default:
        return { ...(await reader.templates(page(req))), index: await reader.health() };
    }
  }
  async function spec(id: string) {
    const market = await found(reader.market(id));
    const { stored } = await specOf(market);
    if (!stored) throw new IdentityError(503, "SPEC_UNAVAILABLE", { retryable: false });
    return storedContentResponse(stored);
  }
  return {
    paths: [...readPaths, ...transactionPaths],
    async handle(req) {
      try {
        if (transactionPaths.includes(req.path))
          return await handleTransaction(deps, req);
        if (req.path === "/v1/markets/:id/spec") return await spec(req.params.id!);
        return { status: 200, body: (await read(req)) as Record<string, unknown> };
      } catch (error) {
        if (error instanceof IdentityError) throw error;
        const code = error instanceof Error ? error.message : "";
        const status: Record<string, number> = {
          INVALID_PAGE: 400,
          INVALID_MARKET_PAGE: 400,
          UNAUTHORIZED: 401,
          IDEMPOTENCY_CONFLICT: 409,
          REQUEST_IN_PROGRESS: 409,
        };
        if (status[code])
          throw new IdentityError(
            status[code]!,
            code.startsWith("INVALID_") && status[code] === 400 ? "INVALID_CURSOR" : code,
          );
        throw error;
      }
    },
  };
}
