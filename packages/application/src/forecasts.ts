import { hashTypedData, type Hex } from "viem";
import {
  ForecastSubmission,
  forecastTypedData,
  type ForecastView,
} from "@blink/schemas";
import {
  DEFAULT_WINDOW_SCHEDULE,
  JobError,
  consensus,
  forecastLeaf,
  forecasterWeight,
  meanBrier,
  weightValue,
  merkleProof,
  merkleRoot,
  plannedWindows,
  tradable,
  windowContaminated,
  type WindowSchedule,
} from "@blink/domain";
import {
  SignatureCheckUnavailable,
  type ForecastStore,
  type ForecasterStats,
  type ForecastWindow,
  type HorizonType,
  type IdentityPrincipal,
  type KeyScope,
  type ProtocolReader,
  type SignatureVerifier,
  type StoredForecast,
} from "@blink/ports";
import { IdentityError, readFreshIndex } from "./identity.js";
import type { RouteService, ServiceRequest } from "./route-service.js";

export const forecastPaths = [
  "/v1/markets/:id/forecast-windows",
  "/v1/markets/:id/forecasts",
  "/v1/forecasts/:id/withdrawal",
  "/v1/forecast-windows/:id",
  "/v1/forecast-windows/:id/proof",
  "/v1/markets/:id/consensus",
  "/v1/forecasters",
  "/v1/forecasters/:address",
] as const;

const WEIGHT_SCALE = 10n ** 18n;
const HORIZONS: readonly HorizonType[] = ["DAILY", "PRE_CLOSE"];
const sec = (date: Date) => Math.floor(date.getTime() / 1000);
const lower = (value: string) => value.toLowerCase();
const refuse = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
) => new IdentityError(status, code, { details });
/** `scheduledAt|horizonType` of the last window of a page. */
function windowCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const [time, type, ...rest] = cursor.split("|");
  if (
    !/^[0-9]{1,15}$/.test(time ?? "") ||
    !HORIZONS.includes(type as HorizonType) ||
    rest.length
  )
    throw new IdentityError(400, "INVALID_CURSOR");
  return {
    scheduledAt: new Date(Number(time) * 1000),
    horizonType: type as HorizonType,
  };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Signed forecasts, their windows and roots, and the credit-weighted consensus. The platform admits,
 * seals and scores answers; it never signs, anchors or annotates by hand.
 */
