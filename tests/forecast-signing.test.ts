import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { testAccounts } from "./helpers/protocol-fixture.ts";
import {
  ANCHOR,
  FORECASTERS,
  WALLET,
  forecastFixture,
} from "./helpers/forecast-fixture.ts";

const { a, b, c } = FORECASTERS;
// A throwaway key for "signed with someone else's key"; a fixture value, never funded.
const stranger = privateKeyToAccount(
  "0x0101010101010101010101010101010101010101010101010101010101010101",
);

async function setup() {
  const f = await forecastFixture();
  const window = await f.addWindow(600);
  return { f, window };
}

test("rejects forecast signed for another window", async () => {
  const { f, window } = await setup();
  try {
    const other = await f.addWindow(1200);
    const before = await f.stored();
    // The signature is honest, but for the window ending at 1200; the request names the one at 600.
    const message = f.message(a, other);
    const res = await f.post(
      1,
      f.agents.a,
      f.body(
        { ...message, scheduledAt: window.scheduledAt },
        await f.sign(a, message),
      ),
    );
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, "INVALID_FORECAST_SIGNATURE");
    // Horizon is part of the struct as well.
    const preClose = f.message(a, { ...window, horizon: 1 });
    const res2 = await f.post(
      1,
      f.agents.a,
      f.body({ ...preClose, horizon: 0 }, await f.sign(a, preClose)),
    );
    assert.equal(res2.statusCode, 400, res2.body);
    assert.deepEqual(await f.stored(), before);
  } finally {
    await f.close();
  }
});

test("rejects another forecaster's signature", async () => {
  const { f, window } = await setup();
  try {
    const before = await f.stored();
    // b signs b's own forecast; a's key posts it. The server binds the struct to a's wallet.
    const message = f.message(b, window);
    const res = await f.post(
      1,
      f.agents.a,
      f.body(message, await f.sign(b, message)),
    );
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, "INVALID_FORECAST_SIGNATURE");
    // A key that is not the wallet's, signing the right struct.
    const forged = await f.submit(f.agents.a, stranger, window, {}, { as: a });
    assert.equal(forged.statusCode, 400, forged.body);
    assert.deepEqual(await f.stored(), before);
  } finally {
    await f.close();
  }
});

test("contract wallet forecaster accepted", async () => {
  const { f, window } = await setup();
  try {
    // The wallet's owner signs; the verifier accepts it for the wallet's address.
    const res = await f.submit(
      f.agents.wallet,
      testAccounts.trader,
      window,
      {},
      { as: { address: WALLET } },
    );
    assert.equal(res.statusCode, 201, res.body);
    assert.match(res.json().digest, /^0x[0-9a-f]{64}$/);
    assert.match(res.json().leaf, /^0x[0-9a-f]{64}$/);
    const { rows } = await f.asOwner(() =>
      f.t.db.query<{ verified_block: string; forecaster: string }>(
        `SELECT verified_block::text, '0x'||encode(forecaster_address,'hex') AS forecaster FROM forecasts.submissions`,
      ),
    );
    assert.deepEqual(rows, [{ verified_block: "1", forecaster: WALLET }]);
    // The owner's key alone does not sign for another wallet.
    const wrong = await f.submit(
      f.agents.b,
      testAccounts.trader,
      window,
      {},
      { as: b },
    );
    assert.equal(wrong.statusCode, 400);
  } finally {
    await f.close();
  }
});

