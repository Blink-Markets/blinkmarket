import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOpenApi } from "../packages/schemas/src/index.js";
import { indexOpenApi, groupOf, groupOperations } from "../apps/web/content/openapi-index.ts";

test("indexes every path and method from the shared contracts", () => {
  const doc = generateOpenApi();
  const expected = Object.values(doc.paths).reduce((n, item) => n + Object.keys(item).length, 0);
  const ops = indexOpenApi(doc);
  assert.equal(ops.length, expected);
  for (const op of ops) {
    assert.match(op.method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.ok(op.path.startsWith("/"));
  }
  const markets = ops.find((o) => o.method === "GET" && o.path === "/v1/markets");
  assert.ok(markets);
  assert.equal(markets.status, "not-implemented");
  assert.equal(markets.group, "markets");
});

test("indexes operations missing vendor extensions", () => {
  const ops = indexOpenApi({ paths: { "/v1/config": { get: { responses: {} } } } });
  assert.deepEqual(ops, [{ method: "GET", path: "/v1/config", group: "config", status: "unspecified", access: null }]);
});

test("tolerates documents without paths", () => {
  assert.deepEqual(indexOpenApi({}), []);
  assert.deepEqual(indexOpenApi(null), []);
});

test("groups by the first segment after the version", () => {
  assert.equal(groupOf("/v1/admin/candidates/{id}/approve"), "admin");
  assert.equal(groupOf("/v1/markets/{id}/spec"), "markets");
  assert.equal(groupOf("/health"), "health");
  const grouped = groupOperations(indexOpenApi(generateOpenApi()));
  assert.ok(grouped.some((g) => g.group === "markets" && g.operations.length > 1));
});
