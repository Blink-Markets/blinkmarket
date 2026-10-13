import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FetchError,
  checkFetchUrl,
  isPublicAddress,
} from "../packages/domain/src/network-policy.ts";

const addresses: [string, boolean][] = [
  // IPv4: first/last address inside each blocked range and its public neighbours.
  ["0.0.0.0", false],
  ["0.255.255.255", false],
  ["1.0.0.0", true],
  ["10.0.0.1", false],
  ["10.255.255.255", false],
  ["100.63.255.255", true],
  ["100.64.0.0", false],
  ["100.127.255.255", false],
  ["100.128.0.0", true],
  ["127.0.0.1", false],
  ["127.255.255.254", false],
  ["169.254.169.254", false],
  ["169.253.255.255", true],
  ["169.255.0.0", true],
  ["172.15.255.255", true],
  ["172.16.0.1", false],
  ["172.31.255.255", false],
  ["172.32.0.0", true],
  ["192.0.0.8", false],
  ["192.0.1.1", true],
  ["192.0.2.55", false],
  ["192.88.99.1", false],
  ["192.168.1.1", false],
  ["198.17.255.255", true],
  ["198.18.0.1", false],
  ["198.19.255.255", false],
  ["198.20.0.0", true],
  ["198.51.100.7", false],
  ["203.0.113.9", false],
  ["223.255.255.255", true],
  ["224.0.0.1", false],
  ["239.255.255.255", false],
  ["240.0.0.1", false],
  ["255.255.255.255", false],
  ["1.1.1.1", true],
  ["8.8.8.8", true],
  ["93.184.216.34", true],
  // IPv6.
  ["::", false],
  ["::1", false],
  ["0:0:0:0:0:0:0:1", false],
  ["100::1", false],
  ["100:0:0:0:ffff::1", false],
  ["100:0:0:1::1", true],
  ["2001:db8::1", false],
  ["2001:db8:ffff::1", false],
  ["2001:db9::1", true],
  ["fc00::1", false],
  ["FD12:3456::1", false],
  ["fe80::1", false],
  ["febf::1", false],
  ["ff02::1", false],
  ["2606:4700::1111", true],
  ["2001:4860:4860::8888", true],
  // IPv4-mapped and NAT64 forms are judged by the embedded IPv4 address.
  ["::ffff:127.0.0.1", false],
  ["::ffff:7f00:1", false],
  ["::ffff:169.254.169.254", false],
  ["::ffff:a00:1", false],
  ["::FFFF:192.168.0.1", false],
  ["::ffff:8.8.8.8", true],
  ["::ffff:808:808", true],
  ["64:ff9b::7f00:1", false],
  ["64:ff9b::10.0.0.1", false],
  ["64:ff9b::a9fe:a9fe", false],
  ["64:ff9b::8.8.8.8", true],
  ["64:ff9b::808:808", true],
  // IPv4-compatible forms are judged by the embedded address as well.
  ["::7f00:1", false],
  ["::8.8.8.8", true],
  // Anything that is not a canonical address is refused.
  ["", false],
  ["not-an-ip", false],
  ["1.2.3", false],
  ["1.2.3.4.5", false],
  ["256.1.1.1", false],
  ["01.2.3.4", false],
  ["fe80::1%eth0", false],
  ["1::2::3", false],
  ["12345::1", false],
  ["[::1]", false],
  ["::ffff:1.2.3", false],
];
test("isPublicAddress classifies every blocked range and fails closed on garbage", () => {
  assert.ok(addresses.length >= 25);
  for (const [address, expected] of addresses)
    assert.equal(isPublicAddress(address), expected, address);
});

