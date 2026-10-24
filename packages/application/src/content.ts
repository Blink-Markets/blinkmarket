import { keccak256 } from "viem";
import {
  CONTENT_MAX_BYTES,
  CONTENT_MEDIA_TYPES,
  parseMarketSpec,
} from "@blink/schemas";
import type {
  ContentMediaType,
  ContentStore,
  IdentityPrincipal,
  KeyScope,
  ProtocolReader,
} from "@blink/ports";
import { IdentityError, requireRegisteredAddress } from "./identity.js";
import type { RouteService } from "./route-service.js";

export const contentPaths = ["/v1/content", "/v1/content/:hash"] as const;

// Served bytes are untrusted uploads: nosniff and a sandbox CSP stop any browser from running them,
// and HTML is never rendered inline.
const SERVE_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox",
} as const;

/** The media type of a Content-Type header, without parameters, or null if it is not allowed. */
export function allowedMediaType(header: string | undefined) {
  const type = header?.split(";")[0]?.trim().toLowerCase();
  return (CONTENT_MEDIA_TYPES as readonly string[]).includes(type ?? "")
    ? (type as ContentMediaType)
    : null;
}

export function createContentService(deps: {
  store: ContentStore;
  identity: {
    authenticate(
      authorization: string | undefined,
      scope?: KeyScope,
    ): Promise<IdentityPrincipal>;
  };
  reader: Pick<ProtocolReader, "health" | "account">;
  /** SPEC_PUBLIC_ORIGIN: the canonical origin this API is served from, without a trailing slash. */
  publicOrigin: string;
}): RouteService {
  async function upload(req: Parameters<RouteService["handle"]>[0]) {
    const principal = await deps.identity.authenticate(
      req.authorization,
      "content:write",
    );
    const mediaType = allowedMediaType(req.contentType);
    if (!mediaType) throw new IdentityError(415, "UNSUPPORTED_MEDIA_TYPE");
    const bytes = req.body;
    if (!(bytes instanceof Uint8Array) || bytes.length === 0)
      throw new IdentityError(400, "INVALID_REQUEST");
    if (bytes.length > CONTENT_MAX_BYTES)
      throw new IdentityError(413, "PAYLOAD_TOO_LARGE");
    // An upload acts for an identity, so it needs the indexed registration of the key's wallet.
    if (!principal.address) throw new IdentityError(403, "NOT_REGISTERED");
    await requireRegisteredAddress(deps.reader, principal.address);
    const hash = keccak256(bytes);
    // A spec that names a suggestion is linked to it; any other bytes are stored as they are.
    const parsed = parseMarketSpec(bytes);
    const stored = await deps.store.put({
      hash,
      bytes,
      mediaType,
      uploader: principal.address.toLowerCase(),
      suggestionId: parsed.ok ? (parsed.spec.suggestionId ?? null) : null,
    });
    return {
      status: 201,
      body: {
        hash: stored.hash,
        size: stored.size,
        mediaType: stored.mediaType,
        uri: deps.publicOrigin + "/v1/content/" + stored.hash,
      },
    };
  }

  async function download(hash: string) {
    let found;
    try {
      found = await deps.store.get(hash);
    } catch {
      // Damaged or missing bytes are never served.
      throw new IdentityError(503, "CONTENT_UNAVAILABLE", { retryable: false });
    }
    if (!found) throw new IdentityError(404, "NOT_FOUND");
    const { object, bytes } = found;
    return {
      status: 200,
      body: bytes,
      contentType: object.mediaType,
      headers: {
        ...SERVE_HEADERS,
        ETag: '"' + object.hash + '"',
        ...(object.mediaType === "text/html"
          ? { "Content-Disposition": "attachment" }
          : {}),
      },
    };
  }

  return {
    paths: contentPaths,
    handle: (req) =>
      req.method === "POST" ? upload(req) : download(req.params.hash!),
  };
}
