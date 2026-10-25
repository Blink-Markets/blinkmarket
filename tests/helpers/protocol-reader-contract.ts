import assert from "node:assert/strict";
import type { ProtocolReader } from "../../packages/ports/src/index.ts";
import {
  RoleName,
  type ProtocolAccount,
  type ProtocolMarket,
} from "../../packages/schemas/src/index.ts";
import { address, hash, readMarket } from "./protocol-index.ts";
import type { FakeProtocolState } from "./protocol-reader.ts";
export function readerContractState(): Partial<FakeProtocolState> {
  const account: ProtocolAccount = {
    address: address(1),
    registered: true,
    roles: Object.fromEntries(
      RoleName.options.map((role) => [
        role,
        {
          stakeMicros: role === "MAKER" ? "100000000" : "99999999",
          active: true,
          exitRequestedAt: null,
          openObligations: 0,
        },
      ]),
    ) as ProtocolAccount["roles"],
    credit: Object.fromEntries(
      RoleName.options.map((role) => [role, { value: 100, updatedAt: 1000 }]),
    ) as ProtocolAccount["credit"],
  };
  return {
    accounts: [account],
    markets: [
      readMarket(1),
      readMarket(2, { state: "FINAL" }),
      readMarket(3),
    ] as ProtocolMarket[],
    makers: [{ address: address(1), freeMicros: "123", epoch: "2" }],
    digests: { [hash(5)]: "CONSUMED", [hash(6)]: "CANCELLED" },
    anchors: [{ root: hash(7), by: address(1), anchoredAt: 1000 }],
  };
}
export async function assertReaderContract(reader: ProtocolReader) {
  assert.equal(
    (await reader.account(address(1).toUpperCase()))?.registered,
    true,
  );
  assert.equal(await reader.account(address(99)), null);
  assert.equal(await reader.hasRole(address(1), "MAKER"), true);
  assert.equal(await reader.hasRole(address(1), "TAKER"), false);
  assert.equal(await reader.hasRole(address(1), "JUROR"), true);
  assert.equal(await reader.hasRole(address(99), "JUROR"), false);
  for (const [elapsed, value] of [
    [0, 100],
    [2592000, 50],
    [6480000, 25],
    [103680000, 0],
  ] as const)
    assert.equal(
      await reader.creditAt(address(1), "MAKER", 1000 + elapsed),
      value,
    );
  assert.equal((await reader.market("1"))?.marketId, "1");
  assert.equal(await reader.market("99"), null);
  assert.equal(
    (await reader.marketBySpecHash(hash(2).toUpperCase()))?.marketId,
    "2",
  );
  assert.equal((await reader.markets({ limit: 1001 })).items.length, 3);
  const page = await reader.markets({ limit: 2 });
  assert.deepEqual(
    page.items.map((m) => m.marketId),
    ["1", "2"],
  );
  assert.equal(page.next, "2");
  assert.deepEqual(
    (await reader.markets({ limit: 2, after: page.next! })).items.map(
      (m) => m.marketId,
    ),
    ["3"],
  );
  assert.deepEqual(
    (await reader.markets({ limit: 2, states: ["FINAL"] })).items.map(
      (m) => m.marketId,
    ),
    ["2"],
  );
  assert.equal((await reader.maker(address(1))).freeMicros, "123");
  assert.equal((await reader.maker(address(99))).epoch, "0");
  assert.equal(await reader.digest(hash(5)), "CONSUMED");
  assert.equal(await reader.digest(hash(6)), "CANCELLED");
  assert.equal(await reader.digest(hash(99)), "UNUSED");
  assert.equal((await reader.anchor(hash(7)))?.anchoredAt, 1000);
  assert.equal(await reader.anchor(hash(99)), null);
}
