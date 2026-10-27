import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import { createContext, type AgentContext, type AgentEnv } from "../../examples/agents/src/lib/env.ts";
import { createLogger } from "../../examples/agents/src/lib/log.ts";
import { runAgent } from "../../examples/agents/src/lib/loop.ts";
import type { Model } from "../../examples/agents/src/lib/model.ts";
import { onboard } from "../../examples/agents/src/lib/session.ts";
import { createTrader, type TraderOptions } from "../../examples/agents/src/roles/trader.ts";

export type TraderRun = {
  marketId: string;
  digest: string;
  /** Empty when the fill landed but this process lost its hash. */
  fillTxHash: string;
  redeemTxHash: string;
  finalOutcome: string;
  payoutMicros: string;
};

/** The trader asks its model nothing; this one answers null to everything. */
const silentModel: Model = {
  questions: async () => [],
  fromSuggestion: async () => null,
  probabilityBps: async () => null,
  outcome: async () => null,
  creationObjection: async () => null,
  appeal: async () => false,
};

/**
 * Drives the reference trader the way `main.ts` does (onboard, then the loop with the trader's
 * tick) until it has filled one market and redeemed it, and returns what it logged. The first
 * `tick_error` fails the run, as an agent that stopped did before the trader became a tick.
 */
export async function runTrader(config: {
  apiUrl: string;
  privateKey: Hex;
  rpcUrl: string;
  pollMs: number;
  trader?: TraderOptions;
  /** Receives every JSON log line. */
  log?: (line: string) => void;
  /**
   * An existing state directory, as a restarted process would be given; it is kept. Without one
   * the run uses a fresh directory and removes it.
   */
  stateDir?: string;
  /** Called with the onboarded context before the first tick, for a test to wrap parts of it. */
  prepare?: (ctx: AgentContext) => void;
}): Promise<TraderRun> {
  const stateDir = config.stateDir ?? (await mkdtemp(join(tmpdir(), "blink-trader-")));
  const stop = new AbortController();
  let loop: Promise<void> = Promise.resolve();
  try {
    return await new Promise<TraderRun>((resolve, reject) => {
      const seen: Record<string, Record<string, unknown>> = {};
      const log = createLogger("trader", [config.privateKey], (line) => {
        config.log?.(line);
        const entry = JSON.parse(line) as Record<string, unknown>;
        const event = String(entry.event);
        seen[event] = entry;
        if (event === "tick_error") reject(new Error(`trader tick failed: ${String(entry.code)}`));
        if (event === "redeemed")
          resolve({
            marketId: String(entry.marketId),
            digest: String(seen.filled?.digest),
            fillTxHash: String(seen.filled?.txHash),
            redeemTxHash: String(entry.txHash),
            finalOutcome: String(entry.finalOutcome),
            payoutMicros: String(entry.payoutMicros),
          });
      });
      const env: AgentEnv = {
        name: "trader",
        roles: ["trader"],
        apiUrl: config.apiUrl,
        rpcUrl: config.rpcUrl,
        key: config.privateKey,
        worldPath: "",
        stateDir,
      };
      loop = (async () => {
        const ctx = await createContext(env, {
          model: silentModel,
          log,
          pollingIntervalMs: config.pollMs,
        });
        await onboard(ctx);
        config.prepare?.(ctx);
        await runAgent(ctx, [createTrader({ pollMs: config.pollMs, ...config.trader })], {
          tickMs: config.pollMs,
          signal: stop.signal,
        });
      })().catch(reject);
    });
  } finally {
    stop.abort();
    await loop.catch(() => undefined);
    if (config.stateDir === undefined) await rm(stateDir, { recursive: true, force: true });
  }
}
