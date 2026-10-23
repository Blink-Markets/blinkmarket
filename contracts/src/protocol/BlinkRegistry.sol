// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {Role, Params, GenerationAddresses} from "./BlinkTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

contract BlinkRegistry is IBlinkRegistry, ReentrancyGuard {
    using SafeERC20 for IERC20;

    error WrongChain();
    error WrongAddress();
    error InvalidAddress();
    error InvalidParams();
    error NotRegistered();
    error AlreadyRegistered();
    error JurorUsesToken();
    error StakeTooLow();
    error InvalidAmount();
    error RoleAlreadyJoined();
    error RoleNotActive();
    error NotExiting();
    error CooldownActive();
    error UnauthorizedReporter();
    error NothingToImport();
    error AlreadyImported();

    event Registered(address indexed account, uint256 feePaid);
    event RoleJoined(address indexed account, Role indexed role, uint256 amount);
    event RoleStakeAdded(address indexed account, Role indexed role, uint256 amount);
    event RoleExitRequested(address indexed account, Role indexed role, uint64 withdrawableAt);
    event RoleWithdrawn(address indexed account, Role indexed role, uint256 amount);
    event RoleSlashed(address indexed account, Role indexed role, uint256 amount);
    event CreditGained(address indexed account, Role indexed role, uint256 amount, uint256 credit);
    event CreditLost(address indexed account, Role indexed role, uint256 amount, uint256 credit);
    event CreditImported(address indexed account, Role indexed role, uint256 amount, uint256 credit);
    event Imported(address indexed account);

    enum RoleStatus { NONE, ACTIVE, EXITING }

    struct RoleAccount {
        uint256 stake;
        uint64 withdrawableAt; // set while EXITING
        RoleStatus status;
    }

    struct Credit {
        uint256 value; // as of updatedAt; halves every creditHalfLife
        uint64 updatedAt;
    }

    uint256 private constant BPS = 10_000;
    uint256 private constant ROLE_COUNT = 7;
    uint256 private constant MAX_DECAY_SHIFT = 32;

    IERC20 private immutable collateral;
    address private immutable jurors;
    address private immutable markets;
    address private immutable resolution;
    address private immutable token;
    address private immutable priceSource;
    address private immutable treasury;
    address private immutable previousRegistry;

    Params private _params;
    mapping(address => bool) private _registered;
    mapping(address => bool) private _imported;
    mapping(address => mapping(Role => RoleAccount)) private _roles;
    mapping(address => mapping(Role => Credit)) private _credit;

    modifier onlyReporter() {
        if (msg.sender != markets && msg.sender != resolution && msg.sender != jurors) revert UnauthorizedReporter();
        _;
    }

    constructor(Params memory p, GenerationAddresses memory a) {
        if (block.chainid != 84532) revert WrongChain();
        if (a.registry != address(this)) revert WrongAddress();
        if (
            a.jurors == address(0) || a.markets == address(0) || a.resolution == address(0)
                || a.collateral == address(0) || a.treasury == address(0)
        ) revert InvalidAddress();
        if (a.previousRegistry != address(0) && a.previousRegistry.code.length == 0) revert InvalidAddress();
        _validate(p);
        _params = p;
        collateral = IERC20(a.collateral);
        jurors = a.jurors;
        markets = a.markets;
        resolution = a.resolution;
        token = a.token;
        priceSource = a.priceSource;
        treasury = a.treasury;
        previousRegistry = a.previousRegistry;
    }

    function _validate(Params memory p) private pure {
        uint256 shares =
            uint256(p.treasuryShareBps) + p.creatorShareBps + p.resolutionShareBps + p.jurorShareBps + p.bountyShareBps;
        if (shares != BPS || p.maxRounds > 4 || p.creditHalfLife == 0 || p.creditUnitMicros == 0) revert InvalidParams();
        if (p.maxCreditMultiplierBps < BPS) revert InvalidParams(); // the multiplier starts at 10000
        if (
            p.feeBps > BPS || p.keeperTipBps > BPS || p.jurorBondCutBps > BPS || p.maxCreditDiscountBps > BPS
                || p.importDiscountBps > BPS || p.nonRevealSlashBps > BPS || p.incoherentSlashBps > BPS
                || p.roleSlashBps > BPS
        ) revert InvalidParams();
        for (uint256 i; i < 4; ++i) {
            if (p.quorumBps[i] > BPS) revert InvalidParams();
        }
    }

    // identity

    function register() external nonReentrant {
        if (_registered[msg.sender]) revert AlreadyRegistered();
        _registered[msg.sender] = true;
        uint256 fee = _params.registrationFee;
        if (previousRegistry != address(0) && IBlinkRegistry(previousRegistry).isRegistered(msg.sender)) fee = 0;
        if (fee != 0) collateral.safeTransferFrom(msg.sender, treasury, fee);
        emit Registered(msg.sender, fee);
    }

    function isRegistered(address account) external view returns (bool) {
        return _registered[account];
    }

    // roles

    function joinRole(Role role, uint256 amount) external nonReentrant {
        _requireStakedRole(role);
        if (!_registered[msg.sender]) revert NotRegistered();
        RoleAccount storage r = _roles[msg.sender][role];
        if (r.status != RoleStatus.NONE) revert RoleAlreadyJoined();
        if (amount < _params.minRoleStake) revert StakeTooLow();
        r.status = RoleStatus.ACTIVE;
        r.stake = amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit RoleJoined(msg.sender, role, amount);
    }

    function addRoleStake(Role role, uint256 amount) external nonReentrant {
        _requireStakedRole(role);
        RoleAccount storage r = _roles[msg.sender][role];
        if (r.status != RoleStatus.ACTIVE) revert RoleNotActive();
        if (amount == 0) revert InvalidAmount();
        r.stake += amount;
        collateral.safeTransferFrom(msg.sender, address(this), amount);
        emit RoleStakeAdded(msg.sender, role, amount);
    }

    function requestRoleExit(Role role) external {
        _requireStakedRole(role);
        RoleAccount storage r = _roles[msg.sender][role];
        if (r.status != RoleStatus.ACTIVE) revert RoleNotActive();
        r.status = RoleStatus.EXITING;
        r.withdrawableAt = uint64(block.timestamp) + _params.roleExitCooldown;
        emit RoleExitRequested(msg.sender, role, r.withdrawableAt);
    }

    function withdrawRole(Role role) external nonReentrant {
        _requireStakedRole(role);
        RoleAccount storage r = _roles[msg.sender][role];
        if (r.status != RoleStatus.EXITING) revert NotExiting();
        if (block.timestamp < r.withdrawableAt) revert CooldownActive();
        uint256 amount = r.stake;
        delete _roles[msg.sender][role];
        collateral.safeTransfer(msg.sender, amount);
        emit RoleWithdrawn(msg.sender, role, amount);
    }

    function hasRole(address account, Role role) external view returns (bool) {
        if (role == Role.JUROR) return _registered[account]; // juror stake is the token, registration is enough
        return _roles[account][role].status == RoleStatus.ACTIVE;
    }

    function roleStake(address account, Role role) external view returns (uint256) {
        return _roles[account][role].stake;
    }

    function _requireStakedRole(Role role) private pure {
        if (role == Role.JUROR) revert JurorUsesToken();
    }

    // credit

    function creditOf(address account, Role role) public view returns (uint256) {
        Credit storage c = _credit[account][role];
        uint256 shift = (block.timestamp - c.updatedAt) / _params.creditHalfLife;
        return shift >= MAX_DECAY_SHIFT ? 0 : c.value >> shift;
    }

    function bondFor(address account, Role role, uint256 baseBond) external view returns (uint256) {
        Params storage p = _params;
        uint256 discount = Math.min(creditOf(account, role) * p.creditDiscountStepBps, p.maxCreditDiscountBps);
        return Math.mulDiv(baseBond, BPS - discount, BPS, Math.Rounding.Ceil); // rounds up: never under the floor
    }

    function limitMultiplierBps(address account, Role role) external view returns (uint256) {
        Params storage p = _params;
        return Math.min(BPS + creditOf(account, role) * p.creditMultiplierStepBps, p.maxCreditMultiplierBps);
    }

    function meetsThreshold(address account, Role role, uint32 threshold) external view returns (bool) {
        if (IBlinkMarkets(markets).finalizedCount() < _params.phaseInFinalizedMarkets) return true;
        return creditOf(account, role) >= threshold;
    }

    // reporter hooks

    function reportGain(address account, Role role, uint256 maxPayout) external onlyReporter {
        uint256 gain = _creditUnits(maxPayout);
        if (gain == 0) return;
        Credit storage c = _credit[account][role];
        _materialise(c);
        c.value += gain;
        emit CreditGained(account, role, gain, c.value);
    }

    function reportLoss(address account, Role role, uint256 maxPayout) external onlyReporter {
        uint256 loss = _creditUnits(maxPayout) * _params.creditLossMultiplier;
        if (loss == 0) return;
        Credit storage c = _credit[account][role];
        _materialise(c);
        loss = Math.min(loss, c.value);
        if (loss == 0) return;
        c.value -= loss;
        emit CreditLost(account, role, loss, c.value);
    }

    function slashRole(address account, Role role) external onlyReporter nonReentrant returns (uint256 slashed) {
        RoleAccount storage r = _roles[account][role];
        slashed = r.stake * _params.roleSlashBps / BPS;
        if (slashed == 0) return 0;
        r.stake -= slashed;
        collateral.safeTransfer(treasury, slashed);
        emit RoleSlashed(account, role, slashed);
    }

    function _creditUnits(uint256 maxPayout) private view returns (uint256) {
        Params storage p = _params;
        return Math.min(maxPayout / p.creditUnitMicros, p.creditGainCap);
    }

    // Applies pending decay, keeping the part of the current period that has already elapsed.
    function _materialise(Credit storage c) private {
        uint256 value = c.value;
        if (value == 0) {
            c.updatedAt = uint64(block.timestamp);
            return;
        }
        uint256 half = _params.creditHalfLife;
        uint256 shift = (block.timestamp - c.updatedAt) / half;
        if (shift >= MAX_DECAY_SHIFT) {
            c.value = 0;
            c.updatedAt = uint64(block.timestamp);
        } else if (shift != 0) {
            c.value = value >> shift;
            c.updatedAt += uint64(shift * half);
        }
    }

    // generations

    function importCredit() external {
        if (previousRegistry == address(0)) revert NothingToImport();
        if (!_registered[msg.sender]) revert NotRegistered();
        if (_imported[msg.sender]) revert AlreadyImported();
        _imported[msg.sender] = true;
        uint256 discountBps = _params.importDiscountBps;
        for (uint256 i; i < ROLE_COUNT; ++i) {
            Role role = Role(i);
            uint256 amount = IBlinkRegistry(previousRegistry).creditOf(msg.sender, role) * discountBps / BPS;
            if (amount == 0) continue;
            Credit storage c = _credit[msg.sender][role];
            _materialise(c);
            c.value += amount; // added to anything already earned here
            emit CreditImported(msg.sender, role, amount, c.value);
        }
        emit Imported(msg.sender);
    }

    // views

    function params() external view returns (Params memory) {
        return _params;
    }

    function addresses() external view returns (GenerationAddresses memory) {
        return GenerationAddresses({
            registry: address(this),
            jurors: jurors,
            markets: markets,
            resolution: resolution,
            collateral: address(collateral),
            token: token,
            priceSource: priceSource,
            treasury: treasury,
            previousRegistry: previousRegistry
        });
    }
}
