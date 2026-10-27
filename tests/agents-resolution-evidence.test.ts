import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { keccak256, toBytes } from "viem";
import { BlinkApiError, createBlinkClient } from "../packages/client/src/index.ts";
import type { AgentContext } from "../examples/agents/src/lib/env.ts";
import { evidenceAvailable } from "../examples/agents/src/lib/resolution.ts";

// Which refusals of /v1/content mean "these bytes are not there" (an unsupported proposal), and
// which say nothing about the bytes (the agent's loop backs off or fails the tick).

const BYTES = "the evidence";
const HASH = keccak256(toBytes(BYTES));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// An answer is built per request: a retried call must not meet a Response whose body was read.
type Answer = () => Response;
const refusal = (status: number, code: string, retryable = false): Answer => () =>
  new Response(JSON.stringify({ code, message: code, requestId: "r1", retryable, details: {} }), {
    status,
    headers: { "content-type": "application/json" },
  });

async function available(answer: Answer) {
  globalThis.fetch = (async () => answer()) as typeof fetch;
  const client = createBlinkClient("http://127.0.0.1:9", undefined, { maxAttempts: 1, sleep: async () => {} });
  return evidenceAvailable({ client } as unknown as AgentContext, HASH);
}

test("intact bytes are available", async () => {
  assert.equal(await available(() => new Response(BYTES)), true);
});

test("a missing object, damaged stored bytes and a hash mismatch are unsupported evidence", async () => {
  assert.equal(await available(refusal(404, "NOT_FOUND")), false);
  assert.equal(await available(refusal(503, "CONTENT_UNAVAILABLE")), false);
  assert.equal(await available(() => new Response("other bytes")), false);
});

test("a rate limit, a stale index and an unrelated schema failure propagate", async () => {
  await assert.rejects(available(refusal(429, "RATE_LIMITED", true)), (e) => e instanceof BlinkApiError && e.status === 429);
  await assert.rejects(
    available(refusal(503, "INDEX_STALE", true)),
    (e) => e instanceof BlinkApiError && e.body.code === "INDEX_STALE",
  );
  // A code the client does not know is a parse failure, not proof that the bytes are missing.
  await assert.rejects(available(refusal(400, "SOMETHING_NEW")), (e) => (e as Error).name === "ZodError");
});

test("a network failure propagates unchanged", async () => {
  const failure = new TypeError("fetch failed");
  globalThis.fetch = (async () => {
    throw failure;
  }) as typeof fetch;
  const client = createBlinkClient("http://127.0.0.1:9", undefined, { maxAttempts: 1, sleep: async () => {} });
  await assert.rejects(evidenceAvailable({ client } as unknown as AgentContext, HASH), (e) => e === failure);
});
