import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData } from "viem";
import { opsStatusCommand } from "../scripts/ops-status.js";
import { blinkMarketAbi } from "../packages/adapters/src/blink-abi.js";
import { testManifest } from "./helpers/signer-fixture.js";

test("pause CLI prints unsigned ADMIN drafts and only makes authenticated GETs", async () => {
  const manifest = testManifest({ deploymentId: "ops-test" });
  const calls: string[] = [];
  const request = async (url: string, init: RequestInit) => {
    assert.equal(init.method, "GET");
    assert.equal(
      (init.headers as Record<string, string>).authorization,
      "Bearer test-admin-key",
    );
    calls.push(new URL(url).pathname);
    return new Response(
      JSON.stringify(
        new URL(url).pathname === "/v1/config"
          ? {
              chainId: 84532,
              deployment: {
                deploymentId: manifest.deploymentId,
                chainId: manifest.chainId,
                deploymentBlock: manifest.deploymentBlock,
                contracts: manifest.contracts,
                artifacts: {
                  abiHashes: manifest.artifacts.abiHashes,
                  bytecodeHashes: manifest.artifacts.bytecodeHashes,
                },
                roles: manifest.roles,
                parameters: manifest.parameters,
              },
            }
          : {
              deploymentId: "ops-test",
              globalPaused: false,
              markets: [],
              health: {
                status: "not-ready",
                tradingEnabled: false,
                reasons: ["INDEXER_LAG"],
              },
            },
      ),
      { status: 200 },
    );
  };
  for (const [args, name, expected] of [
    [["--pause"], "setGlobalTradingPaused", [true]],
    [["--unpause"], "setGlobalTradingPaused", [false]],
    [["--pause", "--market", "7"], "setMarketTradingPaused", [7n, true]],
    [["--unpause", "--market", "7"], "setMarketTradingPaused", [7n, false]],
  ] as const) {
    const draft = JSON.parse(
      await opsStatusCommand([...args], {
        apiUrl: "http://127.0.0.1:3001",
        adminKey: "test-admin-key",
        request,
      }),
    );
    assert.equal(draft.chainId, 84532);
    assert.equal(draft.requiredSender, manifest.roles.admin);
    assert.equal(draft.to, manifest.contracts.BlinkMarket);
    assert.equal(draft.value, "0");
    const decoded = decodeFunctionData({
      abi: blinkMarketAbi,
      data: draft.data,
    });
    assert.equal(decoded.functionName, name);
    assert.deepEqual(decoded.args, expected);
  }
  assert.deepEqual([...new Set(calls)].sort(), [
    "/v1/admin/pause",
    "/v1/config",
  ]);
  await assert.rejects(
    opsStatusCommand(["--pause"], {
      apiUrl: "http://127.0.0.1",
      adminKey: "test-admin-key",
      request: async (url, init) => {
        const response = await request(url, init);
        if (new URL(url).pathname === "/v1/admin/pause") {
          const body = await response.json();
          body.deploymentId = "different";
          return new Response(JSON.stringify(body));
        }
        return response;
      },
    }),
    /DEPLOYMENT_MISMATCH/,
  );
  await assert.rejects(
    opsStatusCommand(["--pause", "--unpause"], {
      apiUrl: "http://127.0.0.1",
      adminKey: "test-admin-key",
      request,
    }),
    /INVALID_ARGUMENTS/,
  );
  await assert.rejects(
    opsStatusCommand(["--pause"], {
      apiUrl: "http://127.0.0.1",
      adminKey: "test-admin-key",
      request: async () => new Response(JSON.stringify({ chainId: 8453 })),
    }),
    /MAINNET_REFUSED/,
  );
});

test("status CLI fails closed when its API cannot supply status", async () => {
  await assert.rejects(
    opsStatusCommand([], {
      apiUrl: "http://127.0.0.1",
      adminKey: "test-admin-key",
      request: async () => new Response("private error", { status: 503 }),
    }),
    /OPS_STATUS_REQUEST_FAILED/,
  );
});

test("status summary says when a list shows only the newest 100 rows", async () => {
  const run = (truncated: boolean) =>
    opsStatusCommand([], {
      apiUrl: "http://127.0.0.1:3001",
      adminKey: "test-admin-key",
      request: async (url) => {
        const path = new URL(url).pathname;
        const list = { items: [], truncated };
        const body =
          path === "/v1/admin/budgets"
            ? {
                daily: {
                  day: "2026-01-01",
                  capUsdMicros: "1",
                  spentUsdMicros: "0",
                  reservedUsdMicros: "0",
                  unknownUsdMicros: "0",
                },
              }
            : path === "/v1/admin/pause"
              ? {
                  deploymentId: "ops-test",
                  globalPaused: false,
                  markets: [],
                  health: {
                    status: "not-ready",
                    tradingEnabled: false,
                    reasons: [],
                  },
                }
              : list;
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
  const more = await run(true);
  assert.equal(more.match(/showing 100 newest of more/g)?.length, 3);
  assert.doesNotMatch(more, /first 100/);
  assert.doesNotMatch(await run(false), /showing 100 newest of more/);
});
