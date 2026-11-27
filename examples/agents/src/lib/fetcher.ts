// Reading a source page for a market. The URLs come from market specs, which anyone can write, so
// everything here treats a URL as hostile input: the URL is judged before any lookup, every
// address the name resolves to is judged before any connection, and the connection goes to the
// address that was judged, not to the name again. A page is never run or interpreted here; it is
// only read as bytes (and, in watch.ts, turned into text to compare).
//
// This file is deliberately self-contained. An outside developer who copies the example gets its
// own copy of the address rules, and a test in the repository compares them with the platform's.
//
// What `httpsFetcher` does not do, and what an operator must know before turning it on:
// - The default resolver asks the name servers directly (c-ares: A and AAAA, bounded in time and
//   in tries, cancelled when the fetch gives up). It does not read /etc/hosts and does not apply
//   search domains, so a name that only a hosts file or a search domain knows is not found. The
//   operating system's resolver is not used because it cannot be cancelled and a few names whose
//   servers never answer would hold its small thread pool for the whole process.
// - It never uses an HTTP proxy, and it refuses to be built while HTTPS_PROXY, https_proxy,
//   HTTP_PROXY, http_proxy or NODE_USE_ENV_PROXY is set, because a proxy resolves the name itself and
//   would defeat the address check. Pass `direct: true` to say that the direct connection is
//   intended.
// - The pinning check (the socket must end at the address that was judged) runs after the connection
//   is made. If another library patches the agent, the TCP connection and the TLS ClientHello, which
//   carries the host name, can reach another address before the request is destroyed; no HTTP
//   request is sent. It is a backstop, and the proxy-environment check above is the front line.
// - The address rules refuse what is not publicly routable, and any address inside a subnet of one
//   of this machine's network interfaces (a host on the operator's own network can have a public
//   looking address). Inside a container that list is the container's interfaces, not the host's
//   network: put the host's subnets in `extraBlockedRanges` (CIDR strings), as well as any private
//   network that is numbered from public space. A range written as `::ffff:a.b.c.d/n` is read as
//   the IPv4 range it maps to; NAT64 (`64:ff9b::/96`) and IPv4-compatible ranges stay IPv6, since
//   reading `64:ff9b::/96` as IPv4 would block every address. To block every form of an IPv4
//   address, write the IPv4 range. On an IPv6-only network whose NAT64 uses a network-specific
//   prefix, `<prefix>::<private IPv4>` passes the checks: put that prefix's forms of the private
//   ranges in `extraBlockedRanges` (for a /96 prefix, `<prefix>::10.0.0.0/104` covers 10.0.0.0/8).
// - Answers that arrive more than 300 ms after the first non-empty answer are not waited for (RFC
//   8305's resolution delay), so a name whose AAAA (or A) query is never answered does not cost the
//   resolver's timeout on every hop. A connection goes only to a judged address that is pinned, so a
//   late answer cannot direct a connection anywhere.
// - A source can link readers of its page to the operator. A page that carries a per-request token
//   puts that token into the fingerprint and into the archived snapshot, which are public once an
//   answer is revealed; and the validators that this file replays (ETag, Last-Modified) let a
//   server recognise the same agent across windows, and across changes of its IP address. No header
//   that names the operator or the software is sent, but the connection's source address is the
//   operator's. Unlinkability needs a tunnel or an egress address around the whole process, which
//   this file cannot provide.
import dns from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import https from "node:https";
import type { LookupFunction } from "node:net";
import os from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { createGunzip, createInflate, type Gunzip, type Inflate } from "node:zlib";
import type { World } from "./world.ts";

/** The `ETag` and `Last-Modified` that go on a request, so that an unchanged page costs nothing. */
export type ConditionalHeaders = { etag?: string; lastModified?: string };
/**
 * What an earlier answer left for the next one: its validators and the URL they belong to (the one
 * the redirects ended at). They are sent only on the request for that URL, never on another hop.
 */
export type Validators = ConditionalHeaders & { finalUrl?: string };

/**
 * One read of one URL. `mediaType` is the response's `Content-Type` without parameters and `charset`
 * is its `charset` parameter, lower-cased. `finalUrl` is where the redirects ended. A `304` means
 * "unchanged since the version these validators name". `code` is a stable, secret-free failure code.
 */
