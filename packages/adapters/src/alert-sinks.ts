import { appendFile } from "node:fs/promises";
import { JobError, type Alert, type AlertSink } from "@blink/ports";
import { alertPayload } from "./alert-payload.js";
import { isAllowedAlertWebhookUrl } from "./alert-url.js";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

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

export function webhookAlertSink(
  url: string,
  options: { timeoutMs?: number } = {},
): AlertSink {
  if (!isAllowedAlertWebhookUrl(url))
    throw new Error("INVALID_ALERT_WEBHOOK_URL");
  const timeoutMs = options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  return {
    async deliver(alert, signal) {
      signal.throwIfAborted();
      const body = encode(alert);
      let status: number;
      try {
        const response = await fetch(url, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "idempotency-key": alert.dedupeKey,
          },
          body,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
        });
        await response.body?.cancel();
        status = response.status;
      } catch {
        throw new JobError("ALERT_SINK_FAILED", true);
      }
      if (status >= 200 && status < 300) return;
      // A client error other than 408/429 will not fix itself (bad path, rotated token): still
      // retried, but reported with its own code so it is not mistaken for an outage.
      const permanent =
        status >= 400 && status < 500 && status !== 408 && status !== 429;
      throw new JobError(
        permanent ? "ALERT_SINK_REJECTED" : "ALERT_SINK_FAILED",
        true,
      );
    },
  };
}
