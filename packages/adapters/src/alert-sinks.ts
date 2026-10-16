import { appendFile } from "node:fs/promises";
import { JobError, type Alert, type AlertSink } from "@blink/ports";
import { alertPayload } from "./alert-payload.js";

function encode(alert: Alert): string {
  if (!/^alert:[0-9a-f-]{36}$/.test(alert.dedupeKey))
    throw new JobError("INVALID_ALERT", false);
  return JSON.stringify(
    alertPayload(alert.dedupeKey.slice(6), alert.type, { ...alert }),
  );
}

export function stdoutAlertSink(): AlertSink {
  return {
    async deliver(alert, signal) {
      signal.throwIfAborted();
      const line = encode(alert) + "\n";
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(line, (error) =>
          error ? reject(new JobError("ALERT_SINK_FAILED", true)) : resolve(),
        );
      });
    },
  };
}

export function fileAlertSink(path: string): AlertSink {
  return {
    async deliver(alert, signal) {
      signal.throwIfAborted();
      try {
        await appendFile(path, encode(alert) + "\n", { mode: 0o600 });
      } catch {
        throw new JobError("ALERT_SINK_FAILED", true);
      }
    },
  };
}

export function webhookAlertSink(url: string): AlertSink {
  try {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      url.includes("<TO BE PROVIDED:")
    )
      throw new Error();
  } catch {
    throw new Error("INVALID_ALERT_WEBHOOK_URL");
  }
  return {
    async deliver(alert, signal) {
      signal.throwIfAborted();
      const body = encode(alert);
      try {
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "idempotency-key": alert.dedupeKey,
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error();
      } catch {
        throw new JobError("ALERT_SINK_FAILED", true);
      }
    },
  };
}
