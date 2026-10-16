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
      o.reason !== before.reason ||
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
    if (before.active && evaluated.includes(before.family))
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
 * alerts in the outbox for the normal alert.deliver path. It needs no keeper, signer or execution
 * configuration, only the worker's own database login (and the RPC URL when one is configured).
 * Conditions without a deployment (budget gates, DEAD jobs, the RPC) are evaluated once per tick
 * under the global scope; the rest once per deployment.
 */
export function createAlertEvaluateHandler(deps: {
  store: AlertEvaluateStore;
  rpc: RpcProbe | null;
  policy: AlertEvaluatePolicy;
  keeperOverdueSeconds: number;
  /** Fixed deployments; when null every enabled deployment is evaluated. */
  deploymentIds: string[] | null;
}): JobHandler {
  const evaluateScope = async (
    scope: string,
    scopeFamilies: readonly AlertFamily[],
    rpc: RpcProbeResult | null,
  ) => {
    const observed = await deps.store.observe(scope, {
      keeperOverdueSeconds: deps.keeperOverdueSeconds,
    });
    // Unknown families neither open nor clear; truncated ones may open but never clear.
    const known = scopeFamilies.filter((f) => !observed.unknown.includes(f));
    if (!known.length) return;
    const clearable = known.filter((f) => !observed.truncated.includes(f));
    const observations = observed.observations.filter((o) =>
      known.includes(o.family),
    );
    await deps.store.transition(
      scope,
      known,
      observations,
      ({ episodes, now }) =>
        decideEpisodeChanges({
          episodes,
          observations,
          evaluated: clearable,
          now,
          policy: deps.policy,
          rpc,
        }),
    );
  };
  return async ({ signal }) => {
    signal.throwIfAborted();
    // One probe per tick; it never throws.
    const rpc = deps.rpc ? await deps.rpc.probe(signal) : null;
    signal.throwIfAborted();
    await evaluateScope(
      GLOBAL_ALERT_SCOPE,
      ALERT_SCOPE_FAMILIES.global.filter((f) => f !== "rpc" || rpc !== null),
      rpc,
    );
    for (const deploymentId of deps.deploymentIds ??
      (await deps.store.deployments())) {
      signal.throwIfAborted();
      await evaluateScope(deploymentId, ALERT_SCOPE_FAMILIES.deployment, null);
    }
  };
}
