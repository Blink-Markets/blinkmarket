import { test } from "node:test";
import assert from "node:assert/strict";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { FetchError } from "../packages/domain/src/network-policy.ts";
import type { FetchTransport } from "../packages/ports/src/index.js";
import {
  allowlistFetcher,
  httpsRequestOptions,
} from "../packages/adapters/src/allowlist-fetcher.js";

const MIB = 1024 * 1024;
const policy = {
  exactUrl: "https://ir.example.test/q1.html",
  redirectPrefixes: ["https://cdn.example.test/files/"],
  allowedMime: ["text/html", "application/pdf", "text/plain"],
};
const hosts: Record<string, { address: string; family: 4 | 6 }[]> = {
  "ir.example.test": [{ address: "93.184.216.34", family: 4 }],
  "cdn.example.test": [{ address: "2606:4700::1111", family: 6 }],
  "mixed.example.test": [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "metadata.example.test": [{ address: "169.254.169.254", family: 4 }],
  "mapped.example.test": [{ address: "::ffff:127.0.0.1", family: 6 }],
  "evil.example": [{ address: "93.184.216.35", family: 4 }],
  "empty.example.test": [],
};
type Response = Awaited<ReturnType<FetchTransport["request"]>>;
type Input = Parameters<FetchTransport["request"]>[0];
async function* chunks(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}
async function* stalled(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
  await new Promise<never>(() => {});
}
const html = (
  body: AsyncIterable<Uint8Array>,
  headers: Record<string, string> = {},
): Response => ({
  status: 200,
  headers: { "content-type": "text/html; charset=UTF-8", ...headers },
  body,
});
const redirect = (location: string, status = 302): Response => ({
  status,
  headers: { location },
  body: chunks(),
});
function harness(
  respond: (input: Input, call: number) => Response | Promise<Response>,
  limits: Parameters<typeof allowlistFetcher>[0]["limits"] = {},
) {
  const requests: Input[] = [];
  const lookups: string[] = [];
  const fetcher = allowlistFetcher({
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
    limits,
  });
  return { fetcher, requests, lookups };
}
const fails = (promise: Promise<unknown>, code: string, retryable: boolean) =>
  assert.rejects(
    promise,
    (error) =>
      error instanceof FetchError &&
      error.code === code &&
      error.retryable === retryable,
    code,
  );
const live = new AbortController().signal;
const text = (value: string) => new TextEncoder().encode(value);

test("fetches the exact URL, pins the validated address and decodes gzip, deflate and brotli", async () => {
  const original = text("<html>Annual results: gross margin 41%</html>");
  const encodings: [string, Uint8Array][] = [
    ["gzip", gzipSync(original)],
    ["x-gzip", gzipSync(original)],
    ["deflate", deflateSync(original)],
    ["br", brotliCompressSync(original)],
    ["identity", original],
  ];
  for (const [encoding, encoded] of encodings) {
    const { fetcher, requests } = harness(() =>
      html(
        chunks(encoded.slice(0, 7), encoded.slice(7)),
        encoding === "identity" ? {} : { "Content-Encoding": encoding },
      ),
    );
    const result = await fetcher.fetch(policy, live);
    assert.deepEqual(new Uint8Array(result.bytes), original, encoding);
    assert.equal(result.finalUrl, policy.exactUrl);
    assert.equal(result.mime, "text/html");
    assert.ok(result.observedAt instanceof Date);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.ip, "93.184.216.34");
    assert.equal(requests[0]!.family, 4);
    assert.equal(requests[0]!.url.href, policy.exactUrl);
    assert.ok(requests[0]!.signal instanceof AbortSignal);
    assert.equal(requests[0]!.timeoutMs, 15_000);
  }
});

test("accepts a body of exactly 10 MiB", async () => {
  const { fetcher } = harness(() =>
    html(chunks(...Array.from({ length: 10 }, () => new Uint8Array(MIB)))),
  );
  assert.equal((await fetcher.fetch(policy, live)).bytes.length, 10 * MIB);
});

