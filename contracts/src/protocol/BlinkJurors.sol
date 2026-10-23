// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkJurors} from "./interfaces/IBlinkJurors.sol";
import {IBlinkRegistry} from "./interfaces/IBlinkRegistry.sol";
import {IBlinkMarkets} from "./interfaces/IBlinkMarkets.sol";
import {IBlinkPriceSource} from "./interfaces/IBlinkPriceSource.sol";
import {GenerationAddresses, Params} from "./BlinkTypes.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @dev Token held here splits three ways, tracked apart: staked (checkpointed), pending unstakes, and slashed
/// tokens awaiting `reward`. token.balanceOf(this) >= totalStaked() + totalPending + undistributedSlashed.
contract BlinkJurors is IBlinkJurors, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;

    error WrongChain();
    error WrongAddress();
    error UnauthorizedCaller();
    error NotRegistered();
    error InvalidAmount();
    error InsufficientStake();
    error CooldownActive();
    error NothingToWithdraw();
    error UnstakeBreaksSecurity();
    error RewardNotFunded();
    error InsufficientSlashed();

    event Staked(address indexed juror, uint256 amount);
    event UnstakeRequested(address indexed juror, uint256 amount, uint256 unlockAt);
    event UnstakeWithdrawn(address indexed juror, uint256 amount);
    event RewardNotified(address indexed from, uint256 amount, uint256 rewardPerToken);
    event RewardsClaimed(address indexed juror, uint256 amount);
    event Slashed(address indexed juror, uint256 requested, uint256 slashed, address indexed to);
    event JurorRewarded(address indexed juror, uint256 amount);

    struct Unstake {
        uint256 amount;
        uint256 unlockAt;
    }

    uint256 private constant REWARD_PRECISION = 1e36;

    IBlinkRegistry public immutable registry;
    address public immutable markets;
    address public immutable resolution;
    IERC20 public immutable token;
    IERC20 public immutable collateral;
    IBlinkPriceSource public immutable priceSource;

    mapping(address => Checkpoints.Trace208) private _stake;
    Checkpoints.Trace208 private _totalStake;
    // one aggregate request per juror: a new request restarts the cooldown for the whole pending amount
    mapping(address => Unstake) public pendingUnstake;
    uint256 public totalPending;
    uint256 public undistributedSlashed;

    uint256 public rewardPerTokenStored;
    uint256 public rewardCarry; // notified while nothing was staked; joins the next notify
    uint256 public rewardsOwed; // notified bUSD not yet claimed (includes floor-rounding dust)
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    constructor(GenerationAddresses memory a) {
        if (block.chainid != 84532) revert WrongChain();
        if (
            a.jurors != address(this) || a.registry == address(0) || a.markets == address(0)
                || a.resolution == address(0) || a.collateral == address(0) || a.token == address(0)
                || a.priceSource == address(0)
        ) revert WrongAddress();
        registry = IBlinkRegistry(a.registry);
        markets = a.markets;
        resolution = a.resolution;
        token = IERC20(a.token);
        collateral = IERC20(a.collateral);
        priceSource = IBlinkPriceSource(a.priceSource);
    }

    function stake(uint256 amount) external nonReentrant {
        if (!registry.isRegistered(msg.sender)) revert NotRegistered();
        if (amount == 0) revert InvalidAmount();
        _settle(msg.sender);
        _setStake(msg.sender, _stake[msg.sender].latest() + amount, _totalStake.latest() + amount);
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    function requestUnstake(uint256 amount) external {
        if (amount == 0) revert InvalidAmount();
        uint256 current = _stake[msg.sender].latest();
        if (amount > current) revert InsufficientStake();
        _settle(msg.sender);
        _setStake(msg.sender, current - amount, _totalStake.latest() - amount);
        Params memory p = registry.params();
        // the stake that remains must still cover every open payout; otherwise nobody can exit below the bound
        if (attackCostMicros() * 10000 < IBlinkMarkets(markets).openPayoutTotal() * p.securityMultipleBps) {
            revert UnstakeBreaksSecurity();
        }
        Unstake storage u = pendingUnstake[msg.sender];
        u.amount += amount;
        u.unlockAt = block.timestamp + p.jurorUnstakeCooldown;
        totalPending += amount;
        emit UnstakeRequested(msg.sender, amount, u.unlockAt);
    }

    function withdrawUnstaked() external nonReentrant {
        Unstake memory u = pendingUnstake[msg.sender];
        if (u.amount == 0) revert NothingToWithdraw();
        if (block.timestamp < u.unlockAt) revert CooldownActive();
        delete pendingUnstake[msg.sender];
        totalPending -= u.amount;
        token.safeTransfer(msg.sender, u.amount);
        emit UnstakeWithdrawn(msg.sender, u.amount);
    }

    function claimRewards() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = rewards[msg.sender];
        if (amount == 0) return;
        rewards[msg.sender] = 0;
        rewardsOwed -= amount;
        collateral.safeTransfer(msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    function stakeAt(address juror, uint256 timepoint) external view returns (uint256) {
        return _stake[juror].upperLookupRecent(_key(timepoint));
    }

    function totalStakeAt(uint256 timepoint) external view returns (uint256) {
        return _totalStake.upperLookupRecent(_key(timepoint));
    }

    function totalStaked() public view returns (uint256) {
        return _totalStake.latest();
    }

    function attackCostMicros() public view returns (uint256) {
        return totalStaked() * priceSource.tokenPriceMicros() / 1e18 / 2;
    }

    function notifyReward(uint256 busdAmount) external {
        if (msg.sender != markets && msg.sender != resolution) revert UnauthorizedCaller();
        if (busdAmount == 0) return; // a zero juror share must not block the caller's settlement
        if (collateral.balanceOf(address(this)) < rewardsOwed + busdAmount) revert RewardNotFunded();
        rewardsOwed += busdAmount;
        uint256 total = _totalStake.latest();
        uint256 distributable = busdAmount + rewardCarry;
        if (total == 0) {
            rewardCarry = distributable;
        } else {
            rewardCarry = 0;
            rewardPerTokenStored += Math.mulDiv(distributable, REWARD_PRECISION, total);
        }
        emit RewardNotified(msg.sender, busdAmount, rewardPerTokenStored);
    }

    /// @dev Takes from stake first, then from a pending unstake so requesting an exit cannot dodge a slash.
    /// Capped at what the juror still has so a slash never reverts resolution. Tokens sent to this contract
    /// stay here as undistributedSlashed.
    function slash(address juror, uint256 amount, address to) external nonReentrant {
        if (msg.sender != resolution) revert UnauthorizedCaller();
        _settle(juror);
        uint256 staked = _stake[juror].latest();
        uint256 fromStake = Math.min(amount, staked);
        uint256 fromPending = Math.min(amount - fromStake, pendingUnstake[juror].amount);
        uint256 taken = fromStake + fromPending;
        if (taken == 0) return;
        if (fromStake > 0) _setStake(juror, staked - fromStake, _totalStake.latest() - fromStake);
        if (fromPending > 0) {
            pendingUnstake[juror].amount -= fromPending;
            totalPending -= fromPending;
        }
        if (to == address(this)) undistributedSlashed += taken;
        else token.safeTransfer(to, taken);
        emit Slashed(juror, amount, taken, to);
    }

    function reward(address juror, uint256 tokenAmount) external nonReentrant {
        if (msg.sender != resolution) revert UnauthorizedCaller();
        if (tokenAmount > undistributedSlashed) revert InsufficientSlashed();
        undistributedSlashed -= tokenAmount;
        token.safeTransfer(juror, tokenAmount);
        emit JurorRewarded(juror, tokenAmount);
    }

    function _settle(address juror) private {
        uint256 delta = rewardPerTokenStored - userRewardPerTokenPaid[juror];
        if (delta == 0) return;
        rewards[juror] += Math.mulDiv(_stake[juror].latest(), delta, REWARD_PRECISION);
        userRewardPerTokenPaid[juror] = rewardPerTokenStored;
    }

    function _setStake(address juror, uint256 jurorStake, uint256 total) private {
        uint48 key = uint48(block.timestamp);
        _stake[juror].push(key, SafeCast.toUint208(jurorStake));
        _totalStake.push(key, SafeCast.toUint208(total));
    }

    function _key(uint256 timepoint) private pure returns (uint48) {
        return uint48(Math.min(timepoint, type(uint48).max));
    }
}
