// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkMarket} from "./interfaces/IBlinkMarket.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BlinkMarket is IBlinkMarket, EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error WrongChain();
    error InvalidAddress();
    error InvalidCollateral();
    error UnauthorizedRole();
    error MarketNotFound();
    error InvalidSpec();
    error DuplicateSpec();
    error InvalidSchedule();
    error InvalidCap();
    error TradingPaused();
    error MarketClosed();
    error InvalidTaker();
    error InvalidSide();
    error InvalidQuantity();
    error InvalidPrice();
    error CapExceeded();
    error InvalidQuoteTime();
    error EpochMismatch();
    error QuoteAlreadyConsumed();
    error QuoteAlreadyCancelled();
    error InvalidSignature();
    error InsufficientMakerBalance();
    error InvalidAmount();
    error InvalidState();
    error DeadlineViolation();
    error EmptyEvidence();
    error NoPosition();

    uint256 public constant UNIT = 1_000_000;
    uint64 public constant MAX_FILL_SHARES = 100;
    uint64 public constant MAX_MARKET_PAIRS = 10_000;
    uint64 public constant MAX_TAKER_SHARES = 500;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 marketId,bytes32 specHash,address maker,address taker,uint8 side,uint64 quantity,uint16 priceBps,uint64 validAfter,uint64 expiresAt,uint256 nonce,uint256 epoch)"
    );

    IERC20 public immutable collateral;
    address public immutable maker;
    address public immutable admin;
    address public immutable resultProposer;
    address public immutable challenger;
    address public immutable arbiter;
    bool public globalTradingPaused;
    uint256 public makerFreeBalance;
    uint256 public currentMakerEpoch;
    uint256 public nextMarketId = 1;
    mapping(bytes32 => bool) public usedSpecHashes;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public cancelled;
    mapping(address => bool) public takerAllowed;
    mapping(uint256 => Market) private markets;

    struct Position {
        uint256 yes;
        uint256 no;
    }
    mapping(uint256 => mapping(address => Position)) private positions;
    mapping(uint256 => mapping(address => uint256)) public cumulativeTakerShares;

    constructor(
        address collateral_,
        address maker_,
        address admin_,
        address proposer_,
        address challenger_,
        address arbiter_
    ) EIP712("Blink RFQ", "0.1") {
        if (block.chainid != 84532) revert WrongChain();
        address[5] memory roles = [maker_, admin_, proposer_, challenger_, arbiter_];
        for (uint256 i; i < roles.length; ++i) {
            if (roles[i] == address(0)) revert InvalidAddress();
            for (uint256 j; j < i; ++j) {
                if (roles[i] == roles[j]) revert InvalidAddress();
            }
        }
        if (maker_.code.length != 0) revert InvalidAddress();
        if (collateral_.code.length == 0) revert InvalidCollateral();
        try IERC20Metadata(collateral_).decimals() returns (uint8 value) {
            if (value != 6) revert InvalidCollateral();
        } catch {
            revert InvalidCollateral();
        }
        collateral = IERC20(collateral_);
        maker = maker_;
        admin = admin_;
        resultProposer = proposer_;
        challenger = challenger_;
        arbiter = arbiter_;
    }

    modifier only(address role) {
        if (msg.sender != role) revert UnauthorizedRole();
        _;
    }

    function _market(uint256 id) internal view returns (Market storage m) {
        if (id == 0 || id >= nextMarketId) revert MarketNotFound();
        m = markets[id];
    }

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
    ) external only(admin) returns (uint256 id) {
        if (specHash == bytes32(0) || bytes(specURI).length == 0) revert InvalidSpec();
        if (usedSpecHashes[specHash]) revert DuplicateSpec();
        if (
            !(block.timestamp < closeAt && closeAt < proposalDeadline && proposalDeadline < hardDeadline)
                || hardDeadline - proposalDeadline <= challengeSeconds
                || challengeSeconds != (mode == Mode.LIVE ? 86400 : 120)
        ) revert InvalidSchedule();
        if (
            maxPairs == 0 || maxPairs > MAX_MARKET_PAIRS || maxTakerShares == 0 || maxTakerShares > MAX_TAKER_SHARES
                || maxTakerShares > maxPairs
        ) revert InvalidCap();
        id = nextMarketId++;
        usedSpecHashes[specHash] = true;
        Market storage m = markets[id];
        m.specHash = specHash;
        m.specURI = specURI;
        m.mode = mode;
        m.closeAt = closeAt;
        m.proposalDeadline = proposalDeadline;
        m.hardDeadline = hardDeadline;
        m.challengeSeconds = challengeSeconds;
        m.maxPairs = maxPairs;
        m.maxTakerShares = maxTakerShares;
        emit MarketCreated(
            id,
            specHash,
            specURI,
            mode,
            closeAt,
            proposalDeadline,
            hardDeadline,
            challengeSeconds,
            maxPairs,
            maxTakerShares
        );
    }

    function setGlobalTradingPaused(bool paused) external only(admin) {
        globalTradingPaused = paused;
        emit TradingPauseChanged(0, true, paused);
    }

    function setMarketTradingPaused(uint256 id, bool paused) external only(admin) {
        _market(id).paused = paused;
        emit TradingPauseChanged(id, false, paused);
    }

    function setTakerAllowed(address account, bool allowed) external only(admin) {
        if (
            account == address(0) || account == maker || account == admin || account == resultProposer
                || account == challenger || account == arbiter
        ) revert InvalidTaker();
        takerAllowed[account] = allowed;
        emit TakerAllowedChanged(account, allowed);
    }

    function depositMaker(uint256 amount) external only(maker) nonReentrant {
        if (amount == 0) revert InvalidAmount();
        collateral.safeTransferFrom(maker, address(this), amount);
        makerFreeBalance += amount;
        emit MakerDeposited(amount);
    }

    function withdrawMaker(uint256 amount) external only(maker) nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (amount > makerFreeBalance) revert InsufficientMakerBalance();
        makerFreeBalance -= amount;
        collateral.safeTransfer(maker, amount);
        emit MakerWithdrawn(amount);
    }

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q)));
    }

    function fillQuote(Quote calldata q, bytes calldata signature) external nonReentrant {
        Market storage m = _market(q.marketId);
        if (globalTradingPaused || m.paused) revert TradingPaused();
        if (m.state != State.OPEN || block.timestamp >= m.closeAt) revert MarketClosed();
        if (q.maker != maker || q.taker != msg.sender || !takerAllowed[msg.sender] || q.taker == maker) {
            revert InvalidTaker();
        }
        if (q.specHash != m.specHash) revert InvalidSpec();
        if (q.side > 1) revert InvalidSide();
        if (q.quantity == 0 || q.quantity > MAX_FILL_SHARES) revert InvalidQuantity();
        if (q.priceBps == 0 || q.priceBps >= 10000) revert InvalidPrice();
        if (
            m.totalMintedPairs + q.quantity > m.maxPairs
                || cumulativeTakerShares[q.marketId][msg.sender] + q.quantity > m.maxTakerShares
        ) revert CapExceeded();
        if (
            !(q.validAfter <= block.timestamp && block.timestamp < q.expiresAt && q.expiresAt <= m.closeAt)
                || q.expiresAt - q.validAfter > 60
        ) revert InvalidQuoteTime();
        if (q.epoch != currentMakerEpoch) revert EpochMismatch();
        bytes32 digest = hashQuote(q);
        if (consumed[digest]) revert QuoteAlreadyConsumed();
        if (cancelled[digest]) revert QuoteAlreadyCancelled();
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError || recovered != maker) revert InvalidSignature();
        uint256 notional = uint256(q.quantity) * UNIT;
        uint256 takerCost = uint256(q.quantity) * q.priceBps * 100;
        uint256 makerCost = notional - takerCost;
        if (makerFreeBalance < makerCost) revert InsufficientMakerBalance();
        consumed[digest] = true;
        makerFreeBalance -= makerCost;
        m.escrowMicros += notional;
        m.totalMintedPairs += q.quantity;
        cumulativeTakerShares[q.marketId][msg.sender] += q.quantity;
        Position storage t = positions[q.marketId][msg.sender];
        Position storage p = positions[q.marketId][maker];
        if (q.side == 0) {
            t.yes += q.quantity;
            p.no += q.quantity;
        } else {
            t.no += q.quantity;
            p.yes += q.quantity;
        }
        collateral.safeTransferFrom(msg.sender, address(this), takerCost);
        emit QuoteFilled(q.marketId, digest, maker, msg.sender, q.side, q.quantity, q.priceBps, takerCost, makerCost);
    }

    function cancelQuote(Quote calldata q) external only(maker) {
        if (q.maker != maker) revert InvalidTaker();
        bytes32 digest = hashQuote(q);
        if (consumed[digest]) revert QuoteAlreadyConsumed();
        if (!cancelled[digest]) {
            cancelled[digest] = true;
            emit QuoteCancelled(digest);
        }
    }

    function incrementMakerEpoch() external only(maker) {
        emit MakerEpochIncremented(++currentMakerEpoch);
    }

    function proposeOutcome(uint256 id, Outcome outcome, bytes32 evidenceHash) external only(resultProposer) {
        Market storage m = _market(id);
        if (m.state != State.OPEN) revert InvalidState();
        if (block.timestamp < m.closeAt || block.timestamp >= m.proposalDeadline) revert DeadlineViolation();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        m.state = State.PROPOSED;
        m.proposedAt = uint64(block.timestamp);
        m.proposedOutcome = outcome;
        m.proposalEvidenceHash = evidenceHash;
        emit OutcomeProposed(id, outcome, evidenceHash);
    }

    function challengeOutcome(uint256 id, bytes32 evidenceHash) external only(challenger) {
        Market storage m = _market(id);
        if (m.state != State.PROPOSED) revert InvalidState();
        if (block.timestamp >= uint256(m.proposedAt) + m.challengeSeconds) revert DeadlineViolation();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        m.state = State.DISPUTED;
        m.challengeEvidenceHash = evidenceHash;
        emit OutcomeChallenged(id, evidenceHash);
    }

    function finalizeUnchallenged(uint256 id) external {
        Market storage m = _market(id);
        if (m.state != State.PROPOSED) revert InvalidState();
        if (block.timestamp < uint256(m.proposedAt) + m.challengeSeconds || block.timestamp >= m.hardDeadline) {
            revert DeadlineViolation();
        }
        _finalize(id, m, m.proposedOutcome, FinalizationReason.UNCHALLENGED, m.proposalEvidenceHash);
    }

    function arbitrate(uint256 id, Outcome outcome, bytes32 evidenceHash) external only(arbiter) {
        Market storage m = _market(id);
        if (m.state != State.DISPUTED) revert InvalidState();
        if (block.timestamp >= m.hardDeadline) revert DeadlineViolation();
        if (evidenceHash == bytes32(0)) revert EmptyEvidence();
        _finalize(id, m, outcome, FinalizationReason.ARBITRATED, evidenceHash);
    }

    function finalizeTimeout(uint256 id) external {
        Market storage m = _market(id);
        if (m.state == State.FINAL) revert InvalidState();
        if (block.timestamp < m.hardDeadline) revert DeadlineViolation();
        _finalize(id, m, Outcome.INVALID, FinalizationReason.TIMEOUT, bytes32(0));
    }

    function _finalize(uint256 id, Market storage m, Outcome outcome, FinalizationReason reason, bytes32 evidenceHash)
        private
    {
        m.state = State.FINAL;
        m.finalOutcome = outcome;
        m.finalEvidenceHash = evidenceHash;
        emit OutcomeFinalized(id, outcome, reason, evidenceHash);
    }

    function redeem(uint256 id) external nonReentrant {
        Market storage m = _market(id);
        if (m.state != State.FINAL) revert InvalidState();
        Position memory p = positions[id][msg.sender];
        if (p.yes == 0 && p.no == 0) revert NoPosition();
        delete positions[id][msg.sender];
        uint256 payout = m.finalOutcome == Outcome.YES
            ? p.yes * UNIT
            : m.finalOutcome == Outcome.NO ? p.no * UNIT : (p.yes + p.no) * (UNIT / 2);
        m.escrowMicros -= payout;
        if (payout != 0) collateral.safeTransfer(msg.sender, payout);
        emit PositionRedeemed(id, msg.sender, p.yes, p.no, payout);
    }

    function getMarket(uint256 id) external view returns (Market memory) {
        return _market(id);
    }

    function getPosition(uint256 id, address account) external view returns (uint256 yesShares, uint256 noShares) {
        _market(id);
        Position storage p = positions[id][account];
        return (p.yes, p.no);
    }
}