test("a name that resolves to any private address is refused before any connection", async () => {
  for (const host of [
    "mixed.example.test",
    "metadata.example.test",
    "mapped.example.test",
  ]) {
    const { fetcher, requests } = harness(() => html(chunks()));
    await fails(
      fetcher.fetch({ ...policy, exactUrl: `https://${host}/q1.html` }, live),
      "PRIVATE_ADDRESS",
      false,
    );
    assert.equal(requests.length, 0, host);
  }
});

test("a lookup failure or an empty answer is a retryable DNS_FAILED", async () => {
  for (const host of ["unknown.example.test", "empty.example.test"]) {
    const { fetcher, requests } = harness(() => html(chunks()));
    await fails(
      fetcher.fetch({ ...policy, exactUrl: `https://${host}/` }, live),
      "DNS_FAILED",
      true,
    );
    assert.equal(requests.length, 0);
  }
});

test("a redirect outside the prefixes is refused before it is resolved", async () => {
  const { fetcher, requests, lookups } = harness(() =>
    redirect("https://evil.example/"),
  );
  await fails(fetcher.fetch(policy, live), "NOT_ALLOWLISTED", false);
  assert.equal(requests.length, 1);
  assert.deepEqual(lookups, ["ir.example.test"]);
});

test("a redirect into a host that resolves to the metadata address is refused", async () => {
  const withMetadata = {
    ...policy,
    redirectPrefixes: ["https://metadata.example.test/"],
  };
  const { fetcher, requests } = harness(() =>
    redirect("https://metadata.example.test/latest"),
  );
  await fails(fetcher.fetch(withMetadata, live), "PRIVATE_ADDRESS", false);
  assert.equal(requests.length, 1);
});

test("redirect targets that are IP literals, http or fragments are refused", async () => {
  const cases: [string, string][] = [
    ["https://169.254.169.254/files/", "IP_LITERAL"],
    ["http://cdn.example.test/files/a", "NOT_HTTPS"],
    ["https://cdn.example.test/files/a#top", "FRAGMENT"],
    ["https://user:pw@cdn.example.test/files/a", "CREDENTIALS"],
    ["https://cdn.example.test:8443/files/a", "PORT"],
  ];
  for (const [location, code] of cases) {
    const { fetcher } = harness(() => redirect(location));
    await fails(fetcher.fetch(policy, live), code, false);
  }
});

test("follows at most three redirects, resolving relative Location values", async () => {
  const hops = (count: number) =>
    harness((_input, call) =>
      call <= count
        ? redirect(
            call === 1 ? "https://cdn.example.test/files/1" : `/files/${call}`,
            [301, 302, 307][call % 3],
          )
        : html(chunks(text("done"))),
    );
  const ok = hops(3);
  const result = await ok.fetcher.fetch(policy, live);
  assert.equal(result.finalUrl, "https://cdn.example.test/files/3");
  assert.equal(ok.requests.length, 4);
  assert.equal(ok.requests[1]!.ip, "2606:4700::1111");
  assert.equal(ok.requests[1]!.family, 6);

  const tooMany = hops(4);
  await fails(tooMany.fetcher.fetch(policy, live), "TOO_MANY_REDIRECTS", false);
  assert.equal(tooMany.requests.length, 4);

  const narrowed = harness(() => redirect("https://cdn.example.test/files/1"), {
    maxRedirects: 1,
  });
  await fails(
    narrowed.fetcher.fetch(policy, live),
    "TOO_MANY_REDIRECTS",
    false,
  );
  assert.equal(narrowed.requests.length, 2);
});

test("a redirect without a usable Location is an HTTP failure or BAD_REDIRECT", async () => {
  const bare = harness(() => ({ status: 302, headers: {}, body: chunks() }));
  await fails(bare.fetcher.fetch(policy, live), "HTTP_302", false);
  const broken = harness(() => redirect("https://[bad"));
  await fails(broken.fetcher.fetch(policy, live), "BAD_REDIRECT", false);
});