export function createForecastService(deps: {
  store: ForecastStore;
  identity: {
    authenticate(
      authorization: string | undefined,
      scope?: KeyScope,
    ): Promise<IdentityPrincipal>;
  };
  reader: Pick<
    ProtocolReader,
    "health" | "hasRole" | "market" | "proposal" | "anchor"
  >;
  verifier: SignatureVerifier;
  /** The generation's BlinkMarkets and the shared BlinkAnchor (the EIP-712 verifying contract). */
  deployment: { markets: string; anchor: string };
}): RouteService {
  const { store, reader } = deps;

  async function walletOf(req: ServiceRequest, scope?: KeyScope) {
    const principal = await deps.identity.authenticate(req.authorization, scope);
    if (!principal.address) throw new IdentityError(403, "NOT_REGISTERED");
    return { principal, address: lower(principal.address) };
  }
  // Every write refuses first when the index lags, whatever else is wrong with it.
  const requireFreshIndex = () => readFreshIndex(reader, async () => undefined);

  const windowView = (w: ForecastWindow, now: Date, hideRoot = false) => ({
    windowId: w.id,
    horizon: (w.horizonType === "DAILY" ? 0 : 1) as 0 | 1,
    horizonType: w.horizonType,
    scheduledAt: sec(w.scheduledAt),
    openAt: sec(w.openAt),
    deadline: sec(w.deadline),
    status: (now < w.openAt ? "UPCOMING" : now >= w.deadline ? "CLOSED" : "OPEN") as
      | "UPCOMING"
      | "OPEN"
      | "CLOSED",
    root: hideRoot ? null : w.merkleRoot,
    rootAt: hideRoot || !w.rootAt ? null : sec(w.rootAt),
  });
  const forecastView = (f: StoredForecast): ForecastView => ({
    submissionId: f.submissionId,
    windowId: f.windowId,
    forecaster: f.forecaster,
    probabilityBps: f.probabilityBps,
    contentHash: f.contentHash,
    digest: f.digest,
    leaf: forecastLeaf(f.digest),
    signature: f.signature,
    verifiedBlock: f.verifiedBlock,
    receivedAt: sec(f.receivedAt),
    withdrawnAt: f.withdrawnAt ? sec(f.withdrawnAt) : null,
  });
  /** The window's sorted leaves; only meaningful once its deadline passed. */
  const leavesOf = async (windowId: string) =>
    [...new Set((await store.digests(windowId)).map(forecastLeaf))].sort();

  // ---- POST /v1/markets/:id/forecasts ----------------------------------------------------------
  async function submit(req: ServiceRequest) {
    const { principal, address } = await walletOf(req, "forecast:write");
    await requireFreshIndex();
    const body = ForecastSubmission.safeParse(req.body);
    if (!body.success) throw new IdentityError(400, "INVALID_REQUEST");
    const input = body.data;
    const marketId = req.params.id!;
    const horizonType = HORIZONS[input.horizon]!;
    // The signed struct is built here from the route and the key, never taken from the caller, so a
    // signature made for another window, market, forecaster or deployment cannot verify.
    const typedData = forecastTypedData({
      anchor: deps.deployment.anchor,
      message: {
        forecaster: address,
        markets: deps.deployment.markets,
        marketId,
        horizon: input.horizon,
        scheduledAt: input.scheduledAt,
        probabilityBps: input.probabilityBps,
        contentHash: input.contentHash.toLowerCase(),
      },
    });
    const digest = hashTypedData(typedData);
    const receipt = { digest, leaf: forecastLeaf(digest) };

    // One consistent look at the index, the role, the market, the window and the clock. It runs
    // again after the signature check, which can take a long time, so an answer is never admitted
    // against a role, a market or a clock older than the check.
    const look = async () => {
      const now = await store.now();
      const market = await readFreshIndex(reader, async () => {
        if (!(await reader.hasRole(address, "FORECASTER")))
          throw refuse(403, "ROLE_REQUIRED", { role: "FORECASTER" });
        return reader.market(marketId);
      });
      if (!market) throw new IdentityError(404, "NOT_FOUND");
      const window = await store.windowFor(
        marketId,
        horizonType,
        new Date(input.scheduledAt * 1000),
      );
      if (!window) throw new IdentityError(404, "NOT_FOUND");
      const existing = await store.submissionOf(window.id, address);
      if (existing) {
        // The same signed answer again is a retry, not a second answer.
        if (lower(existing.digest) === digest) return { window, replay: true };
        throw new IdentityError(409, "FORECAST_ALREADY_SUBMITTED");
      }
      if (!tradable(market, sec(now)))
        throw new IdentityError(409, "MARKET_CLOSED");
      if (now < window.openAt || now >= window.deadline)
        throw refuse(409, "FORECAST_WINDOW_CLOSED", {
          reason: now < window.openAt ? "NOT_OPEN" : "CLOSED",
        });
      return { window, replay: false };
    };
    const first = await look();
    if (first.replay) return { status: 201, body: receipt };

    let check;
    try {
      check = await deps.verifier.verifyTypedData({
        address,
        typedData,
        signature: input.signature as Hex,
      });
    } catch (error) {
      if (error instanceof SignatureCheckUnavailable)
        throw new IdentityError(503, "SIGNATURE_CHECK_UNAVAILABLE", {
          retryable: true,
          retryAfterSeconds: 1,
        });
      throw error;
    }
    if (!check.valid) throw new IdentityError(400, "INVALID_FORECAST_SIGNATURE");

    const second = await look();
    if (second.replay) return { status: 201, body: receipt };
    const stored = await store.submit({
      id: crypto.randomUUID(),
      windowId: second.window.id,
      keyId: principal.keyId,
      agentId: principal.agentId,
      operatorId: principal.operatorId,
      requestId: req.requestId,
      forecaster: address,
      probabilityBps: input.probabilityBps,
      contentHash: input.contentHash.toLowerCase(),
      digest,
      signature: input.signature,
      verifiedBlock: check.blockNumber,
    });
    if (stored.state === "CLOSED")
      throw refuse(409, "FORECAST_WINDOW_CLOSED", { reason: "CLOSED" });
    if (stored.state === "DUPLICATE") {
      // Lost a race with the same forecaster: identical answer is a retry, anything else a second answer.
      const winner = await store.submissionOf(second.window.id, address);
      if (winner && lower(winner.digest) === digest)
        return { status: 201, body: receipt };
      throw new IdentityError(409, "FORECAST_ALREADY_SUBMITTED");
    }
    return { status: 201, body: receipt };
  }

  // ---- GET /v1/markets/:id/forecasts -----------------------------------------------------------
  async function listForecasts(req: ServiceRequest) {
    const principal =
      req.authorization !== undefined
        ? await deps.identity.authenticate(req.authorization)
        : null;
    const { limit, cursor, windowId } = req.query as {
      limit: number;
      cursor?: string;
      windowId: string;
    };
    const window = await store.windowById(windowId);
    if (!window || window.marketId !== req.params.id)
      throw new IdentityError(404, "NOT_FOUND");
    if (cursor !== undefined && !UUID.test(cursor))
      throw new IdentityError(400, "INVALID_CURSOR");
    const sealed = (await store.now()) < window.deadline;
    // Sealed: nobody reads another forecaster's answer before the deadline, only their own.
    const mine = principal?.address ? lower(principal.address) : null;
    if (sealed && mine === null)
      return { status: 200, body: { items: [], nextCursor: null } };
    const rows = await store.submissions(
      window.id,
      sealed ? mine : null,
      limit + 1,
      cursor ?? null,
    );
    const items = rows.slice(0, limit);
    return {
      status: 200,
      body: {
        items: items.map(forecastView),
        nextCursor:
          rows.length > limit ? items[items.length - 1]!.submissionId : null,
      },
    };
  }

  // ---- POST /v1/forecasts/:id/withdrawal -------------------------------------------------------
  async function withdraw(req: ServiceRequest) {
    const { principal, address } = await walletOf(req, "forecast:write");
    // Like every identity-acting write: the index must be fresh and the wallet must still be a FORECASTER.
    await readFreshIndex(reader, async () => {
      if (!(await reader.hasRole(address, "FORECASTER")))
        throw refuse(403, "ROLE_REQUIRED", { role: "FORECASTER" });
    });
    const result = await store.withdraw(req.params.id!, address, principal.keyId);
    if (result.state === "NOT_FOUND") throw new IdentityError(404, "NOT_FOUND");
    if (result.state === "CLOSED")
      throw refuse(409, "FORECAST_WINDOW_CLOSED", { reason: "CLOSED" });
    return {
      status: 200,
      body: { submissionId: req.params.id!, withdrawnAt: sec(result.withdrawnAt) },
    };
  }

  // ---- windows ---------------------------------------------------------------------------------
  async function listWindows(req: ServiceRequest) {
    const { limit, cursor } = req.query as { limit: number; cursor?: string };
    const after = windowCursor(cursor);
    const rows = await store.windows(req.params.id!, limit + 1, after);
    const now = await store.now();
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      status: 200,
      body: {
        items: items.map((w) => windowView(w, now)),
        nextCursor:
          rows.length > limit && last
            ? `${sec(last.scheduledAt)}|${last.horizonType}`
            : null,
      },
    };
  }

  async function getWindow(req: ServiceRequest) {
    const window = await store.windowById(req.params.id!);
    if (!window) throw new IdentityError(404, "NOT_FOUND");
    const now = await store.now();
    const sealed = now < window.deadline;
    const leaves = sealed ? [] : await leavesOf(window.id);
    const anchor = window.merkleRoot ? await reader.anchor(window.merkleRoot) : null;
    return {
      status: 200,
      body: {
        ...windowView(window, now, sealed),
        marketId: window.marketId,
        leaves,
        anchor,
        index: await reader.health(),
      },
    };
  }

  async function getProof(req: ServiceRequest) {
    const window = await store.windowById(req.params.id!);
    if (!window) throw new IdentityError(404, "NOT_FOUND");
    if ((await store.now()) < window.deadline)
      throw new IdentityError(409, "WINDOW_SEALED");
    if (!window.rootAt) throw new IdentityError(409, "ROOT_PENDING");
    const leaf = lower(String((req.query as { leaf: string }).leaf));
    const leaves = await leavesOf(window.id);
    if (!window.merkleRoot || !leaves.includes(leaf))
      throw new IdentityError(404, "LEAF_NOT_FOUND");
    // The stored root and the leaves must agree; if they do not, say nothing rather than a wrong proof.
    if (merkleRoot(leaves) !== window.merkleRoot)
      throw new Error("WINDOW_ROOT_MISMATCH");
    return {
      status: 200,
      body: { root: window.merkleRoot, leaf, proof: merkleProof(leaves, leaf) },
    };
  }

  // ---- consensus and credit --------------------------------------------------------------------
  async function getConsensus(req: ServiceRequest) {
    const { limit, cursor } = req.query as { limit: number; cursor?: string };
    const marketId = req.params.id!;
    const after = windowCursor(cursor);
    const now = await store.now();
    const rows = await store.windows(marketId, limit + 1, after);
    // Windows end when they are scheduled, so the closed ones are a prefix of the list.
    const closed = rows.filter((w) => now >= w.deadline);
    const items = closed.slice(0, limit);
    const proposal = items.length ? await reader.proposal(marketId) : null;
    const views = [];
    for (const window of items) {
      const answers = await store.answers(window.id);
      // Credit as the platform knew it at the deadline, so a later score never moves the consensus.
      const stats = await store.creditStats(
        answers.map((a) => a.forecaster),
        window.deadline,
      );
      const weights = Object.fromEntries(
        stats.map((s) => [s.address, forecasterWeight(s)]),
      );
      views.push({
        windowId: window.id,
        horizon: (window.horizonType === "DAILY" ? 0 : 1) as 0 | 1,
        horizonType: window.horizonType,
        scheduledAt: sec(window.scheduledAt),
        deadline: sec(window.deadline),
        probabilityBps: consensus(answers, weights),
        submissions: answers.length,
        contaminated: windowContaminated(proposal, sec(window.deadline)),
      });
    }
    const last = items[items.length - 1];
    return {
      status: 200,
      body: {
        items: views,
        nextCursor:
          rows.length > limit && closed.length > limit && last
            ? `${sec(last.scheduledAt)}|${last.horizonType}`
            : null,
      },
    };
  }

  // The numbers shown are for reading only; ranking and the consensus use the exact fraction.
  const creditView = (s: ForecasterStats) => {
    const w = forecasterWeight(s);
    return {
      view: {
        address: s.address,
        n: s.n,
        meanBrier: meanBrier(s),
        weight: weightValue(w),
      },
      // Highest weight first (to 1e-18), then more scored answers, then address.
      key: `${String(WEIGHT_SCALE - (w.num * WEIGHT_SCALE) / w.den).padStart(19, "0")}:${String(1_000_000 - s.n).padStart(7, "0")}:${s.address}`,
    };
  };
  async function listForecasters(req: ServiceRequest) {
    const { limit, cursor } = req.query as { limit: number; cursor?: string };
    const keyed = (await store.creditStats(null, null))
      .map(creditView)
      .map((c) => [c.key, c.view] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    // The cursor is the rank key of the last item, so a forecaster joining between pages shifts nothing.
    if (cursor !== undefined && !/^\d{19}:\d{7}:0x[0-9a-f]{40}$/.test(cursor))
      throw new IdentityError(400, "INVALID_CURSOR");
    const rest = keyed.filter(([key]) => cursor === undefined || key > cursor);
    const page = rest.slice(0, limit);
    return {
      status: 200,
      body: {
        items: page.map(([, v]) => v),
        nextCursor: rest.length > limit ? page[page.length - 1]![0] : null,
      },
    };
  }
  async function getForecaster(req: ServiceRequest) {
    const [stats] = await store.creditStats([req.params.address!], null);
    if (!stats) throw new IdentityError(404, "NOT_FOUND");
    return { status: 200, body: creditView(stats).view };
  }

  return {
    paths: forecastPaths,
    async handle(req) {
      switch (req.path) {
        case "/v1/markets/:id/forecast-windows":
          return listWindows(req);
        case "/v1/markets/:id/forecasts":
          return req.method === "POST" ? submit(req) : listForecasts(req);
        case "/v1/forecasts/:id/withdrawal":
          return withdraw(req);
        case "/v1/forecast-windows/:id":
          return getWindow(req);
        case "/v1/forecast-windows/:id/proof":
          return getProof(req);
        case "/v1/markets/:id/consensus":
          return getConsensus(req);
        case "/v1/forecasters":
          return listForecasters(req);
        default:
          return getForecaster(req);
      }
    },
  };
}

