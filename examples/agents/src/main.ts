// One reference agent process. It knows only its key, the API URL, the RPC URL, a world file and
// its name; it reaches the platform through the public API, `@blink/client` and the contracts.
//
//   BLINK_AGENT_NAME=trader-1 BLINK_AGENT_ROLES=trader BLINK_API_URL=http://127.0.0.1:3001 \
//   BLINK_RPC_URL=http://127.0.0.1:8545 BLINK_AGENT_KEY=0x... BLINK_WORLD=world.json \
//   BLINK_AGENT_STATE_DIR=./state node --import tsx examples/agents/src/main.ts
//
// SIGTERM (or SIGINT) stops it after the tick that is running.
import { pathToFileURL } from "node:url";
import { createContext, loadAgentEnv, type RoleName } from "./lib/env.ts";
import { createLogger } from "./lib/log.ts";
import { runAgent, type RoleTick } from "./lib/loop.ts";
import { fixtureModel } from "./lib/model.ts";
import { onboard } from "./lib/session.ts";
import { loadWorld } from "./lib/world.ts";
import { trader } from "./roles/trader.ts";

const TICK_MS = 2000;

/** The tick of each role. A role without one here has no reference agent yet and is only onboarded. */
export const ROLE_TICKS: Partial<Record<RoleName, RoleTick>> = { trader };

async function main() {
  const env = await loadAgentEnv(process.env);
  const log = createLogger(env.name, [env.key]);
  const ctx = await createContext(env, {
    model: fixtureModel(await loadWorld(env.worldPath), env.name),
    log,
  });
  await onboard(ctx);
  const ticks = ctx.roles.flatMap((role) => ROLE_TICKS[role] ?? []);
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
  log("started", { roles: ctx.roles, ticks: ticks.length });
  await runAgent(ctx, ticks, { tickMs: TICK_MS, signal: stop.signal });
  log("stopped");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // A code, never the message of an arbitrary error: it could name a secret.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,}(:[A-Za-z0-9_]+)?/.exec(error.message);
    console.error(JSON.stringify({ event: "fatal", code: code ? code[0] : "AGENT_FAILED" }));
    process.exitCode = 1;
  }
}
