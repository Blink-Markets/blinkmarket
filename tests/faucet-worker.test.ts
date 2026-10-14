import { test } from "node:test";
import assert from "node:assert/strict";
import { faucetFixture } from "./helpers/faucet.js";
import { postgresFaucetStore } from "../packages/adapters/src/faucet-store.js";
import {
  createFaucetMintHandler,
  createExecutionDispatcher,
} from "../packages/application/src/execution.js";

const signal = new AbortController().signal;
test("faucet signer UNKNOWN retains the claim/request; SIGNED queues dispatch exactly once", async () => {
  const w = await faucetFixture();
  try {
    const claim = (await w.post("first")).json();
    await w.t.setRole("blink_worker");
    const store = postgresFaucetStore(w.t.pool);
    const seen: string[] = [];
    let signed = false;
    const handler = createFaucetMintHandler({
      store,
      signer: {
        async sign(input) {
          seen.push(input.signRequestId);
          return signed
            ? { state: "SIGNED", artifactId: "test", artifactHash: "0x11" }
            : { state: "UNKNOWN", code: "TIMEOUT" };
        },
      },
    });
    const ctx = {
      job: { id: "fixture", payload: { claimId: claim.claimId } },
      signal,
    };
    await assert.rejects(handler(ctx), /SIGN_UNKNOWN/);
    await w.t.setRole("blink_api");
    assert.equal((await w.post("pending")).json().code, "FAUCET_PENDING");
    await w.t.setRole("blink_worker");
    signed = true;
    await handler(ctx);
    await handler(ctx);
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(
      (await w.t.pool.query("SELECT state FROM faucet.claims")).rows[0].state,
      "SUBMITTED",
    );
    assert.equal(
      (
        await w.t.pool.query(
          "SELECT id FROM operations.jobs WHERE type='tx.dispatch'",
        )
      ).rows.length,
      1,
    );
  } finally {
    await w.close();
  }
});

test("a rejected faucet signature fails the claim and permits a fresh claim", async () => {
  const w = await faucetFixture();
  try {
    const claim = (await w.post("first")).json();
    await w.t.setRole("blink_worker");
    const handler = createFaucetMintHandler({
      store: postgresFaucetStore(w.t.pool),
      signer: {
        sign: async () => ({ state: "REJECTED", code: "GAS_CAP_EXCEEDED" }),
      },
    });
    await handler({
      job: { id: "fixture", payload: { claimId: claim.claimId } },
      signal,
    });
    assert.equal(
      (await w.t.pool.query("SELECT state FROM faucet.claims")).rows[0].state,
      "FAILED",
    );
    await w.t.setRole("blink_api");
    assert.equal((await w.post("next")).statusCode, 202);
  } finally {
    await w.close();
  }
});
