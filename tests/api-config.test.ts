import { test } from "node:test";
import assert from "node:assert/strict";
import { apiConfig } from "../apps/api/src/config.js";

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
const signer = {
  SIGNER_URL: "http://127.0.0.1:3003",
  SIGNER_CALLER_TOKEN: "caller-token",
  BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
};
const trading = { ...markets, ...signer };
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
  assert.equal(config.signerUrl, undefined);
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

test("trading mode additionally needs the signer and the RPC", () => {
  const config = apiConfig({ BLINK_API_MODE: "trading", ...trading });
  assert.equal(config.mode, "trading");
  assert.equal(config.deploymentId, "local-anvil");
  assert.equal(config.signerUrl, signer.SIGNER_URL);
  assert.equal(config.signerToken, signer.SIGNER_CALLER_TOKEN);
  assert.equal(config.rpcUrl, signer.BASE_SEPOLIA_RPC_URL);
  assert.throws(
    () =>
      apiConfig({
        BLINK_API_MODE: "trading",
        ...without(trading, "BLINK_DEPLOYMENT_ID"),
      }),
    /MARKETS_CONFIGURATION_REQUIRED/,
  );
  for (const name of Object.keys(signer) as (keyof typeof signer)[])
    assert.throws(
      () => apiConfig({ BLINK_API_MODE: "trading", ...without(trading, name) }),
      /TRADING_CONFIGURATION_REQUIRED/,
      name,
    );
});
