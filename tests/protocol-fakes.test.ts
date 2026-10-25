import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { SignatureCheckUnavailable } from "../packages/ports/src/index.ts";
import {
  RoleName,
  type ProtocolAccount,
  type ProtocolMarket,
} from "../packages/schemas/src/index.ts";
import { fakeProtocolReader } from "./helpers/protocol-reader.ts";
import { fakeSignatureVerifier } from "./helpers/signature-verifier.ts";

const alice = "0x00000000000000000000000000000000000000a1";
const noRole = {
  stakeMicros: "0",
  active: false,
  exitRequestedAt: null,
  openObligations: 0,
};
const account: ProtocolAccount = {
  address: alice,
  registered: true,
  roles: {
    ...Object.fromEntries(RoleName.options.map((r) => [r, { ...noRole }])),
    MAKER: {
      stakeMicros: "100000000",
      active: true,
      exitRequestedAt: null,
      openObligations: 0,
    },
    TAKER: {
      stakeMicros: "99999999",
      active: true,
      exitRequestedAt: null,
      openObligations: 0,
    },
  } as ProtocolAccount["roles"],
  credit: {
    ...Object.fromEntries(
      RoleName.options.map((r) => [r, { value: 0, updatedAt: 0 }]),
    ),
    MAKER: { value: 40, updatedAt: 1000 },
  } as ProtocolAccount["credit"],
};
const market = (
  id: string,
  state: ProtocolMarket["state"],
): ProtocolMarket => ({
  marketId: id,
  creator: alice,
  class: "B",
  state,
  templateId: "0x" + "1".repeat(64),
  specHash: "0x" + id.padStart(64, "0"),
  specUri: "ipfs://x",
  replay: false,
  openAt: 1,
  closeAt: 2,
  proposalDeadline: 3,
  hardDeadline: 4,
  maxPairs: "10",
  mintedPairs: "0",
  escrowMicros: "0",
  feePoolMicros: "0",
  finalOutcome: null,
  feesDistributed: false,
  creationChallenged: false,
});

test("fakeProtocolReader mirrors registry role and credit-decay rules", async () => {
  const reader = fakeProtocolReader({ accounts: [account] });
  assert.equal(await reader.hasRole(alice, "MAKER"), true);
  assert.equal(
    await reader.hasRole(alice, "TAKER"),
    false,
    "stake below minRoleStake",
  );
  assert.equal(
    await reader.hasRole(alice, "JUROR"),
    true,
    "registration is enough",
  );
  const half = 2_592_000;
  assert.equal(await reader.creditAt(alice, "MAKER", 1000 + half - 1), 40);
  assert.equal(await reader.creditAt(alice, "MAKER", 1000 + half), 20);
  assert.equal(await reader.creditAt(alice, "MAKER", 1000 + 3 * half), 5);
  assert.equal(await reader.creditAt(alice, "MAKER", 1000 + 32 * half), 0);
  assert.equal(await reader.hasRole("0x" + "9".repeat(40), "MAKER"), false);
});

test("fakeProtocolReader pages markets and exposes settable health", async () => {
  const reader = fakeProtocolReader({
    markets: [market("3", "OPEN"), market("1", "OPEN"), market("2", "FINAL")],
  });
  const first = await reader.markets({ limit: 2 });
  assert.deepEqual(
    first.items.map((m) => m.marketId),
    ["1", "2"],
  );
  assert.equal(first.next, "2");
  const rest = await reader.markets({ limit: 2, after: first.next! });
  assert.deepEqual(
    rest.items.map((m) => m.marketId),
    ["3"],
  );
  assert.equal(rest.next, null);
  assert.deepEqual(
    (await reader.markets({ states: ["FINAL"], limit: 5 })).items.map(
      (m) => m.marketId,
    ),
    ["2"],
  );
  reader.set({
    health: { headBlock: 9, indexedBlock: 1, lagSeconds: 99, stale: true },
  });
  assert.equal((await reader.health()).stale, true);
  assert.equal(await reader.digest("0x" + "a".repeat(64)), "UNUSED");
});

test("fakeSignatureVerifier recovers EOAs, honours listed wallets and can go unavailable", async () => {
  const owner = privateKeyToAccount(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  const wallet = "0x00000000000000000000000000000000000000b2";
  const verifier = fakeSignatureVerifier({
    contractWallets: { [wallet]: owner.address },
  });
  const signature = await owner.signMessage({ message: "hi" });
  assert.equal(
    (
      await verifier.verifyMessage({
        address: owner.address,
        message: "hi",
        signature,
      })
    ).valid,
    true,
  );
  assert.equal(
    (
      await verifier.verifyMessage({
        address: wallet,
        message: "hi",
        signature,
      })
    ).valid,
    true,
  );
  assert.equal(
    (await verifier.verifyMessage({ address: alice, message: "hi", signature }))
      .valid,
    false,
  );
  verifier.setUnavailable(true);
  await assert.rejects(
    verifier.verifyMessage({ address: alice, message: "hi", signature }),
    SignatureCheckUnavailable,
  );
});

test("fakeProtocolReader passes the shared indexed-reader contract", async () => {
  const { assertReaderContract, readerContractState } =
    await import("./helpers/protocol-reader-contract.ts");
  await assertReaderContract(fakeProtocolReader(readerContractState()));
});
