// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Outcome} from "../BlinkTypes.sol";

interface IBlinkResolution {
    event RoundRestarted(uint256 indexed disputeId, uint8 round, uint64 snapshotAt);

    // proposals and challenges
    function propose(uint256 id, Outcome o, bytes32 evidenceHash, string calldata evidenceURI) external;
    function challengeResult(uint256 id, bytes32 evidenceHash) external returns (uint256 disputeId);
    function challengeCreation(uint256 id, uint8 ground, bytes32 evidenceHash) external returns (uint256 disputeId);
    function finalizeUnchallenged(uint256 id) external;
    function finalizeTimeout(uint256 id) external;

    // commit-reveal rounds and appeals
    function commitVote(uint256 disputeId, bytes32 commitment) external;
    function revealVote(uint256 disputeId, uint8 choice, bytes32 salt) external;
    function settleRound(uint256 disputeId) external;
    function appeal(uint256 disputeId) external;
    function finalizeDispute(uint256 disputeId) external;

    // views read by BlinkMarkets
    function proposerOf(uint256 id) external view returns (address);
    function proposedOutcome(uint256 id) external view returns (Outcome);
    function bountyWinner(uint256 id) external view returns (address);
}
