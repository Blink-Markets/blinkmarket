import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProtocolParams,
  TEST_TOKEN_PRICE_MICROS,
  governorDefaults,
  presets,
} from "../packages/schemas/src/index.ts";

// Copied from contracts/test/protocol/ProtocolBase.sol defaultParams(), in declaration order.
// replayAllowed is true there; the baseSepolia preset turns it off.
const protocolBaseDefaults = {
  registrationFee: "10000000",
  minRoleStake: "100000000",
  roleExitCooldown: 86_400,
  feeBps: 100,
  treasuryShareBps: 3000,
  creatorShareBps: 2500,
  resolutionShareBps: 1500,
  jurorShareBps: 1500,
  bountyShareBps: 1500,
  keeperTipBps: 500,
  creationBondBps: 500,
  proposerBondBps: 500,
  challengeBondBps: 500,
  jurorBondCutBps: 2000,
  maxCreditDiscountBps: 5000,
  creditDiscountStepBps: 100,
  creditMultiplierStepBps: 500,
  maxCreditMultiplierBps: 40_000,
  creatorExposureMultiple: 50_000,
  creationWindow: [3600, 14_400, 86_400],
  firstUseExtraWindow: 3600,
  resultChallengeWindow: [3600, 14_400, 86_400],
  minResultChallengeWindow: [600, 1800, 3600],
  challengeWindowStepSeconds: 60,
  commitSeconds: 3600,
  revealSeconds: 3600,
  appealSeconds: 3600,
  maxRounds: 3,
  quorumBps: [2000, 3000, 4000, 5000],
  nonRevealSlashBps: 1000,
  incoherentSlashBps: 500,
  roleSlashBps: 1000,
  jurorUnstakeCooldown: 172_800,
  securityMultipleBps: 20_000,
  maxMarketPairs: 10_000,
  maxTakerShares: 500,
  maxFillShares: 100,
  creditHalfLife: 2_592_000,
  creditUnitMicros: "100000000",
  creditGainCap: 50,
  creditLossMultiplier: 3,
  classCCreditThreshold: 10,
  roundCreditThreshold: [0, 5, 10, 20],
  phaseInFinalizedMarkets: 3,
  importDiscountBps: 5000,
  replayAllowed: true,
} as const;

test("baseSepolia equals ProtocolBase defaults except replayAllowed", () => {
  assert.deepEqual(
    Object.keys(presets.baseSepolia),
    Object.keys(protocolBaseDefaults),
  );
  for (const [field, value] of Object.entries(protocolBaseDefaults)) {
    const actual =
      presets.baseSepolia[field as keyof typeof presets.baseSepolia];
    if (field === "replayAllowed") assert.equal(actual, false, field);
    else assert.deepEqual(actual, value, field);
  }
  assert.deepEqual(
    ProtocolParams.parse(presets.baseSepolia),
    presets.baseSepolia,
  );
});

test("alpha differs from baseSepolia only in time fields and replayAllowed", () => {
  const diff = Object.keys(presets.alpha).filter(
    (k) =>
      JSON.stringify(presets.alpha[k as keyof typeof presets.alpha]) !==
      JSON.stringify(
        presets.baseSepolia[k as keyof typeof presets.baseSepolia],
      ),
  );
  assert.deepEqual(diff.sort(), [
    "appealSeconds",
    "challengeWindowStepSeconds",
    "commitSeconds",
    "creationWindow",
    "firstUseExtraWindow",
    "jurorUnstakeCooldown",
    "minResultChallengeWindow",
    "replayAllowed",
    "resultChallengeWindow",
    "revealSeconds",
    "roleExitCooldown",
  ]);
  assert.deepEqual(
    {
      roleExitCooldown: presets.alpha.roleExitCooldown,
      jurorUnstakeCooldown: presets.alpha.jurorUnstakeCooldown,
      creationWindow: presets.alpha.creationWindow,
      firstUseExtraWindow: presets.alpha.firstUseExtraWindow,
      resultChallengeWindow: presets.alpha.resultChallengeWindow,
      minResultChallengeWindow: presets.alpha.minResultChallengeWindow,
      challengeWindowStepSeconds: presets.alpha.challengeWindowStepSeconds,
      commitSeconds: presets.alpha.commitSeconds,
      revealSeconds: presets.alpha.revealSeconds,
      appealSeconds: presets.alpha.appealSeconds,
      replayAllowed: presets.alpha.replayAllowed,
    },
    {
      roleExitCooldown: 60,
      jurorUnstakeCooldown: 120,
      creationWindow: [60, 60, 60],
      firstUseExtraWindow: 30,
      resultChallengeWindow: [60, 60, 60],
      minResultChallengeWindow: [30, 30, 30],
      challengeWindowStepSeconds: 1,
      commitSeconds: 30,
      revealSeconds: 30,
      appealSeconds: 30,
      replayAllowed: true,
    },
  );
  // Thresholds, stakes, bonds and caps are untouched (spec 2.1.2): the diff above is the whole story.
  assert.equal(presets.alpha.minRoleStake, presets.baseSepolia.minRoleStake);
  assert.doesNotThrow(() => ProtocolParams.parse(presets.alpha));
});

test("alpha satisfies the R39 arbitration budget", () => {
  const a = presets.alpha;
  const maxGap = 600;
  for (const cls of [0, 1, 2]) {
    const needed =
      a.resultChallengeWindow[cls]! +
      a.maxRounds * (a.commitSeconds + a.revealSeconds + a.appealSeconds);
    // hardDeadline - proposalDeadline must exceed `needed`; some gap <= 600 s must work.
    assert.ok(needed + 1 <= maxGap, `class ${cls}: needs ${needed}s`);
  }
});

test("ProtocolParams rejects an invalid preset", () => {
  assert.equal(
    ProtocolParams.safeParse({ ...presets.alpha, jurorShareBps: 0 }).success,
    false,
    "shares must sum to 10000",
  );
  assert.equal(
    ProtocolParams.safeParse({ ...presets.alpha, maxRounds: 5 }).success,
    false,
  );
  assert.equal(
    ProtocolParams.safeParse({ ...presets.alpha, minRoleStake: "-1" }).success,
    false,
  );
});

test("governor defaults and test token price are fixed", () => {
  assert.deepEqual(governorDefaults, {
    votingDelay: 86_400,
    votingPeriod: 259_200,
    proposalThreshold: "10000000000000000000",
    quorumFraction: 4,
    adoptionDelay: 172_800,
  });
  assert.equal(TEST_TOKEN_PRICE_MICROS, 1_000_000);
});
