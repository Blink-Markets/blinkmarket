import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type https from "node:https";
import net from "node:net";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { keccak256, type Hex } from "viem";
import { createContext, type AgentEnv } from "../examples/agents/src/lib/env.ts";
import {
  fixtureFetcher,
  httpsFetcher,
  httpsRequestOptions,
  httpsTransport,
  isCanonicalHttpsUrl,
  isMediaType,
  isPublicAddress,
  mediaTypeOf,
  type SourceFetcher,
} from "../examples/agents/src/lib/fetcher.ts";
import { emptyState, loadState, saveState, type WatchRecord } from "../examples/agents/src/lib/state.ts";
import {
  checkSources,
  decideUpdate,
  fingerprint,
  normalizeForFingerprint,
  watchableUrl,
} from "../examples/agents/src/lib/watch.ts";
import type { World } from "../examples/agents/src/lib/world.ts";
import { isPublicAddress as platformIsPublicAddress } from "../packages/domain/src/network-policy.ts";
import { httpsRequestOptions as platformHttpsRequestOptions } from "../packages/adapters/src/allowlist-fetcher.ts";

// No test in this file may open a socket or ask a real resolver: both are made to throw, so a
// seam that is not injected shows up as a failure instead of as network traffic.
net.Socket.prototype.connect = function () {
  throw new Error("SOCKET_OPENED_IN_TEST");
} as unknown as typeof net.Socket.prototype.connect;
(dns as { lookup: unknown }).lookup = async () => {
  throw new Error("DNS_LOOKUP_IN_TEST");
};

const MIB = 1024 * 1024;
const text = (value: string) => new TextEncoder().encode(value);

type Resolved = { address: string; family: 4 | 6 }[];
type Transport = NonNullable<Parameters<typeof httpsFetcher>[0]>["transport"];
type TransportInput = Parameters<NonNullable<Transport>["request"]>[0];
type TransportResponse = Awaited<ReturnType<NonNullable<Transport>["request"]>>;

const hosts: Record<string, Resolved> = {
  "a.example": [{ address: "93.184.216.34", family: 4 }],
  "v6.example": [{ address: "2606:4700::1111", family: 6 }],
  "mixed.example": [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "metadata.example": [{ address: "169.254.169.254", family: 4 }],
  "mapped.example": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "empty.example": [],
  "a.example.": [{ address: "93.184.216.34", family: 4 }],
  "b.example": [{ address: "93.184.216.35", family: 4 }],
  "zone.example": [{ address: "fe80::1%eth0", family: 6 }],
  "space.example": [{ address: "93.184.216.34 ", family: 4 }],
  "imds6.example": [{ address: "fd00:ec2::254", family: 6 }],
  "nat64.example": [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
};
async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}
const page = (body: AsyncIterable<Uint8Array>, headers: Record<string, string> = {}): TransportResponse => ({
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8", ...headers },
  body,
});
const redirect = (location: string, status = 302): TransportResponse => ({
  status,
  headers: { location },
  body: chunks(),
});

/** A fetcher whose resolver and transport are recorded and never reach the network. */
function harness(
  respond: (input: TransportInput, call: number) => TransportResponse | Promise<TransportResponse>,
  options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
) {
  const requests: TransportInput[] = [];
  const lookups: string[] = [];
  const fetcher = httpsFetcher({
    direct: true,
    async resolve(host) {
      lookups.push(host);
      const found = hosts[host];
      if (!found) throw new Error("ENOTFOUND");
      return found;
    },
    transport: {
      async request(input) {
        requests.push(input);
        return respond(input, requests.length);
      },
    },
    ...options,
  });
  return { fetcher, requests, lookups };
}
const none = {};

// -- Refusals before any socket opens ---------------------------------------------------------

test("a URL with userinfo, a non-443 port, a non-https scheme or an IP-literal host is refused before any socket opens", async () => {
  const cases: [string, string][] = [
    ["http://a.example/", "NOT_HTTPS"],
    ["https://user:pw@a.example/", "CREDENTIALS"],
    ["https://a.example:8443/", "PORT"],
    ["https://10.0.0.1/", "IP_LITERAL"],
    ["https://[::1]/", "IP_LITERAL"],
    ["https://0x7f.1/", "IP_LITERAL"],
    ["https://2130706433/", "IP_LITERAL"],
    ["https://127.0.0.1./", "IP_LITERAL"],
    ["ftp://a.example/", "NOT_HTTPS"],
    ["not a url", "INVALID_URL"],
  ];
  for (const [url, code] of cases) {
    const { fetcher, requests, lookups } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(url, none), { status: "error", code }, url);
    assert.equal(requests.length, 0, `${url}: the transport was reached`);
    assert.equal(lookups.length, 0, `${url}: the resolver was reached`);
  }
});

test("an explicit :443 and a fragment are harmless; the fragment is never sent", async () => {
  const { fetcher, requests } = harness(() => page(chunks(text("ok"))));
  const result = await fetcher("https://a.example:443/p?q=1#top", none);
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url.href, "https://a.example/p?q=1");
});

test("a lookup answer with one public and one private address is refused", async () => {
  for (const host of ["mixed.example", "metadata.example", "mapped.example"]) {
    const { fetcher, requests } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(`https://${host}/`, none), { status: "error", code: "PRIVATE_ADDRESS" }, host);
    assert.equal(requests.length, 0, `${host}: the transport was reached`);
  }
});

test("a failed lookup or an empty answer is DNS_FAILED and opens nothing", async () => {
  for (const host of ["unknown.example", "empty.example"]) {
    const { fetcher, requests } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(`https://${host}/`, none), { status: "error", code: "DNS_FAILED" }, host);
    assert.equal(requests.length, 0);
  }
});

test("the transport gets the address that was checked, and the URL keeps its name", async () => {
  const { fetcher, requests } = harness(() => page(chunks(text("ok"))));
  await fetcher("https://v6.example/x", none);
  assert.equal(requests[0]!.ip, "2606:4700::1111");
  assert.equal(requests[0]!.family, 6);
  assert.equal(requests[0]!.url.hostname, "v6.example");
  assert.ok(requests[0]!.signal instanceof AbortSignal);
});

/** A stand-in for dns.Resolver: records what was asked, answers from a table, and can be cancelled. */
function fakeResolver(table: Record<string, { v4?: string[] | string; v6?: string[] | string }>) {
  const calls: string[] = [];
  const created: { timeout?: number; tries?: number }[] = [];
  const cancelled: string[] = [];
  const stoppers: (() => void)[] = [];
  class FakeResolver {
    constructor(options?: { timeout?: number; tries?: number }) {
      created.push(options ?? {});
    }
    private answer(kind: "v4" | "v6", host: string): Promise<string[]> {
      calls.push(`${kind}:${host}`);
      const found = table[host]?.[kind];
      if (found === undefined) return Promise.reject(Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }));
      if (found === "HANG") return new Promise<string[]>(() => {});
      // Never answers until the resolver is cancelled, as a name server that stays silent does.
      if (found === "HANG_UNTIL_CANCEL")
        return new Promise<string[]>((_resolve, reject) => {
          stoppers.push(() => reject(Object.assign(new Error("query ECANCELLED"), { code: "ECANCELLED" })));
        });
      if (typeof found === "string") return Promise.reject(Object.assign(new Error(found), { code: found }));
      return Promise.resolve(found);
    }
    resolve4(host: string) {
      return this.answer("v4", host);
    }
    resolve6(host: string) {
      return this.answer("v6", host);
    }
    cancel() {
      cancelled.push("cancel");
      for (const stop of stoppers.splice(0)) stop();
    }
  }
  const saved = dns.Resolver;
  (dns as { Resolver: unknown }).Resolver = FakeResolver;
  return { calls, created, cancelled, restore: () => ((dns as { Resolver: unknown }).Resolver = saved) };
}

test("the default resolver asks c-ares for A and AAAA with a bound on time and tries, never getaddrinfo", async () => {
  const fake = fakeResolver({ "a.example": { v4: ["93.184.216.34"], v6: ["2606:4700::1111"] }, "v4only.example": { v4: ["93.184.216.35"], v6: "ENODATA" } });
  try {
    const requests: TransportInput[] = [];
    const fetcher = httpsFetcher({
      direct: true,
      transport: {
        async request(input) {
          requests.push(input);
          return page(chunks(text("ok")));
        },
      },
    });
    assert.equal((await fetcher("https://a.example/", none)).status, 200);
    assert.equal(requests[0]!.ip, "93.184.216.34", "the first answer is the one that was judged and used");
    assert.equal((await fetcher("https://v4only.example/", none)).status, 200, "no AAAA record is not a failure");
    assert.deepEqual(fake.calls, ["v4:a.example", "v6:a.example", "v4:v4only.example", "v6:v4only.example"]);
    assert.deepEqual(fake.created, [{ timeout: 2000, tries: 2 }, { timeout: 2000, tries: 2 }], "a new resolver per lookup, so a cancel reaches only that lookup");
    // A name with no record of either kind is DNS_FAILED, and a resolver failure is too.
    assert.deepEqual(await fetcher("https://unknown.example/", none), { status: "error", code: "DNS_FAILED" });
    assert.equal(requests.length, 2);
    const broken = fakeResolver({ "down.example": { v4: "ECONNREFUSED", v6: "ECONNREFUSED" } });
    try {
      assert.deepEqual(await fetcher("https://down.example/", none), { status: "error", code: "DNS_FAILED" });
    } finally {
      broken.restore();
    }
  } finally {
    fake.restore();
  }
});

test("the resolver is given the fetch's signal, and an abort reaches it", async () => {
  // An injected resolver gets the signal as its second argument and sees it abort at the deadline.
  const seen: { host: string; signal: AbortSignal | undefined }[] = [];
  const fetcher = httpsFetcher({
    direct: true,
    timeoutMs: 30,
    resolve: (host, signal) => {
      seen.push({ host, signal });
      return new Promise<never>(() => {});
    },
    transport: { request: async () => assert.fail("never reached") },
  });
  assert.deepEqual(await fetcher("https://slow.example/", none), { status: "error", code: "TIMEOUT" });
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.signal instanceof AbortSignal);
  assert.equal(seen[0]!.signal!.aborted, true, "the lookup was told to stop when the fetch gave up");

  // The default resolver turns that abort into Resolver.cancel(), which stops the queries themselves.
  const fake = fakeResolver({ "hang.example": { v4: "HANG", v6: "HANG" } });
  try {
    const stuck = httpsFetcher({ direct: true, timeoutMs: 30, transport: { request: async () => assert.fail("never reached") } });
    assert.deepEqual(await stuck("https://hang.example/", none), { status: "error", code: "TIMEOUT" });
    assert.deepEqual(fake.cancelled, ["cancel"], "the abort cancelled the resolver");
  } finally {
    fake.restore();
  }
});

// -- The pinned connection --------------------------------------------------------------------

const answers = (options: https.RequestOptions) => {
  const lookup = options.lookup!;
  return Promise.all([
    new Promise((resolve) => lookup("attacker-chosen.example", {}, (error, address, family) => resolve({ error, address, family }))),
    new Promise((resolve) => lookup("attacker-chosen.example", { all: true }, (error, list) => resolve({ error, list }))),
  ]);
};

test("httpsRequestOptions pins the connection to the checked address", async () => {
  const v4 = httpsRequestOptions({
    ip: "93.184.216.34",
    family: 4,
    url: new URL("https://a.example/reports/q1.html?lang=en"),
  });
  assert.equal(v4.protocol, "https:");
  assert.equal(v4.hostname, "a.example");
  assert.equal(v4.port, 443);
  assert.equal(v4.method, "GET");
  assert.equal(v4.path, "/reports/q1.html?lang=en");
  assert.equal(v4.servername, "a.example");
  assert.equal(v4.agent, false);
  assert.equal(v4.rejectUnauthorized, true);
  const headers = v4.headers as Record<string, string>;
  assert.equal(headers["Host"], "a.example");
  assert.equal(headers["Accept-Encoding"], "identity");
  assert.equal(headers["Cookie"], undefined);
  assert.equal(headers["If-None-Match"], undefined);
  assert.deepEqual(await answers(v4), [
    { error: null, address: "93.184.216.34", family: 4 },
    { error: null, list: [{ address: "93.184.216.34", family: 4 }] },
  ]);

  const v6 = httpsRequestOptions({
    ip: "2606:4700::1111",
    family: 6,
    url: new URL("https://v6.example:443/files/a"),
  });
  assert.equal(v6.servername, "v6.example");
  assert.equal((v6.headers as Record<string, string>)["Host"], "v6.example");
  assert.deepEqual(await answers(v6), [
    { error: null, address: "2606:4700::1111", family: 6 },
    { error: null, list: [{ address: "2606:4700::1111", family: 6 }] },
  ]);
});

