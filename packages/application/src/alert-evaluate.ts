import {
  ALERT_SCOPE_FAMILIES,
  GLOBAL_ALERT_SCOPE,
  type AlertEpisode,
  type AlertEvaluateStore,
  type AlertFamily,
  type AlertObservation,
  type EpisodeChange,
  type JobHandler,
  type RpcProbe,
  type RpcProbeResult,
} from "@blink/ports";

/** A reason change is announced at most this often per episode (a flapping probe stays quiet). */
const REASON_CHANGE_MIN_MS = 10 * 60_000;

export interface AlertEvaluatePolicy {
  /** An episode that stays active this long is announced again (STILL_OPEN). */
  reAlertMs: number;
  /** Consecutive failed RPC probes before alert.rpc opens. */
  rpcFailures: number;
}

const key = (family: string, subject: string) => family + "\u0000" + subject;
const countOf = (observation: AlertObservation) =>
  Number(observation.fields?.count ?? 0);

/**
 * The episode state machine. `observations` are the conditions true now. `evaluated` are the
 * families that were judged completely this tick: only their episodes may CLEAR, and a family
 * missing from it (unknown, truncated) changes nothing. `rpc` is this tick's probe result (null
 * when the RPC family is not evaluated). Returns only what must be written.
 *
 * A reason change inside an open episode is announced at once (STILL_OPEN). A condition that
 * flips between ticks opens and clears an episode per flip: flapping is at tick granularity.
 */
export function decideEpisodeChanges(input: {
  episodes: AlertEpisode[];
  observations: AlertObservation[];
  evaluated: readonly AlertFamily[];
  now: Date;
  policy: AlertEvaluatePolicy;
  rpc: RpcProbeResult | null;
  /** Episodes whose subject could not be judged this tick: they change nothing. */
  skip?: (episode: AlertEpisode) => boolean;
}): EpisodeChange[] {
  const { episodes, evaluated, now, policy, rpc } = input;
  const previous = new Map(episodes.map((e) => [key(e.family, e.subject), e]));
  const current = new Map(
    input.observations.map((o) => [key(o.family, o.subject), o]),
  );
  const changes: EpisodeChange[] = [];
  // The RPC streak counts in the episode row even before the episode opens.
  let rpcFailures = 0;
  if (rpc) {
    const before = previous.get(key("rpc", "rpc"));
    rpcFailures = rpc.ok ? 0 : (before?.consecutiveFailures ?? 0) + 1;
    if (!rpc.ok && rpcFailures >= policy.rpcFailures)
      current.set(key("rpc", "rpc"), {
        family: "rpc",
        subject: "rpc",
        reason: rpc.reason,
        fields: { failures: String(rpcFailures) },
      });
  }
  for (const [k, o] of current) {
    const before = previous.get(k);
    const failures = o.family === "rpc" ? rpcFailures : 0;
    const count = o.monotonic ? countOf(o) : 0;
    const next = {
      family: o.family,
      subject: o.subject,
      active: true,
      reason: o.reason,
      consecutiveFailures: failures,
      lastCount: count,
    };
    if (!before?.active)
      changes.push({
        ...next,
        openedAt: now,
        lastAlertAt: now,
        emit: { state: "OPEN", fields: o.fields },
      });
    else if (
      (o.reason !== before.reason &&
        now.getTime() - before.lastAlertAt!.getTime() >=
          REASON_CHANGE_MIN_MS) ||
      (o.monotonic
        ? count > before.lastCount
        : now.getTime() - before.lastAlertAt!.getTime() > policy.reAlertMs)
    )
      changes.push({
        ...next,
        openedAt: before.openedAt,
        lastAlertAt: now,
        emit: { state: "STILL_OPEN", fields: o.fields },
      });
    else if (
      before.consecutiveFailures !== failures ||
      before.lastCount !== count
    )
      changes.push({
        ...before,
        consecutiveFailures: failures,
        lastCount: count,
      });
  }
  for (const [k, before] of previous) {
    if (current.has(k)) continue;
    if (
      before.active &&
      evaluated.includes(before.family) &&
      !input.skip?.(before)
    )
      changes.push({
        ...before,
        active: false,
        consecutiveFailures: 0,
        lastCount: 0,
        emit: { state: "CLEARED" },
      });
    else if (
      !before.active &&
      before.family === "rpc" &&
      rpc &&
      before.consecutiveFailures !== rpcFailures
    )
      changes.push({ ...before, consecutiveFailures: rpcFailures });
  }
  // A first failed probe has no episode yet; record the streak so the next ones can reach the threshold.
  if (
    rpc &&
    rpcFailures > 0 &&
    !previous.has(key("rpc", "rpc")) &&
    !current.has(key("rpc", "rpc"))
  )
    changes.push({
      family: "rpc",
      subject: "rpc",
      active: false,
      reason: null,
      openedAt: null,
      lastAlertAt: null,
      consecutiveFailures: rpcFailures,
      lastCount: 0,
    });
  return changes;
}

