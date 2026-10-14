import { test } from "node:test";
import assert from "node:assert/strict";
import { executionConfig } from "../apps/worker/src/config.js";

test("execution is optional but refuses partial signer/RPC configuration", () => {
  assert.equal(executionConfig({}), null);
  assert.equal(executionConfig({ BLINK_DEPLOYMENT_ID: "fixture" }), null);
  const env = {
    BLINK_DEPLOYMENT_ID: "fixture",
    SIGNER_URL: "http://127.0.0.1:3004",
    WORKER_SIGNER_CALLER_TOKEN: "fixture-token",
    BASE_SEPOLIA_RPC_URL: "http://127.0.0.1:8545",
  };
  assert.deepEqual(executionConfig(env), {
    deploymentId: "fixture",
    signerUrl: env.SIGNER_URL,
    signerToken: env.WORKER_SIGNER_CALLER_TOKEN,
    rpcUrl: env.BASE_SEPOLIA_RPC_URL,
  });
  for (const name of Object.keys(env)) {
    const partial: NodeJS.ProcessEnv = { ...env };
    delete partial[name];
    assert.throws(
      () => executionConfig(partial),
      /WORKER_EXECUTION_CONFIGURATION_INCOMPLETE/,
    );
  }
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { executionChainReader } from "../packages/adapters/src/execution-chain-reader.js";

test("execution RPC refuses mainnet before reads or broadcasts, including a chain change after startup", async () => {
  let chainId = "0x14a34"; // 84532
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      const input = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({ jsonrpc: "2.0", id: input.id, result: chainId }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const reader = executionChainReader({
      url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      marketAddress: "0x" + "11".repeat(20),
    });
    await reader.assertChain();
    chainId = "0x2105"; // 8453
    await assert.rejects(reader.marketState("1"), /MAINNET_REFUSED/);
    let sends = 0;
    const guarded = reader.guardDispatch({
      sendRawTransaction: async () => {
        sends++;
        return { state: "ALREADY_KNOWN" };
      },
      getReceipt: async () => null,
      blockHashAt: async () => null,
      finalizedBlockNumber: async () => null,
    });
    await assert.rejects(guarded.sendRawTransaction("0x11"), /MAINNET_REFUSED/);
    assert.equal(sends, 0);
    chainId = "0x1";
    await assert.rejects(reader.blockTimestamp(1n), /CHAIN_NOT_ALLOWED/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