export type SourceFetchResult =
  | {
      status: 200;
      bytes: Uint8Array;
      mediaType: string;
      charset?: string;
      etag?: string;
      lastModified?: string;
      finalUrl?: string;
    }
  | { status: 304 }
  | { status: "error"; code: string };
export type SourceFetcher = (url: string, validators: Validators) => Promise<SourceFetchResult>;

/**
 * Resolves a name to every address it has. The signal aborts when the fetch gives up, and the
 * lookup must stop then. The default asks the name servers for A and AAAA (see the header).
 */
export type Resolve = (host: string, signal?: AbortSignal) => Promise<{ address: string; family: 4 | 6 }[]>;
/** Connects to an address that was already judged; the URL's host stays the TLS name. Header names are lower-case. */
export type FetchTransport = {
  request(input: {
    ip: string;
    family: 4 | 6;
    url: URL;
    signal: AbortSignal;
    timeoutMs: number;
    validators?: ConditionalHeaders;
  }): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Uint8Array> }>;
};

const MIB = 1024 * 1024;
const MAX_REDIRECTS = 3;
// With --use-env-proxy, the runtime proxies https through HTTPS_PROXY, or through HTTP_PROXY when that is the only one set.
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_USE_ENV_PROXY"];
const TLS_FAILURE = /^(CERT_|ERR_TLS_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/;
// A validator is only sent, and only kept, in the exact shape a server issues it: an entity tag
// (quoted, printable ASCII, bounded) or an IMF-fixdate. Anything else, such as `*`, is not a version.
const ETAG = /^(W\/)?"[\x21\x23-\x7e]{0,250}"$/;
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
export const isEtag = (value: unknown): value is string => typeof value === "string" && ETAG.test(value);
export const isLastModified = (value: unknown): value is string => typeof value === "string" && IMF_FIXDATE.test(value);

// A URL that is a key or is stored (a source, a final URL) is in one form and one size, so that the
// state file, a note and a log line never carry something unbounded. Everything that keys or stores
// a URL uses `isCanonicalHttpsUrl`; there is no other rule.
export const MAX_URL_BYTES = 2048;
/** The byte length of a string as JSON, without its quotes: a backslash or a quote costs two bytes. */
export const jsonBytes = (value: string): number => new TextEncoder().encode(JSON.stringify(value)).length - 2;
/** An https URL that is its own `new URL(u).href` and takes at most 2048 bytes once JSON-encoded. */
export const isCanonicalHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === value && jsonBytes(value) <= MAX_URL_BYTES;
  } catch {
    return false;
  }
};
// A media type as `Content-Type` gives it, without parameters: lower-case type and subtype, bounded.
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,127}\/[a-z0-9!#$&^_.+-]{1,127}$/;
export const isMediaType = (value: unknown): value is string => typeof value === "string" && MEDIA_TYPE.test(value);
/** A Content-Type value's type and subtype, lower-cased, or application/octet-stream when that is not a media type. */
export const mediaTypeOf = (value: unknown): string => {
  const declared = typeof value === "string" ? value.split(";")[0]!.trim().toLowerCase() : "";
  return isMediaType(declared) ? declared : "application/octet-stream";
};
/** The part of `validators` that may go on a request. */
function conditional(validators: ConditionalHeaders | undefined): ConditionalHeaders {
  return {
    ...(isEtag(validators?.etag) ? { etag: validators.etag } : {}),
    ...(isLastModified(validators?.lastModified) ? { lastModified: validators.lastModified } : {}),
  };
}

/** A failure with a stable code. Only the code ever leaves this file, never a message. */
class FetchFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FetchFailure";
  }
}

// -- The address rules ------------------------------------------------------------------------

const BLOCKED_V4 = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8", // private
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8", // loopback
  "169.254.0.0/16", // link-local, including cloud metadata services
  "172.16.0.0/12", // private
  "192.0.0.0/24", // IETF protocol assignments
  "192.0.2.0/24", // documentation
  "192.88.99.0/24", // old 6to4 relay anycast
  "192.168.0.0/16", // private
  "198.18.0.0/15", // benchmarking
  "198.51.100.0/24", // documentation
  "203.0.113.0/24", // documentation
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved, including the broadcast address
].map((cidr) => {
  const [base, length] = cidr.split("/") as [string, string];
  const mask = (0xffffffff << (32 - Number(length))) >>> 0;
  return { network: (packV4(parseV4(base)!) & mask) >>> 0, mask };
});