/**
 * alert.evaluate: observes every alert family, opens/re-announces/clears episodes, and leaves the
 * alerts in the outbox for the normal alert.deliver path. It needs only the worker's own database login (and the RPC URL when one is configured).
 * Conditions without a deployment (budget gates, DEAD jobs, the RPC) are evaluated once per tick
 * under the global scope; the rest once per deployment.
 */
export function createAlertEvaluateHandler(deps: {
  store: AlertEvaluateStore;
  rpc: RpcProbe | null;
  policy: AlertEvaluatePolicy;
  /** Fixed deployments; when null every enabled deployment is evaluated. */
  deploymentIds: string[] | null;
  /** Called with a fixed code when a tick is skipped because another evaluator is running. */
  onSkip?: (code: string) => void;
}): JobHandler {
  const evaluateScope = async (
    scope: string,
    scopeFamilies: readonly AlertFamily[],
    rpc: RpcProbeResult | null,
  ) => {
    const observed = await deps.store.observe(scope);
    // Unknown subjects neither open nor clear; truncated families may open but never clear.
    const unknown = (episode: { family: AlertFamily; subject: string }) =>
      observed.unknown.some(
        (u) => u.family === episode.family && u.covers(episode.subject),
      );
    const observations = observed.observations.filter((o) => !unknown(o));
    await deps.store.transition(
      scope,
      scopeFamilies,
      observations,
      ({ episodes, now }) =>
        decideEpisodeChanges({
          episodes,
          observations,
          evaluated: scopeFamilies.filter(
            (f) => !observed.truncated.includes(f),
          ),
          skip: unknown,
          now,
          policy: deps.policy,
          rpc,
        }),
    );
  };
  return async ({ signal }) => {
    signal.throwIfAborted();
    // Two evaluators never overlap: a late one skips its tick instead of failing.
    const lock = await deps.store.tryLock();
    if (!lock) return void deps.onSkip?.("ALERT_EVALUATE_SKIPPED_OVERLAP");
    try {
      // One probe per tick; it never throws.
      const rpc = deps.rpc ? await deps.rpc.probe(signal) : null;
      signal.throwIfAborted();
      // A scope that fails does not stop the others; the first failure is rethrown afterwards.
      const failures: unknown[] = [];
      const scoped = async (run: () => Promise<void>) => {
        try {
          await run();
        } catch (error) {
          if (signal.aborted) throw error;
          failures.push(error);
        }
      };
      await scoped(() =>
        evaluateScope(
          GLOBAL_ALERT_SCOPE,
          ALERT_SCOPE_FAMILIES.global.filter(
            (f) => f !== "rpc" || rpc !== null,
          ),
          rpc,
        ),
      );
      let deployments: string[] = [];
      await scoped(async () => {
        deployments = deps.deploymentIds ?? (await deps.store.deployments());
      });
      for (const deploymentId of deployments) {
        signal.throwIfAborted();
        await scoped(() =>
          evaluateScope(deploymentId, ALERT_SCOPE_FAMILIES.deployment, null),
        );
      }
      if (failures.length) throw failures[0];
    } finally {
      await lock.release();
    }
  };
}
