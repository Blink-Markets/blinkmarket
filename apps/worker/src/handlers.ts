import type { JobType } from "@blink/domain";
import type { JobHandler } from "@blink/ports";
import type { OutboxMapping } from "@blink/adapters";

// Worker tasks register their job handlers and outbox-event mappings here.
export const handlers: Partial<Record<JobType, JobHandler>> = {};
export const outboxMapping: OutboxMapping = {};
