import { apiContracts, IdempotencyHeaders, MarketSpec } from "@blink/schemas";
import type { ChainCursor } from "@blink/schemas";
import type {
  MarketReadStore,
  SpecArchive,
  IdentityPrincipal,
  IndexedMarketRow,
  IndexCursorRow,
  MarketListQuery,
  TransactionHint,
} from "@blink/ports";
import type { RouteService } from "./route-service.js";
import { IdentityError } from "./identity.js";
const hintBody = apiContracts.find(
  (c) => c.method === "POST" && c.path === "/v1/transactions",
)!.body!;
export function createMarketReadService(deps: {
  store: MarketReadStore;
  archive: SpecArchive;
  identity: {
    authenticate(
      authorization: string | undefined,
    ): Promise<IdentityPrincipal & { wallet: string | null }>;
  };
  hooks?: {
    forecastSnapshotId?(
      deploymentId: string,
      marketId: string,
    ): Promise<string | null>;
    costMicros?(deploymentId: string, marketId: string): Promise<string>;
    canTrade?(
      market: IndexedMarketRow,
      cursor: IndexCursorRow | null,
    ): Promise<{ canTrade: boolean; reasons: string[] }>;
  };
}): RouteService {
  const paths = [
    "/v1/markets",
    "/v1/markets/:id",
    "/v1/markets/:id/spec",
    "/v1/accounts/:address/positions",
    "/v1/markets/:id/resolution",
    "/v1/transactions",
    "/v1/transactions/:txHash",
  ];
  const ref = (m: IndexedMarketRow) => ({
    deploymentId: m.deploymentId,
    marketId: m.marketId,
    mode: m.mode,
  });
  // No projection cursor yet: report an explicit "nothing observed" position, never a made-up block.
  const noCursor: ChainCursor = {
    blockNumber: "0",
    blockHash: "0x" + "0".repeat(64),
    finality: "UNKNOWN",
  };
  const cursor = (m: IndexedMarketRow): ChainCursor =>
    !m.cursor
      ? noCursor
      : {
          blockNumber: m.cursor.blockNumber,
          blockHash: m.cursor.blockHash,
          finality:
            m.cursor.finalizedNumber === null
              ? "UNKNOWN"
              : BigInt(m.createdBlockNumber) <= BigInt(m.cursor.finalizedNumber)
                ? "FINALIZED"
                : "INCLUDED",
        };
  const iso = (seconds: string) =>
    new Date(Number(BigInt(seconds) * 1000n)).toISOString();
  const resolution = (m: IndexedMarketRow) => ({
    ...ref(m),
    proposedOutcome: m.proposedOutcome,
    finalOutcome: m.finalOutcome,
    proposalEvidenceHash: m.proposalEvidenceHash,
    finalEvidenceHash: m.finalEvidenceHash,
    proposedAt: m.proposedAt === null ? null : iso(m.proposedAt),
    challengeEndsAt:
      m.proposedAt === null
        ? null
        : iso((BigInt(m.proposedAt) + BigInt(m.challengeSeconds)).toString()),
    hardDeadline: iso(m.hardDeadline),
    chainCursor: cursor(m),
  });
  async function summary(m: IndexedMarketRow) {
    const reasons = ["TRADING_DISABLED"];
    if (m.effectiveState !== "OPEN") reasons.push("MARKET_CLOSED");
    if (m.paused) reasons.push("TRADING_PAUSED");
    if (!m.cursor || m.cursor.gateReason || m.cursor.stale)
      reasons.push("INDEXER_LAG");
    return {
      ...ref(m),
      specHash: m.specHash,
      storedState: m.storedState,
      effectiveState: m.effectiveState,
      paused: m.paused,
      ...(deps.hooks?.canTrade
        ? await deps.hooks.canTrade(m, m.cursor)
        : { canTrade: false, reasons }),
      chainCursor: cursor(m),
    };
  }
  return {
    paths,
    async handle(req) {
      try {
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
        if (req.path === "/v1/transactions/:txHash") {
          const t = await deps.store.transaction(
            deployment,
            req.params.txHash!,
          );
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
        if (req.path === "/v1/markets") {
          const page = await deps.store.list(req.query as MarketListQuery);
          return {
            status: 200,
            body: {
              items: await Promise.all(page.items.map(summary)),
              nextCursor: page.nextCursor,
            },
          };
        }
        if (req.path === "/v1/accounts/:address/positions") {
          const page = await deps.store.positions(
            deployment,
            req.params.address!,
            req.query as MarketListQuery,
          );
          return {
            status: 200,
            body: {
              nextCursor: page.nextCursor,
              items: page.items.map((p) => ({
                ...ref(p.market),
                yesShares: p.yesShares,
                noShares: p.noShares,
                payoutMicros:
                  p.market.storedState !== "FINAL"
                    ? null
                    : (p.market.finalOutcome === "YES"
                        ? BigInt(p.yesShares) * 1000000n
                        : p.market.finalOutcome === "NO"
                          ? BigInt(p.noShares) * 1000000n
                          : (BigInt(p.yesShares) + BigInt(p.noShares)) * 500000n
                      ).toString(),
                pendingIntentIds: p.pendingIntentIds,
                chainCursor: cursor(p.market),
              })),
            },
          };
        }
        const m = await deps.store.market(deployment, req.params.id!);
        if (!m) throw new IdentityError(404, "NOT_FOUND");
        if (req.path === "/v1/markets/:id/resolution")
          return { status: 200, body: resolution(m) };
        let bytes: Uint8Array, spec: MarketSpec;
        try {
          bytes = await deps.archive.read(m.specUri, m.specHash);
          spec = MarketSpec.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
          );
        } catch {
          await deps.store.integrityFailure(m, req.requestId);
          throw new IdentityError(503, "SPEC_UNAVAILABLE", {
            retryable: false,
          });
        }
        if (req.path === "/v1/markets/:id/spec")
          return {
            status: 200,
            body: bytes,
            contentType: "application/json",
            headers: {
              ETag: '"' + m.specHash + '"',
              "Cache-Control": "public, max-age=31536000, immutable",
            },
          };
        return {
          status: 200,
          body: {
            ...(await summary(m)),
            spec,
            resolution: resolution(m),
            forecastSnapshotId:
              (await deps.hooks?.forecastSnapshotId?.(
                deployment,
                m.marketId,
              )) ?? null,
            costMicros:
              (await deps.hooks?.costMicros?.(deployment, m.marketId)) ?? "0",
          },
        };
      } catch (error) {
        if (error instanceof IdentityError) throw error;
        const code = error instanceof Error ? error.message : "";
        const status: Record<string, number> = {
          INVALID_CURSOR: 400,
          UNAUTHORIZED: 401,
          IDEMPOTENCY_CONFLICT: 409,
          REQUEST_IN_PROGRESS: 409,
        };
        if (status[code]) throw new IdentityError(status[code]!, code);
        throw error;
      }
    },
  };
}
