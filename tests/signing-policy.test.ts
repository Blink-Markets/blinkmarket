import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  checkGasCaps,
  checkMakerQuote,
  checkTransactionCall,
  gasLimitFor,
  intentRole,
  maxFeePerGas,
  minimumReplacementFees,
  minReplacementTipWei,
  parseTransactionPayload,
  replacementFeesAccepted,
  signingLimits,
} from "../packages/domain/src/signing-policy.js";
import {
  testAccounts,
  testManifest,
  testMarket,
  testToken,
} from "./helpers/signer-fixture.js";

const manifest = testManifest();
const specHash = "0x" + "11".repeat(32);
const quote = {
  marketId: "1",
  specHash,
  maker: testAccounts.maker.address,
  taker: testAccounts.taker.address,
  side: "0",
  quantity: "10",
  priceBps: "6000",
  validAfter: "1000",
  expiresAt: "1030",
  nonce: "7",
  epoch: "3",
};
const open = { state: "OPEN", closeAt: 2000n, specHash };
const quoteCheck = (
  overrides: {
    message?: unknown;
    nowMs?: number;
    market?: typeof open | null;
    epoch?: bigint | null;
    deploymentEnabled?: boolean;
    manifest?: typeof manifest;
  } = {},
) =>
  checkMakerQuote({
    manifest: overrides.manifest ?? manifest,
    makerAddress: testAccounts.maker.address,
    deploymentEnabled: overrides.deploymentEnabled ?? true,
    nowMs: overrides.nowMs ?? 1_010_000,
    message: "message" in overrides ? overrides.message : quote,
    market: overrides.market === undefined ? open : overrides.market,
    epoch: overrides.epoch === undefined ? 3n : overrides.epoch,
  });
const rejectedWith = (result: { ok: boolean; code?: string }, code: string) =>
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code });

test("maker quote policy accepts a well-formed quote for an open market", () => {
  const result = quoteCheck();
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.quote.quantity, 10n);
    assert.equal(result.quote.priceBps, 6000n);
    assert.equal(result.quote.maker, testAccounts.maker.address.toLowerCase());
  }
  // The boundaries named in the brief are inclusive.
  for (const message of [
    { ...quote, quantity: "1" },
    { ...quote, quantity: "100" },
    { ...quote, priceBps: "1" },
    { ...quote, priceBps: "9999" },
    { ...quote, validAfter: "1029" },
    { ...quote, expiresAt: "1060" },
  ])
    assert.equal(quoteCheck({ message }).ok, true, JSON.stringify(message));
  assert.equal(
    quoteCheck({ message: { ...quote, expiresAt: "2000", validAfter: "1950" } })
      .ok,
    true,
    "expiresAt equal to close_at is allowed",
  );
});

test("maker quote policy rejects every out-of-policy field with a specific code", () => {
  rejectedWith(quoteCheck({ deploymentEnabled: false }), "DEPLOYMENT_DISABLED");
  rejectedWith(
    quoteCheck({ manifest: testManifest({ tradingEnabled: false }) }),
    "TRADING_DISABLED",
  );
  for (const message of [
    null,
    "quote",
    { ...quote, extra: "1" },
    { ...quote, side: "2" },
    { ...quote, quantity: "1.5" },
    { ...quote, quantity: 10 },
    { ...quote, priceBps: "65536" },
    { ...quote, taker: "0x1234" },
    { ...quote, specHash: "0x11" },
    { marketId: "1" },
  ])
    rejectedWith(quoteCheck({ message }), "QUOTE_INVALID");
  rejectedWith(
    quoteCheck({ message: { ...quote, maker: testAccounts.keeper.address } }),
    "MAKER_NOT_ALLOWED",
  );
  for (const expiresAt of ["1000", "999", "1061"])
    rejectedWith(
      quoteCheck({ message: { ...quote, expiresAt } }),
      "QUOTE_LIFETIME_INVALID",
    );
  // Signer clock must be strictly below expiresAt - 2 s.
  assert.equal(quoteCheck({ nowMs: 1_027_999 }).ok, true);
  rejectedWith(quoteCheck({ nowMs: 1_028_000 }), "QUOTE_EXPIRED");
  rejectedWith(quoteCheck({ nowMs: 1_100_000 }), "QUOTE_EXPIRED");
  rejectedWith(quoteCheck({ market: null }), "MARKET_NOT_FOUND");
  rejectedWith(
    quoteCheck({ market: { ...open, state: "PROPOSED" } }),
    "MARKET_NOT_OPEN",
  );
  rejectedWith(
    quoteCheck({ market: { ...open, closeAt: 1029n } }),
    "QUOTE_AFTER_CLOSE",
  );
  rejectedWith(
    quoteCheck({ market: { ...open, specHash: "0x" + "22".repeat(32) } }),
    "SPEC_HASH_MISMATCH",
  );
  rejectedWith(quoteCheck({ epoch: 4n }), "EPOCH_MISMATCH");
  rejectedWith(quoteCheck({ epoch: null }), "EPOCH_MISMATCH");
  for (const quantity of ["0", "101"])
    rejectedWith(
      quoteCheck({ message: { ...quote, quantity } }),
      "QUANTITY_NOT_ALLOWED",
    );
  for (const priceBps of ["0", "10000"])
    rejectedWith(
      quoteCheck({ message: { ...quote, priceBps } }),
      "PRICE_NOT_ALLOWED",
    );
});

