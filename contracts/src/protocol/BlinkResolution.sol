// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkResolution} from "./interfaces/IBlinkResolution.sol";
import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
    error ConflictedJuror();
    error InsufficientCredit();
    error NoWeight();
    error InvalidChoice();
    error InvalidVote();
    error AlreadySettled();
    error LosersPending();
    error NoMoreAppeals();

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

    struct Vote {
        bytes32 commitment;
        uint256 weight;
        uint8 choice;
        bool revealed;
        bool settled;
        bool creditSettled;
    }

    struct Bond {
        address poster;
        uint256 amount;
        Role role;
        bool challengerSide;
        bool locked;
    }

    struct Pool {
        // shortcut: timeout pools and rounding dust stay in jurors, revisit if a recovery policy is specified.
        uint256 tokens;
        uint256 pendingLosers;
        bool coherenceCounted;
    }

    event VoteCommitted(uint256 indexed disputeId, uint256 indexed round, address indexed juror, uint256 weight);
    event VoteRevealed(uint256 indexed disputeId, uint256 indexed round, address indexed juror, uint8 choice);
    event RoundSettled(uint256 indexed disputeId, uint256 indexed round, uint8 appealRound, uint8 choice, uint256 appealEnd);
    event Appealed(uint256 indexed disputeId, uint256 indexed round, uint8 appealRound, address indexed appellant, uint256 bond);
    event VoteSettled(uint256 indexed disputeId, uint256 indexed round, address indexed juror, uint256 slash, uint256 reward);
    event DisputeFinalized(uint256 indexed disputeId, uint8 choice);

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
    mapping(uint256 => mapping(uint256 => Round)) internal _rounds;
    mapping(uint256 => mapping(uint256 => mapping(address => Vote))) internal _votes;
    mapping(uint256 => mapping(uint8 => Pool)) internal _pools;
    mapping(uint256 => Bond[]) internal _bonds;
    mapping(uint256 => mapping(address => bool)) internal _appellants;
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
        Dispute storage d = _disputes[disputeId];
        d.marketId = id;
        d.challenger = msg.sender;
        d.bond = bond;
        d.kind = kind;
        d.ground = ground;
        d.evidenceHash = evidenceHash;
        d.lastBond = bond;
        if (kind == DisputeKind.RESULT) {
            Proposal storage proposal = _proposals[id];
            _bonds[disputeId].push(Bond(proposal.proposer, proposal.bond, Role.PROPOSER, false, true));
        } else {
            _bonds[disputeId].push(Bond(markets.getMarket(id).creator, 0, Role.CREATOR, false, false));
        }
        _bonds[disputeId].push(Bond(msg.sender, bond, Role.CHALLENGER, true, true));
        _startRound(disputeId, p);
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
        uint256 forfeited;
        uint256 disputeId = _marketDispute[id];
        if (disputeId != 0 && !_disputes[disputeId].settled) {
            Dispute storage d = _disputes[disputeId];
            d.settled = true;
            d.timedOut = true;
            d.bond = 0;
            _proposals[id].bond = 0;
            Bond[] storage bonds = _bonds[disputeId];
            // At most two initial sides plus maxRounds - 1 appellants (maxRounds <= 4).
            for (uint256 i; i < bonds.length; ++i) {
                Bond storage b = bonds[i];
                if (b.locked) registry.unlockRole(b.poster, b.role);
                uint256 amount = b.amount;
                b.amount = 0;
                if (b.challengerSide) forfeited += amount;
                else {
                    returnedBond += amount;
                    collateral.safeTransfer(b.poster, amount);
                }
            }
            _notifyJurors(forfeited);
        } else if (_proposals[id].proposer != address(0)) {
            returnedBond = _returnProposalBond(id);
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

    function _startRound(uint256 disputeId, Params memory p) internal {
        Dispute storage d = _disputes[disputeId];
        Round storage r = _rounds[disputeId][d.currentRound];
        r.snapshotAt = uint64(block.timestamp - 1);
        r.commitEnd = block.timestamp + p.commitSeconds;
        r.revealEnd = r.commitEnd + p.revealSeconds;
        r.appealEnd = r.revealEnd + p.appealSeconds;
        r.level = d.appealRound;
        r.creditThreshold = markets.finalizedCount() >= p.phaseInFinalizedMarkets ? p.roundCreditThreshold[r.level] : 0;
    }

    function _activeDispute(uint256 disputeId) internal view returns (Dispute storage d) {
        d = _disputes[disputeId];
        if (d.challenger == address(0) || d.settled) revert InvalidState();
        if (block.timestamp >= markets.getMarket(d.marketId).hardDeadline) revert DeadlineViolation();
    }

    function commitVote(uint256 disputeId, bytes32 commitment) external nonReentrant {
        Dispute storage d = _activeDispute(disputeId);
        Round storage r = _rounds[disputeId][d.currentRound];
        if (r.settled || block.timestamp >= r.commitEnd) revert DeadlineViolation();
        IBlinkMarkets.Market memory m = markets.getMarket(d.marketId);
        if (msg.sender == m.creator || msg.sender == _proposals[d.marketId].proposer
            || msg.sender == d.challenger || _appellants[disputeId][msg.sender]) revert ConflictedJuror();
        (uint256 yes, uint256 no) = markets.getPosition(d.marketId, msg.sender);
        if (yes != 0 || no != 0) revert ConflictedJuror();
        if (registry.creditOf(msg.sender, Role.JUROR) < r.creditThreshold) {
            revert InsufficientCredit();
        }
        Vote storage v = _votes[disputeId][d.currentRound][msg.sender];
        if (v.weight != 0 || commitment == bytes32(0)) revert InvalidVote();
        uint256 weight = Math.min(jurors.stakeAt(msg.sender, r.snapshotAt), jurors.slashableStake(msg.sender));
        if (weight == 0) revert NoWeight();
        v.commitment = commitment;
        v.weight = weight;
        r.committedWeight += weight;
        ++r.committers;
        jurors.lockVote(msg.sender);
        emit VoteCommitted(disputeId, d.currentRound, msg.sender, weight);
    }

    function revealVote(uint256 disputeId, uint8 choice, bytes32 salt) external {
        Dispute storage d = _activeDispute(disputeId);
        Round storage r = _rounds[disputeId][d.currentRound];
        if (r.settled || block.timestamp < r.commitEnd || block.timestamp >= r.revealEnd) revert DeadlineViolation();
        if (choice > 1) revert InvalidChoice();
        Vote storage v = _votes[disputeId][d.currentRound][msg.sender];
        if (v.weight == 0 || v.revealed
            || v.commitment != keccak256(abi.encode(disputeId, d.currentRound, msg.sender, choice, salt))) {
            revert InvalidVote();
        }
        v.revealed = true;
        v.choice = choice;
        r.revealedWeight[choice] += v.weight;
        ++r.revealers;
        ++r.revealersByChoice[choice];
        emit VoteRevealed(disputeId, d.currentRound, msg.sender, choice);
    }

    function settleRound(uint256 disputeId) external {
        Dispute storage d = _activeDispute(disputeId);
        Round storage r = _rounds[disputeId][d.currentRound];
        if (r.settled) revert AlreadySettled();
        if (block.timestamp < r.revealEnd) revert DeadlineViolation();
        Params memory p = registry.params();
        uint8 choice;
        if (r.revealedWeight[1] > r.revealedWeight[choice]) choice = 1;
        bool tied = r.revealedWeight[0] == r.revealedWeight[1];
        r.settled = true;
        _pools[disputeId][r.level].pendingLosers += r.committers - r.revealers;
        if (r.committedWeight < jurors.totalStakeAt(r.snapshotAt) * p.quorumBps[r.level] / BPS
            || tied) {
            r.restarted = true;
            ++d.currentRound;
            _startRound(disputeId, p);
            emit RoundRestarted(disputeId, d.currentRound, d.appealRound, _rounds[disputeId][d.currentRound].snapshotAt);
        } else {
            r.leadingChoice = choice;
            emit RoundSettled(disputeId, d.currentRound, d.appealRound, choice, r.appealEnd);
        }
    }

    function appeal(uint256 disputeId) external nonReentrant {
        Dispute storage d = _activeDispute(disputeId);
        Round storage r = _rounds[disputeId][d.currentRound];
        if (!r.settled || r.restarted) revert InvalidState();
        if (block.timestamp >= r.appealEnd) revert DeadlineViolation();
        Params memory p = registry.params();
        if (d.appealRound + 1 >= p.maxRounds) revert NoMoreAppeals();
        if (block.timestamp + p.commitSeconds + p.revealSeconds >= markets.getMarket(d.marketId).hardDeadline) {
            revert DeadlineViolation();
        }
        bool challengerSide = !_challengerWins(d, r.leadingChoice);
        Role role = challengerSide ? Role.CHALLENGER : (d.kind == DisputeKind.CREATION ? Role.CREATOR : Role.PROPOSER);
        bool existingPoster;
        Bond[] storage bonds = _bonds[disputeId];
        for (uint256 i; i < bonds.length; ++i) {
            if (bonds[i].poster == msg.sender) {
                if (bonds[i].challengerSide != challengerSide) revert SelfChallenge();
                role = bonds[i].role;
                existingPoster = true;
            }
        }
        if (!existingPoster && !registry.hasRole(msg.sender, role)) revert MissingRole();
        // A voter cannot become an appellant in the round they just voted in.
        if (_votes[disputeId][d.currentRound][msg.sender].weight != 0) revert ConflictedJuror();
        uint256 bond = d.lastBond * 2;
        d.lastBond = bond;
        _bonds[disputeId].push(Bond(msg.sender, bond, role, challengerSide, true));
        _appellants[disputeId][msg.sender] = true;
        registry.lockRole(msg.sender, role);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        ++d.appealRound;
        ++d.currentRound;
        _startRound(disputeId, p);
        emit Appealed(disputeId, d.currentRound, d.appealRound, msg.sender, bond);
    }

    function _challengerWins(Dispute storage d, uint8 choice) internal view returns (bool) {
        return d.kind == DisputeKind.CREATION ? choice == 1 : choice != uint8(_proposals[d.marketId].outcome);
    }

    function finalizeDispute(uint256 disputeId) external nonReentrant {
        Dispute storage d = _activeDispute(disputeId);
        Round storage r = _rounds[disputeId][d.currentRound];
        if (!r.settled || r.restarted) revert InvalidState();
        if (block.timestamp < r.appealEnd) revert DeadlineViolation();
        d.settled = true;
        d.bond = 0;
        _proposals[d.marketId].bond = 0;
        bool challengerWins = _challengerWins(d, r.leadingChoice);
        _settleBonds(disputeId, challengerWins);
        if (d.kind == DisputeKind.RESULT) {
            bountyWinner[d.marketId] = challengerWins ? d.challenger : _proposals[d.marketId].proposer;
            markets.finalize(d.marketId, Outcome(r.leadingChoice));
        } else {
            markets.resolveCreation(d.marketId, challengerWins, d.challenger);
            // A rejected creation challenge must not block a later result challenge.
            delete _marketDispute[d.marketId];
        }
        emit DisputeFinalized(disputeId, r.leadingChoice);
    }

    function _settleBonds(uint256 disputeId, bool challengerWins) internal {
        Dispute storage d = _disputes[disputeId];
        Bond[] storage bonds = _bonds[disputeId];
        uint256 winningBonds;
        uint256 losingBonds;
        uint256 cut;
        uint256 cutBps = registry.params().jurorBondCutBps;
        for (uint256 i; i < bonds.length; ++i) {
            if (bonds[i].challengerSide == challengerWins) winningBonds += bonds[i].amount;
            else {
                losingBonds += bonds[i].amount;
                cut += bonds[i].amount * cutBps / BPS;
            }
        }
        uint256 prizes = losingBonds - cut;
        uint256 paidPrizes;
        uint256 remainingWinners = winningBonds;
        uint256 payout = markets.maxPayout(d.marketId);
        for (uint256 i; i < bonds.length; ++i) {
            Bond storage b = bonds[i];
            uint256 amount = b.amount;
            b.amount = 0;
            if (b.locked) registry.unlockRole(b.poster, b.role);
            bool first = true;
            // Credit and role slashes apply once per party/role, even after repeated appeals.
            for (uint256 j; j < i; ++j) {
                if (bonds[j].poster == b.poster && bonds[j].role == b.role) first = false;
            }
            if (b.challengerSide == challengerWins) {
                if (first) registry.reportGain(b.poster, b.role, payout);
                uint256 prize;
                if (winningBonds == 0) {
                    prize = prizes; // the creator's winning bond remains in markets
                } else if (amount != 0) {
                    remainingWinners -= amount;
                    prize = remainingWinners == 0 ? prizes - paidPrizes : Math.mulDiv(prizes, amount, winningBonds);
                }
                paidPrizes += prize;
                collateral.safeTransfer(b.poster, amount + prize);
            } else if (first) {
                registry.reportLoss(b.poster, b.role, payout);
                registry.slashRole(b.poster, b.role);
            }
        }
        _notifyJurors(cut);
    }

    function _notifyJurors(uint256 amount) internal {
        if (amount == 0) return;
        collateral.safeTransfer(address(jurors), amount);
        jurors.notifyReward(amount);
    }

    function settleVote(uint256 disputeId, uint256 round, address juror) external nonReentrant {
        Dispute storage d = _disputes[disputeId];
        Round storage r = _rounds[disputeId][round];
        Vote storage v = _votes[disputeId][round][juror];
        if (v.weight == 0 || (!r.settled && !d.timedOut)) revert InvalidState();
        bool finalRound = d.settled && !d.timedOut && round == d.currentRound;
        if (v.settled) {
            if (!finalRound || v.creditSettled) revert AlreadySettled();
            _settleCredit(d, r, v, juror);
            emit VoteSettled(disputeId, round, juror, 0, 0);
            return;
        }
        uint256 slashed;
        uint256 reward;
        if (!d.timedOut) {
            Pool storage pool = _pools[disputeId][r.level];
            uint8 finalChoice = _rounds[disputeId][d.currentRound].leadingChoice;
            if (v.revealed && !r.restarted) {
                if (!d.settled) revert InvalidState();
                // Each level has one decisive round; count its incoherent revealers only once the choice is final.
                if (!pool.coherenceCounted) {
                    pool.pendingLosers += r.revealers - r.revealersByChoice[finalChoice];
                    pool.coherenceCounted = true;
                }
            }
            bool loser = !v.revealed || (!r.restarted && v.choice != finalChoice);
            if (loser) {
                Params memory p = registry.params();
                uint256 before = jurors.undistributedSlashed();
                jurors.slash(juror, v.weight * (v.revealed ? p.incoherentSlashBps : p.nonRevealSlashBps) / BPS, address(jurors));
                slashed = jurors.undistributedSlashed() - before;
                pool.tokens += slashed;
                --pool.pendingLosers;
            } else if (!r.restarted) {
                if (pool.pendingLosers != 0) revert LosersPending();
                reward = Math.mulDiv(pool.tokens, v.weight, r.revealedWeight[finalChoice]);
                jurors.reward(juror, reward);
            }
        }
        v.settled = true;
        jurors.unlockVote(juror);
        if (finalRound) _settleCredit(d, r, v, juror);
        emit VoteSettled(disputeId, round, juror, slashed, reward);
    }

    function _settleCredit(Dispute storage d, Round storage r, Vote storage v, address juror) internal {
        v.creditSettled = true;
        uint256 payout = markets.maxPayout(d.marketId);
        if (v.revealed && v.choice == r.leadingChoice) registry.reportGain(juror, Role.JUROR, payout);
        else registry.reportLoss(juror, Role.JUROR, payout);
    }

    function getDispute(uint256 disputeId) external view returns (Dispute memory dispute, Round memory round) {
        dispute = _disputes[disputeId];
        round = _rounds[disputeId][dispute.currentRound];
    }
}