test("rejects a raw body of 10 MiB + 1 byte", async () => {
  const { fetcher } = harness(() =>
    html(
      chunks(
        ...Array.from({ length: 10 }, () => new Uint8Array(MIB)),
        new Uint8Array(1),
      ),
    ),
  );
  await fails(fetcher.fetch(policy, live), "TOO_LARGE", false);
});

test("rejects an oversize Content-Length without reading the body", async () => {
  let read = false;
  const { fetcher } = harness(() =>
    html(
      (async function* () {
        read = true;
        yield text("x");
      })(),
      { "content-length": String(10 * MIB + 1) },
    ),
  );
  await fails(fetcher.fetch(policy, live), "TOO_LARGE", false);
  assert.equal(read, false);
});

test("a gzip bomb is cut off at 10 MiB of decoded bytes", async () => {
  for (const [encoding, encoded] of [
    ["gzip", gzipSync(new Uint8Array(20 * MIB))],
    ["deflate", deflateSync(new Uint8Array(20 * MIB))],
    ["br", brotliCompressSync(new Uint8Array(20 * MIB))],
  ] as const) {
    assert.ok(encoded.length < 100 * 1024, `${encoding} fixture is small`);
    const { fetcher } = harness(() =>
      html(chunks(encoded), { "content-encoding": encoding }),
    );
    await fails(fetcher.fetch(policy, live), "TOO_LARGE", false);
  }
});

test("a corrupt or unsupported content encoding is a non-retryable failure", async () => {
  const corrupt = harness(() =>
    html(chunks(text("this is not gzip data at all")), {
      "content-encoding": "gzip",
    }),
  );
  await fails(corrupt.fetcher.fetch(policy, live), "DECODE_FAILED", false);
  const unknown = harness(() =>
    html(chunks(text("x")), { "content-encoding": "compress" }),
  );
  await fails(
    unknown.fetcher.fetch(policy, live),
    "UNSUPPORTED_ENCODING",
    false,
  );
});

test("rejects MIME types outside the reviewed list", async () => {
  for (const type of [
    "application/zip",
    "application/octet-stream",
    "text/html-evil",
    "",
  ]) {
    let read = false;
    const { fetcher } = harness(() => ({
      status: 200,
      headers: type ? { "content-type": type } : {},
      body: (async function* () {
        read = true;
        yield text("x");
      })(),
    }));
    await fails(fetcher.fetch(policy, live), "MIME_NOT_ALLOWED", false);
    assert.equal(read, false, type);
  }
  const upper = harness(() =>
    html(chunks(text("%PDF")), { "content-type": "Application/PDF ; q=1" }),
  );
  assert.equal(
    (await upper.fetcher.fetch(policy, live)).mime,
    "application/pdf",
  );
});

test("an empty 200 body is refused", async () => {
  const { fetcher } = harness(() => html(chunks()));
  await fails(fetcher.fetch(policy, live), "EMPTY_BODY", false);
});

test("HTTP statuses map to retryable or permanent failures", async () => {
  const table: [number, boolean][] = [
    [500, true],
    [503, true],
    [429, true],
    [404, false],
    [403, false],
    [304, false],
  ];
  for (const [status, retryable] of table) {
    const { fetcher } = harness(() => ({
      status,
      headers: {},
      body: chunks(),
    }));
    await fails(fetcher.fetch(policy, live), `HTTP_${status}`, retryable);
  }
});

test("transport failures are retryable, certificate failures are not", async () => {
  const reset = harness(() => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  });
  await fails(reset.fetcher.fetch(policy, live), "NETWORK_ERROR", true);
  const midBody = harness(() =>
    html(
      (async function* () {
        yield text("part");
        throw new Error("aborted");
      })(),
    ),
  );
  await fails(midBody.fetcher.fetch(policy, live), "NETWORK_ERROR", true);
  const certificate = harness(() => {
    throw Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });
  });
  await fails(certificate.fetcher.fetch(policy, live), "TLS_FAILED", false);
});