test("the maker key must be the manifest maker", () => {
  const result = checkMakerQuote({
    manifest,
    makerAddress: testAccounts.keeper.address,
    deploymentEnabled: true,
    nowMs: 1_010_000,
    message: { ...quote, maker: testAccounts.keeper.address },
    market: open,
    epoch: 3n,
  });
  rejectedWith(result, "MAKER_NOT_ALLOWED");
});

const addresses = {
  trader: testAccounts.trader.address,
  keeper: testAccounts.keeper.address,
};
const call = (
  role: "maker" | "trader" | "keeper" | "faucet",
  kind: Parameters<typeof checkTransactionCall>[0]["kind"],
  payload: unknown,
) => checkTransactionCall({ manifest, addresses, role, kind, payload });
const signature = "0x" + "ab".repeat(65);
const fill = (overrides: Record<string, unknown> = {}) => ({
  to: testMarket,
  functionName: "fillQuote",
  args: [
    { ...quote, taker: testAccounts.trader.address, ...overrides },
    signature,
  ],
});

test("keeper may only finalize on BlinkMarket", () => {
  for (const [kind, functionName] of [
    ["FINALIZE_UNCHALLENGED", "finalizeUnchallenged"],
    ["FINALIZE_TIMEOUT", "finalizeTimeout"],
  ] as const) {
    const ok = call("keeper", kind, {
      to: testMarket,
      functionName,
      args: ["12"],
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
      assert.equal(ok.call.to, testMarket.toLowerCase());
      assert.equal(ok.call.functionName, functionName);
      assert.deepEqual(ok.call.args, [12n]);
    }
    rejectedWith(
      call("keeper", kind, { to: testToken, functionName, args: ["12"] }),
      "TARGET_NOT_ALLOWED",
    );
  }
  for (const functionName of [
    "redeem",
    "mint",
    "transfer",
    "withdrawMaker",
    "setTakerAllowed",
    "arbitrate",
  ])
    rejectedWith(
      call("keeper", "FINALIZE_TIMEOUT", {
        to: testMarket,
        functionName,
        args: ["1"],
      }),
      "SELECTOR_NOT_ALLOWED",
    );
  // The intent kind pins the exact function.
  rejectedWith(
    call("keeper", "FINALIZE_TIMEOUT", {
      to: testMarket,
      functionName: "finalizeUnchallenged",
      args: ["1"],
    }),
    "SELECTOR_NOT_ALLOWED",
  );
});

test("faucet may only mint a bounded amount on BlinkTestUSD", () => {
  const mint = (amount: string, to = testToken) => ({
    to,
    functionName: "mint",
    args: [testAccounts.taker.address, amount],
  });
  const ok = call("faucet", "MINT", mint("1000000000"));
  assert.equal(ok.ok, true);
  if (ok.ok)
    assert.deepEqual(ok.call.args, [
      testAccounts.taker.address.toLowerCase(),
      1_000_000_000n,
    ]);
  rejectedWith(
    call("faucet", "MINT", mint("1000000001")),
    "AMOUNT_NOT_ALLOWED",
  );
  rejectedWith(
    call("faucet", "MINT", mint("1000000000", testMarket)),
    "TARGET_NOT_ALLOWED",
  );
  rejectedWith(
    call("faucet", "MINT", { ...mint("1"), functionName: "approve" }),
    "SELECTOR_NOT_ALLOWED",
  );
  rejectedWith(
    call("faucet", "MINT", { ...mint("1"), functionName: "transfer" }),
    "SELECTOR_NOT_ALLOWED",
  );
});

test("trader may approve a bounded amount, fill as itself against the maker, and redeem", () => {
  const approve = (amount: string, spender = testMarket, to = testToken) => ({
    to,
    functionName: "approve",
    args: [spender, amount],
  });
  assert.equal(call("trader", "APPROVE", approve("100000000")).ok, true);
  assert.equal(call("trader", "APPROVE", approve("1")).ok, true);
  for (const amount of ["0", "100000001", (2n ** 256n - 1n).toString()])
    rejectedWith(
      call("trader", "APPROVE", approve(amount)),
      "AMOUNT_NOT_ALLOWED",
    );
  rejectedWith(
    call("trader", "APPROVE", approve("1", testAccounts.taker.address)),
    "TARGET_NOT_ALLOWED",
  );
  rejectedWith(
    call("trader", "APPROVE", approve("1", testMarket, testMarket)),
    "TARGET_NOT_ALLOWED",
  );

  const ok = call("trader", "FILL", fill());
  assert.equal(ok.ok, true);
  rejectedWith(
    call("trader", "FILL", fill({ taker: testAccounts.taker.address })),
    "TAKER_NOT_ALLOWED",
  );
  rejectedWith(
    call("trader", "FILL", fill({ maker: testAccounts.keeper.address })),
    "MAKER_NOT_ALLOWED",
  );
  rejectedWith(
    call("trader", "FILL", { ...fill(), to: testToken }),
    "TARGET_NOT_ALLOWED",
  );
  rejectedWith(
    call("trader", "FILL", {
      ...fill(),
      args: [fill().args[0], "0x1234"],
    }),
    "PAYLOAD_INVALID",
  );
  rejectedWith(
    call("trader", "FILL", { ...fill(), args: [{ marketId: "1" }, signature] }),
    "PAYLOAD_INVALID",
  );

  assert.equal(
    call("trader", "REDEEM", {
      to: testMarket,
      functionName: "redeem",
      args: ["3"],
    }).ok,
    true,
  );
  for (const functionName of [
    "mint",
    "finalizeTimeout",
    "transferFrom",
    "cancelQuote",
  ])
    rejectedWith(
      call("trader", "REDEEM", { to: testMarket, functionName, args: ["3"] }),
      "SELECTOR_NOT_ALLOWED",
    );
});

test("raw calldata, value and unknown keys never reach the signer", () => {
  const base = { to: testMarket, functionName: "redeem", args: ["3"] };
  for (const payload of [
    { ...base, data: "0xdeadbeef" },
    { ...base, calldata: "0xdeadbeef" },
    { ...base, value: "1" },
    { ...base, from: testAccounts.admin.address },
    { to: testMarket, functionName: "redeem" },
    { ...base, args: [] },
    { ...base, args: ["3", "4"] },
    { ...base, args: ["0"] },
    { ...base, args: ["-1"] },
    { ...base, args: [3] },
    { ...base, to: "0x1234" },
    "redeem",
    null,
    [],
  ])
    rejectedWith(call("trader", "REDEEM", payload), "PAYLOAD_INVALID");
  // A role cannot act under another role's intent kind.
  rejectedWith(call("keeper", "REDEEM", base), "INTENT_MISMATCH");
  rejectedWith(call("maker", "REDEEM", base), "INTENT_MISMATCH");
  assert.equal(intentRole("MAKER_QUOTE"), "maker");
  assert.equal(intentRole("MINT"), "faucet");
});

test("replacement payloads carry exactly the two fee fields", () => {
  const base = { to: testMarket, functionName: "redeem", args: ["3"] };
  assert.deepEqual(parseTransactionPayload(base, false)?.fees, null);
  const fees = { maxFeePerGas: "1125", maxPriorityFeePerGas: "113" };
  assert.deepEqual(parseTransactionPayload({ ...base, ...fees }, true)?.fees, {
    maxFeePerGas: 1125n,
    maxPriorityFeePerGas: 113n,
  });
  assert.equal(parseTransactionPayload({ ...base, ...fees }, false), null);
  assert.equal(parseTransactionPayload(base, true), null);
  assert.equal(
    parseTransactionPayload({ ...base, maxFeePerGas: "1" }, true),
    null,
  );
  // Field presence is what counts: a zero tip is a valid EIP-1559 field.
  assert.deepEqual(
    parseTransactionPayload(
      { ...base, maxFeePerGas: "5", maxPriorityFeePerGas: "0" },
      true,
    )?.fees,
    { maxFeePerGas: 5n, maxPriorityFeePerGas: 0n },
  );
  assert.equal(
    parseTransactionPayload(
      { ...base, maxFeePerGas: "-1", maxPriorityFeePerGas: "0" },
      true,
    ),
    null,
  );
  assert.equal(
    replacementFeesAccepted(
      { maxFeePerGas: 5n, maxPriorityFeePerGas: 0n },
      { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
    ),
    false,
    "zero fees are not a replacement",
  );
});

test("a replacement must raise both fee fields by at least 12.5 percent", () => {
  const prev = { maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n };
  assert.equal(
    replacementFeesAccepted(prev, {
      maxFeePerGas: 1125n,
      maxPriorityFeePerGas: 113n,
    }),
    true,
  );
  assert.equal(
    replacementFeesAccepted(prev, {
      maxFeePerGas: 1124n,
      maxPriorityFeePerGas: 113n,
    }),
    false,
    "max fee below +12.5%",
  );
  assert.equal(
    replacementFeesAccepted(prev, {
      maxFeePerGas: 1125n,
      maxPriorityFeePerGas: 112n,
    }),
    false,
    "priority fee below +12.5%",
  );
  assert.equal(replacementFeesAccepted(prev, prev), false);
  assert.equal(
    replacementFeesAccepted(prev, {
      maxFeePerGas: 5000n,
      maxPriorityFeePerGas: 99n,
    }),
    false,
    "lowering one field is never allowed",
  );
});

test("a zero-tip transaction is replaced with the 1 gwei minimum tip, and the fee cap still rises 12.5 percent", () => {
  assert.equal(minReplacementTipWei, 1_000_000_000n);
  // Non-zero tips are bumped by 12.5 percent, rounded up.
  assert.deepEqual(
    minimumReplacementFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 100n }),
    { maxFeePerGas: 1125n, maxPriorityFeePerGas: 113n },
  );
  // A zero tip becomes the minimum tip; the cap never drops below the tip.
  assert.deepEqual(
    minimumReplacementFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 0n }),
    { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  );
  assert.deepEqual(
    minimumReplacementFees({
      maxFeePerGas: 4_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    { maxFeePerGas: 4_500_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  );
  assert.deepEqual(
    minimumReplacementFees({ maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }),
    { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n },
  );
  // The signer accepts exactly what the dispatcher asks for, and anything higher; nothing lower.
  const prev = { maxFeePerGas: 4_000_000_000n, maxPriorityFeePerGas: 0n };
  const min = minimumReplacementFees(prev);
  assert.equal(replacementFeesAccepted(prev, min), true);
  assert.equal(
    replacementFeesAccepted(prev, {
      ...min,
      maxPriorityFeePerGas: min.maxPriorityFeePerGas + 1n,
    }),
    true,
  );
  assert.equal(
    replacementFeesAccepted(prev, { ...min, maxPriorityFeePerGas: 0n }),
    false,
    "a zero tip stays zero",
  );
  assert.equal(
    replacementFeesAccepted(prev, {
      ...min,
      maxPriorityFeePerGas: min.maxPriorityFeePerGas - 1n,
    }),
    false,
  );
  assert.equal(
    replacementFeesAccepted(prev, {
      ...min,
      maxFeePerGas: min.maxFeePerGas - 1n,
    }),
    false,
    "fee cap below +12.5%",
  );
  assert.equal(
    replacementFeesAccepted(
      { maxFeePerGas: 1000n, maxPriorityFeePerGas: 0n },
      { maxFeePerGas: 1125n, maxPriorityFeePerGas: 1_000_000_000n },
    ),
    false,
    "a fee cap below the tip is not a valid transaction",
  );
});

test("gas arithmetic and caps follow the brief", () => {
  assert.equal(gasLimitFor(100_000n), 120_000n);
  assert.equal(gasLimitFor(1n), 1n);
  assert.equal(maxFeePerGas(3n, 1n), 7n);
  assert.equal(signingLimits.perTxCapWei, 200_000_000_000_000n);
  assert.equal(signingLimits.dailyCapWei, 2_000_000_000_000_000n);
  const caps = { perTxCapWei: 1000n, dailyCapWei: 5000n };
  const check = (maxCost: bigint, reservedWei = 0n, spentWei = 0n) =>
    checkGasCaps({ maxCost, reservedWei, spentWei, ...caps });
  assert.equal(check(1000n), null);
  assert.equal(check(1001n), "GAS_CAP_EXCEEDED");
  assert.equal(check(1000n, 3000n, 1000n), null);
  assert.equal(check(1000n, 3000n, 1001n), "GAS_DAILY_CAP_EXCEEDED");
  assert.equal(check(1000n, 4001n), "GAS_DAILY_CAP_EXCEEDED");
  assert.equal(
    check(1001n, 4001n),
    "GAS_CAP_EXCEEDED",
    "per-tx cap is checked first",
  );
});

test("canonicalJson is order independent and rejects non-JSON values", () => {
  assert.equal(
    canonicalJson({ b: [1, { d: "x", c: null }], a: true }),
    canonicalJson({ a: true, b: [1, { c: null, d: "x" }] }),
  );
  assert.equal(canonicalJson({ a: 1 }), '{"a":1}');
  assert.throws(() => canonicalJson({ a: 1n }), /CANONICAL_JSON_UNSUPPORTED/);
  assert.throws(
    () => canonicalJson({ a: undefined }),
    /CANONICAL_JSON_UNSUPPORTED/,
  );
});
