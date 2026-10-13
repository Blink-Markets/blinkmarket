import https from "node:https";
import type { LookupFunction } from "node:net";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  type BrotliDecompress,
  type Gunzip,
  type Inflate,
} from "node:zlib";
import {
  FetchError,
  MAX_REDIRECTS,
  checkFetchUrl,
  isPublicAddress,
  type FetchPolicy,
  type FetchTransport,
  type SourceFetcher,
} from "@blink/ports";

const MIB = 1024 * 1024;
const TLS_FAILURE = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;

// The URL is checked before DNS, every resolved address before connecting, and the connection is
// pinned to the address that was checked. Document bytes are never parsed or executed here.
export function allowlistFetcher(options: {
  resolve(host: string): Promise<{ address: string; family: 4 | 6 }[]>;
  transport?: FetchTransport;
  limits?: {
    maxRedirects?: number;
    requestTimeoutMs?: number;
    totalTimeoutMs?: number;
    maxBytes?: number;
  };
}): SourceFetcher {
  const transport = options.transport ?? httpsTransport();
  const limits = {
    maxRedirects: MAX_REDIRECTS,
    requestTimeoutMs: 15_000,
    totalTimeoutMs: 60_000,
    maxBytes: 10 * MIB,
    ...options.limits,
  };

  async function resolveAll(host: string) {
    try {
      return await options.resolve(host);
    } catch {
      throw new FetchError("DNS_FAILED", true);
    }
  }
  // One request: DNS, connect, headers and body share the per-request deadline.
  async function hop(
    target: URL,
    policy: FetchPolicy,
    overall: AbortSignal,
  ): Promise<{ redirect: string } | { bytes: Buffer; mime: string }> {
    const request = new AbortController();
    const relay = () => request.abort(overall.reason);
    if (overall.aborted) relay();
    else overall.addEventListener("abort", relay, { once: true });
    const timer = setTimeout(
      () => request.abort(new FetchError("TIMEOUT", true)),
      limits.requestTimeoutMs,
    );
    const { signal } = request;
    try {
      const addresses = await abortable(resolveAll(target.hostname), signal);
      if (!addresses.length) throw new FetchError("DNS_FAILED", true);
      // One private answer poisons the name: never pick the public one and hope.
      if (addresses.some(({ address }) => !isPublicAddress(address)))
        throw new FetchError("PRIVATE_ADDRESS", false);
      const { address, family } = addresses[0]!;
      const response = await abortable(
        transport.request({
          ip: address,
          family,
          url: target,
          signal,
          timeoutMs: limits.requestTimeoutMs,
        }),
        signal,
      );
      const headers = Object.fromEntries(
        Object.entries(response.headers).map(([name, value]) => [
          name.toLowerCase(),
          value,
        ]),
      );
      const { status } = response;
      if (status >= 300 && status < 400 && headers["location"] !== undefined) {
        try {
          return { redirect: new URL(headers["location"], target).href };
        } catch {
          throw new FetchError("BAD_REDIRECT", false);
        }
      }
      if (status !== 200)
        throw new FetchError(`HTTP_${status}`, status >= 500 || status === 429);
      const mime = (headers["content-type"] ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (!policy.allowedMime.some((allowed) => allowed.toLowerCase() === mime))
        throw new FetchError("MIME_NOT_ALLOWED", false);
      if (Number(headers["content-length"]) > limits.maxBytes)
        throw new FetchError("TOO_LARGE", false);
      const bytes = await readBody(
        response.body,
        decoderFor(headers["content-encoding"]),
        limits.maxBytes,
        signal,
      );
      if (!bytes.length) throw new FetchError("EMPTY_BODY", false);
      return { bytes, mime };
    } catch (error) {
      throw failure(error, signal);
    } finally {
      clearTimeout(timer);
      overall.removeEventListener("abort", relay);
      // Releases the socket, including after a redirect whose body was never read.
      request.abort();
    }
  }

  return {
    async fetch(policy, signal) {
      const overall = new AbortController();
      const relay = () => overall.abort(signal.reason);
      if (signal.aborted) relay();
      else signal.addEventListener("abort", relay, { once: true });
      const timer = setTimeout(
        () => overall.abort(new FetchError("TIMEOUT", true)),
        limits.totalTimeoutMs,
      );
      try {
        let url = policy.exactUrl;
        for (let redirects = 0; ; redirects++) {
          if (redirects > limits.maxRedirects)
            throw new FetchError("TOO_MANY_REDIRECTS", false);
          const checked = checkFetchUrl(url, policy, redirects);
          if (!checked.ok) throw new FetchError(checked.code, false);
          if (overall.signal.aborted) throw overall.signal.reason;
          const result = await hop(new URL(url), policy, overall.signal);
          if ("redirect" in result) {
            url = result.redirect;
            continue;
          }
          return {
            bytes: result.bytes,
            finalUrl: new URL(url).href,
            mime: result.mime,
            observedAt: new Date(),
          };
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", relay);
      }
    },
  };
}

type Decoder = Gunzip | Inflate | BrotliDecompress;
function decoderFor(encoding: string | undefined): Decoder | undefined {
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "":
    case "identity":
      return undefined;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new FetchError("UNSUPPORTED_ENCODING", false);
  }
}
// Both the raw and the decoded size are capped, and decoding stops at the cap, so a few KiB of
// compressed zeros cannot expand into memory.
async function readBody(
  body: AsyncIterable<Uint8Array>,
  decoder: Decoder | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const output: Buffer[] = [];
  let decoded = 0;
  const keep = (chunk: Uint8Array) => {
    decoded += chunk.length;
    if (decoded > maxBytes) throw new FetchError("TOO_LARGE", false);
    output.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  };
  let raw = 0;
  const pump = async (take: (chunk: Uint8Array) => void) => {
    const iterator = body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) return;
        raw += next.value.length;
        if (raw > maxBytes) throw new FetchError("TOO_LARGE", false);
        take(next.value);
      }
    } finally {
      // A stalled body never settles return(); the request abort tears it down instead.
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  };
  if (!decoder) await pump(keep);
  else {
    // Errors surface through the iterator below; this only keeps a late one from being fatal.
    decoder.on("error", () => {});
    const decoding = (async () => {
      try {
        for await (const chunk of decoder) keep(chunk);
      } catch (error) {
        throw error instanceof FetchError
          ? error
          : new FetchError("DECODE_FAILED", false);
      }
    })();
    const feeding = pump((chunk) => {
      decoder.write(chunk);
    }).then(() => {
      decoder.end();
    });
    try {
      await Promise.all([feeding, decoding]);
    } finally {
      decoder.destroy();
    }
  }
  return Buffer.concat(output);
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}
function failure(error: unknown, signal: AbortSignal) {
  if (error instanceof FetchError) return error;
  // An abort carries its own reason: a deadline (FetchError) or the caller's cancellation.
  if (signal.aborted) return signal.reason;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TLS_FAILURE.test(code)
    ? new FetchError("TLS_FAILED", false)
    : new FetchError("NETWORK_ERROR", true);
}

