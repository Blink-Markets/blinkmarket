import { test } from "node:test";
import assert from "node:assert/strict";
import { signerConfig } from "../apps/signer/src/config.js";
import { isLoopbackUrl } from "../packages/adapters/src/gas-oracle.js";
import { sha256Hex } from "./helpers/signer-fixture.js";

const callers = JSON.stringify([
  { name: "worker", tokenSha256: sha256Hex("t1"), roles: ["keeper", "faucet"] },
  { name: "api", tokenSha256: sha256Hex("t2"), roles: ["maker"] },
]);
const enabled = {
  SIGNER_ENABLED: "true",
  SIGNER_DATABASE_URL: "postgresql://signer@127.0.0.1/blink",
  BASE_SEPOLIA_RPC_URL: "https://rpc.example.invalid",
  SIGNER_DEPLOYMENT_ID: "dep-1",
  SIGNER_CALLERS: callers,
  SIGNER_MAKER_KEY_FILE: "/run/secrets/maker",
};

test("the signer is a health-only stub unless explicitly enabled, and binds to loopback by default", () => {
  const stub = signerConfig({});
  assert.equal(stub.enabled, false);
  assert.equal(stub.host, "127.0.0.1");
  assert.equal(stub.port, 3004);
  assert.deepEqual(stub.callers, []);
  assert.throws(
    () => signerConfig({ SIGNER_ENABLED: "yes" }),
    /INVALID_SIGNER_ENABLED/,
  );
  assert.throws(
    () => signerConfig({ SIGNER_PORT: "70000" }),
    /INVALID_SIGNER_PORT/,
  );
  assert.equal(
    signerConfig({ SIGNER_HOST: "10.0.0.5", SIGNER_PORT: "4004" }).port,
    4004,
  );
});

test("an enabled signer needs its database, RPC, deployment, callers and at least one key file", () => {
  const config = signerConfig(enabled);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.keyFiles, { maker: "/run/secrets/maker" });
  assert.equal(config.l1FeeMode, "oracle");
  assert.equal(config.callers.length, 2);
  for (const missing of [
    "SIGNER_DATABASE_URL",
    "BASE_SEPOLIA_RPC_URL",
    "SIGNER_DEPLOYMENT_ID",
    "SIGNER_MAKER_KEY_FILE",
  ])
    assert.throws(
      () => signerConfig({ ...enabled, [missing]: "" }),
      /SIGNER_CONFIGURATION_REQUIRED/,
      missing,
    );
  const keys = signerConfig({
    ...enabled,
    SIGNER_KEEPER_KEY_FILE: "/k",
    SIGNER_FAUCET_KEY_FILE: "/f",
    SIGNER_TRADER_KEY_FILE: "/t",
  }).keyFiles;
  assert.deepEqual(Object.keys(keys).sort(), [
    "faucet",
    "keeper",
    "maker",
    "trader",
  ]);
  assert.throws(
    () => signerConfig({ ...enabled, BASE_SEPOLIA_RPC_URL: "ftp://x" }),
    /INVALID_SIGNER_RPC_URL/,
  );
  assert.throws(
    () => signerConfig({ ...enabled, BASE_SEPOLIA_RPC_URL: "nope" }),
    /INVALID_SIGNER_RPC_URL/,
  );
});

test("SIGNER_CALLERS is strict: known roles, hashed tokens, unique callers", () => {
  const good = { name: "w", tokenSha256: sha256Hex("a"), roles: ["keeper"] };
  const parse = (value: unknown) =>
    signerConfig({
      ...enabled,
      SIGNER_CALLERS: typeof value === "string" ? value : JSON.stringify(value),
    });
  parse([good]);
  for (const bad of [
    "not json",
    [],
    {},
    [{ ...good, extra: 1 }],
    [{ name: "w", roles: ["keeper"] }],
    [{ ...good, tokenSha256: "plain-token" }],
    [{ ...good, tokenSha256: sha256Hex("a").toUpperCase() }],
    [{ ...good, roles: [] }],
    [{ ...good, roles: ["admin"] }],
    [{ ...good, roles: ["keeper", "keeper"] }],
    [{ ...good, name: "" }],
    [good, { ...good, tokenSha256: sha256Hex("b") }],
    [good, { ...good, name: "other" }],
  ])
    assert.throws(
      () => parse(bad),
      /INVALID_SIGNER_CALLERS/,
      JSON.stringify(bad),
    );
});

test("l1FeeMode local-none is allowed only for a loopback RPC URL", () => {
  for (const url of [
    "http://127.0.0.1:8545",
    "http://localhost:8545",
    "http://[::1]:8545",
    "http://127.1.2.3",
  ])
    assert.equal(
      signerConfig({
        ...enabled,
        SIGNER_L1_FEE_MODE: "local-none",
        BASE_SEPOLIA_RPC_URL: url,
      }).l1FeeMode,
      "local-none",
      url,
    );
  for (const url of [
    "https://sepolia.base.org",
    "http://10.0.0.5:8545",
    "http://0.0.0.0:8545",
    "http://127.0.0.1.evil.example",
    "http://localhost.evil.example",
    "http://user@evil.example/?x=127.0.0.1",
  ])
    assert.throws(
      () =>
        signerConfig({
          ...enabled,
          SIGNER_L1_FEE_MODE: "local-none",
          BASE_SEPOLIA_RPC_URL: url,
        }),
      /SIGNER_L1_FEE_NONE_REQUIRES_LOOPBACK_RPC/,
      url,
    );
  assert.throws(
    () => signerConfig({ ...enabled, SIGNER_L1_FEE_MODE: "none" }),
    /INVALID_SIGNER_L1_FEE_MODE/,
  );
  assert.equal(isLoopbackUrl("not a url"), false);
  // The default is the oracle, which any RPC may use.
  assert.equal(signerConfig(enabled).l1FeeMode, "oracle");
});
