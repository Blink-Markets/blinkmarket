import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApi } from "../apps/api/src/server.js";
import { jobs } from "../apps/worker/src/registry.js";
import {
  MarketSpec,
  Quote,
  quoteTypes,
} from "../packages/schemas/src/index.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

test("scaffold never advertises deployment or transaction readiness", async () => {
  const app = buildApi();
  app.log.level = "silent";
  try {
    assert.equal((await app.inject("/health/live")).statusCode, 200);
    assert.equal((await app.inject("/health/ready")).statusCode, 503);
    const config = (await app.inject("/v1/config")).json();
    assert.equal(config.chainId, 84532);
    assert.equal(config.deployment, null);
    assert.equal(config.tradingEnabled, false);
    const write = await app.inject({
      method: "POST",
      url: "/v1/rfqs",
      headers: { "idempotency-key": "smoke" },
      payload: { marketId: "1", side: "YES", quantity: "10" },
    });
    // Without the relay wired in, a valid RFQ is refused as not implemented, never accepted.
    assert.ok(write.statusCode >= 400, String(write.statusCode));
    assert.equal(write.statusCode === 201, false);
    const openapi = (await app.inject("/openapi.json")).json();
    for (const path of ["/v1/quotes/{quoteId}", "/v1/faucet/claims"])
      assert.equal(openapi.paths[path], undefined);
    assert.equal(openapi.paths["/v1/rfqs"].post["x-status"], "not-implemented");
    assert.equal(
      openapi.paths["/v1/markets/{id}"].get["x-status"],
      "not-implemented",
    );
  } finally {
    await app.close();
  }
});
test("schemas enforce integer wire amounts and isolate LIVE challenge periods", () => {
  const spec = JSON.parse(
    readFileSync("fixtures/replay/market-spec.json", "utf8"),
  );
  assert.equal(MarketSpec.safeParse(spec).success, true);
  assert.equal(MarketSpec.safeParse({ ...spec, mode: "LIVE" }).success, false);
  assert.equal(
    MarketSpec.safeParse({ ...spec, hardDeadline: spec.proposalDeadline })
      .success,
    false,
  );
  const quote = {
    marketId: "1",
    specHash: "0x" + "1".repeat(64),
    maker: "0x" + "2".repeat(40),
    taker: "0x" + "3".repeat(40),
    side: "0",
    quantity: "10",
    priceBps: "6200",
    validAfter: "100",
    expiresAt: "130",
    nonce: "1",
    epoch: "0",
  };
  assert.equal(Quote.safeParse(quote).success, true);
  assert.equal(Quote.safeParse({ ...quote, quantity: 10 }).success, false);
  assert.equal(
    Quote.safeParse({ ...quote, nonce: (2n ** 256n).toString() }).success,
    false,
  );
  assert.equal(Quote.safeParse({ ...quote, expiresAt: "161" }).success, false);
});
test("EIP-712 field order and types match the Solidity interface", () => {
  const source = readFileSync(
    "contracts/src/protocol/interfaces/IBlinkMarkets.sol",
    "utf8",
  );
  const body = source.match(/struct Quote\s*\{([^}]+)\}/)?.[1];
  assert.ok(body);
  const fields = [...body.matchAll(/(\w+)\s+(\w+)\s*;/g)].map((m) => ({
    name: m[2],
    type: m[1],
  }));
  assert.deepEqual(fields, quoteTypes.Quote);
});

test("platform has no signer workspace", () => {
  assert.equal(existsSync("apps/signer"), false);
  const deleted =
    /(?:^|[/@-])(?:signer(?:[-/.]|$)|signing(?:[-/.]|$)|tx-dispatcher(?:[/.]|$)|keeper(?:[-/.]|$)|faucet(?:[-/.]|$)|trader(?:[-/.]|$)|quote-reconcile(?:[/.]|$)|trading-store(?:[/.]|$))/;
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "out"].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          const specifier =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) &&
                  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    node.expression.getText(source) === "require")
                ? node.arguments[0]
                : undefined;
          if (specifier && ts.isStringLiteralLike(specifier))
            assert.equal(
              deleted.test(specifier.text),
              false,
              `${path}: ${specifier.text}`,
            );
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  for (const root of ["apps", "packages"]) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      const manifest = join(directory, "package.json");
      if (existsSync(manifest))
        assert.notEqual(
          JSON.parse(readFileSync(manifest, "utf8")).name,
          "@blink/signer",
        );
      const source = root === "apps" ? directory : join(directory, "src");
      if (existsSync(source)) scan(source);
    }
  }
});

test("platform runs no research or approval roles", () => {
  // Module specifiers that point at a retired research, approval or creation-tracking module.
  const retiredModule =
    /(?:^|[/@-])(?:discovery|approval|creation-poller)(?:[-/.]|$)/;
  const retiredIdentifier = /^(?:FORECASTER_A|FORECASTER_B|BASELINE)$/;
  const retiredJobType = /^(?:discovery\.|research\.forecast|candidate\.|market\.deploy)/;
  function scan(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", "out"].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, "utf8"),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          const specifier =
            ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
              ? node.moduleSpecifier
              : ts.isCallExpression(node) &&
                  (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                    node.expression.getText(source) === "require")
                ? node.arguments[0]
                : undefined;
          if (specifier && ts.isStringLiteralLike(specifier))
            assert.equal(
              retiredModule.test(specifier.text),
              false,
              `${path}: ${specifier.text}`,
            );
          if (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
            assert.equal(
              retiredIdentifier.test(node.text),
              false,
              `${path}: ${node.text}`,
            );
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  for (const root of ["apps", "packages"]) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source =
        root === "apps" ? join(root, entry.name) : join(root, entry.name, "src");
      if (existsSync(source)) scan(source);
    }
  }
  for (const type of jobs)
    assert.equal(retiredJobType.test(type), false, `job type ${type}`);
});