test("httpsRequestOptions sends the validators it is given and drops malformed ones", () => {
  const url = new URL("https://a.example/");
  const sent = httpsRequestOptions({
    ip: "93.184.216.34",
    family: 4,
    url,
    validators: { etag: '"abc"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT" },
  });
  const headers = sent.headers as Record<string, string>;
  assert.equal(headers["If-None-Match"], '"abc"');
  assert.equal(headers["If-Modified-Since"], "Tue, 01 Jan 2030 00:00:00 GMT");
  const bad = httpsRequestOptions({
    ip: "93.184.216.34",
    family: 4,
    url,
    validators: { etag: '"a"\r\nX-Evil: 1', lastModified: "x".repeat(300) },
  });
  assert.equal((bad.headers as Record<string, string>)["If-None-Match"], undefined);
  assert.equal((bad.headers as Record<string, string>)["If-Modified-Since"], undefined);
  // Only an entity tag and an IMF-fixdate are validators; any other printable string is not.
  for (const etag of ["*", "abc", '"a" "b"', `"${"x".repeat(251)}"`, 'W/abc', '"a\u00e9"'])
    assert.equal((httpsRequestOptions({ ip: "93.184.216.34", family: 4, url, validators: { etag } }).headers as Record<string, string>)["If-None-Match"], undefined, etag);
  for (const etag of ['"abc"', 'W/"abc"', '""', `"${"x".repeat(250)}"`])
    assert.equal((httpsRequestOptions({ ip: "93.184.216.34", family: 4, url, validators: { etag } }).headers as Record<string, string>)["If-None-Match"], etag, etag);
  for (const lastModified of ["id=" + "7f3a".repeat(63), "yesterday", "Tue, 1 Jan 2030 00:00:00 GMT", "Tue, 01 Jan 2030 00:00:00 UTC", "Tuesday, 01-Jan-30 00:00:00 GMT"])
    assert.equal((httpsRequestOptions({ ip: "93.184.216.34", family: 4, url, validators: { lastModified } }).headers as Record<string, string>)["If-Modified-Since"], undefined, lastModified);
});

// A stand-in for node:https that records what the transport asked of the request.
function fakeHttps(status = 200, headers: Record<string, string> = { "content-type": "text/html" }) {
  const state: { options?: https.RequestOptions; idleMs?: number; onIdle?: () => void; ended: boolean } = {
    ended: false,
  };
  const request = (options: https.RequestOptions, callback: (response: never) => void) => {
    state.options = options;
    const fake = Object.assign(new EventEmitter(), {
      setTimeout(ms: number, onIdle: () => void) {
        state.idleMs = ms;
        state.onIdle = onIdle;
        return fake;
      },
      end() {
        state.ended = true;
        const response = Object.assign(new PassThrough(), { statusCode: status, headers });
        response.end("hello");
        callback(response as never);
      },
      destroy() {
        return fake;
      },
    });
    return fake;
  };
  return { state, request: request as unknown as typeof https.request };
}

test("the default transport passes those options to request", async () => {
  const { state, request } = fakeHttps();
  const controller = new AbortController();
  const response = await httpsTransport({ request }).request({
    ip: "93.184.216.34",
    family: 4,
    url: new URL("https://a.example/p?x=1"),
    signal: controller.signal,
    timeoutMs: 777,
    validators: { etag: '"v1"' },
  });
  const expected = httpsRequestOptions({
    ip: "93.184.216.34",
    family: 4,
    url: new URL("https://a.example/p?x=1"),
    validators: { etag: '"v1"' },
  });
  const { lookup, ...given } = state.options!;
  const { lookup: expectedLookup, ...wanted } = expected;
  assert.equal(typeof lookup, "function");
  assert.equal(typeof expectedLookup, "function");
  assert.equal(given.signal, controller.signal);
  delete given.signal;
  assert.deepEqual(given, wanted);
  assert.deepEqual(await answers(state.options!), await answers(expected));
  assert.equal(state.idleMs, 777);
  assert.equal(state.ended, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/html");
  const body: Uint8Array[] = [];
  for await (const part of response.body) body.push(part);
  assert.equal(Buffer.concat(body).toString(), "hello");
});

test("an idle socket is a TIMEOUT, whatever the error that follows", async () => {
  const requests: https.RequestOptions[] = [];
  const request = ((options: https.RequestOptions) => {
    requests.push(options);
    const fake = Object.assign(new EventEmitter(), {
      setTimeout(_ms: number, onIdle: () => void) {
        queueMicrotask(onIdle);
        return fake;
      },
      end() {},
      destroy(error: unknown) {
        queueMicrotask(() => fake.emit("error", error));
        return fake;
      },
    });
    return fake;
  }) as unknown as typeof https.request;
  const fetcher = httpsFetcher({
    direct: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    transport: httpsTransport({ request }),
  });
  assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code: "TIMEOUT" });
  assert.equal(requests.length, 1);
});

// -- Redirects --------------------------------------------------------------------------------

test("every redirect is checked again: a redirect to an IP literal, to http, to another port or to a name that resolves privately is refused, and a fourth redirect is refused", async () => {
  const cases: [string, string][] = [
    ["https://169.254.169.254/latest", "IP_LITERAL"],
    ["https://[::1]/", "IP_LITERAL"],
    ["https://0177.0.0.1/", "IP_LITERAL"],
    ["http://v6.example/files/a", "NOT_HTTPS"],
    ["https://v6.example:8443/files/a", "PORT"],
    ["https://user:pw@v6.example/files/a", "CREDENTIALS"],
    ["https://metadata.example/latest", "PRIVATE_ADDRESS"],
    ["https://mixed.example/", "PRIVATE_ADDRESS"],
    ["https://unknown.example/", "DNS_FAILED"],
  ];
  for (const [location, code] of cases) {
    const { fetcher, requests } = harness((_input, call) => (call === 1 ? redirect(location) : page(chunks(text("secret")))));
    assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code }, location);
    assert.equal(requests.length, 1, `${location}: only the first hop may have connected`);
  }

  const hops = (count: number) =>
    harness((_input, call) =>
      call <= count
        ? redirect(call === 1 ? "https://v6.example/files/1" : `/files/${call}`, [301, 302, 307][call % 3])
        : page(chunks(text("done"))),
    );
  const ok = hops(3);
  assert.equal((await ok.fetcher("https://a.example/", none)).status, 200);
  assert.equal(ok.requests.length, 4);
  assert.equal(ok.requests[1]!.ip, "2606:4700::1111");
  assert.equal(ok.requests[3]!.url.href, "https://v6.example/files/3");
  const tooMany = hops(4);
  assert.deepEqual(await tooMany.fetcher("https://a.example/", none), { status: "error", code: "TOO_MANY_REDIRECTS" });
  assert.equal(tooMany.requests.length, 4);
  const narrowed = harness(() => redirect("https://v6.example/files/1"), { maxRedirects: 1 });
  assert.deepEqual(await narrowed.fetcher("https://a.example/", none), { status: "error", code: "TOO_MANY_REDIRECTS" });
  assert.equal(narrowed.requests.length, 2);
});

test("a redirect without a usable Location is an error, not a follow", async () => {
  const bare = harness(() => ({ status: 302, headers: {}, body: chunks() }));
  assert.deepEqual(await bare.fetcher("https://a.example/", none), { status: "error", code: "HTTP_302" });
  const broken = harness(() => redirect("https://[bad"));
  assert.deepEqual(await broken.fetcher("https://a.example/", none), { status: "error", code: "BAD_REDIRECT" });
});

// -- Size, encoding, status -------------------------------------------------------------------

test("a compressed body that expands past the cap is UNREACHABLE with code TOO_LARGE", async () => {
  const cap = 64 * 1024;
  for (const [encoding, encoded] of [
    ["gzip", gzipSync(new Uint8Array(4 * MIB))],
    ["deflate", deflateSync(new Uint8Array(4 * MIB))],
  ] as const) {
    assert.ok(encoded.length < cap, `${encoding} fixture is small on the wire`);
    const { fetcher } = harness(() => page(chunks(encoded), { "content-encoding": encoding }), { maxBytes: cap });
    assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code: "TOO_LARGE" }, encoding);
  }
  // Through checkSources the same answer is an UNREACHABLE source that keeps nothing.
  const { fetcher } = harness(() => page(chunks(gzipSync(new Uint8Array(4 * MIB))), { "content-encoding": "gzip" }), { maxBytes: cap });
  const checked = await checkSources(fetcher, { sources: {} }, ["https://a.example/"], 1000);
  assert.equal(checked.items[0]!.status, "UNREACHABLE");
  assert.equal(checked.items[0]!.code, "TOO_LARGE");
  assert.deepEqual(checked.next, {});
});

test("a body over the cap is TOO_LARGE, an oversize Content-Length is refused unread, and a body at the cap is accepted", async () => {
  const cap = 1024;
  const over = harness(() => page(chunks(new Uint8Array(cap), new Uint8Array(1))), { maxBytes: cap });
  assert.deepEqual(await over.fetcher("https://a.example/", none), { status: "error", code: "TOO_LARGE" });
  let read = false;
  const declared = harness(
    () =>
      page(
        (async function* () {
          read = true;
          yield text("x");
        })(),
        { "content-length": String(cap + 1) },
      ),
    { maxBytes: cap },
  );
  assert.deepEqual(await declared.fetcher("https://a.example/", none), { status: "error", code: "TOO_LARGE" });
  assert.equal(read, false);
  const exact = harness(() => page(chunks(new Uint8Array(cap))), { maxBytes: cap });
  const result = await exact.fetcher("https://a.example/", none);
  assert.equal(result.status === 200 && result.bytes.length, cap);
  const defaults = harness(() => page(chunks(new Uint8Array(4 * MIB), new Uint8Array(1))));
  assert.deepEqual(await defaults.fetcher("https://a.example/", none), { status: "error", code: "TOO_LARGE" });
});

test("a 200 answer decodes gzip and deflate and reports the media type without parameters", async () => {
  const original = text("<html>Gross margin 41%</html>");
  for (const [encoding, encoded] of [
    ["gzip", gzipSync(original)],
    ["deflate", deflateSync(original)],
    ["identity", original],
  ] as const) {
    const { fetcher } = harness(() =>
      page(chunks(encoded.slice(0, 5), encoded.slice(5)), {
        "content-encoding": encoding,
        "Content-Type": "Text/HTML; charset=UTF-8",
        etag: '"v7"',
        "last-modified": "Tue, 01 Jan 2030 00:00:00 GMT",
      }),
    );
    const result = await fetcher("https://a.example/", none);
    assert.equal(result.status, 200, encoding);
    if (result.status !== 200) continue;
    assert.deepEqual(new Uint8Array(result.bytes), original, encoding);
    assert.equal(result.mediaType, "text/html");
    assert.equal(result.etag, '"v7"');
    assert.equal(result.lastModified, "Tue, 01 Jan 2030 00:00:00 GMT");
  }
  const missing = harness(() => ({ status: 200, headers: {}, body: chunks(text("x")) }));
  const result = await missing.fetcher("https://a.example/", none);
  assert.equal(result.status === 200 && result.mediaType, "application/octet-stream");
});

test("a corrupt or unknown content encoding, an HTTP error and a transport failure are error codes", async () => {
  const corrupt = harness(() => page(chunks(text("not gzip at all")), { "content-encoding": "gzip" }));
  assert.deepEqual(await corrupt.fetcher("https://a.example/", none), { status: "error", code: "DECODE_FAILED" });
  const unknown = harness(() => page(chunks(text("x")), { "content-encoding": "compress" }));
  assert.deepEqual(await unknown.fetcher("https://a.example/", none), { status: "error", code: "UNSUPPORTED_ENCODING" });
  for (const status of [404, 429, 500]) {
    const failing = harness(() => ({ status, headers: {}, body: chunks() }));
    assert.deepEqual(await failing.fetcher("https://a.example/", none), { status: "error", code: `HTTP_${status}` });
  }
  const reset = harness(() => {
    throw Object.assign(new Error("socket hang up with a secret inside"), { code: "ECONNRESET" });
  });
  assert.deepEqual(await reset.fetcher("https://a.example/", none), { status: "error", code: "NETWORK_ERROR" });
  const certificate = harness(() => {
    throw Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  });
  assert.deepEqual(await certificate.fetcher("https://a.example/", none), { status: "error", code: "TLS_FAILED" });
});

test("the timeout stops a transport that never answers and a body that stalls", async () => {
  const silent = harness(() => new Promise<TransportResponse>(() => {}), { timeoutMs: 30 });
  assert.deepEqual(await silent.fetcher("https://a.example/", none), { status: "error", code: "TIMEOUT" });
  const stalled = harness(
    () =>
      page(
        (async function* () {
          yield text("part");
          await new Promise<never>(() => {});
        })(),
      ),
    { timeoutMs: 30 },
  );
  assert.deepEqual(await stalled.fetcher("https://a.example/", none), { status: "error", code: "TIMEOUT" });
  const slowRedirect = harness((_input, call) => (call === 1 ? redirect("https://v6.example/") : new Promise<TransportResponse>(() => {})), {
    timeoutMs: 30,
  });
  assert.deepEqual(await slowRedirect.fetcher("https://a.example/", none), { status: "error", code: "TIMEOUT" });
});

test("a 304 answer is UNCHANGED and downloads nothing", async () => {
  let read = false;
  const { fetcher, requests } = harness(() => ({
    status: 304,
    headers: {},
    body: (async function* () {
      read = true;
      yield text("never read");
    })(),
  }));
  // The validators belong to the page at finalUrl; the transport gets only the conditional values.
  assert.deepEqual(await fetcher("https://a.example/", { etag: '"v1"', finalUrl: "https://a.example/" }), { status: 304 });
  assert.deepEqual(requests[0]!.validators, { etag: '"v1"' });
  assert.equal(read, false);
  // Without validators a 304 was not asked for; it is an error, never "unchanged".
  assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code: "HTTP_304" });

  const fingerprintOf = "0x" + "ab".repeat(32);
  const stored: WatchRecord = {
    sources: { "https://a.example/": { fingerprint: fingerprintOf as Hex, etag: '"v1"', finalUrl: "https://a.example/", checkedAt: 100 } },
  };
  const checked = await checkSources(fetcher, stored, ["https://a.example/"], 200);
  assert.equal(checked.items[0]!.status, "UNCHANGED");
  assert.equal(checked.items[0]!.fingerprint, fingerprintOf);
  assert.deepEqual(checked.next["https://a.example/"], { fingerprint: fingerprintOf, etag: '"v1"', finalUrl: "https://a.example/", checkedAt: 200 });
  assert.equal(stored.sources["https://a.example/"]!.checkedAt, 100, "the record passed in is not changed");
});

// -- The address rules and the drift test -----------------------------------------------------

