import {
  ALERT_FAMILIES,
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

/**
 * The episode state machine. `observations` are the conditions true now for the families in
 * `evaluated`; `rpc` is this tick's probe result (null when the RPC family is not evaluated).
 * Returns only what must be written: new or ended episodes, re-alerts and RPC streak changes.
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
    const base = { family: o.family, subject: o.subject, active: true };
    if (!before?.active)
      changes.push({
        ...base,
        reason: o.reason,
        openedAt: now,
        lastAlertAt: now,
        consecutiveFailures: failures,
        emit: { state: "OPEN", fields: o.fields },
      });
    else if (now.getTime() - before.lastAlertAt!.getTime() > policy.reAlertMs)
      changes.push({
        ...base,
        reason: o.reason,
        openedAt: before.openedAt,
        lastAlertAt: now,
        consecutiveFailures: failures,
        emit: { state: "STILL_OPEN", fields: o.fields },
      });
    else if (before.consecutiveFailures !== failures)
      changes.push({ ...before, consecutiveFailures: failures });
  }
  for (const [k, before] of previous) {
    if (current.has(k)) continue;
    if (before.active && evaluated.includes(before.family))
      changes.push({
        ...before,
        active: false,
        consecutiveFailures: 0,
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
    });
  return changes;
}

/**
 * alert.evaluate: observes every alert family, opens/re-announces/clears episodes, and leaves the
 * alerts in the outbox for the normal alert.deliver path. It needs no keeper, signer or execution
 * configuration, only the worker's own database login (and the RPC URL when one is configured).
 */
export function createAlertEvaluateHandler(deps: {
  store: AlertEvaluateStore;
  rpc: RpcProbe | null;
  policy: AlertEvaluatePolicy;
  keeperOverdueSeconds: number;
  /** Fixed deployments; when null every enabled deployment is evaluated. */
  deploymentIds: string[] | null;
}): JobHandler {
  const evaluated = ALERT_FAMILIES.filter(
    (family) => family !== "rpc" || deps.rpc !== null,
  );
  return async ({ signal }) => {
    signal.throwIfAborted();
    // One probe per tick serves every deployment; it never throws.
    const rpc = deps.rpc ? await deps.rpc.probe(signal) : null;
    for (const deploymentId of deps.deploymentIds ??
      (await deps.store.deployments())) {
      signal.throwIfAborted();
      const observations = await deps.store.observe(deploymentId, {
        keeperOverdueSeconds: deps.keeperOverdueSeconds,
      });
      await deps.store.transition(
        deploymentId,
        evaluated,
        ({ episodes, now }) =>
          decideEpisodeChanges({
            episodes,
            observations,
            evaluated,
            now,
            policy: deps.policy,
            rpc,
          }),
      );
    }
  };
}
