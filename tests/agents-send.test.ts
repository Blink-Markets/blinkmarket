import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentContext } from "../examples/agents/src/lib/env.ts";
import { isRevert } from "../examples/agents/src/lib/resolution.ts";
import { send } from "../examples/agents/src/lib/session.ts";

// What `send` makes of a receipt: only `reverted` is the chain's final refusal.

const sendWith = (status: unknown) =>
  send(
    {
      walletClient: { writeContract: async () => "0x" + "ab".repeat(32) },
      publicClient: { waitForTransactionReceipt: async () => ({ status, logs: [] }) },
    } as unknown as AgentContext,
    "CLAIM_REWARDS",
    {} as never,
  );

test("a success receipt is returned", async () => {
  assert.deepEqual(await sendWith("success"), { status: "success", logs: [] });
});

test("a reverted receipt is a revert", async () => {
  await assert.rejects(sendWith("reverted"), (e) => (e as Error).message === "CLAIM_REWARDS_REVERTED" && isRevert(e));
});

test("a missing or unknown status is a distinct error that is not a revert", async () => {
  for (const status of [undefined, "pending", 0])
    await assert.rejects(
      sendWith(status),
      (e) => (e as Error).message === "CLAIM_REWARDS_RECEIPT_UNKNOWN" && !isRevert(e),
      String(status),
    );
});
