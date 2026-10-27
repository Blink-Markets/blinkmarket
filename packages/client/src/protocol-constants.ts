import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

// Copied from the enums of contracts/src/protocol/BlinkTypes.sol, in declaration order.
// tests/client-agent-kit.test.ts parses that file and fails if these drift.
export const ROLE = {
  CREATOR: 0,
  MAKER: 1,
  TAKER: 2,
  FORECASTER: 3,
  PROPOSER: 4,
  CHALLENGER: 5,
  JUROR: 6,
} as const;
export const QUESTION_CLASS = {
  A_COMPUTABLE: 0,
  B_VERIFIABLE: 1,
  C_JUDGMENT: 2,
} as const;
export const MARKET_STATE = {
  PENDING: 0,
  OPEN: 1,
  PROPOSED: 2,
  DISPUTED: 3,
  FINAL: 4,
  CANCELLED: 5,
} as const;
export const OUTCOME = { YES: 0, NO: 1, INVALID: 2 } as const;

/**
 * The `ground` argument of `challengeCreation`, in the order of spec section 5.3: the wrong class,
 * an ambiguous spec, a result participants can influence. The contract only requires `ground < 3`,
 * so this order is a Blink P3 convention that the documentation states, not a protocol rule.
 */
export const CREATION_GROUND = {
  WRONG_CLASS: 0,
  AMBIGUOUS: 1,
  MANIPULABLE: 2,
} as const;

/**
 * What a juror commits and later reveals: keccak256(abi.encode(disputeId, round, juror, choice,
 * salt)), the hash BlinkResolution.revealVote recomputes with the dispute's current round.
 */
export function voteCommitment(input: {
  disputeId: bigint;
  round: bigint;
  juror: Address;
  choice: number;
  salt: Hex;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "uint8" },
        { type: "bytes32" },
      ],
      [input.disputeId, input.round, input.juror, input.choice, input.salt],
    ),
  );
}

/** The id BlinkMarkets.registerTemplate gives a template: keccak256(abi.encode(cls, parserHash, uri)). */
export function templateIdFor(cls: number, parserHash: Hex, uri: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint8" }, { type: "bytes32" }, { type: "string" }],
      [cls, parserHash, uri],
    ),
  );
}
