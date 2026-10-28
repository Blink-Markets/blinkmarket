import { test } from "node:test";
import assert from "node:assert/strict";
import { apiConfig, parseTrustedProxies } from "../apps/api/src/config.js";

const identity = {
  API_DATABASE_URL: "postgresql://blink_api@127.0.0.1/blink",
  WALLET_BINDING_ORIGIN: "https://blink.example",
};
const markets = {
  ...identity,
  SPEC_OBJECT_DIRECTORY: "/var/blink/specs",
  SPEC_PUBLIC_ORIGIN: "https://blink.example",
  BLINK_DEPLOYMENT_ID: "local-anvil",
};

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
  // The retired preparation and approval modes are no longer accepted.
  for (const retired of ["preparation", "approval"])
    assert.throws(
      () => apiConfig({ BLINK_API_MODE: retired, ...markets }),
      /INVALID_API_MODE/,
    );
});

test("markets mode needs the spec archive and the deployment id", () => {
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
    /MARKETS_CONFIGURATION_REQUIRED/,
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

test("public read bucket defaults to production values and accepts the drill override", () => {
  assert.equal(apiConfig({}).publicReadLimit, undefined);
  assert.deepEqual(apiConfig({ API_PUBLIC_READ_LIMIT: "600,100" }).publicReadLimit, {
    capacity: 600,
    refillPerSecond: 100,
  });
  for (const value of ["", "0,1", "1,0", "1.5,2", "1,2,3", "999999999999999999999999999,1", "1,999999999999999999999999999"])
    assert.throws(() => apiConfig({ API_PUBLIC_READ_LIMIT: value }), /INVALID_API_PUBLIC_READ_LIMIT/);
});