/** Exported for the pinning unit test. */
export function httpsRequestOptions(input: {
  ip: string;
  family: 4 | 6;
  url: URL;
}): https.RequestOptions {
  const { ip, family, url } = input;
  const pinned: LookupFunction = (_host, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  };
  return {
    protocol: "https:",
    hostname: url.hostname,
    port: 443,
    method: "GET",
    path: url.pathname + url.search,
    headers: {
      Host: url.host,
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "User-Agent": "BlinkMarketEvidenceFetcher/0.1",
    },
    // A shared agent would reuse sockets across validated addresses.
    agent: false,
    lookup: pinned,
    servername: url.hostname,
    // Explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot switch verification off.
    rejectUnauthorized: true,
  };
}
// `request` is injectable so tests can drive the socket without a network.
export function httpsTransport(
  deps: { request?: typeof https.request } = {},
): FetchTransport {
  const open = deps.request ?? https.request;
  return {
    request: ({ ip, family, url, signal, timeoutMs }) =>
      new Promise((resolve, reject) => {
        // An idle socket destroys the request; the error that follows is a timeout, whatever its shape.
        let idle = false;
        const timeout = () => new FetchError("TIMEOUT", true);
        const request = open(
          { ...httpsRequestOptions({ ip, family, url }), signal },
          (response) => {
            // Read through the async iterator; this listener only prevents an unhandled error event.
            response.on("error", () => {});
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers[name] = Array.isArray(value) ? value.join(", ") : value;
            resolve({
              status: response.statusCode ?? 0,
              headers,
              body: (async function* () {
                try {
                  yield* response;
                } catch (error) {
                  throw idle ? timeout() : error;
                }
              })(),
            });
          },
        );
        request.setTimeout(timeoutMs, () => {
          idle = true;
          request.destroy(timeout());
        });
        request.on("error", (error) => reject(idle ? timeout() : error));
        request.end();
      }),
  };
}