test("the total timeout stops a stalled body", async () => {
  const { fetcher } = harness(() => html(stalled(text("part"))), {
    totalTimeoutMs: 40,
    requestTimeoutMs: 5_000,
  });
  await fails(fetcher.fetch(policy, live), "TIMEOUT", true);
});

test("the per-request timeout stops a transport that never answers", async () => {
  const { fetcher } = harness(() => new Promise<Response>(() => {}), {
    requestTimeoutMs: 40,
    totalTimeoutMs: 5_000,
  });
  await fails(fetcher.fetch(policy, live), "TIMEOUT", true);
});

test("the total timeout also spans redirects", async () => {
  const { fetcher } = harness(
    (_input, call) =>
      call === 1
        ? redirect("https://cdn.example.test/files/1")
        : new Promise<Response>(() => {}),
    { totalTimeoutMs: 40, requestTimeoutMs: 5_000 },
  );
  await fails(fetcher.fetch(policy, live), "TIMEOUT", true);
});

test("the caller's abort signal wins and the request signal is aborted afterwards", async () => {
  const controller = new AbortController();
  const { fetcher, requests } = harness(() => {
    queueMicrotask(() => controller.abort(new Error("JOB_CANCELLED")));
    return html(stalled(text("part")));
  });
  await assert.rejects(
    fetcher.fetch(policy, controller.signal),
    /JOB_CANCELLED/,
  );
  assert.equal(requests[0]!.signal.aborted, true);
  const before = harness(() => html(chunks(text("x"))));
  const gone = new AbortController();
  gone.abort(new Error("ALREADY_CANCELLED"));
  await assert.rejects(
    before.fetcher.fetch(policy, gone.signal),
    /ALREADY_CANCELLED/,
  );
  assert.equal(before.requests.length, 0);
});

test("the transport signal is aborted once a request has finished", async () => {
  const { fetcher, requests } = harness(() => html(chunks(text("ok"))));
  await fetcher.fetch(policy, live);
  assert.equal(requests[0]!.signal.aborted, true);
});

test("httpsRequestOptions pins the connection to the validated address", async () => {
  const url = new URL("https://ir.example.test/reports/q1.html?lang=en");
  const options = httpsRequestOptions({
    ip: "93.184.216.34",
    family: 4,
    url,
  });
  assert.equal(options.servername, "ir.example.test");
  assert.equal(options.hostname, "ir.example.test");
  assert.equal(options.port, 443);
  assert.equal(options.method, "GET");
  assert.equal(options.path, "/reports/q1.html?lang=en");
  assert.equal(options.agent, false);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(
    (options.headers as Record<string, string>)["Host"],
    "ir.example.test",
  );
  const lookup = options.lookup!;
  const one = new Promise((resolve) =>
    lookup("attacker-chosen.example", {}, (error, address, family) =>
      resolve({ error, address, family }),
    ),
  );
  assert.deepEqual(await one, {
    error: null,
    address: "93.184.216.34",
    family: 4,
  });
  const all = new Promise((resolve) =>
    lookup("attacker-chosen.example", { all: true }, (error, addresses) =>
      resolve({ error, addresses }),
    ),
  );
  assert.deepEqual(await all, {
    error: null,
    addresses: [{ address: "93.184.216.34", family: 4 }],
  });
});

test("httpsRequestOptions pins IPv6 addresses and sets the Host header from the URL", async () => {
  const options = httpsRequestOptions({
    ip: "2606:4700::1111",
    family: 6,
    url: new URL("https://cdn.example.test:443/files/a"),
  });
  assert.equal(options.servername, "cdn.example.test");
  assert.equal(
    (options.headers as Record<string, string>)["Host"],
    "cdn.example.test",
  );
  const answer = await new Promise((resolve) =>
    options.lookup!("x", {}, (error, address, family) =>
      resolve({ error, address, family }),
    ),
  );
  assert.deepEqual(answer, {
    error: null,
    address: "2606:4700::1111",
    family: 6,
  });
});
