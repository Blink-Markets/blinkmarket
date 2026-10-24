// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Outcome, DisputeKind} from "../BlinkTypes.sol";

interface IBlinkResolution {
    struct Dispute {
        uint256 marketId;
        address challenger;
        uint256 bond;
        DisputeKind kind;
        uint8 ground;
        bytes32 evidenceHash;
        bool settled;
        bool timedOut;
        uint256 currentRound; // unique attempt number, including restarts
        uint8 appealRound; // parameter index, unchanged on restart
        uint256 lastBond;
    }

    struct Round {
        uint64 snapshotAt;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 appealEnd;
        uint256 committedWeight;
        uint256[3] revealedWeight;
        uint256 committers;
        uint256 revealers;
        uint256[3] revealersByChoice;
        uint8 leadingChoice;
        uint8 level;
        uint32 creditThreshold;
        bool settled;
        bool restarted;
    }

    event RoundRestarted(uint256 indexed disputeId, uint256 indexed round, uint8 appealRound, uint64 snapshotAt);

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
    function settleVote(uint256 disputeId, uint256 round, address juror) external;
    function getDispute(uint256 disputeId) external view returns (Dispute memory dispute, Round memory round);
    function appeal(uint256 disputeId) external;
    function finalizeDispute(uint256 disputeId) external;

    // views read by BlinkMarkets
    function proposerOf(uint256 id) external view returns (address);
    function proposedOutcome(uint256 id) external view returns (Outcome);
    function bountyWinner(uint256 id) external view returns (address);
}