function packV4(octets: number[]): number {
  return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}
// A canonical dotted quad only. A leading zero can mean octal to some parsers, so it is never accepted.
function parseV4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet <= 255) ? octets : null;
}
function parseV6(value: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(value)) return null;
  let rest = value;
  if (rest.includes(".")) {
    // A trailing dotted quad stands for the last two groups.
    const cut = rest.lastIndexOf(":");
    const quad = parseV4(rest.slice(cut + 1));
    if (!quad) return null;
    rest = `${rest.slice(0, cut + 1)}${((quad[0]! << 8) | quad[1]!).toString(16)}:${((quad[2]! << 8) | quad[3]!).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) =>
    part === "" ? [] : part.split(":").map((g) => (/^[0-9a-fA-F]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const gap = 8 - head.length - tail.length;
  // Without "::" all eight groups must be written; with it, it stands for at least one.
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const all = [...head, ...new Array<number>(gap).fill(0), ...tail];
  return all.some(Number.isNaN) ? null : all;
}
const publicV4 = (octets: number[]) => {
  const address = packV4(octets);
  return !BLOCKED_V4.some(({ network, mask }) => ((address & mask) >>> 0) === network);
};

/**
 * True only for a canonical IPv4 or IPv6 address that is outside every non-public range. Anything
 * it cannot read is not public. Forms that carry an IPv4 address (mapped, NAT64, compatible) are
 * judged by that address; transition ranges that could hide one are refused outright.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return publicV4(v4);
  const g = parseV6(ip);
  if (!g) return false;
  const carried = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  if (zero(0, 5) && g[5] === 0xffff) return publicV4(carried); // ::ffff:0:0/96 (IPv4-mapped)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return publicV4(carried); // 64:ff9b::/96 (NAT64)
  if (zero(0, 6)) return publicV4(carried); // ::/96 (IPv4-compatible, which also covers :: and ::1)
  // Everything else must be global unicast, 2000::/3. That leaves out 100::/64, the SIIT and
  // 64:ff9b:1::/48 transition ranges, fc00::/7, fe80::/10, fec0::/10, ff00::/8 and the reserved
  // space, and 5f00::/16 and the unallocated blocks.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  // 2001::/23 is the IETF protocol assignments block, mostly not reachable (Teredo, ORCHID,
  // benchmarking). The registry marks these parts globally reachable: 2001:1::1 to 2001:1::3,
  // 2001:3::/32 (AMT), 2001:4:112::/48 (AS112), 2001:20::/28 and 2001:30::/28.
  if (g[0] === 0x2001 && g[1]! < 0x200)
    return (
      (g[1] === 1 && zero(2, 7) && g[7]! >= 1 && g[7]! <= 3) ||
      g[1] === 3 ||
      (g[1] === 4 && g[2] === 0x112) ||
      (g[1]! & 0xfff0) === 0x20 ||
      (g[1]! & 0xfff0) === 0x30
    );
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // 2001:db8::/32 (documentation)
  if (g[0] === 0x2002) return false; // 2002::/16 (6to4)
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // 3fff::/20 (documentation)
  return true;
}

// -- Address ranges (this machine's subnets, and what an operator adds) ----------------------

type Net = { family: 4 | 6; value: bigint };
type Range = Net & { bits: number; prefix: number };
const netOf = (address: string): Net | null => {
  const v4 = parseV4(address);
  if (v4) return { family: 4, value: BigInt(packV4(v4)) };
  const g = parseV6(address);
  return g ? { family: 6, value: g.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n) } : null;
};
/**
 * Every form an address is checked in. An IPv6 address that carries an IPv4 address (mapped,
 * NAT64 64:ff9b::/96, or IPv4-compatible ::/96) is checked as itself and as that IPv4 address. An
 * address that cannot be read has no form, and is refused.
 */
const checkedNets = (address: string): Net[] => {
  const net = netOf(address);
  if (!net) return [];
  if (net.family === 4) return [net];
  const high = net.value >> 32n;
  return high === 0xffffn || high === 0x64ff9b0000000000000000n || high === 0n
    ? [net, { family: 4, value: net.value & 0xffffffffn }]
    : [net];
};
function parseRange(cidr: string): Range | null {
  const [address, length, ...rest] = cidr.split("/");
  if (address === undefined || length === undefined || rest.length || !/^\d{1,3}$/.test(length)) return null;
  const net = netOf(address);
  const bits = net?.family === 4 ? 32 : 128;
  const prefix = Number(length);
  if (!net || prefix > bits) return null;
  // An IPv4-mapped range is the IPv4 range it maps to, so that it also blocks an A answer.
  if (net.family === 6 && prefix >= 96 && net.value >> 32n === 0xffffn) {
    const shift4 = BigInt(128 - prefix);
    return { family: 4, value: ((net.value & 0xffffffffn) >> shift4) << shift4, bits: 32, prefix: prefix - 96 };
  }
  const shift = BigInt(bits - prefix);
  return { ...net, value: (net.value >> shift) << shift, bits, prefix };
}
const inRange = (net: Net, range: Range) =>
  net.family === range.family && ((net.value >> BigInt(range.bits - range.prefix)) << BigInt(range.bits - range.prefix)) === range.value;
/** The subnets of this machine's interfaces. An interface that cannot be read is skipped. */
function interfaceRanges(): Range[] {
  const ranges: Range[] = [];
  try {
    for (const addresses of Object.values(os.networkInterfaces()))
      for (const entry of addresses ?? []) {
        const range = typeof entry.cidr === "string" ? parseRange(entry.cidr) : null;
        if (range) ranges.push(range);
      }
  } catch {
    // No interface list: the address rules still apply.
  }
  return ranges;
}

/**
 * Judges a URL before any lookup. Returns the URL to use (without its fragment, which is never sent
 * to a server) or the code that refuses it: not https, userinfo, a port other than 443, or a host
 * that is an IP address. The URL parser has already folded decimal, hex and octal spellings of an
 * IPv4 host (`0x7f.1`, `2130706433`, `127.0.0.1.`) into a dotted quad, so one test catches them all.
 */
function judgeUrl(raw: string): { url: URL } | { code: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { code: "INVALID_URL" };
  }
  if (url.protocol !== "https:") return { code: "NOT_HTTPS" };
  if (url.username || url.password) return { code: "CREDENTIALS" };
  // The parser drops an explicit default port, so any port that is left is not 443.
  if (url.port) return { code: "PORT" };
  if (url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return { code: "IP_LITERAL" };
  url.hash = "";
  return { url };
}

// -- The connection ---------------------------------------------------------------------------

/**
 * The options for one connection. Pure and exported so that a test can pin them: the socket goes
 * to `ip` whatever name is asked for (the pinned `lookup` answers both the single and the
 * `{ all: true }` form), TLS is verified for the URL's host (`servername`), the `Host` header comes
 * from the URL, no agent shares a socket across addresses, and verification is switched on
 * explicitly so that an environment variable cannot turn it off. No cookie and no User-Agent is
 * sent, and the only validators sent are the ones given that have the shape of a validator.
 */
export function httpsRequestOptions(input: {
  ip: string;
  family: 4 | 6;
  url: URL;
  validators?: ConditionalHeaders;
}): https.RequestOptions {
  const { ip, family, url } = input;
  const validators = conditional(input.validators);
  const pinned: LookupFunction = (_host, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  };
  const headers: Record<string, string> = {
    Host: url.host,
    Accept: "*/*",
    // Compression is not asked for; if a server compresses anyway, the cap applies to the decoded bytes.
    "Accept-Encoding": "identity",
  };
  if (validators.etag !== undefined) headers["If-None-Match"] = validators.etag;
  if (validators.lastModified !== undefined) headers["If-Modified-Since"] = validators.lastModified;
  return {
    protocol: "https:",
    hostname: url.hostname,
    port: 443,
    method: "GET",
    path: url.pathname + url.search,
    headers,
    agent: false,
    lookup: pinned,
    servername: url.hostname,
    rejectUnauthorized: true,
  };
}

/** The default transport over `https.request`, which a test replaces with a spy so that no socket opens. */
export function httpsTransport(deps: { request?: typeof https.request } = {}): FetchTransport {
  const open = deps.request ?? https.request;
  return {
    request: ({ ip, family, url, signal, timeoutMs, validators }) =>
      new Promise((resolve, reject) => {
        // An idle socket destroys the request; the error that follows is a timeout, whatever its shape.
        let idle = false;
        const timeout = () => new FetchFailure("TIMEOUT");
        const request = open(
          { ...httpsRequestOptions({ ip, family, url, ...(validators ? { validators } : {}) }), signal },
          (response) => {
            // The body is read through the async iterator; this only keeps a late error from being fatal.
            response.on("error", () => {});
            const headers: Record<string, string> = {};
            for (const [name, value] of Object.entries(response.headers))
              if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
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
        // The socket must end at the address that was judged. The pinned lookup makes that so; this
        // is the check that it is, whatever sits between (a proxy, a changed agent default).
        request.once("socket", (socket) => {
          const verify = () => {
            const remote = socket.remoteAddress;
            const want = netOf(ip);
            const got = remote === undefined ? null : netOf(remote);
            if (!want || !got || want.family !== got.family || want.value !== got.value)
              request.destroy(new FetchFailure("PINNING_FAILED"));
          };
          if (socket.connecting) socket.once("connect", verify);
          else verify();
        });
        request.setTimeout(timeoutMs, () => {
          idle = true;
          request.destroy(timeout());
        });
        request.on("error", (error) => reject(idle ? timeout() : error));
        request.end();
      }),
  };
}

// Brotli is not offered: identity was asked for, and its window costs memory that the cap does not count.
type Decoder = Gunzip | Inflate;
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
    default:
      throw new FetchFailure("UNSUPPORTED_ENCODING");
  }
}

// Both the wire size and the decoded size are capped, and decoding stops at the cap, so a few KiB
// of compressed zeros cannot grow into memory.
async function readBody(
  body: AsyncIterable<Uint8Array>,
  decoder: Decoder | undefined,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const output: Buffer[] = [];
  let decoded = 0;
  const keep = (chunk: Uint8Array) => {
    decoded += chunk.length;
    if (decoded > maxBytes) throw new FetchFailure("TOO_LARGE");
    output.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
  };
  let wire = 0;
  const pump = async (take: (chunk: Uint8Array) => void) => {
    const iterator = body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(iterator.next(), signal);
        if (next.done) return;
        wire += next.value.length;
        if (wire > maxBytes) throw new FetchFailure("TOO_LARGE");
        take(next.value);
      }
    } finally {
      // A stalled body never settles return(); aborting the request tears it down instead.
      void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  };
  if (!decoder) await pump(keep);
  else {
    decoder.on("error", () => {});
    const decoding = (async () => {
      try {
        for await (const chunk of decoder) keep(chunk);
      } catch (error) {
        throw error instanceof FetchFailure ? error : new FetchFailure("DECODE_FAILED");
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
function codeOf(error: unknown, signal: AbortSignal): string {
  if (error instanceof FetchFailure) return error.code;
  // An abort carries its own reason: here always the deadline.
  if (signal.aborted && signal.reason instanceof FetchFailure) return signal.reason.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && TLS_FAILURE.test(code) ? "TLS_FAILED" : "NETWORK_ERROR";
}

const RESOLUTION_DELAY_MS = 300;
const defaultResolve: Resolve = async (host, signal) => {
  // One resolver per lookup, so that cancelling it stops this lookup and no other.
  const resolver = new dns.Resolver({ timeout: 2000, tries: 2 });
  if (signal?.aborted) throw signal.reason;
  const cancel = () => resolver.cancel();
  signal?.addEventListener("abort", cancel, { once: true });
  // The first non-empty answer starts a short wait for the other record type, then the rest is cancelled.
  let delay: NodeJS.Timeout | undefined;
  const answer = async (query: Promise<string[]>, family: 4 | 6) => {
    try {
      const found = (await query).map((address) => ({ address, family }));
      if (found.length && delay === undefined) delay = setTimeout(cancel, RESOLUTION_DELAY_MS);
      return found;
    } catch (error) {
      // A name with no record of this kind is an empty answer; a failure to ask is a failure.
      const code = (error as { code?: string } | null)?.code;
      if (code === "ENODATA" || code === "ENOTFOUND") return [];
      throw error;
    }
  };
  try {
    // One record type that fails (SERVFAIL, a refusal, a timeout) must not fail a name whose other
    // type answered. Every address that comes back is still judged by the caller.
    const [v4, v6] = await Promise.allSettled([answer(resolver.resolve4(host), 4), answer(resolver.resolve6(host), 6)]);
    if (v4.status === "rejected" && v6.status === "rejected") throw v4.reason;
    return [...(v4.status === "fulfilled" ? v4.value : []), ...(v6.status === "fulfilled" ? v6.value : [])];
  } finally {
    clearTimeout(delay);
    signal?.removeEventListener("abort", cancel);
  }
};

// The value of the `charset` parameter of a Content-Type header, lower-cased, or undefined.
function charsetOf(contentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
  const label = (match?.[1] ?? match?.[2] ?? "").trim().toLowerCase();
  return label === "" ? undefined : label;
}

/**
 * Reads a URL over https and nothing else. Exported for operators who embed the agent code; the
 * reference process does not build it (see `fixtureFetcher`). Read the header of this file first:
 * it says what the resolver does and does not read, that no proxy is used, and what a source can
 * learn about the operator.
 *
 * - Before any lookup it refuses a scheme other than https, userinfo, a port other than 443 and an
 *   IP-address host.
 * - It resolves the name with every address and refuses if any one of them is not public, or lies in
 *   a subnet of one of this machine's interfaces, or in one of `extraBlockedRanges`.
 * - It connects to the address it judged, checks that the socket ended there, and verifies TLS for
 *   the host name.
 * - It judges every redirect again from the start, and follows at most three.
 * - One deadline covers the whole read, redirects and lookups included; the decoded body is capped.
 * - Validators are sent only on the request for the URL they were saved for, and a 304 is believed
 *   only when a conditional header was actually sent.
 *
 * It never throws once built: a failure is `{ status: "error", code }`, and the code carries no
 * message. It throws at construction (`PROXY_CONFIGURED`) when a proxy is configured and `direct` is
 * not set.
 */
export function httpsFetcher(
  options: {
    resolve?: Resolve;
    transport?: FetchTransport;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    /** CIDR ranges to refuse in addition to the non-public ones and this machine's subnets. */
    extraBlockedRanges?: readonly string[];
    /** States that the direct connection is intended although a proxy is configured in the environment. */
    direct?: boolean;
  } = {},
): SourceFetcher {
  if (!options.direct && PROXY_VARIABLES.some((name) => process.env[name])) throw new Error("PROXY_CONFIGURED");
  const extra = (options.extraBlockedRanges ?? []).map((cidr) => {
    const range = parseRange(cidr);
    if (!range) throw new RangeError(`INVALID_RANGE: ${cidr}`);
    return range;
  });
  const resolve = options.resolve ?? defaultResolve;
  const transport = options.transport ?? httpsTransport();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxBytes = options.maxBytes ?? 4 * MIB;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;

  async function hop(
    target: URL,
    validators: Validators,
    overall: AbortSignal,
  ): Promise<{ redirect: string } | { result: SourceFetchResult }> {
    // Its own signal, so the socket of a hop that redirected is released without waiting for the deadline.
    const request = new AbortController();
    const relay = () => request.abort(overall.reason);
    if (overall.aborted) relay();
    else overall.addEventListener("abort", relay, { once: true });
    const { signal } = request;
    try {
      let addresses: Awaited<ReturnType<Resolve>>;
      try {
        addresses = await abortable(resolve(target.hostname, signal), signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw new FetchFailure("DNS_FAILED");
      }
      if (!addresses.length) throw new FetchFailure("DNS_FAILED");
      // One private answer poisons the name: never pick the public one and hope.
      if (addresses.some(({ address }) => !isPublicAddress(address))) throw new FetchFailure("PRIVATE_ADDRESS");
      const blocked = [...extra, ...interfaceRanges()];
      if (blocked.length)
        for (const { address } of addresses) {
          const nets = checkedNets(address);
          if (!nets.length || nets.some((net) => blocked.some((range) => inRange(net, range))))
            throw new FetchFailure("PRIVATE_ADDRESS");
        }
      const { address, family } = addresses[0]!;
      // Validators belong to one URL: on any other hop nothing conditional is sent, so a 304 from
      // another page can never stand for the page that was saved.
      const sent = target.href === validators.finalUrl ? conditional(validators) : {};
      const asked = sent.etag !== undefined || sent.lastModified !== undefined;
      const response = await abortable(
        transport.request({ ip: address, family, url: target, signal, timeoutMs, ...(asked ? { validators: sent } : {}) }),
        signal,
      );
      const headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
      const { status } = response;
      if (status >= 300 && status < 400 && status !== 304 && headers["location"] !== undefined) {
        try {
          return { redirect: new URL(headers["location"], target).href };
        } catch {
          throw new FetchFailure("BAD_REDIRECT");
        }
      }
      // A 304 is only an answer to a question that was asked; without a conditional header it is an error.
      if (status === 304 && asked) return { result: { status: 304 } };
      if (status !== 200) throw new FetchFailure(`HTTP_${status}`);
      const contentType = headers["content-type"] ?? "";
      const mediaType = mediaTypeOf(contentType);
      const charset = charsetOf(contentType);
      if (Number(headers["content-length"]) > maxBytes) throw new FetchFailure("TOO_LARGE");
      const bytes = await readBody(response.body, decoderFor(headers["content-encoding"]), maxBytes, signal);
      // An empty page is a glitch more often than a page: it must not replace what was last read.
      if (!bytes.length) throw new FetchFailure("EMPTY_BODY");
      return {
        result: {
          status: 200,
          bytes,
          mediaType,
          ...(charset !== undefined ? { charset } : {}),
          ...(isEtag(headers["etag"]) ? { etag: headers["etag"] } : {}),
          ...(isLastModified(headers["last-modified"]) ? { lastModified: headers["last-modified"] } : {}),
          finalUrl: target.href,
        },
      };
    } finally {
      overall.removeEventListener("abort", relay);
      request.abort();
    }
  }

  return async (raw, validators) => {
    const overall = new AbortController();
    const timer = setTimeout(() => overall.abort(new FetchFailure("TIMEOUT")), timeoutMs);
    try {
      let next = raw;
      for (let redirects = 0; ; redirects++) {
        if (redirects > maxRedirects) throw new FetchFailure("TOO_MANY_REDIRECTS");
        const judged = judgeUrl(next);
        if ("code" in judged) throw new FetchFailure(judged.code);
        if (overall.signal.aborted) throw overall.signal.reason;
        const outcome = await hop(judged.url, validators, overall.signal);
        if ("redirect" in outcome) {
          next = outcome.redirect;
          continue;
        }
        return outcome.result;
      }
    } catch (error) {
      return { status: "error", code: codeOf(error, overall.signal) };
    } finally {
      clearTimeout(timer);
      overall.abort();
    }
  };
}

// -- The fixture fetcher ----------------------------------------------------------------------

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
};
const fixtureMediaType = (file: string) => {
  const dot = file.lastIndexOf(".");
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return (dot > slash && MEDIA_TYPES[file.slice(dot).toLowerCase()]) || "application/octet-stream";
};
const MAX_FIXTURE_BYTES = 4 * MIB;

/**
 * Serves the source files that the world file names, for the URL each is listed under, and nothing
 * else: any other URL is `NOT_IN_WORLD`. This is what the reference agent process uses, so a test, a
 * drill or a demo reads the same bytes every time and never touches the network. A file is served
 * only if, after links are resolved, it lies inside the world directory, and only up to 4 MiB. The
 * files have no revision to compare, so the validators are not honoured: every answer is a full `200`.
 */
export function fixtureFetcher(world: World): SourceFetcher {
  const files = new Map<string, string>();
  for (const question of Object.values(world.questions))
    for (const [url, file] of Object.entries(question.sources ?? {})) if (!files.has(url)) files.set(url, file);
  return async (url) => {
    const file = files.get(url);
    if (file === undefined) return { status: "error", code: "NOT_IN_WORLD" };
    try {
      const root = await realpath(world.dir);
      const full = await realpath(join(world.dir, file));
      const inside = relative(root, full);
      if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return { status: "error", code: "NOT_IN_WORLD" };
      const info = await stat(full);
      if (!info.isFile()) return { status: "error", code: "FIXTURE_UNREADABLE" };
      if (info.size > MAX_FIXTURE_BYTES) return { status: "error", code: "TOO_LARGE" };
      return { status: 200, bytes: new Uint8Array(await readFile(full)), mediaType: fixtureMediaType(file), finalUrl: url };
    } catch {
      return { status: "error", code: "FIXTURE_UNREADABLE" };
    }
  };
}
