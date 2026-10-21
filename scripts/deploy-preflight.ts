import { readFile, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { apiConfig } from "../apps/api/src/config.js";
import {
  alertConfig,
  alertEvaluateConfig,
  executionConfig,
  researchConfig,
  traderConfig,
  workerConfig,
} from "../apps/worker/src/config.js";
import {
  chainIndexerConfig,
  indexerConfig,
} from "../apps/indexer/src/config.js";
import { signerConfig } from "../apps/signer/src/config.js";
import { isClientHttpLoopbackHost } from "../packages/client/src/url-policy.ts";

type Env = Map<string, string>;

function fail(code: string, variable?: string): never {
  console.error(`${code}${variable ? `: ${variable}` : ""}`);
  process.exitCode = 1;
  throw new Error("PREFLIGHT_FAILED");
}

function parseEnv(text: string): Env {
  const env = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) fail("PREFLIGHT_ENV_SYNTAX", `line ${index + 1}`);
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    env.set(match[1]!, value);
  }
  return env;
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  if (isIP(host) === 6) return host === "::1";
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopback(host)) return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return (
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    );
  }
  return isIP(host) === 6 && /^(fc|fd)/i.test(host);
}

function secretLooking(value: string): boolean {
  const privateKey = /(?:0x)?[0-9a-f]{64}\b/i.test(value);
  const mnemonic =
    value.trim().split(/\s+/).length >= 12 && /^[a-z ]+$/i.test(value.trim());
  const credentialUrl = /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value);
  const jwt = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/.test(
    value,
  );
  const awsAccessKey = /\bAKIA[0-9A-Z]{16}\b/.test(value);
  const opaqueToken =
    /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/.test(value);
  const keyLikeUrlValue =
    /https?:\/\/[^\s?#]+(?:\?[^\s#]*)?/i.test(value) &&
    /(?:[?&])(?:api[_-]?key|key|token|access[_-]?token|secret|auth|signature)=([^&#]{8,})/i.test(
      value,
    );
  const keyToken =
    /(?:api[_-]?key|access[_-]?token|secret|password|bearer)\s*[:=]\s*[^\s]{6,}/i.test(
      value,
    );
  const providerToken =
    /\b(?:sk_live_|sk_test_|sk-|ghp_|github_pat_|xox[baprs]-|AIza|eyJ)[A-Za-z0-9_.-]{12,}/.test(
      value,
    );
  return (
    privateKey ||
    mnemonic ||
    credentialUrl ||
    jwt ||
    awsAccessKey ||
    opaqueToken ||
    keyLikeUrlValue ||
    keyToken ||
    providerToken
  );
}

async function main() {
  const file = process.argv[2];
  if (!file) fail("PREFLIGHT_USAGE");
  let source: string;
  try {
    source = await readFile(file!, "utf8");
  } catch {
    fail("PREFLIGHT_ENV_FILE", "<env-file>");
  }
  const env = parseEnv(source!);

  for (const [name, value] of env)
    if (value.includes("<TO BE PROVIDED")) fail("PREFLIGHT_PLACEHOLDER", name);
  const chain = env.get("BLINK_CHAIN_ID");
  if (chain === "8453") fail("MAINNET_REFUSED", "BLINK_CHAIN_ID");
  if (chain !== "84532") fail("PREFLIGHT_CHAIN_ID", "BLINK_CHAIN_ID");
  if (env.has("BLINK_ALLOW_TEST_CLOCK"))
    fail("PREFLIGHT_TEST_CLOCK_FORBIDDEN", "BLINK_ALLOW_TEST_CLOCK");
  if (env.has("DEPLOYER_PRIVATE_KEY"))
    fail("PREFLIGHT_DEPLOYER_KEY_FORBIDDEN", "DEPLOYER_PRIVATE_KEY");
  for (const [name, value] of env)
    if (
      name.startsWith("NEXT_PUBLIC_") &&
      (secretLooking(value) ||
        /(?:^|_)(?:API_?)?KEY|TOKEN|SECRET|PASSWORD|PRIVATE(?:_|$)/i.test(name))
    )
      fail("PREFLIGHT_PUBLIC_SECRET", name);

  const keyNames = [
    "SIGNER_MAKER_KEY_FILE",
    "SIGNER_KEEPER_KEY_FILE",
    "SIGNER_FAUCET_KEY_FILE",
    "SIGNER_TRADER_KEY_FILE",
  ];
  if (
    env.get("SIGNER_ENABLED") === "true" &&
    !keyNames.some((name) => env.get(name)?.trim())
  )
    fail("PREFLIGHT_KEY_FILE_MISSING", "SIGNER_*_KEY_FILE");
  for (const name of keyNames) {
    const value = env.get(name);
    if (!value) continue;
    let mode: number;
    try {
      mode = (await stat(value)).mode & 0o777;
    } catch {
      fail("PREFLIGHT_KEY_FILE_MISSING", name);
    }
    if (mode! !== 0o600) fail("PREFLIGHT_KEY_FILE_MODE", name);
  }

  const signer = env.get("SIGNER_URL");
  if (signer) {
    let parsed: URL;
    try {
      parsed = new URL(signer);
    } catch {
      fail("PREFLIGHT_SIGNER_URL", "SIGNER_URL");
    }
    if (
      !isPrivateHost(parsed!.hostname) ||
      !["http:", "https:"].includes(parsed!.protocol) ||
      parsed!.username ||
      parsed!.password
    )
      fail("PREFLIGHT_SIGNER_URL", "SIGNER_URL");
  }

  const workerApi = env.get("WORKER_API_URL");
  if (workerApi) {
    let parsed: URL;
    try {
      parsed = new URL(workerApi);
    } catch {
      fail("PREFLIGHT_WORKER_API_URL", "WORKER_API_URL");
    }
    if (
      parsed!.username ||
      parsed!.password ||
      !(
        parsed!.protocol === "https:" ||
        (parsed!.protocol === "http:" &&
          isClientHttpLoopbackHost(parsed!.hostname))
      )
    )
      fail("PREFLIGHT_WORKER_API_URL", "WORKER_API_URL");
  }

  const sink = env.get("ALERT_SINK");
  if (!sink || sink === "stdout") fail("PREFLIGHT_ALERT_SINK", "ALERT_SINK");
  if (sink === "file" && !env.get("ALERT_FILE_PATH"))
    fail("PREFLIGHT_ALERT_SINK", "ALERT_FILE_PATH");
  if (sink === "webhook") {
    const raw = env.get("ALERT_WEBHOOK_URL");
    let parsed: URL;
    try {
      parsed = new URL(raw ?? "");
    } catch {
      fail("PREFLIGHT_ALERT_SINK", "ALERT_WEBHOOK_URL");
    }
    if (
      parsed!.username ||
      parsed!.password ||
      parsed!.hash ||
      (parsed!.protocol !== "https:" &&
        !(parsed!.protocol === "http:" && isLoopback(parsed!.hostname)))
    )
      fail("PREFLIGHT_WEBHOOK_HTTPS", "ALERT_WEBHOOK_URL");
  }
  if (sink !== "file" && sink !== "webhook")
    fail("PREFLIGHT_ALERT_SINK", "ALERT_SINK");

  // The API sits behind a private TLS proxy; only that proxy may supply X-Forwarded-For.
  const proxies = env.get("API_TRUSTED_PROXIES")?.trim();
  if (!proxies) fail("PREFLIGHT_API_TRUSTED_PROXIES", "API_TRUSTED_PROXIES");
  for (const entry of proxies!.split(","))
    if (!isPrivateHost(entry.trim().split("/")[0]!))
      fail("PREFLIGHT_API_TRUSTED_PROXIES", "API_TRUSTED_PROXIES");

  // Reuse the production parsers; they are pure config checks and perform no I/O.
  const values = Object.fromEntries(env) as NodeJS.ProcessEnv;
  if (
    values.BLINK_API_MODE !== "trading" ||
    values.WORKER_ENABLED !== "true" ||
    values.CHAIN_INDEXER_ENABLED !== "true" ||
    values.SIGNER_ENABLED !== "true"
  )
    fail("PREFLIGHT_SERVICE_CONFIGURATION");
  try {
    apiConfig(values);
    workerConfig(values);
    researchConfig(values);
    executionConfig(values);
    traderConfig(values);
    alertConfig(values);
    alertEvaluateConfig(values);
    indexerConfig(values);
    chainIndexerConfig(values);
    signerConfig(values);
  } catch {
    fail("PREFLIGHT_SERVICE_CONFIGURATION");
  }
  console.log(
    "DEPLOY PREFLIGHT ok: Base Sepolia profile, environment rules passed (offline)",
  );
}

main().catch((error: unknown) => {
  if (!(error instanceof Error) || error.message !== "PREFLIGHT_FAILED") {
    console.error("PREFLIGHT_INTERNAL_ERROR");
    process.exitCode = 1;
  }
});
