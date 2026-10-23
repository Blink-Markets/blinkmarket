// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {QuestionClass, MarketState, Outcome} from "../BlinkTypes.sol";

interface IBlinkMarkets {
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

    struct CreateArgs {
        bytes32 templateId;
        bytes32 specHash;
        string specURI;
        bool replay;
        uint64 closeAt;
        uint64 proposalDeadline;
        uint64 hardDeadline;
        uint64 maxPairs;
    }

    struct Market {
        address creator;
        QuestionClass cls;
        MarketState state;
        Outcome finalOutcome; // meaningful only once state == FINAL
        bool replay;
        bool creationChallenged; // a creation challenge is pending
        bool feesDistributed;
        bytes32 templateId;
        bytes32 specHash;
        uint64 openAt;
        uint64 closeAt;
        uint64 proposalDeadline;
        uint64 hardDeadline;
        uint64 maxPairs;
        uint256 totalMintedPairs;
        uint256 escrowMicros;
        uint256 creationBond; // held by markets; zero once returned or paid out
    }

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        bytes32 indexed specHash,
        string specURI,
        bytes32 templateId,
        QuestionClass cls,
        bool replay,
        uint64 openAt,
        uint64 closeAt,
        uint64 proposalDeadline,
        uint64 hardDeadline,
        uint64 maxPairs,
        uint256 creationBond
    );

    event QuoteFilled(
        uint256 indexed marketId,
        bytes32 indexed digest,
        address maker,
        address indexed taker,
        uint8 side,
        uint64 quantity,
        uint16 priceBps,
        uint256 takerCost,
        uint256 makerCost,
        uint256 fee
    );

    // creation
    function registerTemplate(QuestionClass cls, bytes32 parserHash, string calldata uri)
        external
        returns (bytes32 templateId);
    function createMarket(CreateArgs calldata a) external returns (uint256 id);
    function open(uint256 id) external;
    function getMarket(uint256 id) external view returns (Market memory);
    function specURI(uint256 id) external view returns (string memory);
    function maxPayout(uint256 id) external view returns (uint256);
    function openPayoutTotal() external view returns (uint256);
    function openPayoutByCreator(address creator) external view returns (uint256);
    function finalizedCount() external view returns (uint256);

    // hooks, resolution only
    function markCreationChallenged(uint256 id) external;
    function resolveCreation(uint256 id, bool upheld, address challenger) external;
    function setProposed(uint256 id) external;
    function setDisputed(uint256 id) external;
    function finalize(uint256 id, Outcome outcome) external;

    // trading
    function depositMaker(uint256 amount) external;
    function withdrawMaker(uint256 amount) external;
    function makerFree(address maker) external view returns (uint256);
    function fillQuote(Quote calldata q, bytes calldata sig) external;
    function cancelQuote(Quote calldata q) external;
    function incrementMakerEpoch() external;
    function makerEpoch(address maker) external view returns (uint256);
    function getPosition(uint256 id, address account) external view returns (uint256 yesShares, uint256 noShares);

    // settlement
    function feePool(uint256 id) external view returns (uint256);
    function distributeFees(uint256 id) external;
    function redeem(uint256 id) external;
}
