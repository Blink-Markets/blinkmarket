// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

enum Role { CREATOR, MAKER, TAKER, FORECASTER, PROPOSER, CHALLENGER, JUROR }
enum QuestionClass { A_COMPUTABLE, B_VERIFIABLE, C_JUDGMENT }
enum MarketState { PENDING, OPEN, PROPOSED, DISPUTED, FINAL, CANCELLED }
enum Outcome { YES, NO, INVALID }
enum DisputeKind { CREATION, RESULT }

struct GenerationAddresses {
    address registry; address jurors; address markets; address resolution; // this generation, predicted
    address collateral; address token; address priceSource; address treasury; address previousRegistry; // pre-existing (previousRegistry may be 0)
}

struct Params {
    uint256 registrationFee;        // bUSD micros, paid to treasury, not refundable
    uint256 minRoleStake;           // bUSD micros per role (JUROR excluded: juror stake is the token)
    uint64 roleExitCooldown;
    uint16 feeBps;                  // charged on the taker payment
    uint16 treasuryShareBps; uint16 creatorShareBps; uint16 resolutionShareBps; uint16 jurorShareBps; uint16 bountyShareBps; // sum == 10000
    uint16 keeperTipBps;            // of the resolution share, to whoever distributes
    uint16 creationBondBps; uint16 proposerBondBps; uint16 challengeBondBps; // of maxPayout
    uint16 jurorBondCutBps;         // of every losing bond, to coherent jurors
    uint16 maxCreditDiscountBps;    // bonds never fall below (10000 - this) of base
    uint16 creditDiscountStepBps;   // discount per credit point
    uint16 creditMultiplierStepBps; uint16 maxCreditMultiplierBps; // limit multiplier, starts at 10000
    uint16 creatorExposureMultiple; // open maxPayout per creator <= roleStake * multiplier * this / 10000
    uint64[3] creationWindow;       // per class
    uint64 firstUseExtraWindow;
    uint64[3] resultChallengeWindow; uint64[3] minResultChallengeWindow; uint64 challengeWindowStepSeconds;
    uint64 commitSeconds; uint64 revealSeconds; uint64 appealSeconds;
    uint8 maxRounds;                // <= 4
    uint16[4] quorumBps;            // of snapshot total stake, per round
    uint16 nonRevealSlashBps; uint16 incoherentSlashBps; uint16 roleSlashBps;
    uint64 jurorUnstakeCooldown;
    uint16 securityMultipleBps;     // attackCost * 10000 >= openPayout * this
    uint64 maxMarketPairs; uint64 maxTakerShares; uint64 maxFillShares;
    uint64 creditHalfLife; uint256 creditUnitMicros; uint32 creditGainCap; uint8 creditLossMultiplier;
    uint32 classCCreditThreshold; uint32[4] roundCreditThreshold; uint32 phaseInFinalizedMarkets;
    uint16 importDiscountBps;
    bool replayAllowed;
}
