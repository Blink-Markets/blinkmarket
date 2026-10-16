import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { encodeFunctionData } from "viem";
import {
  AdminCandidatesResponse,
  AdminJobsResponse,
  AdminBudgetsResponse,
  AdminPauseResponse,
  AdminResolutionsResponse,
  PublicDeployment,
  PositiveUint256,
} from "../packages/schemas/src/index.ts";
import { blinkMarketAbi } from "../packages/adapters/src/blink-abi.js";

type Options = {
  apiUrl: string;
  adminKey: string;
  request?: (url: string, init: RequestInit) => Promise<Response>;
};
const shown = (list: { truncated: boolean }) =>
  list.truncated ? "showing 100 newest of more" : "all";
export async function opsStatusCommand(
  args: string[],
  options: Options,
): Promise<string> {
  const { values } = parseArgs({
    args,
    options: {
      pause: { type: "boolean" },
      unpause: { type: "boolean" },
      market: { type: "string" },
    },
  });
  const drafting = values.pause || values.unpause;
  if ((values.pause && values.unpause) || (values.market && !drafting))
    throw new Error("INVALID_ARGUMENTS");
  const marketId = values.market
    ? PositiveUint256.parse(values.market)
    : undefined;
  const origin = new URL(options.apiUrl);
  if (
    !options.adminKey ||
    origin.username ||
    origin.password ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("INVALID_CONFIGURATION");
  const request = options.request ?? fetch;
  async function get(path: string): Promise<unknown> {
    const response = await request(new URL(path, origin).href, {
      method: "GET",
      headers: { authorization: "Bearer " + options.adminKey },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("OPS_STATUS_REQUEST_FAILED");
    return response.json();
  }
  if (drafting) {
    const raw = await get("/v1/config");
    if (!raw || typeof raw !== "object" || !("chainId" in raw))
      throw new Error("INVALID_CONFIGURATION");
    const config = raw;
    if (config.chainId === 8453) throw new Error("MAINNET_REFUSED");
    if (config.chainId !== 84532) throw new Error("CHAIN_ID_MISMATCH");
    if (!("deployment" in config)) throw new Error("INVALID_CONFIGURATION");
    if (
      config.deployment &&
      typeof config.deployment === "object" &&
      "chainId" in config.deployment &&
      config.deployment.chainId === 8453
    )
      throw new Error("MAINNET_REFUSED");
    const deployment = PublicDeployment.parse(config.deployment);
    // Authenticate before printing a draft; no transaction is ever submitted.
    const pause = AdminPauseResponse.parse(await get("/v1/admin/pause"));
    if (pause.deploymentId !== deployment.deploymentId)
      throw new Error("DEPLOYMENT_MISMATCH");
    const paused = Boolean(values.pause);
    return JSON.stringify(
      {
        chainId: 84532,
        to: deployment.contracts.BlinkMarket,
        requiredSender: deployment.roles.admin,
        value: "0",
        data: marketId
          ? encodeFunctionData({
              abi: blinkMarketAbi,
              functionName: "setMarketTradingPaused",
              args: [BigInt(marketId), paused],
            })
          : encodeFunctionData({
              abi: blinkMarketAbi,
              functionName: "setGlobalTradingPaused",
              args: [paused],
            }),
        warnings: [
          "UNSIGNED_ADMIN_WALLET_TRANSACTION",
          "INDEXED_STATE_MAY_LAG",
        ],
      },
      null,
      2,
    );
  }
  const [candidates, jobs, budgets, pause, resolutions] = await Promise.all([
    get("/v1/admin/candidates").then((v) => AdminCandidatesResponse.parse(v)),
    get("/v1/admin/jobs?state=DEAD").then((v) => AdminJobsResponse.parse(v)),
    get("/v1/admin/budgets").then((v) => AdminBudgetsResponse.parse(v)),
    get("/v1/admin/pause").then((v) => AdminPauseResponse.parse(v)),
    get("/v1/admin/resolutions").then((v) => AdminResolutionsResponse.parse(v)),
  ]);
  const b = budgets.daily;
  const health = pause.health;
  return [
    `Operator status — ${pause.deploymentId} (Base Sepolia, indexed)`,
    `Health: ${health.status}; reasons: ${health.reasons.join(", ") || "none"}`,
    `Index: ${health.details?.chainIndex.blockNumber ?? "unknown"} / ${health.details?.chainIndex.headNumber ?? "unknown"}; signer: ${health.details?.signerReachable ?? "unknown"}`,
    `Candidates (${shown(candidates)}, own operator): ${candidates.items.length}; approvals: ${candidates.items.filter((c) => c.approval).length}`,
    `Failed jobs (${shown(jobs)}): ${jobs.items.length}; queue: ${health.details?.queue.map((q) => q.name + "=" + q.count).join(", ") ?? "unknown"}`,
    `Budget ${b.day} (USD micros): cap=${b.capUsdMicros}, spent=${b.spentUsdMicros}, reserved=${b.reservedUsdMicros}, unknown=${b.unknownUsdMicros}`,
    `Budget gates: daily=${health.details?.budgetGates.dailyClosed ?? "unknown"}, questions=${health.details?.budgetGates.questionsClosed ?? "unknown"}`,
    `Pause: global=${pause.globalPaused ?? "unknown"}; paused markets=${
      pause.markets
        .filter((m) => m.paused)
        .map((m) => m.marketId)
        .join(",") || "none"
    }`,
    `Resolution queue (${shown(resolutions)}): ${resolutions.items.length}; disputed=${resolutions.items.filter((m) => m.state === "DISPUTED").length}`,
    ...[...resolutions.items]
      .sort((a, b) => Number(BigInt(a.hardDeadline) - BigInt(b.hardDeadline)))
      .slice(0, 5)
      .map(
        (m) =>
          `  Market ${m.marketId}: ${m.state}; challengeEnd=${m.challengeEndsAt ?? "n/a"}; hardDeadline=${m.hardDeadline}; own open reports=${m.openReports}`,
      ),
  ].join("\n");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(
      await opsStatusCommand(process.argv.slice(2), {
        apiUrl: process.env.BLINK_API_URL ?? "http://127.0.0.1:3001",
        adminKey: process.env.BLINK_ADMIN_API_KEY ?? "",
      }),
    );
  } catch (error) {
    console.error(
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "OPS_STATUS_FAILED",
    );
    process.exitCode = 1;
  }
}
