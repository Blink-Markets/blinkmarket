// Pure network policy for fetching official sources. No DNS, sockets or node: imports;
// the adapter resolves and connects, this module only judges addresses and URLs.

/** Stable failure for a fetch; `code` is safe to store, `retryable` drives job retries. */
export class FetchError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code);
    this.name = "FetchError";
  }
}

export const MAX_REDIRECTS = 3;

const blockedV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((cidr) => {
  const [address, length] = cidr.split("/") as [string, string];
  const mask = (0xffffffff << (32 - Number(length))) >>> 0;
  return { network: (toInt(parseIPv4(address)!) & mask) >>> 0, mask };
});

function toInt(octets: number[]) {
  return (
    ((octets[0]! << 24) |
      (octets[1]! << 16) |
      (octets[2]! << 8) |
      octets[3]!) >>>
    0
  );
}
// Canonical dotted quad only: leading zeros are ambiguous (octal) and never valid here.
function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) =>
    /^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : NaN,
  );
  return octets.every((octet) => octet <= 255) ? octets : null;
}
function parseIPv6(text: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  let rest = text;
  if (rest.includes(".")) {
    const split = rest.lastIndexOf(":");
    const tail = parseIPv4(rest.slice(split + 1));
    if (!tail) return null;
    rest =
      rest.slice(0, split + 1) +
      ((tail[0]! << 8) | tail[1]!).toString(16) +
      ":" +
      ((tail[2]! << 8) | tail[3]!).toString(16);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) =>
    part === ""
      ? []
      : part
          .split(":")
          .map((group) =>
            /^[0-9a-fA-F]{1,4}$/.test(group) ? parseInt(group, 16) : NaN,
          );
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...new Array<number>(fill).fill(0), ...tail];
  return all.some(Number.isNaN) ? null : all;
}
const publicV4 = (octets: number[]) => {
  const address = toInt(octets);
  return !blockedV4.some(
    ({ network, mask }) => (address & mask) >>> 0 === network,
  );
};

/** True only for a canonical IPv4/IPv6 address outside every non-public range; fails closed otherwise. */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return publicV4(v4);
  const g = parseIPv6(ip);
  if (!g) return false;
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  const zeros = (from: number, to: number) =>
    g.slice(from, to).every((group) => group === 0);
  // ::ffff:0:0/96 (mapped), 64:ff9b::/96 (NAT64) and ::/96 (IPv4-compatible, covers ::/128
  // and ::1/128) are judged by the IPv4 address they carry.
  if (zeros(0, 5) && g[5] === 0xffff) return publicV4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))
    return publicV4(embedded);
  if (zeros(0, 6)) return publicV4(embedded);
  if (g[0] === 0x100 && zeros(1, 4)) return false; // 100::/64
  // Transition ranges are refused outright rather than judged by what they embed.
  if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return false; // ::ffff:0:0:0/96 (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // 64:ff9b:1::/48
  if (g[0] === 0x2002) return false; // 2002::/16 (6to4)
  if (g[0] === 0x2001 && g[1] === 0) return false; // 2001::/32 (Teredo)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // 2001:db8::/32
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // fec0::/10 (deprecated site-local)
  if ((g[0]! & 0xff00) === 0xff00) return false; // ff00::/8
  return true;
}

export type FetchUrlCode =
  | "NOT_HTTPS"
  | "CREDENTIALS"
  | "PORT"
  | "FRAGMENT"
  | "NOT_ALLOWLISTED"
  | "IP_LITERAL"
  | "TOO_MANY_REDIRECTS";
// A prefix is a directory: it must end with "/" and carry no query, so that
// ".../files/" can never admit ".../filesystem". Anything else admits nothing.
function underPrefix(url: URL, prefix: string) {
  try {
    const base = new URL(prefix);
    return (
      base.pathname.endsWith("/") &&
      !base.search &&
      url.origin === base.origin &&
      url.pathname.startsWith(base.pathname)
    );
  } catch {
    return false;
  }
}

/** Judges one request URL; `hop` is 0 for the first request and counts redirects followed. */
export function checkFetchUrl(
  raw: string,
  policy: { exactUrl: string; redirectPrefixes: readonly string[] },
  hop: number,
): { ok: true } | { ok: false; code: FetchUrlCode } {
  const fail = (code: FetchUrlCode) => ({ ok: false, code }) as const;
  if (hop > MAX_REDIRECTS) return fail("TOO_MANY_REDIRECTS");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("NOT_ALLOWLISTED");
  }
  if (url.protocol !== "https:") return fail("NOT_HTTPS");
  if (url.username || url.password) return fail("CREDENTIALS");
  // The parser drops the default port, so any remaining port is a non-443 one.
  if (url.port) return fail("PORT");
  // An empty fragment ("...#") is not reflected in url.hash.
  if (raw.includes("#")) return fail("FRAGMENT");
  // The parser has already folded decimal, hex and octal IPv4 hosts into dotted quads.
  if (url.hostname.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname))
    return fail("IP_LITERAL");
  if (hop === 0) {
    try {
      return url.href === new URL(policy.exactUrl).href
        ? { ok: true }
        : fail("NOT_ALLOWLISTED");
    } catch {
      return fail("NOT_ALLOWLISTED");
    }
  }
  return policy.redirectPrefixes.some((prefix) => underPrefix(url, prefix))
    ? { ok: true }
    : fail("NOT_ALLOWLISTED");
}