test("rejects other market or markets address", async () => {
  const { f, window } = await setup();
  try {
    const before = await f.stored();
    const wrongStruct = async (
      patch: Parameters<typeof f.message>[2],
      anchor = ANCHOR,
    ) => {
      const message = f.message(a, window, patch);
      return f.post(
        1,
        f.agents.a,
        f.body(message, await f.sign(a, message, anchor)),
      );
    };
    for (const res of [
      // Another market's id in the struct.
      await wrongStruct({ marketId: "2" }),
      // Another deployment's BlinkMarkets.
      await wrongStruct({ markets: "0x" + "ab".repeat(20) }),
      // Another verifying contract in the domain.
      await wrongStruct({}, "0x" + "cd".repeat(20)),
      // Another amount than the one posted (probability is signed too).
      await (async () => {
        const message = f.message(a, window);
        return f.post(
          1,
          f.agents.a,
          f.body(
            { ...message, probabilityBps: 9000 },
            await f.sign(a, message),
          ),
        );
      })(),
    ]) {
      assert.equal(res.statusCode, 400, res.body);
      assert.equal(res.json().code, "INVALID_FORECAST_SIGNATURE");
    }
    assert.deepEqual(await f.stored(), before);
    // The right struct goes through.
    assert.equal((await f.submit(f.agents.a, a, window)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("rejects after deadline", async () => {
  const { f, window } = await setup();
  try {
    const before = await f.stored();
    // Not yet open.
    const early = await f.addWindow(7000, { openFor: 100 });
    const notOpen = await f.submit(f.agents.a, a, early);
    assert.equal(notOpen.statusCode, 409, notOpen.body);
    assert.equal(notOpen.json().details.reason, "NOT_OPEN");

    await f.clock(601);
    const late = await f.submit(f.agents.a, a, window);
    assert.equal(late.statusCode, 409, late.body);
    assert.equal(late.json().code, "FORECAST_WINDOW_CLOSED");
    assert.deepEqual(await f.stored(), before);

    // A slow signature check that outlives the deadline must not be admitted.
    await f.clock(0);
    f.hooks.whileVerifying = () => f.clock(601);
    const slow = await f.submit(f.agents.b, b, window);
    f.hooks.whileVerifying = undefined;
    assert.equal(slow.statusCode, 409, slow.body);
    assert.equal(slow.json().code, "FORECAST_WINDOW_CLOSED");
    assert.deepEqual(await f.stored(), before);
  } finally {
    await f.close();
  }
});

test("one per window", async () => {
  const { f, window } = await setup();
  try {
    const first = await f.submit(f.agents.a, a, window);
    assert.equal(first.statusCode, 201, first.body);
    // The same signed answer again is a retry and returns the same receipt.
    const retry = await f.submit(f.agents.a, a, window);
    assert.equal(retry.statusCode, 201, retry.body);
    assert.deepEqual(retry.json(), first.json());
    // A different answer is a second submission.
    const second = await f.submit(f.agents.a, a, window, {
      probabilityBps: 2000,
    });
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().code, "FORECAST_ALREADY_SUBMITTED");
    assert.equal((await f.stored()).submissions, 1);
    // Another window is another answer.
    const next = await f.addWindow(1200);
    assert.equal((await f.submit(f.agents.a, a, next)).statusCode, 201);
    assert.equal((await f.stored()).submissions, 2);
    // Two requests racing past the first look: one is stored, the other refused.
    const racing = await f.addWindow(1800);
    f.hooks.whileVerifying = async () => {
      f.hooks.whileVerifying = undefined;
      assert.equal(
        (await f.submit(f.agents.a, a, racing, { probabilityBps: 3000 }))
          .statusCode,
        201,
      );
    };
    const loser = await f.submit(f.agents.a, a, racing, {
      probabilityBps: 4000,
    });
    assert.equal(loser.statusCode, 409, loser.body);
    assert.equal(loser.json().code, "FORECAST_ALREADY_SUBMITTED");
    assert.equal((await f.stored()).submissions, 3);
  } finally {
    await f.close();
  }
});

test("sealed until deadline", async () => {
  const { f, window } = await setup();
  try {
    assert.equal((await f.submit(f.agents.a, a, window)).statusCode, 201);
    assert.equal(
      (await f.submit(f.agents.b, b, window, { probabilityBps: 3000 }))
        .statusCode,
      201,
    );
    const list = (agent: { apiKey: string } | null) =>
      f.get(`/v1/markets/1/forecasts?windowId=${window.id}`, agent);
    const probabilities = async (agent: { apiKey: string } | null) =>
      (await list(agent))
        .json()
        .items.map((i: { probabilityBps: number }) => i.probabilityBps);
    assert.deepEqual(await probabilities(f.agents.a), [6000]);
    assert.deepEqual(await probabilities(f.agents.b), [3000]);
    assert.deepEqual(await probabilities(f.agents.c), []);
    assert.deepEqual(await probabilities(null), []);
    // The window shows no root or leaves, the proof route and consensus say nothing yet.
    const view = (await f.get(`/v1/forecast-windows/${window.id}`)).json();
    assert.deepEqual([view.root, view.leaves, view.anchor], [null, [], null]);
    const sealed = await f.get(
      `/v1/forecast-windows/${window.id}/proof?leaf=0x${"00".repeat(32)}`,
    );
    assert.equal(sealed.statusCode, 409);
    assert.equal(sealed.json().code, "WINDOW_SEALED");
    assert.deepEqual((await f.get("/v1/markets/1/consensus")).json().items, []);

    await f.clock(601);
    assert.deepEqual((await probabilities(null)).sort(), [3000, 6000]);
    const open = (await f.get(`/v1/forecast-windows/${window.id}`)).json();
    assert.deepEqual([open.root, open.leaves.length], [null, 2]);
    // Not yet rooted: the worker has not closed it.
    const pending = await f.get(
      `/v1/forecast-windows/${window.id}/proof?leaf=0x${"00".repeat(32)}`,
    );
    assert.equal(pending.json().code, "ROOT_PENDING");
    // Once closed, the consensus shows the unweighted mean (nobody has credit yet).
    await f.asWorker(() => f.scheduler().closeDue());
    assert.equal(
      (await f.get(`/v1/forecast-windows/${window.id}`)).json().leaves.length,
      2,
    );
    const consensus = (await f.get("/v1/markets/1/consensus")).json().items;
    assert.equal(consensus.length, 1);
    assert.equal(consensus[0].probabilityBps, 4500);
    assert.equal(consensus[0].submissions, 2);
  } finally {
    await f.close();
  }
});

test("requires FORECASTER role", async () => {
  const { f, window } = await setup();
  try {
    const before = await f.stored();
    const noRole = await f.submit(
      f.agents.outsider,
      testAccounts.challenger,
      window,
    );
    assert.equal(noRole.statusCode, 403, noRole.body);
    assert.equal(noRole.json().code, "ROLE_REQUIRED");
    // A key without the forecast:write scope.
    const noScope = await f.submit(
      f.agents.readOnly,
      testAccounts.keeper,
      window,
    );
    assert.equal(noScope.statusCode, 403, noScope.body);
    // No key at all.
    const anonymous = await f.post(
      1,
      null,
      f.body(f.message(a, window), "0x00"),
    );
    assert.equal(anonymous.statusCode, 401);
    // The index lags: nothing is admitted whatever else is right.
    f.reader.set({
      health: { headBlock: 100, indexedBlock: 1, lagSeconds: 900, stale: true },
    });
    const stale = await f.submit(f.agents.a, a, window);
    assert.equal(stale.statusCode, 503, stale.body);
    assert.equal(stale.json().code, "INDEX_STALE");
    f.reader.set({
      health: { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: false },
    });
    // The signature check is down.
    f.verifier.setUnavailable(true);
    const down = await f.submit(f.agents.a, a, window);
    assert.equal(down.statusCode, 503, down.body);
    assert.equal(down.json().code, "SIGNATURE_CHECK_UNAVAILABLE");
    f.verifier.setUnavailable(false);
    // The index lags while the check runs.
    f.hooks.whileVerifying = () => {
      f.reader.set({
        health: {
          headBlock: 100,
          indexedBlock: 1,
          lagSeconds: 900,
          stale: true,
        },
      });
    };
    const lagged = await f.submit(f.agents.a, a, window);
    f.hooks.whileVerifying = undefined;
    assert.equal(lagged.statusCode, 503, lagged.body);
    assert.equal(lagged.json().code, "INDEX_STALE");
    assert.deepEqual(await f.stored(), before);
    // Control: with everything healthy again an eligible forecaster is admitted.
    f.reader.set({
      health: { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: false },
    });
    assert.equal((await f.submit(f.agents.c, c, window)).statusCode, 201);
  } finally {
    await f.close();
  }
});

test("the platform holds no signing key: services import no key-to-account helper", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name === "node_modules" || e.name === ".next"
        ? []
        : e.isDirectory()
          ? files(join(dir, e.name))
          : /\.(ts|tsx|mjs)$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
    );
  const sources = [
    ...files("apps"),
    ...readdirSync("packages").flatMap((p) => files(join("packages", p, "src"))),
  ];
  assert.ok(sources.length > 50);
  for (const file of sources)
    assert.doesNotMatch(readFileSync(file, "utf8"), /privateKeyToAccount|mnemonicToAccount/, file);
});
