// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {ProtocolScenario} from "./Lifecycle.t.sol";
import {BlinkTestUSD} from "../../src/BlinkTestUSD.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {Role, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ProtocolAdversarialTest is ProtocolScenario {
    function test_whitewashingCostsFeeAndResetsCredit() public {
        uint256 id = _create(100); _open(id); _unchallenged(id);
        eq(registry.creditOf(creator, Role.CREATOR), 1);
        address fresh = actor("fresh sybil"); claimAs(fresh);
        approveBusdAs(fresh, address(registry));
        uint256 before = busd.balanceOf(fresh);
        uint256 treasuryBefore = busd.balanceOf(treasury);
        vm.prank(fresh); registry.register();
        eq(before - busd.balanceOf(fresh), p.registrationFee);
        eq(busd.balanceOf(treasury) - treasuryBefore, p.registrationFee);
        vm.prank(fresh); registry.joinRole(Role.CREATOR, p.minRoleStake);
        eq(registry.creditOf(fresh, Role.CREATOR), 0);
        eq(registry.limitMultiplierBps(fresh, Role.CREATOR), 10000);
        eq(registry.bondFor(fresh, Role.CREATOR, 5e6), 5e6);
        require(registry.limitMultiplierBps(creator, Role.CREATOR) > 10000, "old credit has economic value");
    }

    function test_bribeAbove50PercentIsBoundedByPayout() public {
        eq(jurors.stakeAt(j1, token.clock()) * 100 / jurors.totalStaked(), 51);
        uint256 id = _create(100);
        uint256 payout = markets.maxPayout(id);
        require(jurors.attackCostMicros() * 10000 >= payout * p.securityMultipleBps, "creation security bound");
        uint256 before = busd.balanceOf(taker) + busd.balanceOf(challenger) + busd.balanceOf(j1);
        _open(id); _fill(id, MAKER_KEY, taker, 1, 100);
        _propose(id);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(id, EVIDENCE);
        _round(dispute, 1, 0); _finalize(dispute);
        resolution.settleVote(dispute, 0, j2); resolution.settleVote(dispute, 0, j1);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.NO));
        markets.distributeFees(id);
        vm.prank(taker); markets.redeem(id);
        vm.warp(token.clock() + 7 days);
        vm.prank(j1); jurors.claimRewards();
        uint256 after_ = busd.balanceOf(taker) + busd.balanceOf(challenger) + busd.balanceOf(j1);
        require(after_ > before && after_ - before <= payout, "coalition net bUSD gain exceeds max payout");
        require(jurors.attackCostMicros() >= payout * p.securityMultipleBps / 10000, "stake cost exceeds payoff");
    }

    function test_tieStallEndsOnlyAtHardDeadline() public {
        vm.prank(j2); jurors.stake(20e18); // exact 510/510 split
        uint256 id = _create(100);
        uint256 dispute = _resultDispute(id);
        uint256 challengerBefore = busd.balanceOf(challenger);
        uint256 deadline = markets.getMarket(id).hardDeadline;
        uint256 attempts;
        while (uint256(token.clock()) + p.commitSeconds + p.revealSeconds < deadline) {
            (IBlinkResolution.Dispute memory old,) = resolution.getDispute(dispute);
            _round(dispute, 0, 1);
            (IBlinkResolution.Dispute memory next,) = resolution.getDispute(dispute);
            eq(next.currentRound, old.currentRound + 1); eq(next.appealRound, 0);
            resolution.settleVote(dispute, old.currentRound, j1);
            resolution.settleVote(dispute, old.currentRound, j2);
            eq(uint256(markets.getMarket(id).state), uint256(MarketState.DISPUTED));
            ++attempts;
        }
        require(attempts > 2, "repeated tie stall");
        eq(jurors.totalStaked(), 1020e18); eq(jurors.undistributedSlashed(), 0);
        vm.warp(deadline - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); resolution.finalizeTimeout(id);
        vm.warp(deadline); resolution.finalizeTimeout(id);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.INVALID));
        eq(busd.balanceOf(challenger), challengerBefore);
        eq(busd.balanceOf(address(resolution)), 0);
        eq(jurors.rewardsOwed(), 5e6); // challenger bond forfeits, proposal bond returns
        eq(jurors.openVotes(j1) + jurors.openVotes(j2), 0);
        vm.warp(token.clock() + 7 days);
        vm.prank(j1); jurors.claimRewards(); vm.prank(j2); jurors.claimRewards();
    }

    function test_committedWhaleCountsTowardQuorumWithoutRevealing() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        // Add enough nonparticipating snapshot stake that j2 alone is below the 20% quorum.
        // The extra stake is deliberately after this round's snapshot; restart takes a new snapshot.
        address reserve = actor("quorum reserve"); _identity(reserve);
        vm.startPrank(reserve); token.approve(address(jurors), type(uint256).max); jurors.stake(1000e18); vm.stopPrank();
        vm.prank(j1); jurors.stake(400e18);
        vm.prank(j2); jurors.requestUnstake(400e18);
        (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        vm.warp(r.revealEnd); resolution.settleRound(dispute);
        _commit(dispute, j1, 0); _commit(dispute, j2, 1);
        (, r) = resolution.getDispute(dispute);
        vm.warp(r.commitEnd);
        vm.prank(j2); resolution.revealVote(dispute, 1, EVIDENCE);
        vm.warp(r.revealEnd); resolution.settleRound(dispute);
        (, r) = resolution.getDispute(dispute);
        require(r.settled && !r.restarted && r.leadingChoice == 1, "committed weight establishes quorum");
        require(r.revealedWeight[1] < jurors.totalStakeAt(r.snapshotAt) * p.quorumBps[0] / 10000,
            "revealed weight alone is below quorum");
        _finalize(dispute);
        resolution.settleVote(dispute, 1, j1); resolution.settleVote(dispute, 1, j2);
        eq(jurors.openVotes(j1) + jurors.openVotes(j2), 0);
    }

    function test_restartSnapshotUsesCallerChosenTime() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        (, IBlinkResolution.Round memory first) = resolution.getDispute(dispute);
        vm.warp(first.revealEnd);
        vm.prank(j2); jurors.stake(100e18);
        uint64 at = token.clock() + 10 minutes;
        vm.warp(at); resolution.settleRound(dispute);
        (, IBlinkResolution.Round memory next) = resolution.getDispute(dispute);
        eq(next.snapshotAt, at - 1);
        eq(jurors.stakeAt(j2, first.snapshotAt), 490e18);
        eq(jurors.stakeAt(j2, next.snapshotAt), 590e18);
    }

    function test_creationAppellantDoesNotShareCreatorBond() public {
        uint256 id = _create(100);
        vm.prank(challenger); uint256 dispute = resolution.challengeCreation(id, 1, EVIDENCE);
        _round(dispute, 0, 0);
        address appellant = _role(actor("challenger appellant"), Role.CHALLENGER);
        uint256 challengerBefore = busd.balanceOf(challenger);
        vm.prank(appellant); resolution.appeal(dispute);
        uint256 appellantBefore = busd.balanceOf(appellant);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        _round(dispute, 1, 1); _finalize(dispute);
        // R9 pays the held creation bond to the original challenger, even with another appellant.
        eq(busd.balanceOf(challenger) - challengerBefore, 9e6);
        eq(busd.balanceOf(appellant) - appellantBefore, 10e6);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.CANCELLED));
    }

    function test_selfDisputeSybilCanFarmCreditAtACost() public {
        uint256 id = _create(100);
        uint256 before = busd.balanceOf(proposer) + busd.balanceOf(challenger);
        uint256 dispute = _resultDispute(id);
        _round(dispute, 0, 0); _finalize(dispute);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        eq(registry.creditOf(proposer, Role.PROPOSER), 1);
        eq(registry.creditOf(j1, Role.JUROR), 1);
        eq(before - busd.balanceOf(proposer) - busd.balanceOf(challenger), 1e6); // losing bond cut, plus role stake slash
        eq(registry.roleStake(challenger, Role.CHALLENGER), 90e6);
    }

    function test_positionsCannotBeShedToEvadeConflict() public {
        vm.prank(j1); registry.joinRole(Role.TAKER, p.minRoleStake);
        uint256 id = _create(100); _open(id); _fill(id, MAKER_KEY, j1, 0, 1);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        vm.prank(j1); markets.redeem(id);
        _propose(id);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(id, EVIDENCE);
        vm.expectRevert(BlinkResolution.ConflictedJuror.selector);
        vm.prank(j1); resolution.commitVote(dispute, keccak256(abi.encode(dispute, uint256(0), j1, uint8(0), EVIDENCE)));
        (IBlinkMarkets.Quote memory q, bytes memory sig) = _quote(id, MAKER_KEY, taker, 0, 1);
        vm.expectRevert(BlinkMarkets.MarketNotOpen.selector);
        vm.prank(taker); markets.fillQuote(q, sig);
    }

    function test_slashesBeforeTimeoutRemainUndistributed() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        _commit(dispute, j1, 1); _commit(dispute, j2, 0);
        (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        vm.warp(r.commitEnd); vm.prank(j1); resolution.revealVote(dispute, 1, EVIDENCE);
        vm.warp(r.revealEnd); resolution.settleRound(dispute);
        resolution.settleVote(dispute, 0, j2);
        eq(jurors.undistributedSlashed(), 49e18);
        vm.warp(markets.getMarket(id).hardDeadline); resolution.finalizeTimeout(id);
        resolution.settleVote(dispute, 0, j1);
        eq(jurors.undistributedSlashed(), 49e18);
        eq(jurors.openVotes(j1) + jurors.openVotes(j2), 0);
        require(token.balanceOf(address(jurors)) >= jurors.totalStaked() + jurors.undistributedSlashed(), "slash residue funded");
    }
}

