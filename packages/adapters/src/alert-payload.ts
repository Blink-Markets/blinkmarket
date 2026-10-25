import { ALERT_FAMILIES, type Alert } from "@blink/ports";

/** Closed projection: no raw event payload, aggregate, URL, evidence or error text leaves the DB. */
export function alertPayload(id: string, type: string, raw: unknown): Alert {
  const alert: Alert = {
    dedupeKey: `alert:${id}`,
    type: /^alert\.[a-z_]{1,64}$/.test(type) ? type : "alert.unknown",
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { ...alert, marker: "PAYLOAD_INVALID" };
  const payload = raw as Record<string, unknown>;
  if (payload.marker === "PAYLOAD_INVALID") alert.marker = "PAYLOAD_INVALID";
  if (
    typeof payload.deploymentId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(payload.deploymentId)
  )
    alert.deploymentId = payload.deploymentId;
  for (const key of ["deadline", "marketId"] as const)
    if (typeof payload[key] === "string" && /^[0-9]{1,78}$/.test(payload[key]))
      alert[key] = payload[key];
  if (
    Number.isSafeInteger(payload.thresholdSeconds) &&
    Number(payload.thresholdSeconds) >= 0
  )
    alert.thresholdSeconds = Number(payload.thresholdSeconds);
  if (payload.mode === "LIVE" || payload.mode === "REPLAY")
    alert.mode = payload.mode;
  if (payload.kind === "HARD_DEADLINE" || payload.kind === "CHALLENGE_END")
    alert.kind = payload.kind;
  // Episode alerts (alert.evaluate): codes and numbers only, never free text.
  const family = ALERT_FAMILIES.find((name) => name === payload.family);
  if (family) alert.family = family;
  if (family === "fees_undistributed") alert.severity = "info";
  if (
    payload.state === "OPEN" ||
    payload.state === "STILL_OPEN" ||
    payload.state === "CLEARED"
  )
    alert.state = payload.state;
  if (
    typeof payload.subject === "string" &&
    /^[a-z_]{1,32}(:[a-z0-9_]{1,78})?$/.test(payload.subject)
  )
    alert.subject = payload.subject;
  if (
    typeof payload.reason === "string" &&
    /^[A-Z0-9_]{1,64}$/.test(payload.reason)
  )
    alert.reason = payload.reason;
  for (const key of [
    "since",
    "blockNumber",
    "headNumber",
    "count",
    "overdueSeconds",
    "failures",
  ] as const)
    if (typeof payload[key] === "string" && /^[0-9]{1,78}$/.test(payload[key]))
      alert[key] = payload[key];
  if (payload.truncated === true) alert.truncated = true;
  if (Array.isArray(payload.jobTypes)) {
    const types = payload.jobTypes
      .filter(
        (type): type is string =>
          typeof type === "string" && /^[a-z][a-z0-9_.]{0,63}$/.test(type),
      )
      .slice(0, 10);
    if (types.length) alert.jobTypes = types;
  }
  return alert;
}
