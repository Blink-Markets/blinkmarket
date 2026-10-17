import {
  fileAlertSink,
  stdoutAlertSink,
  webhookAlertSink,
} from "@blink/adapters";
import type { AlertSink } from "@blink/ports";
import type { AlertConfig } from "./config.js";

/** The sink `alert.deliver` writes to, chosen by the validated ALERT_SINK configuration. */
export function alertSinkFor(config: AlertConfig): AlertSink {
  return config.sink === "webhook"
    ? webhookAlertSink(config.url)
    : config.sink === "file"
      ? fileAlertSink(config.path)
      : stdoutAlertSink();
}
