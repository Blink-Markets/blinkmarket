// The forecaster. For every open forecast window of an OPEN market where its model has a view, it
// signs the Forecast struct (spec 5.10) with its own wallet and submits it, once per window. The
// platform verifies the signature, seals the answer until the window's deadline and scores it; it
// never signs anything.
import { BlinkApiError, NO_CONTENT_HASH, forecastTypedData } from "@blink/client";
import type { Hex } from "viem";
import type { AgentContext } from "../lib/env.ts";
import type { RoleTick } from "../lib/loop.ts";

/** Window ids already answered (`state.acted`). */
const SUBMITTED = "forecaster.submitted";
/** The API accepts 1..9999; a model that is certain still says so within that range. */
const clampBps = (bps: number) => Math.min(9999, Math.max(1, bps));
/** Refusals after which the window can never take this answer, so it is not tried again. */
const FINAL_REFUSALS = ["FORECAST_ALREADY_SUBMITTED", "FORECAST_WINDOW_CLOSED", "MARKET_CLOSED"];

const actedOn = (ctx: AgentContext, action: string) => (ctx.state.data.acted[action] ??= []);

type Window = Awaited<ReturnType<AgentContext["client"]["listForecastWindows"]>>["items"][number];

async function submit(ctx: AgentContext, marketId: string, window: Window, probabilityBps: number) {
  const { generation, shared } = ctx.deployment;
  const message = {
    forecaster: ctx.account.address,
    markets: generation.markets,
    marketId,
    horizon: window.horizon,
    scheduledAt: window.scheduledAt,
    probabilityBps,
    contentHash: NO_CONTENT_HASH,
  };
  const signature = await ctx.walletClient.signTypedData(forecastTypedData({ anchor: shared.anchor, message }));
  try {
    const receipt = await ctx.client.submitForecast(
      { marketId },
      { horizon: window.horizon, scheduledAt: window.scheduledAt, probabilityBps, contentHash: NO_CONTENT_HASH, signature },
    );
    ctx.log("forecast_submitted", { marketId, windowId: window.windowId, probabilityBps, digest: receipt.digest });
  } catch (error) {
    if (!(error instanceof BlinkApiError && error.status === 409 && FINAL_REFUSALS.includes(error.body.code)))
      throw error;
    ctx.log("forecast_refused", { marketId, windowId: window.windowId, code: error.body.code });
  }
  actedOn(ctx, SUBMITTED).push(window.windowId);
  await ctx.state.save();
}

export const forecaster: RoleTick = async (ctx) => {
  const submitted = actedOn(ctx, SUBMITTED);
  const page = await ctx.client.listMarkets({ state: "OPEN", limit: 100 });
  for (const { market, spec } of page.items) {
    if (!spec.ok) continue;
    // ponytail: the first 100 windows of a market; a long market with daily windows needs paging.
    const windows = await ctx.client.listForecastWindows({ marketId: market.marketId }, { limit: 100 });
    const open = windows.items.filter((w) => w.status === "OPEN" && !submitted.includes(w.windowId));
    if (open.length === 0) continue;
    const probabilityBps = await ctx.model.probabilityBps({
      marketId: BigInt(market.marketId),
      specHash: market.specHash as Hex,
      spec: spec.spec,
    });
    if (probabilityBps === null) continue;
    for (const window of open) await submit(ctx, market.marketId, window, clampBps(probabilityBps));
  }
};
