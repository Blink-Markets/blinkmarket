import { test } from "node:test";
import assert from "node:assert/strict";
import { apiConfig, parseTrustedProxies } from "../apps/api/src/config.js";

const identity = {
  API_DATABASE_URL: "postgresql://blink_api@127.0.0.1/blink",
  WALLET_BINDING_ORIGIN: "https://blink.example",
};
const approval = {
  ...identity,
  SPEC_OBJECT_DIRECTORY: "/var/blink/specs",
  SPEC_PUBLIC_ORIGIN: "https://blink.example",
  EVIDENCE_OBJECT_DIRECTORY: "/var/blink/evidence",
};
const markets = { ...approval, BLINK_DEPLOYMENT_ID: "local-anvil" };

const without = <T extends object>(env: T, name: keyof T) => {
  const copy = { ...env };
  delete copy[name];
  return copy;
};

test("existing API modes keep their requirements", () => {
  assert.equal(apiConfig({}).mode, "scaffold");
  assert.throws(
    () => apiConfig({ BLINK_API_MODE: "nope" }),
    /INVALID_API_MODE/,
  );
  assert.throws(
    () => apiConfig({ BLINK_API_MODE: "identity" }),
    /IDENTITY_CONFIGURATION_REQUIRED/,
  );
  assert.equal(
    apiConfig({ BLINK_API_MODE: "identity", ...identity }).mode,
    "identity",
  );
  assert.throws(
    () => apiConfig({ BLINK_API_MODE: "approval", ...identity }),
    /APPROVAL_CONFIGURATION_REQUIRED/,
  );
  assert.equal(
    apiConfig({ BLINK_API_MODE: "approval", ...approval }).mode,
    "approval",
  );
});

test("markets mode needs everything approval needs plus the deployment id", () => {
  const config = apiConfig({ BLINK_API_MODE: "markets", ...markets });
  assert.equal(config.mode, "markets");
  assert.equal(config.deploymentId, "local-anvil");
  assert.throws(
    () =>
      apiConfig({
        BLINK_API_MODE: "markets",
        ...without(markets, "BLINK_DEPLOYMENT_ID"),
      }),
    /MARKETS_CONFIGURATION_REQUIRED/,
  );
  assert.throws(
    () =>
      apiConfig({
        BLINK_API_MODE: "markets",
        ...without(markets, "SPEC_OBJECT_DIRECTORY"),
      }),
    /APPROVAL_CONFIGURATION_REQUIRED/,
  );
  assert.throws(
    () =>
      apiConfig({
        BLINK_API_MODE: "markets",
        ...without(markets, "API_DATABASE_URL"),
      }),
    /IDENTITY_CONFIGURATION_REQUIRED/,
  );
});

test("retired trading mode is refused", () => {
  assert.throws(
    () => apiConfig({ BLINK_API_MODE: "trading", ...markets }),
    /INVALID_API_MODE/,
  );
});

test("trusted proxies parse to exact addresses or CIDRs and refuse anything broad or malformed", () => {
  assert.deepEqual(parseTrustedProxies(undefined), []);
  assert.deepEqual(parseTrustedProxies(""), []);
  assert.deepEqual(parseTrustedProxies(" 127.0.0.1, ::1,10.0.0.0/8 "), [
    "127.0.0.1",
    "::1",
    "10.0.0.0/8",
  ]);
  for (const raw of [
    "true",
    "*",
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/33",
    "fe80::/129",
    "proxy.internal",
    "127.0.0.1,,::1",
  ])
    assert.throws(
      () => parseTrustedProxies(raw),
      /INVALID_API_TRUSTED_PROXIES/,
    );
});

test("apiConfig exposes the trusted proxies", () => {
  assert.deepEqual(apiConfig({}).trustedProxies, []);
  assert.deepEqual(
    apiConfig({ API_TRUSTED_PROXIES: "127.0.0.1" }).trustedProxies,
    ["127.0.0.1"],
  );
});
