// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkResolution} from "./interfaces/IBlinkResolution.sol";
import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {IBlinkJurors} from "./interfaces/IBlinkJurors.sol";
import {Role, MarketState, Outcome, DisputeKind, Params, GenerationAddresses} from "./BlinkTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BlinkResolution is IBlinkResolution, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error WrongChain();
    error WrongAddress();
    error MissingRole();
    error InvalidState();
    error DeadlineViolation();
    error MissingEvidence();
    error InvalidOutcome();
    error SelfChallenge();
    error UnknownGround();
    error DisputeRoundsPending();

    event Proposed(
        uint256 indexed id,
        address indexed proposer,
        Outcome outcome,
        uint256 bond,
        uint256 challengeEnd,
        bytes32 evidenceHash,
        string evidenceURI
    );
    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed marketId,
        address indexed challenger,
        DisputeKind kind,
        uint256 bond,
        uint8 ground,
        bytes32 evidenceHash
    );
    event UnchallengedFinalized(uint256 indexed id, address indexed proposer, Outcome outcome, uint256 returnedBond);
    event TimeoutFinalized(uint256 indexed id, uint256 returnedBond, uint256 forfeitedBonds);

    struct Proposal {
        address proposer;
        Outcome outcome;
        uint256 bond;
        uint256 challengeEnd;
    }

    struct Dispute {
        uint256 marketId;
        address challenger;
        uint256 bond;
        DisputeKind kind;
        uint8 ground;
        bytes32 evidenceHash;
        bool settled;
    }

    uint256 public constant UNIT = 1_000_000;
    uint256 private constant BPS = 10_000;
    IBlinkRegistry public immutable registry;
    IBlinkMarkets public immutable markets;
    IBlinkJurors public immutable jurors;
    IERC20 public immutable collateral;

    mapping(uint256 => Proposal) internal _proposals;
    mapping(uint256 => Dispute) internal _disputes;
    mapping(uint256 => uint256) internal _marketDispute;
    mapping(uint256 => address) public bountyWinner;
    uint256 internal _nextDisputeId = 1;

    constructor(GenerationAddresses memory a) {
        if (block.chainid != 84532) revert WrongChain();
        if (
            a.resolution != address(this) || a.registry == address(0) || a.markets == address(0)
                || a.jurors == address(0) || a.collateral == address(0)
        ) revert WrongAddress();
        registry = IBlinkRegistry(a.registry);
        markets = IBlinkMarkets(a.markets);
        jurors = IBlinkJurors(a.jurors);
        collateral = IERC20(a.collateral);
    }

    function propose(uint256 id, Outcome o, bytes32 evidenceHash, string calldata evidenceURI) external nonReentrant {
        if (!registry.hasRole(msg.sender, Role.PROPOSER)) revert MissingRole();
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.OPEN || _proposals[id].proposer != address(0)) revert InvalidState();
        if (block.timestamp < m.closeAt || block.timestamp >= m.proposalDeadline) revert DeadlineViolation();
        if (evidenceHash == bytes32(0) || bytes(evidenceURI).length == 0) revert MissingEvidence();
        if (o == Outcome.INVALID) revert InvalidOutcome();

        Params memory p = registry.params();
        uint256 bond = registry.bondFor(msg.sender, Role.PROPOSER, markets.maxPayout(id) * p.proposerBondBps / BPS);
        uint256 window = p.resultChallengeWindow[uint256(m.cls)];
        uint256 minimum = p.minResultChallengeWindow[uint256(m.cls)];
        uint256 reduction = registry.creditOf(msg.sender, Role.PROPOSER) * p.challengeWindowStepSeconds;
        window = reduction >= window - minimum ? minimum : window - reduction;
        uint256 challengeEnd = block.timestamp + window;
        _proposals[id] = Proposal(msg.sender, o, bond, challengeEnd);
        registry.lockRole(msg.sender, Role.PROPOSER);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        markets.setProposed(id);
        emit Proposed(id, msg.sender, o, bond, challengeEnd, evidenceHash, evidenceURI);
    }

    function challengeResult(uint256 id, bytes32 evidenceHash) external nonReentrant returns (uint256 disputeId) {
        if (!registry.hasRole(msg.sender, Role.CHALLENGER)) revert MissingRole();
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.PROPOSED || _marketDispute[id] != 0) revert InvalidState();
        Proposal storage proposal = _proposals[id];
        if (msg.sender == proposal.proposer) revert SelfChallenge();
        if (block.timestamp >= proposal.challengeEnd || block.timestamp >= m.hardDeadline) revert DeadlineViolation();
        disputeId = _openDispute(id, DisputeKind.RESULT, 0, evidenceHash);
        markets.setDisputed(id);
    }

    function challengeCreation(uint256 id, uint8 ground, bytes32 evidenceHash)
        external
        nonReentrant
        returns (uint256 disputeId)
    {
        if (!registry.hasRole(msg.sender, Role.CHALLENGER)) revert MissingRole();
        if (ground >= 3) revert UnknownGround();
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.PENDING || m.creationChallenged || _marketDispute[id] != 0) revert InvalidState();
        if (msg.sender == m.creator) revert SelfChallenge();
        if (block.timestamp >= m.openAt || block.timestamp >= m.hardDeadline) revert DeadlineViolation();
        disputeId = _openDispute(id, DisputeKind.CREATION, ground, evidenceHash);
        markets.markCreationChallenged(id);
    }

    function _openDispute(uint256 id, DisputeKind kind, uint8 ground, bytes32 evidenceHash)
        internal
        returns (uint256 disputeId)
    {
        if (evidenceHash == bytes32(0)) revert MissingEvidence();
        Params memory p = registry.params();
        uint256 bond = registry.bondFor(msg.sender, Role.CHALLENGER, markets.maxPayout(id) * p.challengeBondBps / BPS);
        disputeId = _nextDisputeId++;
        _disputes[disputeId] = Dispute(id, msg.sender, bond, kind, ground, evidenceHash, false);
        _marketDispute[id] = disputeId;
        registry.lockRole(msg.sender, Role.CHALLENGER);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        emit DisputeOpened(disputeId, id, msg.sender, kind, bond, ground, evidenceHash);
    }

    function finalizeUnchallenged(uint256 id) external nonReentrant {
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        Proposal storage proposal = _proposals[id];
        if (m.state != MarketState.PROPOSED || proposal.proposer == address(0) || _marketDispute[id] != 0) {
            revert InvalidState();
        }
        if (block.timestamp < proposal.challengeEnd || block.timestamp >= m.hardDeadline) revert DeadlineViolation();
        uint256 bond = _returnProposalBond(id);
        registry.reportGain(proposal.proposer, Role.PROPOSER, markets.maxPayout(id));
        markets.finalize(id, proposal.outcome);
        emit UnchallengedFinalized(id, proposal.proposer, proposal.outcome, bond);
    }

    function finalizeTimeout(uint256 id) external nonReentrant {
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state == MarketState.FINAL || m.state == MarketState.CANCELLED) revert InvalidState();
        if (block.timestamp < m.hardDeadline) revert DeadlineViolation();
        uint256 returnedBond;
        if (_proposals[id].proposer != address(0)) returnedBond = _returnProposalBond(id);
        uint256 forfeited;
        uint256 disputeId = _marketDispute[id];
        if (disputeId != 0) {
            Dispute storage dispute = _disputes[disputeId];
            if (!dispute.settled) {
                dispute.settled = true;
                forfeited = dispute.bond;
                dispute.bond = 0;
                registry.unlockRole(dispute.challenger, Role.CHALLENGER);
                collateral.safeTransfer(address(jurors), forfeited);
                jurors.notifyReward(forfeited);
            }
        }
        markets.finalize(id, Outcome.INVALID);
        emit TimeoutFinalized(id, returnedBond, forfeited);
    }

    function _returnProposalBond(uint256 id) internal returns (uint256 bond) {
        Proposal storage proposal = _proposals[id];
        bond = proposal.bond;
        proposal.bond = 0;
        registry.unlockRole(proposal.proposer, Role.PROPOSER);
        collateral.safeTransfer(proposal.proposer, bond);
    }

    function proposerOf(uint256 id) external view returns (address) {
        return _proposals[id].proposer;
    }

    function proposedOutcome(uint256 id) external view returns (Outcome) {
        return _proposals[id].outcome;
    }

    // shortcut: dispute rounds are unavailable in Task 6; Task 7 replaces these reverting entry points.
    function commitVote(uint256, bytes32) external pure {
        revert DisputeRoundsPending();
    }

    function revealVote(uint256, uint8, bytes32) external pure {
        revert DisputeRoundsPending();
    }

    function settleRound(uint256) external pure {
        revert DisputeRoundsPending();
    }

    function appeal(uint256) external pure {
        revert DisputeRoundsPending();
    }

    function finalizeDispute(uint256) external pure {
        revert DisputeRoundsPending();
    }
}