contract ProtocolHostileToken is ERC20 {
    address private target;
    bytes private callback;
    bool private fail;
    bool public attempted;
    bool public reentered;
    bytes4 public reentryError;
    constructor() ERC20("Hostile protocol collateral", "BAD") {}
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address who, uint256 amount) external { _mint(who, amount); }
    function configure(address to, bytes calldata data, bool fail_) external {
        target = to; callback = data; fail = fail_; attempted = false; reentered = false; reentryError = bytes4(0);
    }
    function _callback() private {
        require(!fail, "transfer failure");
        if (target == address(0) || attempted) return;
        attempted = true;
        bytes memory reason;
        (reentered, reason) = target.call(callback);
        reentryError = bytes4(reason);
    }
    function transfer(address to, uint256 amount) public override returns (bool) {
        _callback(); return super.transfer(to, amount);
    }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _callback(); return super.transferFrom(from, to, amount);
    }
}

contract ProtocolReentrancyTest is ProtocolScenario {
    ProtocolHostileToken private hostile;

    function setUp() public override {
        ProtocolBase.setUp();
        hostile = new ProtocolHostileToken();
        busd = BlinkTestUSD(address(hostile));
        _setupGeneration(defaultParams());
    }

    function _fundIdentity(address who) internal override {
        claimAs(who); // real faucet provides the platform token; collateral is the malicious test double
        hostile.mint(who, 1000e6);
    }

    function _guarded() private view {
        require(hostile.attempted() && !hostile.reentered(), "callback must attempt and fail");
        require(hostile.reentryError() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "guard blocks callback");
    }

    function test_reentrantTokenCannotDrain() public {
        uint256 id = _create(100); _open(id);
        (IBlinkMarkets.Quote memory q, bytes memory sig) = _quote(id, MAKER_KEY, taker, 0, 10);
        hostile.configure(address(markets), abi.encodeCall(markets.fillQuote, (q, sig)), true);
        vm.expectRevert(); vm.prank(taker); markets.fillQuote(q, sig);
        require(!markets.consumed(markets.hashQuote(q)), "failed transfer rolls quote back");
        eq(markets.getMarket(id).escrowMicros, 0); eq(markets.makerFree(maker), 300e6);
        hostile.configure(address(markets), abi.encodeCall(markets.fillQuote, (q, sig)), false);
        vm.prank(taker); markets.fillQuote(q, sig); _guarded();
        hostile.configure(address(0), "", false);
        _unchallenged(id);
        uint256 held = busd.balanceOf(address(markets));
        hostile.configure(address(markets), abi.encodeCall(markets.redeem, (id)), true);
        vm.expectRevert(); vm.prank(taker); markets.redeem(id);
        (uint256 y,) = markets.getPosition(id, taker); eq(y, 10); eq(markets.getMarket(id).escrowMicros, 10e6);
        hostile.configure(address(markets), abi.encodeCall(markets.redeem, (id)), false);
        uint256 before = busd.balanceOf(taker);
        vm.prank(taker); markets.redeem(id); _guarded(); eq(busd.balanceOf(taker) - before, 10e6);
        eq(held - busd.balanceOf(address(markets)), 10e6);
        hostile.configure(address(markets), abi.encodeCall(markets.distributeFees, (id)), true);
        vm.expectRevert(); markets.distributeFees(id);
        require(!markets.getMarket(id).feesDistributed, "fee rollback"); eq(markets.feePool(id), 50000);
        hostile.configure(address(markets), abi.encodeCall(markets.distributeFees, (id)), false);
        markets.distributeFees(id); _guarded(); eq(markets.feePool(id), 0);
        hostile.configure(address(0), "", false);
        vm.prank(taker); registry.requestRoleExit(Role.TAKER);
        vm.warp(token.clock() + p.roleExitCooldown);
        hostile.configure(address(registry), abi.encodeCall(registry.withdrawRole, (Role.TAKER)), true);
        vm.expectRevert(); vm.prank(taker); registry.withdrawRole(Role.TAKER);
        eq(registry.roleStake(taker, Role.TAKER), p.minRoleStake);
        hostile.configure(address(registry), abi.encodeCall(registry.withdrawRole, (Role.TAKER)), false);
        vm.prank(taker); registry.withdrawRole(Role.TAKER); _guarded(); eq(registry.roleStake(taker, Role.TAKER), 0);
        vm.warp(token.clock() + 7 days);
        uint256 owed = jurors.rewardsOwed();
        hostile.configure(address(jurors), abi.encodeCall(jurors.claimRewards, ()), true);
        vm.expectRevert(); vm.prank(j1); jurors.claimRewards(); eq(jurors.rewardsOwed(), owed);
        hostile.configure(address(jurors), abi.encodeCall(jurors.claimRewards, ()), false);
        before = busd.balanceOf(j1);
        vm.prank(j1); jurors.claimRewards(); _guarded();
        require(busd.balanceOf(j1) > before && jurors.rewardsOwed() < owed, "single funded reward");
    }
}
