import type { Alert } from "@blink/ports";

/** Closed projection: no raw event payload, aggregate, URL, evidence or error text leaves the DB. */
export function alertPayload(
  id: string,
  type: string,
  payload: Record<string, unknown>,
): Alert {
  const alert: Alert = {
    dedupeKey: `alert:${id}`,
    type: /^alert\.[a-z_]{1,64}$/.test(type) ? type : "alert.unknown",
  };
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
  return alert;
}
