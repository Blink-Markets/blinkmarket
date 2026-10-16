import {
  JobError,
  type Alert,
  type AlertSink,
  type JobHandler,
} from "@blink/ports";

export function createAlertDeliveryHandler(sink: AlertSink): JobHandler {
  return async ({ job, signal }) => {
    signal.throwIfAborted();
    const { dedupeKey, type } = job.payload;
    if (
      typeof dedupeKey !== "string" ||
      !/^alert:[0-9a-f-]{36}$/.test(dedupeKey) ||
      typeof type !== "string" ||
      !/^alert\.[a-z_]{1,64}$/.test(type)
    )
      throw new JobError("INVALID_ALERT", false);
    try {
      await sink.deliver({ ...job.payload, dedupeKey, type } as Alert, signal);
      signal.throwIfAborted();
    } catch (error) {
      throw new JobError(
        error instanceof JobError && error.code === "ALERT_SINK_REJECTED"
          ? "ALERT_SINK_REJECTED"
          : "ALERT_SINK_FAILED",
        true,
      );
    }
  };
}