const ADDRESSES = [
  // IPv4: public, then every blocked range at both edges.
  "8.8.8.8", "1.1.1.1", "93.184.216.34", "172.15.255.255", "172.32.0.0", "100.63.255.255", "100.128.0.0",
  "0.0.0.0", "0.255.255.255", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.127.255.255", "127.0.0.1",
  "127.255.255.255", "169.254.169.254", "169.253.0.1", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.0.2.5",
  "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1",
  "239.255.255.255", "240.0.0.1", "255.255.255.255",
  // IPv4 spellings that are not canonical fail closed.
  "010.0.0.1", "0177.0.0.1", "127.1", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.256", "+1.2.3.4", " 1.2.3.4", "1.2.3.4 ", "",
  "2130706433", "0x7f.0.0.1",
  // IPv6.
  "::", "::1", "2606:4700::1111", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "fe80::1", "fe80::1%eth0",
  "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  "2002:c000:204::1", "2002:0808:0808::1", "100::1", "100::", "100:0:0:1::1",
  // Mapped, compatible, NAT64 and SIIT forms are judged by what they carry, or refused.
  "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:10.1.2.3", "::ffff:7f00:1", "::ffff:808:808", "::ffff:a9fe:a9fe",
  "0:0:0:0:0:ffff:192.168.0.1", "::8.8.8.8", "::808:808", "::7f00:1", "64:ff9b::8.8.8.8", "64:ff9b::808:808",
  "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b:1::1", "64:ff9b:1:2::3", "::ffff:0:8.8.8.8", "::ffff:0:808:808",
  // Malformed IPv6 fails closed.
  ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "g::1", "12345::1", "::1.2.3", "::1.2.3.4.5", "[::1]",
  "::ffff:1.2.3.4:5", "1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7", "2606:4700::1111/64", "::ffff:01.2.3.4",
  "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4",
  // Ranges that are not globally reachable, and the exceptions inside them that are.
  "2001:2::1", "2001:10::1", "2001:5::1", "2001:1ff::1", "3fff::1", "3fff:fff::1", "3fff:1000::1", "5f00::1", "100:0:0:1::1", "::1:0:0:0",
  "4000::1", "8000::1", "fe00::1", "2001:1::1", "2001:1::2", "2001:1::3", "2001:1::4", "2001:1:0:1::1", "2001:3::", "2001:4:112::", "2001:4:113::", "2001:20::",
  "2001:30::", "2001:40::", "2001:200::1", "2001:4860:4860::8888", "2620:4f:8000::1",
];

test("isPublicAddress agrees with the platform's isPublicAddress over a list of addresses", () => {
  for (const address of ADDRESSES)
    assert.equal(isPublicAddress(address), platformIsPublicAddress(address), `address ${JSON.stringify(address)}`);
  // The list must exercise both answers, or the comparison proves nothing.
  assert.ok(ADDRESSES.some((a) => isPublicAddress(a)));
  assert.ok(ADDRESSES.some((a) => !isPublicAddress(a)));
  // A sweep of every IPv4 /16-ish boundary the rules name, against the platform's.
  for (let a = 0; a < 256; a++)
    for (const b of [0, 1, 15, 16, 31, 32, 63, 64, 99, 100, 127, 128, 168, 169, 253, 254, 255]) {
      const address = `${a}.${b}.0.1`;
      assert.equal(isPublicAddress(address), platformIsPublicAddress(address), address);
    }
});

test("the example's httpsRequestOptions has the same connection settings as the platform's", async () => {
  for (const [ip, family, href] of [
    ["93.184.216.34", 4, "https://a.example/reports/q1.html?lang=en"],
    ["2606:4700::1111", 6, "https://v6.example/files/a"],
  ] as const) {
    const mine = httpsRequestOptions({ ip, family, url: new URL(href) });
    const theirs = platformHttpsRequestOptions({ ip, family, url: new URL(href) });
    for (const field of ["protocol", "hostname", "port", "method", "path", "servername", "agent", "rejectUnauthorized"] as const)
      assert.deepEqual(mine[field], theirs[field], field);
    assert.equal((mine.headers as Record<string, string>)["Host"], (theirs.headers as Record<string, string>)["Host"]);
    assert.deepEqual(await answers(mine), await answers(theirs));
  }
});

// -- Normalisation and fingerprints -----------------------------------------------------------

const html = (body: string) => text(`<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`);

test("a script nonce and a timestamp attribute keep the fingerprint; a changed paragraph changes it", () => {
  const a = html(
    `<script nonce="aaa111">window.t=1</script><p data-ts="1700000000" class="x">Gross margin is 70%.</p><!-- rendered at 12:00 -->`,
  );
  const b = html(
    `<script nonce="bbb222">window.t=2</script><p data-ts="1700009999" class="y">Gross   margin
     is 70%.</p><!-- rendered at 12:01 --><style>p{color:red}</style><noscript>enable js</noscript>`,
  );
  const c = html(`<script nonce="aaa111">window.t=1</script><p data-ts="1700000000" class="x">Gross margin is 68%.</p>`);
  const fp = (bytes: Uint8Array) => fingerprint(normalizeForFingerprint(bytes, "text/html"));
  assert.equal(fp(a), fp(b));
  assert.notEqual(fp(a), fp(c));
  assert.match(fp(a), /^0x[0-9a-f]{64}$/);
  assert.equal(fp(a), keccak256(new TextEncoder().encode(normalizeForFingerprint(a, "text/html"))));
});

test("html normalisation drops tags, scripts, styles, comments and decodes entities", () => {
  const out = normalizeForFingerprint(
    html(
      `<h1 title="a > b">Q&amp;A &lt;draft&gt;&nbsp;&#65;&#x42;&bogus; &#1114112;</h1><SCRIPT type="x">1 < 2</SCRIPT ><p>one</p><!-- x > y --><p>two</p>`,
    ),
    "text/html; charset=utf-8",
  );
  assert.equal(out, "T Q&A <draft> AB&bogus; \u{fffd} one two");
});

test("html normalisation is linear on hostile input", () => {
  const started = performance.now();
  for (const piece of ["<!--", "<script>", "<a ", "<style x='", "<", "&#", "&amp"]) {
    normalizeForFingerprint(text(piece.repeat(200_000)), "text/html");
  }
  assert.ok(performance.now() - started < 5000, "unterminated markup must not be quadratic");
});

test("key order does not change a JSON fingerprint; a changed value does", () => {
  const fp = (json: string, type = "application/json") => fingerprint(normalizeForFingerprint(text(json), type));
  assert.equal(fp('{"a":1,"b":{"y":[1,2],"x":null}}'), fp('{ "b": {"x": null, "y": [1, 2]},\n "a": 1 }'));
  assert.notEqual(fp('{"a":1,"b":2}'), fp('{"a":1,"b":3}'));
  assert.notEqual(fp('{"a":[1,2]}'), fp('{"a":[2,1]}'), "array order is data");
  assert.equal(fp('{"__proto__":1,"a":2}'), fp('{"a":2,"__proto__":1}'));
  // Not JSON after all: the text is compared with whitespace collapsed instead.
  assert.equal(fp("{ broken   json"), fp("{ broken json"));
});

test("plain text and csv collapse whitespace; a pdf and anything else hash the raw bytes", () => {
  const fp = (value: string | Uint8Array, type: string) =>
    fingerprint(normalizeForFingerprint(typeof value === "string" ? text(value) : value, type));
  assert.equal(fp("  a   b\n\n c \n", "text/plain"), fp("a b c", "text/plain"));
  assert.equal(fp("x,y\r\n1,2\r\n", "text/csv"), fp("x,y 1,2", "text/csv"));
  const pdf = text("%PDF-1.7 a b");
  assert.equal(fp(pdf, "application/pdf"), fp(pdf, "application/octet-stream"));
  assert.notEqual(fp(text("%PDF-1.7 a  b"), "application/pdf"), fp(pdf, "application/pdf"), "raw bytes: whitespace counts");
  assert.notEqual(fp(pdf, "application/pdf"), fp(pdf, "text/plain"));
});

// -- checkSources -----------------------------------------------------------------------------

/** A fetcher that answers from a table that a test edits between checks. */
function scripted() {
  const answers = new Map<string, Awaited<ReturnType<SourceFetcher>>>();
  const seen: { url: string; validators: { etag?: string; lastModified?: string; finalUrl?: string } }[] = [];
  const fetcher: SourceFetcher = async (url, validators) => {
    seen.push({ url, validators });
    const answer = answers.get(url) ?? { status: "error", code: "NOT_IN_WORLD" };
    return answer.status === 200 && answer.finalUrl === undefined ? { ...answer, finalUrl: url } : answer;
  };
  return { answers, seen, fetcher };
}
const ok = (body: string, extra: { etag?: string; lastModified?: string; finalUrl?: string; charset?: string } = {}, mediaType = "text/plain") =>
  ({ status: 200, bytes: text(body), mediaType, ...extra }) as const;

test("a first sighting is NEW with since null, a changed fingerprint is CHANGED, the same is UNCHANGED, a failed fetch is UNREACHABLE and keeps the old fingerprint", async () => {
  const { answers, fetcher } = scripted();
  const u1 = "https://one.example/";
  const u2 = "https://two.example/";
  answers.set(u1, ok("margin 70%", { etag: '"1"' }));
  answers.set(u2, ok("steady"));

  const first = await checkSources(fetcher, { sources: {} }, [u1, u2], 1000);
  assert.deepEqual(
    first.items.map((i) => [i.url, i.status, i.since, i.observedAt]),
    [
      [u1, "NEW", null, 1000],
      [u2, "NEW", null, 1000],
    ],
  );
  assert.deepEqual(first.items[0]!.raw, text("margin 70%"));
  assert.equal(first.items[0]!.mediaType, "text/plain");
  assert.equal(first.next[u1]!.etag, '"1"');
  assert.equal(first.next[u1]!.checkedAt, 1000);

  // Second look: u1 edited, u2 the same.
  answers.set(u1, ok("margin 68%", { etag: '"2"' }));
  const second = await checkSources(fetcher, { sources: first.next }, [u1, u2], 2000);
  const byUrl = Object.fromEntries(second.items.map((i) => [i.url, i]));
  assert.equal(byUrl[u1]!.status, "CHANGED");
  assert.equal(byUrl[u1]!.since, 1000);
  assert.equal(byUrl[u1]!.observedAt, 2000);
  assert.deepEqual(byUrl[u1]!.raw, text("margin 68%"));
  assert.notEqual(byUrl[u1]!.fingerprint, first.items[0]!.fingerprint);
  assert.equal(byUrl[u2]!.status, "UNCHANGED");
  assert.equal(byUrl[u2]!.since, null);
  assert.equal(byUrl[u2]!.raw, undefined);
  assert.equal(second.next[u1]!.etag, '"2"');

  // Third look: u1 fails, u2 fails; the old fingerprints stay, so nothing is faked later.
  answers.set(u1, { status: "error", code: "TIMEOUT" });
  answers.delete(u2);
  const third = await checkSources(fetcher, { sources: second.next }, [u1, u2], 3000);
  assert.deepEqual(
    third.items.map((i) => [i.status, i.code, i.fingerprint, i.since]),
    [
      ["UNREACHABLE", "TIMEOUT", second.next[u1]!.fingerprint, null],
      ["UNREACHABLE", "NOT_IN_WORLD", second.next[u2]!.fingerprint, null],
    ],
  );
  assert.deepEqual(third.next, second.next);

  // And a recovery with the same text is UNCHANGED, not CHANGED.
  answers.set(u1, ok("margin 68%"));
  const fourth = await checkSources(fetcher, { sources: third.next }, [u1], 4000);
  assert.equal(fourth.items[0]!.status, "UNCHANGED");
});

test("a source whose first check fails has no fingerprint and no entry, so its first success is NEW", async () => {
  const { answers, fetcher } = scripted();
  const url = "https://one.example/";
  answers.set(url, { status: "error", code: "TIMEOUT" });
  const failed = await checkSources(fetcher, { sources: {} }, [url], 100);
  assert.deepEqual(
    failed.items.map((i) => [i.status, i.code, i.fingerprint, i.since]),
    [["UNREACHABLE", "TIMEOUT", null, null]],
  );
  assert.deepEqual(failed.next, {});
  answers.set(url, ok("v1"));
  const first = await checkSources(fetcher, { sources: failed.next }, [url], 200);
  assert.equal(first.items[0]!.status, "NEW");
  assert.equal(first.items[0]!.since, null);
  assert.match(first.items[0]!.fingerprint!, /^0x[0-9a-f]{64}$/);
});

test("since is the time of the previous successful check", async () => {
  const { answers, fetcher } = scripted();
  const url = "https://one.example/";
  answers.set(url, ok("v1"));
  let record = (await checkSources(fetcher, { sources: {} }, [url], 100)).next;
  answers.set(url, ok("v1"));
  record = (await checkSources(fetcher, { sources: record }, [url], 200)).next; // UNCHANGED at 200
  answers.set(url, { status: "error", code: "TIMEOUT" });
  record = (await checkSources(fetcher, { sources: record }, [url], 300)).next; // failed: not a check
  answers.set(url, ok("v2"));
  const changed = await checkSources(fetcher, { sources: record }, [url], 400);
  assert.equal(changed.items[0]!.status, "CHANGED");
  assert.equal(changed.items[0]!.since, 200);
  // A stored time in the future (a clock that stepped back) never yields since > observedAt.
  const skewed = await checkSources(fetcher, { sources: { [url]: { ...record[url]!, checkedAt: 900 } } }, [url], 400);
  assert.equal(skewed.items[0]!.since, 400);
});