/** Opens windows for tradable markets and closes them, with their roots, at their deadlines. */
export function createWindowScheduler(
  store: ForecastStore,
  reader: Pick<ProtocolReader, "markets">,
  schedule: WindowSchedule = DEFAULT_WINDOW_SCHEDULE,
) {
  const MARKET_PAGE = 100;
  const DUE_BATCH = 100;
  return {
    /** Plans windows for every OPEN market; PENDING, CANCELLED and closed markets get none. */
    async scheduleOnce(): Promise<number> {
      const now = await store.now();
      let count = 0;
      let after: string | undefined;
      do {
        const page = await reader.markets({
          states: ["OPEN"],
          limit: MARKET_PAGE,
          ...(after === undefined ? {} : { after }),
        });
        for (const market of page.items) {
          for (const window of plannedWindows({
            closeAt: new Date(market.closeAt * 1000),
            now,
            schedule,
          }))
            if (
              tradable(market, sec(window.deadline)) &&
              (await store.addWindow({
                marketId: market.marketId,
                horizonType: window.horizonType,
                scheduledAt: window.scheduledAt,
                openAt: window.openAt,
                deadline: window.deadline,
              }))
            )
              count++;
        }
        after = page.next ?? undefined;
      } while (after !== undefined);
      return count;
    },
    /**
     * Stores the Merkle root of every window past its deadline. The root only ever covers answers
     * admitted before the deadline, because admission and this close share the window's lock.
     * Nothing is anchored here: any agent may do that.
     */
    async closeDue(): Promise<number> {
      let closed = 0;
      for (const id of await store.dueWindows(DUE_BATCH))
        if (
          await store.closeWindow(id, (digests) =>
            merkleRoot(digests.map(forecastLeaf)),
          )
        )
          closed++;
      return closed;
    },
  };
}
export function createForecastScheduleHandler(
  scheduler: Pick<ReturnType<typeof createWindowScheduler>, "scheduleOnce" | "closeDue">,
) {
  return async (ctx: {
    job: { id: string; payload: Record<string, unknown> };
    signal: AbortSignal;
  }): Promise<void> => {
    if (ctx.signal.aborted)
      throw new ForecastScheduleError("OPERATION_ABORTED", true);
    try {
      await scheduler.scheduleOnce();
      await scheduler.closeDue();
    } catch (error) {
      throw new ForecastScheduleError("FORECAST_SCHEDULE_FAILED", true, error);
    }
  };
}
export class ForecastScheduleError extends JobError {
  constructor(
    code: string,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(code, retryable);
    if (cause !== undefined) this.cause = cause;
  }
}
