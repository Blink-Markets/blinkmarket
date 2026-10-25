import assert from "node:assert/strict";
import type { ProtocolReader } from "../../packages/ports/src/index.ts";
import {
  RoleName,
  type FeeBreakdown,
  type JurorState,
  type ProtocolAccount,
  type ProtocolDispute,
  type ProtocolMarket,
  type ProtocolProposal,
  type ProtocolRound,
  type ProtocolVote,
} from "../../packages/schemas/src/index.ts";
import { address, hash, readMarket } from "./protocol-index.ts";
import type { ProtocolPosition } from "../../packages/ports/src/index.ts";
import type { FakeProtocolState } from "./protocol-reader.ts";
const dispute = (disputeId: string, marketId: string): ProtocolDispute => ({
  disputeId,
  marketId,
  kind: "RESULT",
  ground: 0,
  challenger: address(6),
  evidenceHash: hash(12),
  currentRound: 1,
  appealRound: 0,
  settled: false,
  timedOut: false,
  finalChoice: null,
});
const round = (disputeId: string, n: number): ProtocolRound => ({
  disputeId,
  round: n,
  level: 0,
  snapshotAt: 100 + n,
  commitEnd: 200 + n,
  revealEnd: 300 + n,
  appealEnd: 400 + n,
  committedWeight: "150",
  revealedWeight: ["0", "100"],
  committers: 2,
  revealers: 1,
  leadingChoice: 0,
  restarted: n === 0,
  settled: false,
  creditThreshold: 0,
});
const vote = (
  n: number,
  juror: string,
  revealed: boolean,
  choice: 0 | 1 | null,
): ProtocolVote => ({
  disputeId: "9",
  round: n,
  juror,
  weight: "50",
  revealed,
  choice,
  settled: false,
  slashed: "0",
  reward: "0",
});
/** What the real tables also hold: the reward-stream checkpoint the reader never serves. */
export const jurorRow = (j: JurorState) => ({ ...j, rewardPaid: "7" });
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
    proposals: [
      {
        marketId: "1",
        proposer: address(5),
        outcome: "YES",
        bondMicros: "5000000",
        challengeEnd: 2160,
        evidenceHash: hash(11),
        evidenceUri: "ipfs://evidence",
        proposedAt: 2100,
      } satisfies ProtocolProposal,
    ],
    // Ids 9 and 10 sort differently as text and as numbers; rounds and votes are given out of order.
    disputes: [dispute("10", "1"), dispute("9", "1"), dispute("3", "2")],
    rounds: [round("9", 1), round("9", 0)],
    // The unrevealed votes carry a choice here that no reader may show.
    votes: [
      vote(1, address(7), false, 1),
      vote(0, address(8), false, 0),
      vote(0, address(7), true, 1),
    ],
    jurors: [
      {
        address: address(7),
        staked: "1000",
        pendingUnstake: "200",
        unstakeReadyAt: 5000,
        openVotes: 2,
        rewardsOwed: "30",
      },
    ],
    fees: [
      {
        marketId: "2",
        poolMicros: "1001",
        treasury: "301",
        creator: "250",
        resolution: "143",
        keeperTip: "7",
        keeper: address(9),
        jurors: "300",
        bounty: "0",
        bountyWinner: null,
      } satisfies FeeBreakdown,
    ],
    templates: [
      { templateId: hash(4), class: "A", parserHash: hash(6), uri: "ipfs://b" },
      { templateId: hash(3), class: "B", parserHash: hash(6), uri: "ipfs://a" },
    ],
    positions: (["10", "2", "3"] as const).map(
      (marketId): ProtocolPosition => ({
        marketId,
        account: address(1),
        yesShares: "5",
        noShares: "0",
        takerBoughtShares: "5",
        redeemedPayoutMicros: "0",
      }),
    ),
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
  // Task 7 read models: numeric order, stable keyset pages, sealed votes, no internal columns.
  assert.equal((await reader.proposal("1"))?.proposer, address(5));
  assert.equal(await reader.proposal("2"), null);
  const disputes = await reader.disputes("1", { limit: 1 });
  assert.deepEqual(disputes.items.map((d) => d.disputeId), ["9"]);
  assert.equal(disputes.next, "9");
  assert.deepEqual(
    (await reader.disputes("1", { limit: 5, after: "9" })).items.map(
      (d) => d.disputeId,
    ),
    ["10"],
  );
  assert.equal((await reader.disputes("1", { limit: 5, after: "10" })).next, null);
  assert.deepEqual((await reader.disputes("7", { limit: 5 })).items, []);
  assert.equal((await reader.dispute("3"))?.marketId, "2");
  assert.equal(await reader.dispute("99"), null);
  assert.deepEqual((await reader.rounds("9")).map((r) => r.round), [0, 1]);
  assert.deepEqual(await reader.rounds("10"), []);
  const first = await reader.votes("9", { limit: 2 });
  assert.deepEqual(first.items.map((v) => `${v.round}:${v.juror}`), [
    `0:${address(7)}`,
    `0:${address(8)}`,
  ]);
  assert.equal(first.next, `0:${address(8)}`);
  const rest = await reader.votes("9", { limit: 2, after: first.next! });
  assert.deepEqual(rest.items.map((v) => `${v.round}:${v.juror}`), [
    `1:${address(7)}`,
  ]);
  assert.equal(rest.next, null);
  assert.deepEqual(
    (await reader.votes("9", { limit: 9, round: 1 })).items.map((v) => v.round),
    [1],
  );
  for (const v of [...first.items, ...rest.items])
    assert.equal(v.choice, v.revealed ? 1 : null, "unrevealed votes stay sealed");
  const juror = await reader.juror(address(7).toUpperCase());
  assert.equal(juror?.pendingUnstake, "200");
  assert.equal(juror && "rewardPaid" in juror, false);
  assert.equal(await reader.juror(address(99)), null);
  assert.equal((await reader.fees("2"))?.treasury, "301");
  assert.equal(await reader.fees("1"), null);
  const templates = await reader.templates({ limit: 1 });
  assert.deepEqual(templates.items.map((t) => t.templateId), [hash(3)]);
  assert.deepEqual(
    (await reader.templates({ limit: 5, after: templates.next! })).items.map(
      (t) => t.templateId,
    ),
    [hash(4)],
  );
  const positions = await reader.positions(address(1).toUpperCase(), { limit: 2 });
  assert.deepEqual(positions.items.map((p) => p.marketId), ["2", "3"]);
  assert.deepEqual(
    (await reader.positions(address(1), { limit: 2, after: positions.next! })).items.map(
      (p) => p.marketId,
    ),
    ["10"],
  );
  assert.deepEqual((await reader.positions(address(99), { limit: 2 })).items, []);
}
