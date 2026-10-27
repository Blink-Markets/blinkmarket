import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bytesToHex } from "viem";
import { BlinkApiError, createBlinkClient } from "../../packages/client/src/index.ts";
import { createContext, type AgentEnv } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import type { Model } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { startAlphaPlatform } from "../../scripts/alpha/platform.ts";

const silentModel: Model = {
  questions: async () => [],
  fromSuggestion: async () => null,
  probabilityBps: async () => null,
  outcome: async () => null,
  creationObjection: async () => null,
  appeal: async () => false,
};

test(
  "the pglite platform serves an agent that onboards itself, and onboarding can be run again",
  { timeout: 240_000 },
  async () => {
    const platform = await startAlphaPlatform({ backend: "pglite" });
    const stateDir = await mkdtemp(join(tmpdir(), "blink-agent-state-"));
    try {
      assert.equal(platform.deploymentId, "local-alpha");
      assert.match(platform.apiUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(platform.rpcUrl, platform.anvil.url);
      const anonymous = createBlinkClient(platform.apiUrl);
      assert.equal((await anonymous.getDeployment()).deployment.chainId, 84532);

      const key = bytesToHex(platform.accounts.maker.getHdKey().privateKey!);
      const env: AgentEnv = {
        name: "maker-1",
        roles: ["maker"],
        apiUrl: platform.apiUrl,
        rpcUrl: platform.rpcUrl,
        key,
        worldPath: "",
        stateDir,
      };
      const start = async () => {
        const lines: { event: string; [field: string]: unknown }[] = [];
        const log = createLogger(env.name, [key], (line) => lines.push(JSON.parse(line)));
        const ctx = await createContext(env, { model: silentModel, log, pollingIntervalMs: 100 });
        await onboard(ctx);
        return { ctx, lines };
      };

      // First run: faucet, registration, the MAKER role and an API key that the platform accepts.
      const first = await start();
      const events = first.lines.map((l) => l.event);
      assert.deepEqual(
        events.filter((e) => e !== "api_key_issued"),
        ["faucet_claimed", "registered", "joined_role"],
      );
      assert.equal((await first.ctx.client.listRfqs()).items.length, 0);

      // Second run: nothing on chain is repeated, a new key replaces the old one and the old one is dead.
      const second = await start();
      assert.deepEqual(
        second.lines.map((l) => l.event),
        ["api_key_issued", "api_key_revoked"],
      );
      assert.equal((await second.ctx.client.listRfqs()).items.length, 0);
      await assert.rejects(
        first.ctx.client.listRfqs(),
        (error) => error instanceof BlinkApiError && error.status === 401,
      );
      assert.ok(!JSON.stringify([...first.lines, ...second.lines]).includes(key.slice(2)));
    } finally {
      await rm(stateDir, { recursive: true, force: true });
      await platform.stop();
    }
  },
);
