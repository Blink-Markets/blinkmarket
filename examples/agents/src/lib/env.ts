import { createBlinkClient } from "@blink/client";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Chain,
  type HttpTransport,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Log } from "./log.ts";
import { createLogger } from "./log.ts";
import type { SourceFetcher } from "./fetcher.ts";
import type { Model } from "./model.ts";
import { loadState, saveState, type AgentState } from "./state.ts";

export const CHAIN_ID = 84532;
export const ROLE_NAMES = [
  "creator",
  "maker",
  "trader",
  "forecaster",
  "proposer",
  "challenger",
  "juror",
  "keeper",
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

/** The longest the forecaster goes without an analysis when no source changed: 14 days. */
export const DEFAULT_HEARTBEAT_HOURS = 336;
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

/** What an agent process is given: its name and roles, its key, two URLs, a world file and a state directory. */
export type AgentEnv = {
  name: string;
  roles: RoleName[];
  apiUrl: string;
  rpcUrl: string;
  /** Never logged. */
  key: Hex;
  worldPath: string;
  stateDir: string;
  /**
   * BLINK_FORECAST_HEARTBEAT_HOURS in seconds: an analysis runs when the last one is older than
   * this, even if no source changed. Always set by `loadAgentEnv`; 14 days when absent.
   */
  heartbeatSeconds?: number;
};

export type BlinkClient = ReturnType<typeof createBlinkClient>;
export type AgentDeployment = Awaited<ReturnType<BlinkClient["getDeployment"]>>["deployment"];

/** The saved state and the way to save it, so a role writes with one call. */
export type StateHandle = { readonly data: AgentState; save(): Promise<void> };

export type AgentContext = {
  name: string;
  roles: RoleName[];
  apiUrl: string;
  /** Anonymous until `onboard` has an API key; `onboard` then replaces it. */
  client: BlinkClient;
  publicClient: PublicClient<HttpTransport, Chain>;
  /** Any viem local account: a private key, or a custody service that signs (a CDP server wallet). */
  walletClient: WalletClient<HttpTransport, Chain, LocalAccount>;
  account: LocalAccount;
  /** The generation the API serves; nothing is read from a file. */
  deployment: AgentDeployment;
  model: Model;
  /** How a role reads a source page. There is no default: whoever builds the context chooses (see fetcher.ts). */
  fetcher: SourceFetcher;
  /** The forecaster's staleness limit, in seconds (see `AgentEnv.heartbeatSeconds`). */
  heartbeatSeconds: number;
  /** Where the state file lives; the forecaster keeps its archived source bytes beside it. */
  stateDir: string;
  state: StateHandle;
  log: Log;
};

/**
 * Reads the agent's environment. Rejects with `MISSING_ENV:<name>` for a missing variable,
 * `INVALID_ENV:<name>` for a malformed one (the value is never part of the message; the optional
 * `BLINK_FORECAST_HEARTBEAT_HOURS` must be a finite number of hours above zero), and
 * `WRONG_CHAIN` unless the node's `eth_chainId` is 84532. As in every Blink example, the key is
 * only ever sent to a node on this machine.
 */
export async function loadAgentEnv(env: Record<string, string | undefined>): Promise<AgentEnv> {
  const need = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`MISSING_ENV:${name}`);
    return value;
  };
  const name = need("BLINK_AGENT_NAME");
  const rolesRaw = need("BLINK_AGENT_ROLES");
  const apiUrl = need("BLINK_API_URL");
  const rpcUrl = need("BLINK_RPC_URL");
  const key = need("BLINK_AGENT_KEY");
  const worldPath = need("BLINK_WORLD");
  const stateDir = need("BLINK_AGENT_STATE_DIR");
  if (!NAME_PATTERN.test(name)) throw new Error("INVALID_ENV:BLINK_AGENT_NAME");
  const roles = rolesRaw.split(",").map((r) => r.trim());
  if (roles.some((r) => !ROLE_NAMES.includes(r as RoleName)))
    throw new Error("INVALID_ENV:BLINK_AGENT_ROLES");
  if (!KEY_PATTERN.test(key)) throw new Error("INVALID_ENV:BLINK_AGENT_KEY");
  const heartbeatRaw = env["BLINK_FORECAST_HEARTBEAT_HOURS"]?.trim();
  let heartbeatHours = DEFAULT_HEARTBEAT_HOURS;
  if (heartbeatRaw) {
    // Plain decimal digits only: no sign, exponent, hex or "Infinity", and the value must be above zero.
    heartbeatHours = /^(\d+\.?\d*|\.\d+)$/.test(heartbeatRaw) ? Number(heartbeatRaw) : Number.NaN;
    if (!Number.isFinite(heartbeatHours) || heartbeatHours <= 0)
      throw new Error("INVALID_ENV:BLINK_FORECAST_HEARTBEAT_HOURS");
  }
  let rpcHost: string;
  try {
    rpcHost = new URL(rpcUrl).hostname;
    createBlinkClient(apiUrl);
  } catch {
    throw new Error("INVALID_ENV:BLINK_RPC_URL or BLINK_API_URL");
  }
  if (!LOOPBACK.includes(rpcHost)) throw new Error("RPC_NOT_LOOPBACK");
  let chainId: number;
  try {
    chainId = await createPublicClient({ transport: http(rpcUrl, { retryCount: 0 }) }).getChainId();
  } catch {
    throw new Error("RPC_UNREACHABLE");
  }
  if (chainId !== CHAIN_ID) throw new Error("WRONG_CHAIN");
  return {
    name,
    roles: roles as RoleName[],
    apiUrl,
    rpcUrl,
    key: key as Hex,
    worldPath,
    stateDir,
    heartbeatSeconds: heartbeatHours * 3600,
  };
}

/**
 * The chain clients, the saved state and the generation the API serves. The API client is
 * anonymous until `onboard`. The process may only hold this key against chain 84532.
 */
export async function createContext(
  env: AgentEnv,
  options: { model: Model; fetcher: SourceFetcher; heartbeatSeconds?: number; log?: Log; pollingIntervalMs?: number },
): Promise<AgentContext> {
  const log = options.log ?? createLogger(env.name, [env.key]);
  log.redact(env.key);
  const chain = defineChain({
    id: CHAIN_ID,
    name: "Blink local",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [env.rpcUrl] } },
  });
  const account = privateKeyToAccount(env.key);
  const client = createBlinkClient(env.apiUrl);
  const { deployment } = await client.getDeployment();
  if (deployment.chainId !== CHAIN_ID) throw new Error("DEPLOYMENT_CHAIN_MISMATCH");
  const data = await loadState(env.stateDir);
  return {
    name: env.name,
    roles: env.roles,
    apiUrl: env.apiUrl,
    client,
    publicClient: createPublicClient({
      chain,
      transport: http(env.rpcUrl, { retryCount: 0 }),
      pollingInterval: options.pollingIntervalMs ?? 1000,
      cacheTime: 0,
    }),
    walletClient: createWalletClient({
      account,
      chain,
      transport: http(env.rpcUrl, { retryCount: 0 }),
    }),
    account,
    deployment,
    model: options.model,
    fetcher: options.fetcher,
    heartbeatSeconds: options.heartbeatSeconds ?? env.heartbeatSeconds ?? DEFAULT_HEARTBEAT_HOURS * 3600,
    stateDir: env.stateDir,
    state: { data, save: () => saveState(env.stateDir, data) },
    log,
  };
}
