// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkJurors} from "./interfaces/IBlinkJurors.sol";
import {IBlinkResolution} from "./interfaces/IBlinkResolution.sol";
import {Role, QuestionClass, MarketState, Outcome, Params, GenerationAddresses} from "./BlinkTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract BlinkMarkets is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error WrongChain();
    error WrongAddress();
    error UnauthorizedCaller();
    error MissingParser();
    error MissingRole();
    error TemplateNotFound();
    error MarketNotFound();
    error InvalidSpec();
    error DuplicateSpec();
    error InvalidSchedule();
    error InvalidCap();
    error ReplayNotAllowed();
    error InsufficientCredit();
    error CreatorLimitExceeded();
    error SecurityBoundExceeded();
    error CreationWindowActive();
    error CreationChallengePending();
    error InvalidState();
    error InvalidAddress();
    error MarketNotOpen();
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
    error AlreadyDistributed();
    error NoPosition();

    event TemplateRegistered(bytes32 indexed templateId, QuestionClass cls, bytes32 parserHash, string uri);
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
    event MarketOpened(uint256 indexed marketId, uint64 openAt);
    event CreationChallenged(uint256 indexed marketId);
    event CreationResolved(uint256 indexed marketId, bool upheld, address indexed challenger, uint256 bond, uint256 jurorCut);
    event MarketProposed(uint256 indexed marketId);
    event MarketDisputed(uint256 indexed marketId);
    event MarketFinalized(uint256 indexed marketId, Outcome outcome);
    event FeesDistributed(uint256 indexed marketId, uint256 amount, address indexed keeper, uint256 keeperTip);
    event PositionRedeemed(uint256 indexed marketId, address indexed account, uint256 yes, uint256 no, uint256 payout);
    event MakerDeposited(address indexed maker, uint256 amount);
    event MakerWithdrawn(address indexed maker, uint256 amount);
    event QuoteCancelled(bytes32 indexed digest);
    event MakerEpochIncremented(address indexed maker, uint256 epoch);
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

    struct Template {
        QuestionClass cls;
        bool exists;
        bool reviewed;
    }

    struct Position {
        uint256 yes;
        uint256 no;
    }

    uint256 public constant UNIT = 1_000_000;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(uint256 marketId,bytes32 specHash,address maker,address taker,uint8 side,uint64 quantity,uint16 priceBps,uint64 validAfter,uint64 expiresAt,uint256 nonce,uint256 epoch)"
    );
    IBlinkRegistry public immutable registry;
    IBlinkJurors public immutable jurors;
    IERC20 public immutable collateral;
    address public immutable resolution;
    uint256 public nextMarketId = 1;
    uint256 public openPayoutTotal;
    uint256 private _finalizedCount;
    mapping(address => uint256) public openPayoutByCreator;
    mapping(bytes32 => bool) public usedSpecHashes;
    mapping(bytes32 => Template) private templates;
    mapping(uint256 => IBlinkMarkets.Market) internal markets;
    mapping(uint256 => string) private specURIs;
    mapping(address => uint256) public makerFree;
    mapping(address => uint256) public makerEpoch;
    mapping(bytes32 => bool) public consumed;
    mapping(bytes32 => bool) public cancelled;
    mapping(uint256 => uint256) public feePool;
    mapping(uint256 => mapping(address => Position)) private positions;
    mapping(uint256 => mapping(address => uint256)) public cumulativeTakerShares;

    modifier onlyResolution() {
        if (msg.sender != resolution) revert UnauthorizedCaller();
        _;
    }

    constructor(GenerationAddresses memory a) EIP712("Blink RFQ", "0.2") {
        if (block.chainid != 84532) revert WrongChain();
        if (
            a.markets != address(this) || a.registry == address(0) || a.jurors == address(0)
                || a.resolution == address(0) || a.collateral == address(0)
        ) revert WrongAddress();
        registry = IBlinkRegistry(a.registry);
        jurors = IBlinkJurors(a.jurors);
        collateral = IERC20(a.collateral);
        resolution = a.resolution;
    }

    function registerTemplate(QuestionClass cls, bytes32 parserHash, string calldata uri)
        external returns (bytes32 templateId)
    {
        if (cls == QuestionClass.A_COMPUTABLE && parserHash == bytes32(0)) revert MissingParser();
        templateId = keccak256(abi.encode(cls, parserHash, uri));
        if (templates[templateId].exists) return templateId;
        templates[templateId] = Template(cls, true, false);
        emit TemplateRegistered(templateId, cls, parserHash, uri);
    }

    function createMarket(IBlinkMarkets.CreateArgs calldata a) external nonReentrant returns (uint256 id) {
        if (!registry.hasRole(msg.sender, Role.CREATOR)) revert MissingRole();
        Template storage t = templates[a.templateId];
        if (!t.exists) revert TemplateNotFound();
        if (a.specHash == bytes32(0) || bytes(a.specURI).length == 0) revert InvalidSpec();
        bytes32 specKey = keccak256(abi.encode(msg.sender, a.specHash));
        if (usedSpecHashes[specKey]) revert DuplicateSpec();
        Params memory p = registry.params();
        if (a.replay && !p.replayAllowed) revert ReplayNotAllowed();
        uint64 openAt = uint64(block.timestamp) + p.creationWindow[uint256(t.cls)] + (t.reviewed ? 0 : p.firstUseExtraWindow);
        if (
            !(openAt < a.closeAt && a.closeAt < a.proposalDeadline && a.proposalDeadline < a.hardDeadline)
                || a.hardDeadline - a.proposalDeadline <= p.resultChallengeWindow[uint256(t.cls)]
        ) revert InvalidSchedule();
        if (a.maxPairs == 0 || a.maxPairs > p.maxMarketPairs) revert InvalidCap();
        if (t.cls == QuestionClass.C_JUDGMENT && !registry.meetsThreshold(msg.sender, Role.CREATOR, p.classCCreditThreshold)) {
            revert InsufficientCredit();
        }
        uint256 payout = uint256(a.maxPairs) * UNIT;
        uint256 exposure = openPayoutByCreator[msg.sender] + payout;
        uint256 limit = registry.roleStake(msg.sender, Role.CREATOR)
            * registry.limitMultiplierBps(msg.sender, Role.CREATOR) * p.creatorExposureMultiple / 10_000;
        if (exposure > limit) revert CreatorLimitExceeded();
        if ((openPayoutTotal + payout) * p.securityMultipleBps > jurors.attackCostMicros() * 10_000) {
            revert SecurityBoundExceeded();
        }
        uint256 bond = registry.bondFor(msg.sender, Role.CREATOR, payout * p.creationBondBps / 10_000);
        id = nextMarketId++;
        usedSpecHashes[specKey] = true;
        IBlinkMarkets.Market storage m = markets[id];
        m.creator = msg.sender;
        m.cls = t.cls;
        m.state = MarketState.PENDING;
        m.replay = a.replay;
        m.templateId = a.templateId;
        m.specHash = a.specHash;
        specURIs[id] = a.specURI;
        m.openAt = openAt;
        m.closeAt = a.closeAt;
        m.proposalDeadline = a.proposalDeadline;
        m.hardDeadline = a.hardDeadline;
        m.maxPairs = a.maxPairs;
        m.creationBond = bond;
        openPayoutByCreator[msg.sender] = exposure;
        openPayoutTotal += payout;
        registry.lockRole(msg.sender, Role.CREATOR);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        emit MarketCreated(id, msg.sender, a.specHash, a.specURI, a.templateId, t.cls, a.replay, openAt,
            a.closeAt, a.proposalDeadline, a.hardDeadline, a.maxPairs, bond);
    }

    function _market(uint256 id) internal view returns (IBlinkMarkets.Market storage m) {
        if (id == 0 || id >= nextMarketId) revert MarketNotFound();
        m = markets[id];
    }

    function getMarket(uint256 id) external view returns (IBlinkMarkets.Market memory) { return _market(id); }

    function specURI(uint256 id) external view returns (string memory) {
        _market(id);
        return specURIs[id];
    }

    function maxPayout(uint256 id) public view returns (uint256) { return uint256(_market(id).maxPairs) * UNIT; }

    function finalizedCount() public view virtual returns (uint256) { return _finalizedCount; }

    function depositMaker(uint256 amount) external nonReentrant {
        if (!registry.hasRole(msg.sender, Role.MAKER)) revert MissingRole();
        if (amount == 0) revert InvalidAmount();
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        makerFree[msg.sender] += amount;
        emit MakerDeposited(msg.sender, amount);
    }

    // Free collateral remains withdrawable after role exit; filled pairs already hold both sides in escrow.
    function withdrawMaker(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (amount > makerFree[msg.sender]) revert InsufficientMakerBalance();
        makerFree[msg.sender] -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit MakerWithdrawn(msg.sender, amount);
    }

    function hashQuote(IBlinkMarkets.Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q)));
    }

    function fillQuote(IBlinkMarkets.Quote calldata q, bytes calldata signature) external nonReentrant {
        IBlinkMarkets.Market storage m = _market(q.marketId);
        if (m.state != MarketState.OPEN || block.timestamp < m.openAt) revert MarketNotOpen();
        if (block.timestamp >= m.closeAt) revert MarketClosed();
        if (q.taker != msg.sender || q.taker == q.maker) revert InvalidTaker();
        if (!registry.hasRole(q.maker, Role.MAKER) || !registry.hasRole(msg.sender, Role.TAKER)) revert MissingRole();
        if (q.specHash != m.specHash) revert InvalidSpec();
        if (q.side > 1) revert InvalidSide();
        Params memory p = registry.params();
        if (q.quantity == 0 || q.quantity > p.maxFillShares) revert InvalidQuantity();
        if (q.priceBps == 0 || q.priceBps >= 10_000) revert InvalidPrice();
        if (
            m.totalMintedPairs + q.quantity > m.maxPairs
                || cumulativeTakerShares[q.marketId][msg.sender] + q.quantity > p.maxTakerShares
        ) revert CapExceeded();
        if (
            !(q.validAfter <= block.timestamp && block.timestamp < q.expiresAt && q.expiresAt <= m.closeAt)
                || q.expiresAt - q.validAfter > 60
        ) revert InvalidQuoteTime();
        if (q.epoch != makerEpoch[q.maker]) revert EpochMismatch();
        bytes32 digest = hashQuote(q);
        if (consumed[digest]) revert QuoteAlreadyConsumed();
        if (cancelled[digest]) revert QuoteAlreadyCancelled();
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error != ECDSA.RecoverError.NoError || recovered != q.maker) revert InvalidSignature();
        uint256 notional = uint256(q.quantity) * UNIT;
        uint256 takerCost = uint256(q.quantity) * q.priceBps * 100;
        uint256 makerCost = notional - takerCost;
        uint256 fee = takerCost * p.feeBps / 10_000;
        if (makerFree[q.maker] < makerCost) revert InsufficientMakerBalance();
        consumed[digest] = true;
        makerFree[q.maker] -= makerCost;
        m.escrowMicros += notional;
        m.totalMintedPairs += q.quantity;
        cumulativeTakerShares[q.marketId][msg.sender] += q.quantity;
        feePool[q.marketId] += fee;
        Position storage t = positions[q.marketId][msg.sender];
        Position storage makerPosition = positions[q.marketId][q.maker];
        if (q.side == 0) {
            t.yes += q.quantity;
            makerPosition.no += q.quantity;
        } else {
            t.no += q.quantity;
            makerPosition.yes += q.quantity;
        }
        collateral.safeTransferFrom(msg.sender, address(this), takerCost + fee);
        emit QuoteFilled(q.marketId, digest, q.maker, msg.sender, q.side, q.quantity, q.priceBps, takerCost, makerCost, fee);
    }

    function cancelQuote(IBlinkMarkets.Quote calldata q) external {
        if (q.maker != msg.sender) revert InvalidTaker();
        bytes32 digest = hashQuote(q);
        if (consumed[digest]) revert QuoteAlreadyConsumed();
        if (!cancelled[digest]) {
            cancelled[digest] = true;
            emit QuoteCancelled(digest);
        }
    }

    function incrementMakerEpoch() external {
        emit MakerEpochIncremented(msg.sender, ++makerEpoch[msg.sender]);
    }

    function getPosition(uint256 id, address account) external view returns (uint256 yesShares, uint256 noShares) {
        _market(id);
        Position storage p = positions[id][account];
        return (p.yes, p.no);
    }

    function open(uint256 id) external {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.PENDING) revert InvalidState();
        if (m.creationChallenged) revert CreationChallengePending();
        if (block.timestamp < m.openAt) revert CreationWindowActive();
        m.state = MarketState.OPEN;
        templates[m.templateId].reviewed = true;
        emit MarketOpened(id, m.openAt);
    }

    function markCreationChallenged(uint256 id) external onlyResolution {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.PENDING || m.creationChallenged) revert InvalidState();
        m.creationChallenged = true;
        emit CreationChallenged(id);
    }

    function resolveCreation(uint256 id, bool upheld, address challenger) external onlyResolution nonReentrant {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.PENDING || !m.creationChallenged) revert InvalidState();
        m.creationChallenged = false;
        uint256 bond;
        uint256 cut;
        if (upheld) {
            if (challenger == address(0)) revert InvalidAddress();
            m.state = MarketState.CANCELLED;
            uint256 payout = maxPayout(id);
            openPayoutTotal -= payout;
            openPayoutByCreator[m.creator] -= payout;
            bond = m.creationBond;
            m.creationBond = 0;
            cut = bond * registry.params().jurorBondCutBps / 10_000;
            registry.unlockRole(m.creator, Role.CREATOR);
            collateral.safeTransfer(challenger, bond - cut);
            if (cut != 0) {
                collateral.safeTransfer(address(jurors), cut);
                jurors.notifyReward(cut);
            }
        } else {
            m.state = MarketState.OPEN;
            templates[m.templateId].reviewed = true;
            if (block.timestamp > m.openAt) m.openAt = uint64(block.timestamp);
            emit MarketOpened(id, m.openAt);
        }
        emit CreationResolved(id, upheld, challenger, bond, cut);
    }

    function setProposed(uint256 id) external onlyResolution {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.OPEN) revert InvalidState();
        m.state = MarketState.PROPOSED;
        emit MarketProposed(id);
    }

    function setDisputed(uint256 id) external onlyResolution {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.PROPOSED) revert InvalidState();
        m.state = MarketState.DISPUTED;
        emit MarketDisputed(id);
    }

    function finalize(uint256 id, Outcome outcome) external onlyResolution nonReentrant {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state == MarketState.FINAL || m.state == MarketState.CANCELLED) revert InvalidState();
        m.state = MarketState.FINAL;
        m.finalOutcome = outcome;
        uint256 payout = maxPayout(id);
        openPayoutTotal -= payout;
        openPayoutByCreator[m.creator] -= payout;
        ++_finalizedCount;
        uint256 bond = m.creationBond;
        m.creationBond = 0;
        if (outcome == Outcome.INVALID) registry.reportLoss(m.creator, Role.CREATOR, payout);
        else registry.reportGain(m.creator, Role.CREATOR, payout);
        registry.unlockRole(m.creator, Role.CREATOR);
        collateral.safeTransfer(m.creator, bond);
        emit MarketFinalized(id, outcome);
    }

    function distributeFees(uint256 id) external nonReentrant {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.FINAL) revert InvalidState();
        if (m.feesDistributed) revert AlreadyDistributed();
        m.feesDistributed = true;
        uint256 pool = feePool[id];
        feePool[id] = 0;
        Params memory p = registry.params();
        uint256 creatorShare = pool * p.creatorShareBps / 10_000;
        uint256 resolutionShare = pool * p.resolutionShareBps / 10_000;
        uint256 jurorShare = pool * p.jurorShareBps / 10_000;
        uint256 bountyShare = pool * p.bountyShareBps / 10_000;
        // All share-rounding dust belongs to the treasury (R32).
        uint256 treasuryShare = pool - creatorShare - resolutionShare - jurorShare - bountyShare;
        uint256 tip = resolutionShare * p.keeperTipBps / 10_000;
        resolutionShare -= tip;
        IBlinkResolution resolver = IBlinkResolution(resolution);
        address proposer = resolver.proposerOf(id);
        bool proposalWon = proposer != address(0) && m.finalOutcome == resolver.proposedOutcome(id);
        address winner = resolver.bountyWinner(id);
        if (m.finalOutcome == Outcome.INVALID) jurorShare += creatorShare;
        else if (creatorShare != 0) collateral.safeTransfer(m.creator, creatorShare);
        if (proposalWon) {
            if (resolutionShare != 0) collateral.safeTransfer(proposer, resolutionShare);
        } else jurorShare += resolutionShare;
        // Resolution also records the proposer on a failed challenge; only an overturn earns this bounty.
        if (winner != address(0) && !proposalWon && m.finalOutcome != Outcome.INVALID) {
            if (bountyShare != 0) collateral.safeTransfer(winner, bountyShare);
        } else jurorShare += bountyShare;
        if (treasuryShare != 0) collateral.safeTransfer(registry.addresses().treasury, treasuryShare);
        if (tip != 0) collateral.safeTransfer(msg.sender, tip);
        if (jurorShare != 0) {
            collateral.safeTransfer(address(jurors), jurorShare);
            jurors.notifyReward(jurorShare);
        }
        emit FeesDistributed(id, pool, msg.sender, tip);
    }

    function redeem(uint256 id) external nonReentrant {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.FINAL) revert InvalidState();
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
}