const policy = {
  exactUrl: "https://ir.example.test/reports/q1.html?lang=en",
  redirectPrefixes: ["https://cdn.example.test/files/", "https://other.test"],
};
const urls: [string, number, string | "ok"][] = [
  [policy.exactUrl, 0, "ok"],
  // Normalisation: host case and an explicit default port are allowed.
  ["https://IR.Example.test:443/reports/q1.html?lang=en", 0, "ok"],
  ["http://ir.example.test/reports/q1.html?lang=en", 0, "NOT_HTTPS"],
  ["ftp://ir.example.test/reports/q1.html?lang=en", 0, "NOT_HTTPS"],
  ["https://user:pw@ir.example.test/reports/q1.html?lang=en", 0, "CREDENTIALS"],
  ["https://user@ir.example.test/reports/q1.html?lang=en", 0, "CREDENTIALS"],
  ["https://ir.example.test:8443/reports/q1.html?lang=en", 0, "PORT"],
  ["https://ir.example.test:80/reports/q1.html?lang=en", 0, "PORT"],
  ["https://ir.example.test/reports/q1.html?lang=en#frag", 0, "FRAGMENT"],
  ["https://ir.example.test/reports/q1.html?lang=en#", 0, "FRAGMENT"],
  ["https://1.2.3.4/", 0, "IP_LITERAL"],
  ["https://[2606:4700::1111]/", 0, "IP_LITERAL"],
  ["https://[::ffff:127.0.0.1]/", 0, "IP_LITERAL"],
  // The URL parser folds integer and hex hosts into dotted quads.
  ["https://2130706433/", 0, "IP_LITERAL"],
  ["https://0x7f.1/", 0, "IP_LITERAL"],
  ["https://ir.example.test/reports/q2.html?lang=en", 0, "NOT_ALLOWLISTED"],
  ["https://ir.example.test/reports/q1.html", 0, "NOT_ALLOWLISTED"],
  ["https://ir.example.test/reports/q1.html?lang=fr", 0, "NOT_ALLOWLISTED"],
  ["https://evil.test/reports/q1.html?lang=en", 0, "NOT_ALLOWLISTED"],
  ["not a url", 0, "NOT_ALLOWLISTED"],
  // The first request must be the exact URL; redirect prefixes do not apply to it.
  ["https://cdn.example.test/files/q1.pdf", 0, "NOT_ALLOWLISTED"],
  // Redirect hops: only a configured prefix passes; the exact URL is not a prefix.
  ["https://cdn.example.test/files/q1.pdf", 1, "ok"],
  ["https://cdn.example.test/files/deep/er/q1.pdf?x=1", 3, "ok"],
  ["https://other.test/anything", 2, "ok"],
  ["https://cdn.example.test/other/q1.pdf", 1, "NOT_ALLOWLISTED"],
  ["https://cdn.example.test/files", 1, "NOT_ALLOWLISTED"],
  ["https://evil.example/", 1, "NOT_ALLOWLISTED"],
  [policy.exactUrl, 1, "NOT_ALLOWLISTED"],
  // A host-only prefix must not match a longer hostname that merely starts with it.
  ["https://other.test.evil.example/x", 1, "NOT_ALLOWLISTED"],
  ["https://other.test@evil.example/x", 1, "CREDENTIALS"],
  ["http://cdn.example.test/files/q1.pdf", 1, "NOT_HTTPS"],
  ["https://cdn.example.test/files/q1.pdf#top", 1, "FRAGMENT"],
  ["https://cdn.example.test:8443/files/q1.pdf", 1, "PORT"],
  ["https://169.254.169.254/files/", 1, "IP_LITERAL"],
  // At most three redirects.
  ["https://cdn.example.test/files/q1.pdf", 4, "TOO_MANY_REDIRECTS"],
  ["https://cdn.example.test/files/q1.pdf", 9, "TOO_MANY_REDIRECTS"],
];
test("checkFetchUrl enforces scheme, port, credentials, fragment, IP-literal and allowlist rules", () => {
  assert.ok(urls.length >= 25);
  for (const [url, hop, expected] of urls) {
    const result = checkFetchUrl(url, policy, hop);
    assert.deepEqual(
      result,
      expected === "ok" ? { ok: true } : { ok: false, code: expected },
      `${hop} ${url}`,
    );
  }
});

test("an unparsable redirect prefix never matches", () => {
  const broken = { exactUrl: policy.exactUrl, redirectPrefixes: ["", "nope"] };
  assert.deepEqual(checkFetchUrl("https://nope/", broken, 1), {
    ok: false,
    code: "NOT_ALLOWLISTED",
  });
});

test("FetchError carries a stable code and retry flag", () => {
  const error = new FetchError("HTTP_503", true);
  assert.equal(error.code, "HTTP_503");
  assert.equal(error.retryable, true);
  assert.equal(error.message, "HTTP_503");
  assert.ok(error instanceof Error);
});