test("checkSources sends the stored validators, asks each URL once and ignores a fetcher that throws", async () => {
  const { answers, seen, fetcher } = scripted();
  const url = "https://one.example/";
  answers.set(url, ok("v1", { etag: '"1"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT" }));
  const first = await checkSources(fetcher, { sources: {} }, [url, url], 100);
  assert.equal(first.items.length, 1, "a URL listed twice is checked once");
  assert.deepEqual(seen[0]!.validators, {});
  await checkSources(fetcher, { sources: first.next }, [url], 200);
  assert.deepEqual(seen[1]!.validators, { etag: '"1"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT", finalUrl: url });
  const throwing: SourceFetcher = async () => {
    throw new Error("contains a secret");
  };
  const checked = await checkSources(throwing, { sources: {} }, [url], 300);
  assert.equal(checked.items[0]!.status, "UNREACHABLE");
  assert.equal(checked.items[0]!.code, "FETCHER_FAILED");
});

test("a 304 for a URL with no stored fingerprint is UNREACHABLE, never UNCHANGED", async () => {
  const fetcher: SourceFetcher = async () => ({ status: 304 });
  const checked = await checkSources(fetcher, { sources: {} }, ["https://one.example/"], 100);
  assert.equal(checked.items[0]!.status, "UNREACHABLE");
  assert.equal(checked.items[0]!.code, "UNEXPECTED_304");
  assert.deepEqual(checked.next, {});
});

// -- decideUpdate -----------------------------------------------------------------------------

test("decideUpdate: cold start analyses; a change analyses; a NEW source after the cold start analyses; a heartbeat analyses with nothing changed; otherwise carries forward; an UNREACHABLE source alone never analyses", () => {
  const DAY = 86_400;
  const heartbeatSeconds = 14 * DAY;
  const now = 1_000 * DAY;
  const prior = { digest: ("0x" + "11".repeat(32)) as Hex, windowId: "5", analysedAt: now - 2 * DAY, answeredAt: now - DAY, probabilityBps: 6000 };
  const item = (status: "NEW" | "CHANGED" | "UNCHANGED" | "UNREACHABLE") => ({ status });
  const decide = (p: typeof prior | undefined, statuses: Parameters<typeof item>[0][], at = now) =>
    decideUpdate({ prior: p, items: statuses.map(item), now: at, heartbeatSeconds });

  assert.deepEqual(decide(undefined, ["UNCHANGED"]), { action: "analyse", reason: "cold_start" });
  assert.deepEqual(decide(undefined, []), { action: "analyse", reason: "cold_start" });
  assert.deepEqual(decide(prior, ["UNCHANGED", "CHANGED"]), { action: "analyse", reason: "change" });
  assert.deepEqual(decide(prior, ["NEW"]), { action: "analyse", reason: "change" });
  assert.deepEqual(decide(prior, ["UNCHANGED", "UNCHANGED"]), { action: "carry_forward" });
  assert.deepEqual(decide(prior, []), { action: "carry_forward" });
  assert.deepEqual(decide(prior, ["UNREACHABLE", "UNREACHABLE"]), { action: "carry_forward" });
  assert.deepEqual(decide(prior, ["UNREACHABLE", "UNCHANGED"]), { action: "carry_forward" });
  // The heartbeat: due once the last analysis is a full heartbeat old, even with nothing changed.
  assert.deepEqual(decide(prior, ["UNCHANGED"], prior.analysedAt + heartbeatSeconds - 1), { action: "carry_forward" });
  assert.deepEqual(decide(prior, ["UNCHANGED"], prior.analysedAt + heartbeatSeconds), { action: "analyse", reason: "heartbeat" });
  assert.deepEqual(decide(prior, ["UNREACHABLE"], prior.analysedAt + heartbeatSeconds + DAY), { action: "analyse", reason: "heartbeat" });
  // A change outranks the heartbeat as the stated reason.
  assert.deepEqual(decide(prior, ["CHANGED"], prior.analysedAt + heartbeatSeconds), { action: "analyse", reason: "change" });
});

// -- State ------------------------------------------------------------------------------------

const HASH = ("0x" + "cd".repeat(32)) as Hex;
const fullRecord = (): WatchRecord => ({
  sources: {
    "https://one.example/": {
      fingerprint: HASH,
      etag: '"1"',
      lastModified: "Tue, 01 Jan 2030 00:00:00 GMT",
      finalUrl: "https://cdn.example/one",
      checkedAt: 100,
    },
  },
  windowsCursor: "opaque-cursor-from-the-server",
  prior: { digest: HASH, windowId: "12", analysedAt: 90, answeredAt: 100, probabilityBps: 6500 },
  intent: { windowId: "13", kind: "carry_forward", noteBytes: '{"schema":"x"}', probabilityBps: 6500 },
  pendingSnapshots: [{ hash: HASH, mediaType: "text/html", windowId: "13" }],
});

test("state with watch records survives a rename-write and a reload; an older state file without them still loads; a malformed watch record is STATE_CORRUPT", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-state-"));
  try {
    const state = { ...emptyState(), watch: { "7": fullRecord(), "8": { sources: {} } } };
    await saveState(dir, state);
    assert.deepEqual(await loadState(dir), state);

    // A state file written before the watcher existed.
    const old = join(dir, "old");
    await mkdir(old);
    await writeFile(join(old, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {} }));
    assert.deepEqual(await loadState(old), emptyState());

    const corrupt = async (name: string, watch: unknown) => {
      const sub = join(dir, name);
      await mkdir(sub);
      await writeFile(join(sub, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch }));
      await assert.rejects(loadState(sub), /^Error: STATE_CORRUPT$/, name);
    };
    const withRecord = (change: (r: Record<string, unknown>) => void) => {
      const record = JSON.parse(JSON.stringify(fullRecord())) as Record<string, unknown>;
      change(record);
      return { "7": record };
    };
    await corrupt("array", []);
    await corrupt("string", "x");
    await corrupt("record-not-object", { "7": 1 });
    await corrupt("no-sources", { "7": {} });
    await corrupt("sources-array", { "7": { sources: [] } });
    await corrupt("bad-fingerprint", withRecord((r) => ((r.sources as Record<string, Record<string, unknown>>)["https://one.example/"]!.fingerprint = "0x12")));
    await corrupt("bad-checkedAt", withRecord((r) => ((r.sources as Record<string, Record<string, unknown>>)["https://one.example/"]!.checkedAt = "100")));
    const source = (r: Record<string, unknown>) => (r.sources as Record<string, Record<string, unknown>>)["https://one.example/"]!;
    for (const etag of ["*", "abc", `"${"x".repeat(251)}"`, '"a\u00e9"']) await corrupt(`etag-${etag.length}-${etag.slice(0, 3)}`, withRecord((r) => (source(r).etag = etag)));
    for (const lastModified of ["yesterday", "x".repeat(300), "Tue, 1 Jan 2030 00:00:00 GMT"]) await corrupt(`lm-${lastModified.length}`, withRecord((r) => (source(r).lastModified = lastModified)));
    await corrupt("bad-finalUrl", withRecord((r) => (source(r).finalUrl = 5)));
    await corrupt("http-finalUrl", withRecord((r) => (source(r).finalUrl = "http://cdn.example/one")));
    await corrupt("key-not-a-url", { "7": { sources: { "not a url": { fingerprint: HASH, checkedAt: 1 } } } });
    await corrupt("key-http", { "7": { sources: { "http://one.example/": { fingerprint: HASH, checkedAt: 1 } } } });
    await corrupt("key-proto", JSON.parse(`{"7":{"sources":{"__proto__":{"fingerprint":"${HASH}","checkedAt":1}}}}`));
    await corrupt("prior-bps-0", withRecord((r) => ((r.prior as Record<string, unknown>).probabilityBps = 0)));
    await corrupt("prior-bps-10000", withRecord((r) => ((r.prior as Record<string, unknown>).probabilityBps = 10_000)));
    await corrupt("intent-bps-0", withRecord((r) => ((r.intent as Record<string, unknown>).probabilityBps = 0)));
    await corrupt("intent-bps-10000", withRecord((r) => ((r.intent as Record<string, unknown>).probabilityBps = 10_000)));
    await corrupt("bad-etag", withRecord((r) => ((r.sources as Record<string, Record<string, unknown>>)["https://one.example/"]!.etag = 5)));
    await corrupt("bad-cursor", withRecord((r) => (r.windowsCursor = 5)));
    await corrupt("prior-not-object", withRecord((r) => (r.prior = "x")));
    await corrupt("prior-bad-digest", withRecord((r) => ((r.prior as Record<string, unknown>).digest = "nope")));
    await corrupt("prior-bad-bps", withRecord((r) => ((r.prior as Record<string, unknown>).probabilityBps = 10_001)));
    await corrupt("prior-bad-time", withRecord((r) => ((r.prior as Record<string, unknown>).analysedAt = 1.5)));
    await corrupt("intent-bad-kind", withRecord((r) => ((r.intent as Record<string, unknown>).kind = "guess")));
    await corrupt("intent-bad-bytes", withRecord((r) => ((r.intent as Record<string, unknown>).noteBytes = 5)));
    await corrupt("intent-bad-window", withRecord((r) => ((r.intent as Record<string, unknown>).windowId = 13)));
    await corrupt("snapshots-not-array", withRecord((r) => (r.pendingSnapshots = {})));
    await corrupt("snapshot-bad-hash", withRecord((r) => (r.pendingSnapshots = [{ hash: "0x1", mediaType: "text/html", windowId: "13" }])));
    await corrupt("snapshot-bad-type", withRecord((r) => (r.pendingSnapshots = [{ hash: HASH, mediaType: 5, windowId: "13" }])));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- The fixture fetcher ----------------------------------------------------------------------

test("the fixture fetcher serves the world's source files with their media types and nothing else", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-world-"));
  try {
    const files: Record<string, string> = {
      "a.txt": "plain",
      "b.html": "<p>page</p>",
      "c.json": '{"k":1}',
      "d.csv": "x,y",
      "e.pdf": "%PDF",
      "f.bin": "raw",
      "g": "no extension",
    };
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    const world = {
      dir,
      questions: {
        first: { spec: {}, closeInSeconds: 1, maxPairs: 1, sources: { "https://one.example/a": "a.txt", "https://one.example/b": "b.html" } },
        second: {
          spec: {},
          closeInSeconds: 1,
          maxPairs: 1,
          sources: { "https://two.example/c": "c.json", "https://two.example/d": "d.csv", "https://two.example/e": "e.pdf", "https://two.example/f": "f.bin", "https://two.example/g": "g", "https://two.example/gone": "missing.txt" },
        },
        third: { spec: {}, closeInSeconds: 1, maxPairs: 1 },
      },
      suggestions: {},
      agents: {},
    } as unknown as World;
    const fetcher = fixtureFetcher(world);
    const expected: [string, string, string][] = [
      ["https://one.example/a", "text/plain", "plain"],
      ["https://one.example/b", "text/html", "<p>page</p>"],
      ["https://two.example/c", "application/json", '{"k":1}'],
      ["https://two.example/d", "text/csv", "x,y"],
      ["https://two.example/e", "application/pdf", "%PDF"],
      ["https://two.example/f", "application/octet-stream", "raw"],
      ["https://two.example/g", "application/octet-stream", "no extension"],
    ];
    for (const [url, mediaType, body] of expected) {
      const result = await fetcher(url, {});
      assert.equal(result.status, 200, url);
      if (result.status !== 200) continue;
      assert.equal(result.mediaType, mediaType, url);
      assert.equal(new TextDecoder().decode(result.bytes), body, url);
    }
    // Validators are not honoured: the fixture has no revision to compare.
    assert.equal((await fetcher("https://one.example/a", { etag: '"x"' })).status, 200);
    for (const url of ["https://one.example/other", "http://one.example/a", "https://evil.example/", "https://one.example/a?x=1", "not a url"])
      assert.deepEqual(await fetcher(url, {}), { status: "error", code: "NOT_IN_WORLD" }, url);
    assert.deepEqual(await fetcher("https://two.example/gone", {}), { status: "error", code: "FIXTURE_UNREADABLE" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- Review round: JSON depth, settle-then-hash, charsets -------------------------------------

/** 4 MiB of JSON: a long string at the bottom of `depth` arrays, each holding a second element. */
function nestedJson(depth: number): string {
  const prefix = "[".repeat(depth);
  const suffix = ",1]".repeat(depth);
  return prefix + JSON.stringify("A".repeat(4 * MIB - prefix.length - suffix.length - 2)) + suffix;
}
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const fp = (bytes: Uint8Array, type: string, charset?: string) => fingerprint(normalizeForFingerprint(bytes, type, charset));

test("a deeply nested JSON body is compared as text in linear time, and the answer does not depend on how warm the code is", () => {
  const started = performance.now();
  const hostile = nestedJson(2900);
  const normalised = normalizeForFingerprint(text(hostile), "application/json");
  assert.ok(performance.now() - started < 1000, `4 MiB at depth 2900 took ${(performance.now() - started).toFixed(0)} ms`);
  assert.equal(normalised, hostile, "past the depth limit the body is compared as collapsed text");
  // The limit is a fixed number, not a stack overflow: 256 levels of nesting are canonicalised, 257 are not.
  const nest = (arrays: number) => "[".repeat(arrays) + '{"b":1,"a":2}' + "]".repeat(arrays);
  assert.equal(normalizeForFingerprint(text(nest(255)), "application/json"), "[".repeat(255) + '{"a":2,"b":1}' + "]".repeat(255));
  assert.equal(normalizeForFingerprint(text(nest(256)), "application/json"), nest(256));
  // Brackets inside strings do not count towards the depth.
  assert.equal(normalizeForFingerprint(text(JSON.stringify({ s: "[".repeat(5000), a: 1 })), "application/json"), JSON.stringify({ a: 1, s: "[".repeat(5000) }));
  // Deep text near the old stack limit gives the same answer on a cold and on a warm normaliser.
  const deep = text(nest(4000));
  const cold = fp(deep, "application/json");
  for (let i = 0; i < 200; i++) normalizeForFingerprint(text(nest(300)), "application/json");
  assert.equal(fp(deep, "application/json"), cold);
});

test("checkSources lets every fetch settle before it fingerprints any source", async () => {
  const log: string[] = [];
  const RealDecoder = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends RealDecoder {
    override decode(...args: Parameters<TextDecoder["decode"]>) {
      log.push("normalise");
      return super.decode(...args);
    }
  } as typeof TextDecoder;
  try {
    const delays = [0, 40, 10, 25];
    const fetcher: SourceFetcher = async (url) => {
      const index = Number(url.slice(-1));
      await new Promise((resolve) => setTimeout(resolve, delays[index]));
      log.push(`settled ${index}`);
      return { status: 200, bytes: text(`page ${index}`), mediaType: "text/plain" };
    };
    const urls = delays.map((_, i) => `https://one.example/${i}`);
    await checkSources(fetcher, { sources: {} }, urls, 100);
    assert.equal(log.filter((entry) => entry === "normalise").length, 4);
    assert.equal(log.lastIndexOf("settled 1") < log.indexOf("normalise"), true, `a source was fingerprinted before every fetch settled: ${log.join(", ")}`);
    assert.equal(log.filter((entry) => entry.startsWith("settled")).length, 4);
  } finally {
    globalThis.TextDecoder = RealDecoder;
  }
});

test("JSON numbers beyond double precision are compared by their text", () => {
  const json = (value: string) => text(`{"latestFilingId": ${value}}`);
  assert.notEqual(fp(json("9007199254740993"), "application/json"), fp(json("9007199254740992"), "application/json"));
  assert.notEqual(fp(json("1e400"), "application/json"), fp(json("2e400"), "application/json"));
  assert.equal(normalizeForFingerprint(json("12345678901234567890"), "application/json"), '{"latestFilingId":12345678901234567890}');
  // Key order is still ignored, and a repeated key keeps its last value.
  assert.equal(normalizeForFingerprint(text('{"b":1.50,"a":[2,{"d":3,"c":4}],"b":7}'), "application/json"), '{"a":[2,{"c":4,"d":3}],"b":7}');
});

test("a page in a legacy charset keeps its text apart, with its charset or without one", () => {
  const cases: [string, string, Uint8Array, Uint8Array][] = [
    ["gbk", "GBK result: yes / no", hex("bd59b9fba3bacac7"), hex("bd59b9fba3bab7f1")],
    ["shift_jis", "Shift_JIS result: yes / no", hex("8c8b89ca814690a5"), hex("8c8b89ca814694db")],
    ["shift_jis", "Shift_JIS growth / recession", hex("90ac92b7"), hex("908a91de")],
    ["windows-1252", "windows-1252 2 1/2 % / 2 1/4 %", new Uint8Array([...text("Inflation 2"), 0xbd, 0x25]), new Uint8Array([...text("Inflation 2"), 0xbc, 0x25])],
  ];
  for (const [charset, label, a, b] of cases)
    for (const type of ["text/html", "text/plain", "text/csv"]) {
      assert.notEqual(fp(a, type, charset), fp(b, type, charset), `${label} as ${type} with ${charset}`);
      assert.notEqual(fp(a, type), fp(b, type), `${label} as ${type} with no charset`);
    }
  // A label that is not known, or bytes that do not decode, are read as windows-1252, which gives every
  // byte value its own character: a changed byte is a changed character, and nothing is hidden.
  assert.equal(normalizeForFingerprint(hex("bd59"), "text/plain", "no-such-charset"), "\u00bdY");
  assert.notEqual(fp(hex("bd59"), "text/plain", "no-such-charset"), fp(hex("bd5a"), "text/plain", "no-such-charset"));
  assert.equal(normalizeForFingerprint(hex("ff"), "application/json"), "\u00ff");
  // Only types that are not text are compared as raw bytes.
  assert.match(normalizeForFingerprint(hex("bd59"), "application/pdf"), /^raw:0x[0-9a-f]{64}$/);
  // Text that is valid in its charset still ignores whitespace, and UTF-8 with or without a label agrees.
  assert.equal(fp(text("a   b"), "text/plain", "utf-8"), fp(text("a b"), "text/plain"));
  assert.equal(normalizeForFingerprint(new Uint8Array([0xa3, 0xa8]), "text/plain", "gbk"), "（");
});

test("the fetcher reports the charset parameter of the Content-Type, lower-cased and unquoted", async () => {
  for (const [header, expected] of [
    ["text/html; charset=GBK", "gbk"],
    ['text/html;charset="Shift_JIS"', "shift_jis"],
    ["text/plain; format=flowed; charset=UTF-8; x=y", "utf-8"],
    ["text/plain", undefined],
    ["text/plain; charset=", undefined],
  ] as const) {
    const { fetcher } = harness(() => page(chunks(text("x")), { "content-type": header }));
    const result = await fetcher("https://a.example/", none);
    assert.equal(result.status === 200 && result.charset, expected, header);
  }
  // checkSources hands the charset to the normaliser.
  const { answers, fetcher } = scripted();
  answers.set("https://one.example/", { status: 200, bytes: hex("bd59b9fba3bacac7"), mediaType: "text/plain", charset: "gbk" });
  const first = await checkSources(fetcher, { sources: {} }, ["https://one.example/"], 1);
  answers.set("https://one.example/", { status: 200, bytes: hex("bd59b9fba3bab7f1"), mediaType: "text/plain", charset: "gbk" });
  const second = await checkSources(fetcher, { sources: first.next }, ["https://one.example/"], 2);
  assert.equal(second.items[0]!.status, "CHANGED");
});

// -- Review round: the fetcher ------------------------------------------------------------------

test("httpsFetcher refuses to be built when a proxy is configured, unless direct is set", () => {
  const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NODE_USE_ENV_PROXY"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  const clear = () => names.forEach((name) => delete process.env[name]);
  try {
    for (const name of names) {
      clear();
      assert.doesNotThrow(() => httpsFetcher({ resolve: async () => [], transport: { request: async () => assert.fail("x") } }));
      process.env[name] = name === "NODE_USE_ENV_PROXY" ? "1" : "http://proxy.invalid:3128";
      assert.throws(() => httpsFetcher(), /PROXY_CONFIGURED/, name);
      assert.doesNotThrow(() => httpsFetcher({ direct: true }), `${name} with direct`);
    }
  } finally {
    for (const [name, value] of saved)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("no User-Agent is sent", () => {
  const headers = httpsRequestOptions({ ip: "93.184.216.34", family: 4, url: new URL("https://a.example/") }).headers as Record<string, string>;
  assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Accept-Encoding", "Host"]);
});

/** A request whose socket connects (or is already connected) to `remote`. */
function socketHttps(remote: string, mode: "connected" | "connecting") {
  const destroyed: unknown[] = [];
  const request = (() => {
    const fake = Object.assign(new EventEmitter(), {
      setTimeout: () => fake,
      end() {
        const socket = Object.assign(new EventEmitter(), { remoteAddress: remote, connecting: mode === "connecting" });
        fake.emit("socket", socket);
        if (mode === "connecting") queueMicrotask(() => ((socket.connecting = false), socket.emit("connect")));
      },
      destroy(error: unknown) {
        destroyed.push(error);
        queueMicrotask(() => fake.emit("error", error));
        return fake;
      },
    });
    return fake;
  }) as unknown as typeof https.request;
  return { request, destroyed };
}

test("a connection that does not end at the address that was checked is destroyed as PINNING_FAILED", async () => {
  for (const mode of ["connected", "connecting"] as const) {
    const wrong = socketHttps("93.184.216.99", mode);
    const fetcher = httpsFetcher({
      direct: true,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: httpsTransport({ request: wrong.request }),
      timeoutMs: 500,
    });
    assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code: "PINNING_FAILED" }, mode);
    assert.equal(wrong.destroyed.length, 1);
  }
  // The same address in another spelling (IPv6 has several) is the same address: nothing is destroyed.
  const right = socketHttps("2606:4700:0:0:0:0:0:1111", "connected");
  const fetcher = httpsFetcher({
    direct: true,
    resolve: async () => [{ address: "2606:4700::1111", family: 6 }],
    transport: httpsTransport({ request: right.request }),
    timeoutMs: 60,
  });
  assert.deepEqual(await fetcher("https://v6.example/", none), { status: "error", code: "TIMEOUT" }, "it waited for an answer that this fake never sends");
  assert.equal(right.destroyed.length, 0);
});

test("validators are sent, and a 304 accepted, only on the hop whose URL is the one they were saved for", async () => {
  let target = "https://v6.example/2026-q2.html";
  const sent: { host: string; validators?: unknown }[] = [];
  const fetcher = httpsFetcher({
    direct: true,
    resolve: async (host) => hosts[host] ?? [],
    transport: {
      async request(input) {
        sent.push({ host: input.url.hostname, ...(input.validators ? { validators: input.validators } : {}) });
        if (input.url.hostname === "a.example") return redirect(target);
        const since = input.validators?.lastModified;
        if (input.url.pathname.includes("q3") && since !== undefined) return { status: 304, headers: {}, body: chunks() };
        return page(chunks(text(input.url.pathname.includes("q3") ? "Q3 gross margin 38%" : "Q2 gross margin 41%")), {
          "content-type": "text/plain",
          "last-modified": "Wed, 01 Oct 2026 00:00:00 GMT",
          etag: '"e1"',
        });
      },
    },
  });
  const url = "https://a.example/latest";
  const first = await checkSources(fetcher, { sources: {} }, [url], 1000);
  assert.equal(first.items[0]!.status, "NEW");
  assert.equal(first.next[url]!.finalUrl, "https://v6.example/2026-q2.html");
  // "latest" now points at another page of another host: nothing saved for the old page is sent there.
  target = "https://v6.example/2026-q3.html";
  const second = await checkSources(fetcher, { sources: first.next }, [url], 2000);
  assert.deepEqual(sent.filter((s) => s.host === "v6.example").map((s) => s.validators), [undefined, undefined]);
  assert.equal(second.items[0]!.status, "CHANGED");
  // Unchanged target: the saved validators go to that hop only, and its 304 is believed.
  const third = await checkSources(fetcher, { sources: second.next }, [url], 3000);
  assert.deepEqual(sent.at(-1), { host: "v6.example", validators: { etag: '"e1"', lastModified: "Wed, 01 Oct 2026 00:00:00 GMT" } });
  assert.equal(sent.filter((s) => s.host === "a.example").every((s) => s.validators === undefined), true, "the redirecting hop gets none");
  assert.equal(third.items[0]!.status, "UNCHANGED");
});

test("a 304 is an error when the validators on record cannot be sent", async () => {
  const requests: TransportInput[] = [];
  const fetcher = httpsFetcher({
    direct: true,
    resolve: async (host) => hosts[host] ?? [],
    transport: {
      async request(input) {
        requests.push(input);
        return { status: 304, headers: {}, body: chunks() };
      },
    },
  });
  const url = "https://a.example/";
  // A saved value that fails the format test (here a 300-character ETag, and a lone "*") is never sent.
  for (const stored of [{ etag: `"${"x".repeat(298)}"` }, { etag: "*" }, { lastModified: "id=" + "7f".repeat(100) }]) {
    assert.deepEqual(await fetcher(url, { ...stored, finalUrl: url }), { status: "error", code: "HTTP_304" });
    assert.equal(requests.at(-1)!.validators, undefined, "nothing conditional went out");
  }
  // Validators without a final URL are not sent either.
  assert.deepEqual(await fetcher(url, { etag: '"ok"' }), { status: "error", code: "HTTP_304" });
  assert.equal(requests.at(-1)!.validators, undefined);
  assert.deepEqual(await fetcher(url, { etag: '"ok"', finalUrl: url }), { status: 304 });
});

test("a response's validators are kept only when they have the right format", async () => {
  for (const [headers, expected] of [
    [{ etag: '"ok"', "last-modified": "Tue, 01 Jan 2030 00:00:00 GMT" }, { etag: '"ok"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT" }],
    [{ etag: "*", "last-modified": "id=" + "7f3a".repeat(63) }, {}],
    [{ etag: `"${"x".repeat(300)}"` }, {}],
  ] as const) {
    const { fetcher } = harness(() => page(chunks(text("x")), { ...headers }));
    const result = await fetcher("https://a.example/", none);
    assert.equal(result.status, 200);
    if (result.status !== 200) continue;
    assert.deepEqual({ etag: result.etag, lastModified: result.lastModified }, { etag: undefined, lastModified: undefined, ...expected });
    assert.equal(result.finalUrl, "https://a.example/");
  }
});

test("a br answer is UNSUPPORTED_ENCODING, because identity was asked for and a brotli window costs memory the cap does not count", async () => {
  const { fetcher } = harness(() => page(chunks(brotliCompressSync(text("x"))), { "content-encoding": "br" }));
  assert.deepEqual(await fetcher("https://a.example/", none), { status: "error", code: "UNSUPPORTED_ENCODING" });
});

test("an empty 200 is EMPTY_BODY: the source is UNREACHABLE and keeps its fingerprint", async () => {
  let body = "Q2 gross margin 41%";
  const { fetcher } = harness(() => page(chunks(text(body)), { "content-type": "text/plain" }));
  const full = await fetcher("https://a.example/", none);
  assert.equal(full.status, 200);
  const url = "https://a.example/";
  let record: WatchRecord = { sources: {} };
  const statuses: string[] = [];
  for (const [now, next] of [[1, "Q2 gross margin 41%"], [2, ""], [3, "Q2 gross margin 41%"]] as const) {
    body = next;
    const checked = await checkSources(fetcher, record, [url], now);
    statuses.push(`${checked.items[0]!.status} ${checked.items[0]!.code ?? ""}`.trim());
    record = { sources: checked.next };
  }
  assert.deepEqual(statuses, ["NEW", "UNREACHABLE EMPTY_BODY", "UNCHANGED"]);
});

// -- Review round: the address rules ------------------------------------------------------------

const NOT_GLOBAL = ["2001:2::1", "2001:2:0:ffff::1", "2001:10::1", "2001:5::1", "2001:0:0:1::1", "2001:1ff::1", "3fff::1", "3fff:fff::1", "5f00::1", "100:0:0:1::1", "::1:0:0:0", "4000::1", "8000::1", "fe00::1"];
const GLOBAL = ["2001:1::1", "2001:1::2", "2001:1::3", "2001:3::", "2001:4:112::", "2001:20::", "2001:30::", "2001:200::1", "2001:4860:4860::8888", "2a00:1450:4001:81b::200e", "2606:4700::1111", "3fff:1000::1", "2620:4f:8000::1"];

test("IPv6 ranges that are not globally reachable are refused, the exceptions the registry marks reachable are kept, and the platform's rules agree", () => {
  for (const address of NOT_GLOBAL) {
    assert.equal(isPublicAddress(address), false, address);
    assert.equal(platformIsPublicAddress(address), false, `platform ${address}`);
  }
  for (const address of GLOBAL) {
    assert.equal(isPublicAddress(address), true, address);
    assert.equal(platformIsPublicAddress(address), true, `platform ${address}`);
  }
});

function withInterfaces<T>(table: Record<string, { address: string; cidr: string; family: "IPv4" | "IPv6" }[]>, run: () => Promise<T>) {
  const saved = os.networkInterfaces;
  (os as { networkInterfaces: unknown }).networkInterfaces = () => table;
  return run().finally(() => ((os as { networkInterfaces: unknown }).networkInterfaces = saved));
}

test("an address inside a subnet of one of this machine's interfaces is refused, and so is any extraBlockedRanges entry", async () => {
  const { fetcher, requests } = harness(() => page(chunks(text("x"))));
  assert.equal((await fetcher("https://a.example/", none)).status, 200, "93.184.216.34 is public and on no local subnet");
  const blocked = { status: "error", code: "PRIVATE_ADDRESS" };
  await withInterfaces({ eth0: [{ address: "93.184.216.5", cidr: "93.184.216.5/24", family: "IPv4" }] }, async () => {
    assert.deepEqual(await fetcher("https://a.example/", none), blocked);
    assert.equal((await fetcher("https://v6.example/", none)).status, 200, "another subnet, another family");
  });
  await withInterfaces({ eth0: [{ address: "2606:4700::1", cidr: "2606:4700::1/64", family: "IPv6" }] }, async () => {
    assert.deepEqual(await fetcher("https://v6.example/", none), blocked);
    assert.equal((await fetcher("https://a.example/", none)).status, 200);
  });
  await withInterfaces({ eth0: [{ address: "93.184.216.5", cidr: "93.184.216.5/24", family: "IPv4" }, { address: "x", cidr: "garbage", family: "IPv4" }] }, async () => {
    // An entry that cannot be read is skipped; the readable one still applies.
    assert.deepEqual(await fetcher("https://a.example/", none), blocked);
  });
  const mapped = httpsFetcher({
    direct: true,
    resolve: async () => [{ address: "::ffff:93.184.216.34", family: 6 }],
    transport: { request: async () => page(chunks(text("x"))) },
  });
  await withInterfaces({ eth0: [{ address: "93.184.216.5", cidr: "93.184.216.5/24", family: "IPv4" }] }, async () => {
    assert.deepEqual(await mapped("https://a.example/", none), blocked, "a mapped address is judged as the IPv4 address it carries");
  });
  assert.equal(requests.length, 3, "only the three unblocked reads reached the transport");

  // The same IPv4 address written as NAT64 (64:ff9b::/96) or IPv4-compatible (::/96) is judged by the IPv4 address too.
  for (const address of ["64:ff9b::5db8:d822", "::5db8:d822", "::ffff:5db8:d822"]) {
    const reached: string[] = [];
    const transport = { request: async (input: TransportInput) => (reached.push(input.ip), page(chunks(text("internal page")))) };
    const resolve = async () => [{ address, family: 6 as const }];
    const local = httpsFetcher({ direct: true, resolve, transport });
    const listed = httpsFetcher({ direct: true, extraBlockedRanges: ["93.184.216.0/24"], resolve, transport });
    await withInterfaces({ eth0: [{ address: "93.184.216.5", cidr: "93.184.216.5/24", family: "IPv4" }] }, async () => {
      assert.deepEqual(await local("https://a.example/", none), blocked, `${address} in a local subnet`);
    });
    assert.deepEqual(await listed("https://a.example/", none), blocked, `${address} in extraBlockedRanges`);
    assert.deepEqual(reached, [], address);
  }

  const extra = httpsFetcher({
    direct: true,
    extraBlockedRanges: ["93.184.216.0/24", "2606:4700::/32"],
    resolve: async (host) => hosts[host] ?? [],
    transport: { request: async () => page(chunks(text("x"))) },
  });
  assert.deepEqual(await extra("https://a.example/", none), blocked);
  assert.deepEqual(await extra("https://v6.example/", none), blocked);
  assert.throws(() => httpsFetcher({ direct: true, extraBlockedRanges: ["10.0.0.0/33"] }), RangeError);
  assert.throws(() => httpsFetcher({ direct: true, extraBlockedRanges: ["not a range"] }), RangeError);
  assert.throws(() => httpsFetcher({ direct: true, extraBlockedRanges: ["2606:4700::/129"] }), RangeError);
});

// -- Review round: the watcher ------------------------------------------------------------------

test("only this check's URLs are kept in the saved sources, so a URL that was dropped and comes back is NEW", async () => {
  const { answers, fetcher } = scripted();
  for (const url of ["https://one.example/", "https://two.example/", "https://three.example/"]) answers.set(url, ok("x"));
  const first = await checkSources(fetcher, { sources: {} }, ["https://one.example/", "https://two.example/"], 100);
  const second = await checkSources(fetcher, { sources: first.next }, ["https://two.example/", "https://three.example/"], 200);
  assert.deepEqual(Object.keys(second.next).sort(), ["https://three.example/", "https://two.example/"]);
  assert.deepEqual(second.items.map((i) => i.status), ["UNCHANGED", "NEW"]);
  const third = await checkSources(fetcher, { sources: second.next }, ["https://one.example/"], 300);
  assert.equal(third.items[0]!.status, "NEW", "a URL that was added again is a first sighting");
  assert.deepEqual(Object.keys(third.next), ["https://one.example/"]);
  // An unreachable URL that is still listed keeps its entry.
  answers.set("https://one.example/", { status: "error", code: "TIMEOUT" });
  const fourth = await checkSources(fetcher, { sources: third.next }, ["https://one.example/"], 400);
  assert.deepEqual(fourth.next, third.next);
  // Over many windows of a changing list the state stays at the size of one list.
  let record: WatchRecord = { sources: {} };
  for (let window = 0; window < 40; window++) {
    const urls = Array.from({ length: 20 }, (_, i) => `https://news.example/${window}/${i}`);
    for (const url of urls) answers.set(url, ok(url));
    record = { sources: (await checkSources(fetcher, record, urls, 1000 + window)).next };
  }
  assert.equal(Object.keys(record.sources).length, 20);
});

test("checkSources refuses a fractional or negative now, and input that the caller should have filtered", async () => {
  const { answers, fetcher } = scripted();
  const url = "https://one.example/";
  answers.set(url, ok("x"));
  for (const now of [1.5, Math.floor(Date.now() / 1000) + 0.5, -1, NaN, Infinity, 2 ** 53])
    await assert.rejects(checkSources(fetcher, { sources: {} }, [url], now), RangeError, String(now));
  await assert.doesNotReject(checkSources(fetcher, { sources: {} }, [url], 0));
  // More than 20 URLs after de-duplication, a URL that is not https, an unparsable one, one over 2048 bytes once JSON-encoded.
  const many = Array.from({ length: 21 }, (_, i) => `https://e.example/${i}`);
  await assert.rejects(checkSources(fetcher, { sources: {} }, many, 1), RangeError);
  await assert.doesNotReject(checkSources(fetcher, { sources: {} }, [...many.slice(0, 20), many[0]!, many[1]!], 1), "twenty distinct URLs, two repeated");
  for (const bad of ["http://one.example/", "ftp://one.example/", "not a url", "constructor", ""])
    await assert.rejects(checkSources(fetcher, { sources: {} }, [url, bad], 1), RangeError, bad);
  const pad = (length: number) => `https://e.example/${"q".repeat(length - "https://e.example/".length)}`;
  await assert.doesNotReject(checkSources(fetcher, { sources: {} }, [pad(2048)], 1), "2048 bytes");
  await assert.rejects(checkSources(fetcher, { sources: {} }, [pad(2049)], 1), RangeError, "2049 bytes");
  // A backslash in the query is two bytes once JSON-encoded.
  const slashes = `https://e.example/?${"\\".repeat(1100)}`;
  assert.equal(new URL(slashes).href.length < 2048, true);
  await assert.rejects(checkSources(fetcher, { sources: {} }, [slashes], 1), RangeError, "JSON-encoded length");
});

test("checkSources reads at most five URLs at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const fetcher: SourceFetcher = async (url) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return { status: 200, bytes: text(url), mediaType: "text/plain" };
  };
  const urls = Array.from({ length: 20 }, (_, i) => `https://e.example/${i}`);
  const checked = await checkSources(fetcher, { sources: {} }, urls, 1);
  assert.equal(peak, 5);
  assert.deepEqual(checked.items.map((i) => i.url), urls, "the items stay in the order of the list");
  assert.equal(checked.items.every((i) => i.status === "NEW"), true);
});

test("text after an empty comment <!--> or <!---> is kept", () => {
  for (const opener of ["<!-->", "<!--->"]) {
    const page = (margin: string) => text(`<html><body>${opener}<p>Gross margin ${margin}%</p></body></html>`);
    assert.notEqual(fp(page("41"), "text/html"), fp(page("38"), "text/html"), opener);
    assert.equal(normalizeForFingerprint(page("41"), "text/html"), "Gross margin 41%");
  }
  // A real comment still hides its text.
  assert.equal(normalizeForFingerprint(text("a<!-- b -->c<!---->d<!-- -- -->e"), "text/html"), "a c d e");
});

test("decideUpdate: a prior from the future is due, and a heartbeat that is not a positive number throws", () => {
  const prior = { digest: HASH, windowId: "5", analysedAt: 4_102_444_800, answeredAt: 4_102_444_800, probabilityBps: 6000 };
  const decide = (heartbeatSeconds: number, now = 1_800_000_000) => decideUpdate({ prior, items: [{ status: "UNCHANGED" }], now, heartbeatSeconds });
  assert.deepEqual(decide(14 * 86_400), { action: "analyse", reason: "heartbeat" });
  assert.deepEqual(decide(14 * 86_400, prior.analysedAt), { action: "carry_forward" });
  for (const bad of [0, -1, NaN, Infinity, -Infinity])
    assert.throws(() => decide(bad), RangeError, String(bad));
  assert.throws(() => decideUpdate({ prior: undefined, items: [], now: 1, heartbeatSeconds: NaN }), RangeError, "even on a cold start");
});

// -- Review round: the fixture fetcher ----------------------------------------------------------

test("the fixture fetcher refuses a file outside the world directory, by symlink or by a hand-built world, and a file over 4 MiB", async () => {
  const root = await mkdtemp(join(tmpdir(), "blink-watch-escape-"));
  try {
    await mkdir(join(root, "world", "sources"), { recursive: true });
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "secret.txt"), "operator-only text");
    await writeFile(join(root, "world", "sources", "inside.txt"), "inside");
    await symlink(join(root, "outside", "secret.txt"), join(root, "world", "sources", "leak.txt"));
    await symlink(join(root, "world", "sources", "inside.txt"), join(root, "world", "sources", "alias.txt"));
    await writeFile(join(root, "world", "sources", "big.txt"), new Uint8Array(4 * MIB + 1));
    await writeFile(join(root, "world", "sources", "max.txt"), new Uint8Array(4 * MIB));
    const world = {
      dir: join(root, "world"),
      questions: {
        q: {
          spec: {},
          closeInSeconds: 1,
          maxPairs: 1,
          sources: {
            "https://x.example/leak": "sources/leak.txt",
            "https://x.example/up": "../outside/secret.txt",
            "https://x.example/abs": join(root, "outside", "secret.txt"),
            "https://x.example/inside": "sources/inside.txt",
            "https://x.example/alias": "sources/alias.txt",
            "https://x.example/big": "sources/big.txt",
            "https://x.example/max": "sources/max.txt",
            "https://x.example/dir": "sources",
            "https://x.example/gone": "sources/gone.txt",
          },
        },
      },
      suggestions: {},
      agents: {},
    } as unknown as World;
    const fetcher = fixtureFetcher(world);
    const body = (r: Awaited<ReturnType<SourceFetcher>>) => (r.status === 200 ? new TextDecoder().decode(r.bytes).slice(0, 20) : JSON.stringify(r));
    assert.equal(body(await fetcher("https://x.example/inside", {})), "inside");
    assert.equal(body(await fetcher("https://x.example/alias", {})), "inside", "a link that stays inside is fine");
    assert.equal((await fetcher("https://x.example/max", {})).status, 200, "exactly 4 MiB is served");
    for (const name of ["leak", "up"]) assert.deepEqual(await fetcher(`https://x.example/${name}`, {}), { status: "error", code: "NOT_IN_WORLD" }, name);
    assert.equal((await fetcher("https://x.example/abs", {})).status, "error", "an absolute path is read under the world directory, where it does not exist");
    assert.deepEqual(await fetcher("https://x.example/big", {}), { status: "error", code: "TOO_LARGE" });
    assert.deepEqual(await fetcher("https://x.example/dir", {}), { status: "error", code: "FIXTURE_UNREADABLE" });
    assert.deepEqual(await fetcher("https://x.example/gone", {}), { status: "error", code: "FIXTURE_UNREADABLE" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// -- Review round 2 ----------------------------------------------------------------------------

test("JSON with more than 100,000 structural tokens is compared as text, and JSON just under the limit is still canonical", () => {
  const many = (count: number) => text("[" + Array(count).fill('{"b":0,"a":0}').join(",") + "]");
  const hostile = many(50_001);
  const started = performance.now();
  assert.equal(normalizeForFingerprint(hostile, "application/json"), normalizeForFingerprint(hostile, "text/plain"));
  assert.ok(performance.now() - started < 500);
  assert.equal(normalizeForFingerprint(many(1000), "application/json").slice(0, 20), '[{"a":0,"b":0},{"a":');
  // Commas and colons inside strings are not tokens.
  const strings = text(JSON.stringify({ z: ",:".repeat(200_000), a: 1 }));
  assert.equal(normalizeForFingerprint(strings, "application/json"), JSON.stringify({ a: 1, z: ",:".repeat(200_000) }));
});

test("checkSources yields to the event loop between sources", async () => {
  let spins = 0;
  let running = true;
  const spin = () => {
    spins++;
    if (running) setImmediate(spin);
  };
  setImmediate(spin);
  const fetcher: SourceFetcher = async (url) => ({ status: 200, bytes: text(url), mediaType: "text/plain" });
  const urls = Array.from({ length: 6 }, (_, i) => `https://e.example/${i}`);
  await checkSources(fetcher, { sources: {} }, urls, 1);
  running = false;
  assert.ok(spins >= 5, `other work ran ${spins} times while six sources were compared`);
});

test("a failed AAAA query does not fail a lookup whose A record answered, and each address is still judged", async () => {
  const fake = fakeResolver({
    "a.example": { v4: ["93.184.216.34"], v6: "ESERVFAIL" },
    "v6only.example": { v4: "ESERVFAIL", v6: ["2606:4700::1111"] },
    "bad.example": { v4: ["93.184.216.34"], v6: ["fe80::1"] },
    "down.example": { v4: "ESERVFAIL", v6: "ECONNREFUSED" },
  });
  try {
    const requests: TransportInput[] = [];
    const fetcher = httpsFetcher({
      direct: true,
      transport: {
        async request(input) {
          requests.push(input);
          return page(chunks(text("ok")));
        },
      },
    });
    assert.equal((await fetcher("https://a.example/", none)).status, 200);
    assert.equal((await fetcher("https://v6only.example/", none)).status, 200);
    assert.deepEqual(requests.map((r) => r.ip), ["93.184.216.34", "2606:4700::1111"]);
    assert.deepEqual(await fetcher("https://bad.example/", none), { status: "error", code: "PRIVATE_ADDRESS" }, "a private AAAA still poisons the name");
    assert.deepEqual(await fetcher("https://down.example/", none), { status: "error", code: "DNS_FAILED" }, "both failed");
  } finally {
    fake.restore();
  }
});

test("a custom fetcher's Text/HTML or text/html; charset=utf-8 is read as text/html: a new nonce is not a change", async () => {
  for (const declared of ["Text/HTML", "text/html; charset=utf-8", " text/html ;q=1"]) {
    let nonce = 0;
    const fetcher: SourceFetcher = async () => ({
      status: 200,
      bytes: text(`<html><script nonce="n${++nonce}">x()</script><body>Result: pending</body></html>`),
      mediaType: declared,
    });
    let record: WatchRecord = { sources: {} };
    const statuses: string[] = [];
    const types: string[] = [];
    for (const now of [1, 2, 3]) {
      const checked = await checkSources(fetcher, record, ["https://stats.example/cpi"], now);
      statuses.push(checked.items[0]!.status);
      types.push(checked.items[0]!.mediaType!);
      record = { sources: checked.next };
    }
    assert.deepEqual(statuses, ["NEW", "UNCHANGED", "UNCHANGED"], declared);
    assert.deepEqual(types, ["text/html", "text/html", "text/html"], declared);
  }
  const odd: SourceFetcher = async () => ({ status: 200, bytes: text("x"), mediaType: "text/html extra/more" });
  assert.equal((await checkSources(odd, { sources: {} }, ["https://stats.example/cpi"], 1)).items[0]!.mediaType, "application/octet-stream");
  assert.equal(mediaTypeOf("Text/HTML; charset=x"), "text/html");
  assert.equal(mediaTypeOf(undefined), "application/octet-stream");
  assert.equal(mediaTypeOf("text/html extra/more"), "application/octet-stream");
});

test("a legacy page keeps its noise tolerance: a new script nonce, or one stray byte, is not a change", async () => {
  let nonce = 0;
  const html = () => new Uint8Array([...text(`<html><head><meta charset="windows-1252"><script nonce="n${++nonce}">x()</script></head><body>Inflation 2`), 0xbd, ...text("%</body></html>")]);
  const fetcher: SourceFetcher = async () => ({ status: 200, bytes: html(), mediaType: "text/html" });
  let record: WatchRecord = { sources: {} };
  const statuses: string[] = [];
  for (const now of [1, 2, 3]) {
    const checked = await checkSources(fetcher, record, ["https://stats.example/cpi"], now);
    statuses.push(checked.items[0]!.status);
    record = { sources: checked.next };
  }
  assert.deepEqual(statuses, ["NEW", "UNCHANGED", "UNCHANGED"]);
  const stray = (token: number, byte = 0xa9) => new Uint8Array([...text(`<p>Result: pending</p><input type="hidden" name="csrf" value="${token}"><footer>`), byte, ...text(" 2026</footer>")]);
  assert.equal(normalizeForFingerprint(stray(1), "text/html", "utf-8"), normalizeForFingerprint(stray(2), "text/html", "utf-8"));
  assert.notEqual(normalizeForFingerprint(stray(1), "text/html", "utf-8"), normalizeForFingerprint(stray(1, 0xa8), "text/html", "utf-8"), "a changed byte is a changed character");
});

test("watchableUrl returns the canonical https URL within 2048 bytes, and checkSources refuses a raw string that is not that URL", async () => {
  const tabs = "https://a.exa" + "\t".repeat(100_000) + "mple/";
  assert.equal(watchableUrl(tabs), "https://a.example/");
  assert.equal(watchableUrl("https://One.Example:443/a b"), "https://one.example/a%20b");
  assert.equal(watchableUrl("http://a.example/"), null);
  assert.equal(watchableUrl("not a url"), null);
  assert.equal(watchableUrl("https://a.example/" + "é".repeat(1000)), null, "6018 bytes once parsed");
  assert.equal(watchableUrl("https://e.example/" + "q".repeat(2048 - "https://e.example/".length)), "https://e.example/" + "q".repeat(2030));
  assert.equal(watchableUrl("https://e.example/" + "q".repeat(2049 - "https://e.example/".length)), null);
  const fetcher: SourceFetcher = async () => ({ status: 200, bytes: text("x"), mediaType: "text/plain" });
  for (const raw of [tabs, "https://One.example/", "https://a.example:443/", "https://a.example/a b", "https://a.example"])
    await assert.rejects(checkSources(fetcher, { sources: {} }, [raw], 1), /SOURCE_URL_NOT_CANONICAL/, JSON.stringify(raw.slice(0, 40)));
  const checked = await checkSources(fetcher, { sources: {} }, [watchableUrl(tabs)!], 1);
  assert.deepEqual(Object.keys(checked.next), ["https://a.example/"]);
});

test("checkSources saves only validators and a final URL that loadState accepts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-write-"));
  try {
    const url = "https://a.example/";
    const answer = (extra: Record<string, string>): SourceFetcher => async () => ({ status: 200, bytes: text("x"), mediaType: "text/plain", ...extra });
    for (const extra of [
      { etag: "abc123" },
      { etag: "*" },
      { lastModified: "yesterday" },
      { finalUrl: "http://a.example/" },
      { finalUrl: "https://A.example:443/" },
      { etag: "abc123", lastModified: "yesterday", finalUrl: "not a url" },
    ]) {
      const { next } = await checkSources(answer(extra), { sources: {} }, [url], 1000);
      assert.deepEqual(Object.keys(next[url]!).sort(), ["checkedAt", "fingerprint"], JSON.stringify(extra));
      await saveState(dir, { ...emptyState(), watch: { m1: { sources: next } } });
      await assert.doesNotReject(loadState(dir), JSON.stringify(extra));
    }
    const good = { etag: '"abc"', lastModified: "Tue, 01 Jan 2030 00:00:00 GMT", finalUrl: "https://cdn.example/x" };
    const { next } = await checkSources(answer(good), { sources: {} }, [url], 1000);
    assert.deepEqual({ ...next[url]! }, { fingerprint: next[url]!.fingerprint, ...good, checkedAt: 1000 });
    await saveState(dir, { ...emptyState(), watch: { m1: { sources: next } } });
    await assert.doesNotReject(loadState(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadState refuses a source key or a final URL that is not canonical", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-canon-"));
  try {
    for (const [name, sources] of [
      ["key-uppercase", { "https://One.example/": { fingerprint: HASH, checkedAt: 1 } }],
      ["key-port", { "https://one.example:443/": { fingerprint: HASH, checkedAt: 1 } }],
      ["key-tabs", { ["https://a.exa" + "\t".repeat(10) + "mple/"]: { fingerprint: HASH, checkedAt: 1 } }],
      ["final-port", { "https://one.example/": { fingerprint: HASH, checkedAt: 1, finalUrl: "https://one.example:443/" } }],
    ] as const) {
      const sub = join(dir, name);
      await mkdir(sub);
      await writeFile(join(sub, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch: { "7": { sources } } }));
      await assert.rejects(loadState(sub), /^Error: STATE_CORRUPT$/, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- Review round 3 ----------------------------------------------------------------------------

test("a saved final URL is bounded like a key: a long redirect target is not saved, and a state file that holds one is corrupt", async () => {
  const url = "https://a.example/";
  const long = "https://a.example/" + "a".repeat(3000);
  const fetcher: SourceFetcher = async () => ({ status: 200, bytes: text("x"), mediaType: "text/plain", finalUrl: long });
  const { next } = await checkSources(fetcher, { sources: {} }, [url], 1000);
  assert.equal(next[url]!.finalUrl, undefined);
  assert.equal(isCanonicalHttpsUrl("https://a.example/" + "a".repeat(2030)), true);
  assert.equal(isCanonicalHttpsUrl("https://a.example/" + "a".repeat(2031)), false);
  // The same bound for a Location of raw 0xFF bytes, which the parser expands six-fold.
  assert.equal(isCanonicalHttpsUrl(new URL("https://a.example/" + "ÿ".repeat(400)).href), false);
  assert.equal(watchableUrl("https://a.example/" + "ÿ".repeat(400)), null);
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-long-"));
  try {
    for (const [name, sources] of [
      ["final", { [url]: { fingerprint: HASH, checkedAt: 1, finalUrl: long } }],
      ["key", { [long]: { fingerprint: HASH, checkedAt: 1 } }],
    ] as const) {
      const sub = join(dir, name);
      await mkdir(sub);
      await writeFile(join(sub, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch: { "7": { sources } } }));
      await assert.rejects(loadState(sub), /^Error: STATE_CORRUPT$/, name);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a name whose AAAA query is never answered costs 300 ms, not the resolver's timeout, and a redirect between two such names too", async () => {
  const fake = fakeResolver({
    "slow6.example": { v4: ["93.184.216.34"], v6: "HANG_UNTIL_CANCEL" },
    "slow6b.example": { v4: ["93.184.216.35"], v6: "HANG_UNTIL_CANCEL" },
    "late.example": { v4: "HANG_UNTIL_CANCEL", v6: ["2606:4700::1111"] },
  });
  try {
    const requests: TransportInput[] = [];
    const fetcher = httpsFetcher({
      direct: true,
      transport: {
        async request(input) {
          requests.push(input);
          return input.url.hostname === "slow6.example" ? redirect("https://slow6b.example/next") : page(chunks(text("ok")));
        },
      },
    });
    const started = performance.now();
    const result = await fetcher("https://slow6.example/", none);
    assert.equal(result.status, 200);
    assert.deepEqual(requests.map((r) => r.ip), ["93.184.216.34", "93.184.216.35"], "both hops connected, to judged addresses");
    assert.ok(performance.now() - started < 1500, "two hops took no longer than two delays");
    assert.equal((await fetcher("https://late.example/", none)).status, 200, "an AAAA answer alone also starts the delay");
    assert.ok(fake.cancelled.length >= 3, "the lookup was cancelled when the delay ended");
  } finally {
    fake.restore();
  }
});

test("an extraBlockedRanges entry written as ::ffff:a.b.c.d/n blocks the same address answered as an A record, and the reverse", async () => {
  const outcome = async (range: string, address: string, family: 4 | 6) => {
    const reached: string[] = [];
    const fetcher = httpsFetcher({
      direct: true,
      extraBlockedRanges: [range],
      resolve: async () => [{ address, family }],
      transport: { request: async (input) => (reached.push(input.ip), page(chunks(text("x")))) },
    });
    return { result: await fetcher("https://a.example/", none), reached };
  };
  const blockedResult = { status: "error", code: "PRIVATE_ADDRESS" };
  assert.deepEqual((await outcome("::ffff:93.184.216.0/120", "93.184.216.7", 4)).result, blockedResult);
  assert.deepEqual((await outcome("::ffff:5db8:d800/120", "93.184.216.7", 4)).result, blockedResult);
  assert.deepEqual((await outcome("93.184.216.0/24", "::ffff:93.184.216.7", 6)).result, blockedResult);
  assert.deepEqual((await outcome("::ffff:93.184.216.0/120", "::ffff:93.184.216.7", 6)).result, blockedResult);
  // Neighbouring addresses are not touched, and a /96 mapped range is the whole IPv4 space.
  assert.equal((await outcome("::ffff:93.184.216.0/120", "93.184.217.7", 4)).result.status, 200);
  assert.deepEqual((await outcome("::ffff:0:0/96", "93.184.216.7", 4)).result, blockedResult);
  // NAT64 and IPv4-compatible ranges stay IPv6: a /96 NAT64 range does not block every IPv4 address.
  assert.equal((await outcome("64:ff9b::/96", "93.184.216.7", 4)).result.status, 200);
  assert.equal((await outcome("::/96", "93.184.216.7", 4)).result.status, 200);
  assert.deepEqual((await outcome("64:ff9b::/96", "64:ff9b::5db8:d807", 6)).result, blockedResult);
});

test("isMediaType accepts a lower-case type and subtype and nothing longer or stranger", () => {
  for (const good of ["text/html", "application/json", "application/vnd.api+json", "image/svg+xml", "a/b"]) assert.equal(isMediaType(good), true, good);
  for (const bad of ["", "text", "text/", "/html", "Text/Html", "text/html; charset=utf-8", "text/ht ml", "a/b/c", "text/" + "x".repeat(128), "x".repeat(128) + "/y", "text/é"])
    assert.equal(isMediaType(bad), false, JSON.stringify(bad.slice(0, 30)));
  assert.equal(isMediaType(undefined), false);
});

test("an unusable media type becomes application/octet-stream in the fetcher and in checkSources, and a state file with one is corrupt", async () => {
  const hostile = "text/" + "x".repeat(16_000);
  const { fetcher } = harness(() => page(chunks(text("hello")), { "content-type": hostile }));
  const fetched = await fetcher("https://a.example/", none);
  assert.equal(fetched.status === 200 && fetched.mediaType, "application/octet-stream");
  for (const header of ["", "text", "text/html extra/more"]) {
    const { fetcher: f } = harness(() => page(chunks(text("hello")), { "content-type": header }));
    const r = await f("https://a.example/", none);
    assert.equal(r.status === 200 && r.mediaType, "application/octet-stream", JSON.stringify(header));
  }
  const custom: SourceFetcher = async () => ({ status: 200, bytes: text("hello"), mediaType: hostile });
  const { items } = await checkSources(custom, { sources: {} }, ["https://a.example/"], 1);
  assert.equal(items[0]!.mediaType, "application/octet-stream");
  assert.equal(items[0]!.fingerprint, fingerprint(normalizeForFingerprint(text("hello"), "application/octet-stream")));
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-media-"));
  try {
    for (const [name, mediaType] of [["long", hostile], ["upper", "Text/Html"], ["params", "text/html; charset=utf-8"]] as const) {
      const sub = join(dir, name);
      await mkdir(sub);
      const watch = { "7": { sources: {}, pendingSnapshots: [{ hash: HASH, mediaType, windowId: "1" }] } };
      await writeFile(join(sub, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch }));
      await assert.rejects(loadState(sub), /^Error: STATE_CORRUPT$/, name);
    }
    const ok = join(dir, "ok");
    await mkdir(ok);
    const watch = { "7": { sources: {}, pendingSnapshots: [{ hash: HASH, mediaType: "text/html", windowId: "1" }] } };
    await writeFile(join(ok, "state.json"), JSON.stringify({ salts: {}, acted: {}, fills: {}, watch }));
    await assert.doesNotReject(loadState(ok));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// -- Attacks that were tried against the fetcher and the watcher and did not get through -----------

test("every spelling of an IP host is refused before any lookup", async () => {
  for (const raw of [
    "https://127.0.0.1./",
    "https://１２７.０.０.１/", // fullwidth digits
    "https://127。0。0。1/", // ideographic full stops
    "https://%31%32%37.0.0.1/",
    "https://0x7f000001/",
    "https://017700000001/",
    "https://0/",
    "https://0x7f.1/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::1]/",
    "https://[0:0:0:0:0:0:0:1]/",
  ]) {
    const { fetcher, lookups, requests } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(raw, none), { status: "error", code: "IP_LITERAL" }, raw);
    assert.equal(lookups.length + requests.length, 0, raw);
  }
  const { fetcher } = harness(() => page(chunks(text("x"))));
  assert.deepEqual(await fetcher("https://[fe80::1%25eth0]/", none), { status: "error", code: "INVALID_URL" }, "zone id");
});

test("credentials, ports and schemes are judged on the parsed URL", async () => {
  const cases: [string, string][] = [
    ["https://user@a.example/", "CREDENTIALS"],
    ["https://:pw@a.example/", "CREDENTIALS"],
    ["https://a.example@b.example/", "CREDENTIALS"],
    ["https://a.example:8443/", "PORT"],
    ["https://a.example:65536/", "INVALID_URL"],
    ["wss://a.example/", "NOT_HTTPS"],
    ["file:///etc/passwd", "NOT_HTTPS"],
  ];
  for (const [raw, code] of cases) {
    const { fetcher, lookups } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(raw, none), { status: "error", code }, raw);
    assert.equal(lookups.length, 0, raw);
  }
});

test("the lookup, the TLS name, the Host header and the request path all come from one parsed URL", async () => {
  for (const [raw, host, path] of [
    ["https://a.example:0443/x", "a.example", "/x"],
    ["https://a.example:/x", "a.example", "/x"],
    ["https://@a.example/x", "a.example", "/x"],
    ["https:\\\\a.example\\x", "a.example", "/x"],
    ["HTTPS://A.EXAMPLE/x", "a.example", "/x"],
    ["https://a.exa\tmple/x", "a.example", "/x"],
    ["https://a.example./x", "a.example.", "/x"],
    ["https://a.example/x\r\nX-Injected: 1", "a.example", "/xX-Injected:%201"],
    ["https://a.example/x%0d%0aX-Injected:%201", "a.example", "/x%0d%0aX-Injected:%201"],
    ["https://a.example/x#frag", "a.example", "/x"],
  ] as const) {
    const { fetcher, lookups, requests } = harness(() => page(chunks(text("x"))));
    assert.equal((await fetcher(raw, none)).status, 200, raw);
    assert.deepEqual(lookups, [host], raw);
    const options = httpsRequestOptions({ ip: "93.184.216.34", family: 4, url: requests[0]!.url });
    assert.equal(options.hostname, host, raw);
    assert.equal(options.servername, host, raw);
    assert.equal((options.headers as Record<string, string>)["Host"], host, raw);
    assert.equal(options.path, path, raw);
    assert.equal(options.port, 443, raw);
    assert.doesNotMatch(String(options.path), /[\r\n]/, raw);
  }
});

test("the address forms a source could hide behind are all refused, and public forms that carry IPv4 are judged by it", () => {
  const refused = [
    "0.0.0.0", "0.1.2.3", "100.64.0.1", "100.127.255.254", "192.0.0.1", "192.0.0.170", "192.0.0.192", "198.18.0.1",
    "198.19.255.254", "240.0.0.1", "254.1.1.1", "255.255.255.255", "169.254.169.254", "100.100.100.200",
    "::ffff:10.0.0.1", "::ffff:a00:1", "::FFFF:7F00:1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:ffff:127.0.0.1",
    "::10.0.0.1", "::a00:1", "::", "::1", "::0.0.0.0", "64:ff9b::10.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b::127.0.0.1",
    "64:ff9b:1::1", "64:ff9b:1:ffff::808:808", "::ffff:0:127.0.0.1", "100::1", "2002:7f00:1::1", "2002:0808:0808::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", "fc00::1", "fd00:ec2::254", "fec0::1", "feff::1", "fe80::1", "fe80::1%eth0",
    "ff02::1", "ff05::2", "2001:db8::1", "::ffff:127.000.000.001", "[::1]", "1.2.3.4 ", "::ffff:1.2.3.4%1",
  ];
  assert.deepEqual(refused.filter(isPublicAddress), []);
  assert.deepEqual(refused.filter(platformIsPublicAddress), []);
  assert.deepEqual(["8.8.8.8", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2606:4700::1111"].filter((a) => !isPublicAddress(a)), []);
});

test("a lookup answer with a zone id, trailing data, a ULA metadata address or a NAT64 metadata address is refused", async () => {
  for (const host of ["zone.example", "space.example", "imds6.example", "nat64.example"]) {
    const { fetcher, requests } = harness(() => page(chunks(text("x"))));
    assert.deepEqual(await fetcher(`https://${host}/`, none), { status: "error", code: "PRIVATE_ADDRESS" }, host);
    assert.equal(requests.length, 0, host);
  }
});

test("redirects: relative, protocol-relative, credentials, scheme changes, a loop and a 305 are all judged again", async () => {
  const cases: [string, string | number][] = [
    ["//127.0.0.1/", "IP_LITERAL"],
    ["//[::1]/", "IP_LITERAL"],
    ["//a.example@127.0.0.1/", "CREDENTIALS"],
    ["http://a.example/", "NOT_HTTPS"],
    ["data:text/plain,hi", "NOT_HTTPS"],
    ["javascript:alert(1)", "NOT_HTTPS"],
    ["file:///etc/passwd", "NOT_HTTPS"],
    ["https://a.example:444/", "PORT"],
    ["https://zone.example/", "PRIVATE_ADDRESS"],
    ["/elsewhere", 200],
    ["https://b.exa\tmple/x", 200],
  ];
  for (const [location, expected] of cases) {
    const { fetcher, requests } = harness((_input, call) => (call === 1 ? redirect(location) : page(chunks(text("final")))));
    const result = await fetcher("https://a.example/start", none);
    if (typeof expected === "number") assert.equal(result.status, expected, location);
    else assert.deepEqual(result, { status: "error", code: expected }, location);
    if (typeof expected === "string") assert.equal(requests.length, 1, location);
  }
  const loop = harness(() => redirect("https://a.example/start"));
  assert.deepEqual(await loop.fetcher("https://a.example/start", none), { status: "error", code: "TOO_MANY_REDIRECTS" });
  const proxyHop = harness((_input, call) => (call === 1 ? redirect("https://127.0.0.1:3128/", 305) : page(chunks(text("x")))));
  assert.deepEqual(await proxyHop.fetcher("https://a.example/", none), { status: "error", code: "PORT" });
});

test("a validator with a line break or a byte outside printable ASCII is never sent, and Node refuses such a header value too", () => {
  for (const bad of ['"a"\r\nX: 1', '"a"\nX: 1', '"a"\0', "é", "x".repeat(257), ""]) {
    const sent = httpsRequestOptions({ ip: "93.184.216.34", family: 4, url: new URL("https://a.example/"), validators: { etag: bad, lastModified: bad } });
    assert.equal((sent.headers as Record<string, string>)["If-None-Match"], undefined, JSON.stringify(bad));
    assert.equal((sent.headers as Record<string, string>)["If-Modified-Since"], undefined, JSON.stringify(bad));
  }
  assert.throws(() => http.validateHeaderValue("If-None-Match", '"a"\r\nX: 1'), { code: "ERR_INVALID_CHAR" });
});

test("lying lengths, endless bodies, a slow drip and unknown or nested encodings all end in a code", async () => {
  const cap = 64 * 1024;
  const endless = async function* () {
    for (;;) yield new Uint8Array(16 * 1024);
  };
  const cases: [string, () => TransportResponse, unknown][] = [
    ["short Content-Length", () => page(endless(), { "content-length": "10" }), { status: "error", code: "TOO_LARGE" }],
    ["NaN Content-Length", () => page(endless(), { "content-length": "abc" }), { status: "error", code: "TOO_LARGE" }],
    ["endless chunked", () => page(endless()), { status: "error", code: "TOO_LARGE" }],
    ["gzip, gzip", () => page(chunks(gzipSync(gzipSync(text("x")))), { "content-encoding": "gzip, gzip" }), { status: "error", code: "UNSUPPORTED_ENCODING" }],
    ["zstd", () => page(chunks(text("x")), { "content-encoding": "zstd" }), { status: "error", code: "UNSUPPORTED_ENCODING" }],
    ["gzip bomb", () => page(chunks(gzipSync(new Uint8Array(8 * MIB))), { "content-encoding": "gzip" }), { status: "error", code: "TOO_LARGE" }],
  ];
  for (const [label, answer, expected] of cases) {
    const { fetcher } = harness(answer, { maxBytes: cap });
    assert.deepEqual(await fetcher("https://a.example/", none), expected, label);
  }
  const drip = (count: number, gap: number) =>
    page(
      (async function* () {
        for (let i = 0; i < count; i++) {
          await new Promise((resolve) => setTimeout(resolve, gap));
          yield text(".");
        }
      })(),
    );
  const within = harness(() => drip(3, 10), { timeoutMs: 500 });
  assert.equal((await within.fetcher("https://a.example/", none)).status, 200, "a slow drip inside the deadline is read");
  const beyond = harness(() => drip(1000, 20), { timeoutMs: 100 });
  const started = performance.now();
  assert.deepEqual(await beyond.fetcher("https://a.example/", none), { status: "error", code: "TIMEOUT" }, "a drip past the deadline is cut");
  assert.ok(performance.now() - started < 1000, "cut at the deadline, not at the end of the drip");
});

test("hostile markup of every kind is normalised in linear time", () => {
  for (const piece of ["<script></script>", "<a b='c' d=\"e\">", "<a<a<a<a", "&amp;&lt;&#65;&#x42;", '<x a="', "<!---->", "a&bbbbbbbbbbbbbbbbbbbb", "<!-->", "<!--->", "<!--"]) {
    const bytes = text(piece.repeat(Math.floor(MIB / piece.length)));
    const started = performance.now();
    normalizeForFingerprint(bytes, "text/html");
    assert.ok(performance.now() - started < 1000, piece);
  }
});

test("entity decoding is one pass, JSON keys such as __proto__ are only keys, and nothing is polluted", () => {
  assert.equal(normalizeForFingerprint(text("&amp;lt; &#0; &#xD800; &#x110000; &constructor; &__proto__;"), "text/html"), "&lt; � � � &constructor; &__proto__;");
  const json = '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"a":1,"a":2}';
  assert.equal(normalizeForFingerprint(text(json), "application/json"), '{"__proto__":{"polluted":1},"a":2,"constructor":{"prototype":{"polluted":1}}}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.doesNotThrow(() => normalizeForFingerprint(text("[".repeat(500_000)), "application/json"));
});

test("normalisation never throws on random bytes of any media type, with or without a charset", () => {
  let seed = 42;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256;
  for (let i = 0; i < 500; i++) {
    const bytes = new Uint8Array(Array.from({ length: 1 + (i % 300) }, random));
    for (const type of ["text/html", "application/json", "text/plain", "text/csv", "application/pdf", ""])
      for (const charset of [undefined, "gbk", "windows-1252", "no-such-charset"])
        assert.match(fp(bytes, type, charset), /^0x[0-9a-f]{64}$/);
  }
});

test("a URL never becomes a path in the fixture fetcher, and the reference process builds only the fixture fetcher", async () => {
  const dir = await mkdtemp(join(tmpdir(), "blink-watch-url-"));
  try {
    await writeFile(join(dir, "normal.txt"), "x");
    const world = { dir, questions: { q: { spec: {}, closeInSeconds: 1, maxPairs: 1, sources: { "https://example.com/q3-results": "normal.txt" } } }, suggestions: {}, agents: {} } as unknown as World;
    const fetcher = fixtureFetcher(world);
    for (const url of ["https://example.com/q3-results/../../../etc/passwd", "https://example.com/q3-results/", "https://EXAMPLE.com/q3-results", "https://example.com/q3-results?", "normal.txt"])
      assert.deepEqual(await fetcher(url, {}), { status: "error", code: "NOT_IN_WORLD" }, url);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const main = await readFile(new URL("../examples/agents/src/main.ts", import.meta.url), "utf8");
  assert.match(main, /fetcher: fixtureFetcher\(world\)/);
  assert.doesNotMatch(main, /httpsFetcher|httpsTransport/);
});

// -- The context ------------------------------------------------------------------------------

test("createContext without a fetcher is a type error", () => {
  const env: AgentEnv = {
    name: "a",
    roles: ["forecaster"],
    apiUrl: "http://127.0.0.1:1",
    rpcUrl: "http://127.0.0.1:1",
    key: ("0x" + "11".repeat(32)) as Hex,
    worldPath: "",
    stateDir: "",
  };
  const model = {} as never;
  // Never called: the proof is that `pnpm typecheck` accepts the directive below and so finds the error.
  async function neverCalled() {
    // @ts-expect-error `fetcher` is a required option and has no network default
    await createContext(env, { model });
    await createContext(env, { model, fetcher: async () => ({ status: "error", code: "NOT_IN_WORLD" }) });
  }
  assert.equal(typeof neverCalled, "function");
  assert.equal(typeof createContext, "function");
});
