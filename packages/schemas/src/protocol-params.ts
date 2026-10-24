import { z } from "zod";
import { Uint256 } from "./core.ts";

const uint = (max: number) => z.number().int().min(0).max(max);
const u8 = uint(0xff);
const u16 = uint(0xffff);
const u32 = uint(0xffff_ffff);
// uint64 on chain; a JSON number is exact up to 2^53, far beyond any window or cap used here.
const u64 = uint(Number.MAX_SAFE_INTEGER);
const perClass = z.tuple([u64, u64, u64]);
const SHARE_DENOMINATOR = 10_000;

// Every field of Solidity `Params` (contracts/src/protocol/BlinkTypes.sol), in declaration order.
// Times are seconds; uint256 values are decimal strings.
export const ProtocolParams = z
  .strictObject({
    registrationFee: Uint256,
    minRoleStake: Uint256,
    roleExitCooldown: u64,
    feeBps: u16,
    treasuryShareBps: u16,
    creatorShareBps: u16,
    resolutionShareBps: u16,
    jurorShareBps: u16,
    bountyShareBps: u16,
    keeperTipBps: u16,
    creationBondBps: u16,
    proposerBondBps: u16,
    challengeBondBps: u16,
    jurorBondCutBps: u16,
    maxCreditDiscountBps: u16,
    creditDiscountStepBps: u16,
    creditMultiplierStepBps: u16,
    maxCreditMultiplierBps: u16,
    creatorExposureMultiple: u16,
    creationWindow: perClass,
    firstUseExtraWindow: u64,
    resultChallengeWindow: perClass,
    minResultChallengeWindow: perClass,
    challengeWindowStepSeconds: u64,
    commitSeconds: u64,
    revealSeconds: u64,
    appealSeconds: u64,
    maxRounds: u8.max(4),
    quorumBps: z.tuple([u16, u16, u16, u16]),
    nonRevealSlashBps: u16,
    incoherentSlashBps: u16,
    roleSlashBps: u16,
    jurorUnstakeCooldown: u64,
    securityMultipleBps: u16,
    maxMarketPairs: u64,
    maxTakerShares: u64,
    maxFillShares: u64,
    creditHalfLife: u64,
    creditUnitMicros: Uint256,
    creditGainCap: u32,
    creditLossMultiplier: u8,
    classCCreditThreshold: u32,
    roundCreditThreshold: z.tuple([u32, u32, u32, u32]),
    phaseInFinalizedMarkets: u32,
    importDiscountBps: u16,
    replayAllowed: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const shares =
      p.treasuryShareBps +
      p.creatorShareBps +
      p.resolutionShareBps +
      p.jurorShareBps +
      p.bountyShareBps;
    if (shares !== SHARE_DENOMINATOR)
      ctx.addIssue({ code: "custom", message: "Fee shares must sum to 10000" });
    p.minResultChallengeWindow.forEach((min, cls) => {
      if (min > p.resultChallengeWindow[cls]!)
        ctx.addIssue({
          code: "custom",
          message: `minResultChallengeWindow[${cls}] exceeds resultChallengeWindow`,
        });
    });
  });
export type ProtocolParams = z.infer<typeof ProtocolParams>;

// ProtocolBase.defaultParams() with REPLAY off: the Base Sepolia generation parameters.
const baseSepolia: ProtocolParams = {
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
  replayAllowed: false,
};

// Same thresholds, stakes, bonds and caps; only the clocks are short so a full arbitration fits in
// a 10 minute market (R39 budget: 60 + 3 x 90 = 330 s) and REPLAY is on (spec 2.1.2, 5.0).
const alpha: ProtocolParams = {
  ...baseSepolia,
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
};

export const presets = { baseSepolia, alpha } as const;

export const GovernorSettings = z.strictObject({
  votingDelay: u64,
  votingPeriod: u64,
  proposalThreshold: Uint256,
  quorumFraction: uint(100),
  adoptionDelay: u64,
});
export type GovernorSettings = z.infer<typeof GovernorSettings>;

export const governorDefaults: GovernorSettings = {
  votingDelay: 86_400,
  votingPeriod: 259_200,
  proposalThreshold: "10000000000000000000",
  quorumFraction: 4,
  adoptionDelay: 172_800,
};

/** bUSD micros per whole platform token for the immutable FixedPriceSource. */
export const TEST_TOKEN_PRICE_MICROS = 1_000_000;
