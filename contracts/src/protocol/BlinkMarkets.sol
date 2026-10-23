// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkJurors} from "./interfaces/IBlinkJurors.sol";
import {Role, QuestionClass, MarketState, Outcome, Params, GenerationAddresses} from "./BlinkTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Creation slice; trading and settlement complete IBlinkMarkets in Tasks 5 and 8.
contract BlinkMarkets is ReentrancyGuard {
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

    struct Template {
        QuestionClass cls;
        bool exists;
        bool used;
    }

    uint256 public constant UNIT = 1_000_000;
    IBlinkRegistry public immutable registry;
    IBlinkJurors public immutable jurors;
    IERC20 public immutable collateral;
    address public immutable resolution;
    uint256 public nextMarketId = 1;
    uint256 public openPayoutTotal;
    mapping(address => uint256) public openPayoutByCreator;
    mapping(bytes32 => bool) public usedSpecHashes;
    mapping(bytes32 => Template) private templates;
    mapping(uint256 => IBlinkMarkets.Market) internal markets;
    mapping(uint256 => string) private specURIs;

    modifier onlyResolution() {
        if (msg.sender != resolution) revert UnauthorizedCaller();
        _;
    }

    constructor(GenerationAddresses memory a) {
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
        if (usedSpecHashes[a.specHash]) revert DuplicateSpec();
        Params memory p = registry.params();
        if (a.replay && !p.replayAllowed) revert ReplayNotAllowed();
        if (
            !(block.timestamp < a.closeAt && a.closeAt < a.proposalDeadline && a.proposalDeadline < a.hardDeadline)
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
        uint64 openAt = uint64(block.timestamp) + p.creationWindow[uint256(t.cls)] + (t.used ? 0 : p.firstUseExtraWindow);
        t.used = true;
        id = nextMarketId++;
        usedSpecHashes[a.specHash] = true;
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

    // shortcut: settlement accounting arrives in Task 8; no FINAL credits are reported in this slice.
    function finalizedCount() public view virtual returns (uint256) { return 0; }

    function open(uint256 id) external {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state != MarketState.PENDING) revert InvalidState();
        if (m.creationChallenged) revert CreationChallengePending();
        if (block.timestamp < m.openAt) revert CreationWindowActive();
        m.state = MarketState.OPEN;
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

    // shortcut: Task 8 adds bond return, exposure release, creator unlock and credit at FINAL.
    function finalize(uint256 id, Outcome outcome) external onlyResolution {
        IBlinkMarkets.Market storage m = _market(id);
        if (m.state == MarketState.FINAL || m.state == MarketState.CANCELLED) revert InvalidState();
        m.state = MarketState.FINAL;
        m.finalOutcome = outcome;
        emit MarketFinalized(id, outcome);
    }
}
