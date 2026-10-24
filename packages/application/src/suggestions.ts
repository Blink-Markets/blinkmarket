import { SuggestionRequest } from "@blink/schemas";
import type {
  IdentityPrincipal,
  KeyScope,
  ProtocolReader,
  SuggestionRecord,
  SuggestionStore,
} from "@blink/ports";
import { IdentityError, readFreshIndex } from "./identity.js";
import type { RouteService } from "./route-service.js";

export const suggestionPaths = [
  "/v1/suggestions",
  "/v1/suggestions/:id",
  "/v1/suggestions/:id/claims",
] as const;

type Status = "OPEN" | "CLAIMED" | "MARKET_CREATED";
// A filtered page examines at most this many rows before it hands back a cursor, so a rare status
// cannot make one request scan the whole queue.
const SCAN_BATCH = 100;
const MAX_SCAN_ROWS = 1000;

export function createSuggestionService(deps: {
  store: SuggestionStore;
  identity: {
    authenticate(
      authorization: string | undefined,
      scope?: KeyScope,
    ): Promise<IdentityPrincipal>;
  };
  reader: Pick<ProtocolReader, "health" | "hasRole" | "marketBySpecHash">;
}): RouteService {
  // Derived on every read: a market for any linked spec, else any claim, else open.
  async function view(item: SuggestionRecord) {
    let status: Status = item.claimCount > 0 ? "CLAIMED" : "OPEN";
    for (const hash of item.specHashes)
      if (await deps.reader.marketBySpecHash(hash)) {
        status = "MARKET_CREATED";
        break;
      }
    return {
      id: item.id,
      text: item.text,
      sourceUrls: item.sourceUrls,
      status,
      claimCount: item.claimCount,
      specHashes: item.specHashes,
      createdAt: item.createdAt.toISOString(),
    };
  }

  async function list(query: {
    limit: number;
    cursor?: string;
    status?: Status;
  }) {
    if (query.cursor !== undefined && !/^[0-9]{1,18}$/.test(query.cursor))
      throw new IdentityError(400, "INVALID_CURSOR");
    const items: Awaited<ReturnType<typeof view>>[] = [];
    let after = query.cursor ?? null;
    let scanned = 0;
    for (;;) {
      const rows = await deps.store.list({ after, limit: SCAN_BATCH });
      for (const row of rows) {
        const shown = await view(row);
        if (query.status && shown.status !== query.status) {
          after = row.seq;
          scanned++;
          continue;
        }
        // One more match than the page holds means there is a next page.
        if (items.length === query.limit) return { items, nextCursor: after };
        items.push(shown);
        after = row.seq;
        scanned++;
      }
      if (rows.length < SCAN_BATCH) return { items, nextCursor: null };
      if (scanned >= MAX_SCAN_ROWS) return { items, nextCursor: after };
    }
  }

  async function claim(req: Parameters<RouteService["handle"]>[0]) {
    const principal = await deps.identity.authenticate(
      req.authorization,
      "suggestion:claim",
    );
    if (!principal.address) throw new IdentityError(403, "ROLE_REQUIRED");
    const address = principal.address.toLowerCase();
    const isCreator = await readFreshIndex(deps.reader, () =>
      deps.reader.hasRole(address, "CREATOR"),
    );
    if (!isCreator)
      throw new IdentityError(403, "ROLE_REQUIRED", {
        details: { role: "CREATOR" },
      });
    const claimed = await deps.store.claim(req.params.id!, address);
    if (claimed === null) throw new IdentityError(404, "NOT_FOUND");
    if (!claimed) throw new IdentityError(409, "ALREADY_CLAIMED");
    return {
      status: 201,
      body: await view((await deps.store.get(req.params.id!))!),
    };
  }

  return {
    paths: suggestionPaths,
    async handle(req) {
      if (req.path === "/v1/suggestions/:id/claims") return claim(req);
      if (req.path === "/v1/suggestions/:id") {
        const item = await deps.store.get(req.params.id!);
        if (!item) throw new IdentityError(404, "NOT_FOUND");
        return { status: 200, body: await view(item) };
      }
      if (req.method === "GET")
        return {
          status: 200,
          body: await list(
            req.query as { limit: number; cursor?: string; status?: Status },
          ),
        };
      // Public: no key, so nothing here acts for an identity. The per-IP and global limits sit in
      // front of this call (apps/api).
      const input = SuggestionRequest.safeParse(req.body);
      if (!input.success) throw new IdentityError(400, "INVALID_REQUEST");
      const id = crypto.randomUUID();
      await deps.store.add({
        id,
        text: input.data.text,
        sourceUrls: input.data.sourceUrls ?? [],
      });
      return { status: 201, body: { id } };
    },
  };
}
