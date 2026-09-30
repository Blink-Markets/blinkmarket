// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Blink v0.1 non-upgradeable, fully collateralized test-market protocol.
interface IBlinkMarket {
    enum Mode {
        LIVE,
        REPLAY
    }
    enum Side {
        YES,
        NO
    }
    enum Outcome {
        YES,
        NO,
        INVALID
    }
    enum State {
        OPEN,
        PROPOSED,
        DISPUTED,
        FINAL
    }
    enum FinalizationReason {
        UNCHALLENGED,
        ARBITRATED,
        TIMEOUT
    }

    struct Quote {
        uint256 marketId;
        bytes32 specHash;
        address maker;
        address taker;
        uint8 side;
        uint64 quantity;
        uint16 priceBps;
        uint64 validAfter;
        uint64 expiresAt;
        uint256 nonce;
        uint256 epoch;
    }

    struct Market {
        bytes32 specHash;
        string specURI;
        Mode mode;
        uint64 closeAt;
        uint64 proposalDeadline;
        uint64 hardDeadline;
        uint32 challengeSeconds;
        uint64 maxPairs;
        uint64 maxTakerShares;
        State state;
        bool paused;
        uint64 proposedAt;
        Outcome proposedOutcome;
        Outcome finalOutcome;
        bytes32 proposalEvidenceHash;
        bytes32 challengeEvidenceHash;
        bytes32 finalEvidenceHash;
        uint256 totalMintedPairs;
        uint256 escrowMicros;
    }
    event MarketCreated(
        uint256 indexed marketId,
        bytes32 indexed specHash,
        string specURI,
        Mode mode,
        uint64 closeAt,
        uint64 proposalDeadline,
        uint64 hardDeadline,
        uint32 challengeSeconds,
        uint64 maxPairs,
        uint64 maxTakerShares
    );
    event TradingPauseChanged(uint256 indexed marketId, bool globalPause, bool paused);
    event TakerAllowedChanged(address indexed account, bool allowed);
    event MakerDeposited(uint256 amountMicros);
    event MakerWithdrawn(uint256 amountMicros);
    event QuoteFilled(
        uint256 indexed marketId,
        bytes32 indexed digest,
        address maker,
        address indexed taker,
        uint8 side,
        uint64 quantity,
        uint16 priceBps,
        uint256 takerCost,
        uint256 makerCost
    );
    event QuoteCancelled(bytes32 indexed digest);
    event MakerEpochIncremented(uint256 epoch);
    event OutcomeProposed(uint256 indexed marketId, Outcome outcome, bytes32 evidenceHash);
    event OutcomeChallenged(uint256 indexed marketId, bytes32 evidenceHash);
    event OutcomeFinalized(uint256 indexed marketId, Outcome outcome, FinalizationReason reason, bytes32 evidenceHash);
    event PositionRedeemed(
        uint256 indexed marketId, address indexed account, uint256 yesShares, uint256 noShares, uint256 payoutMicros
    );
    function createMarket(
        bytes32 specHash,
        string calldata specURI,
        Mode mode,
        uint64 closeAt,
        uint64 proposalDeadline,
        uint64 hardDeadline,
        uint32 challengeSeconds,
        uint64 maxPairs,
        uint64 maxTakerShares
    ) external returns (uint256);
    function setGlobalTradingPaused(bool paused) external;
    function setMarketTradingPaused(uint256 marketId, bool paused) external;
    function setTakerAllowed(address account, bool allowed) external;
    function depositMaker(uint256 amountMicros) external;
    function withdrawMaker(uint256 amountMicros) external;
    function fillQuote(Quote calldata quote, bytes calldata signature) external;
    function cancelQuote(Quote calldata quote) external;
    function incrementMakerEpoch() external;
    function proposeOutcome(uint256 marketId, Outcome outcome, bytes32 evidenceHash) external;
    function challengeOutcome(uint256 marketId, bytes32 evidenceHash) external;
    function finalizeUnchallenged(uint256 marketId) external;
    function arbitrate(uint256 marketId, Outcome outcome, bytes32 decisionEvidenceHash) external;
    function finalizeTimeout(uint256 marketId) external;
    function redeem(uint256 marketId) external;
    function getMarket(uint256 marketId) external view returns (Market memory);
    function getPosition(uint256 marketId, address account) external view returns (uint256 yesShares, uint256 noShares);
    function hashQuote(Quote calldata quote) external view returns (bytes32);
    function makerFreeBalance() external view returns (uint256);
    function currentMakerEpoch() external view returns (uint256);
    function consumed(bytes32 digest) external view returns (bool);
    function cancelled(bytes32 digest) external view returns (bool);
}
