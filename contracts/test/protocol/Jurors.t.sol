// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {Params, GenerationAddresses} from "../../src/protocol/BlinkTypes.sol";

contract StubRegistry {
    uint64 public cooldown = 3 days;
    uint16 public securityBps = 10000;
    mapping(address => bool) public isRegistered;

    function setSecurityBps(uint16 v) external {
        securityBps = v;
    }

    function register(address who) external {
        isRegistered[who] = true;
    }

    function params() external view returns (Params memory p) {
        p.jurorUnstakeCooldown = cooldown;
        p.securityMultipleBps = securityBps;
    }
}

contract StubMarkets {
    uint256 public openPayoutTotal;

    function setOpenPayoutTotal(uint256 v) external {
        openPayoutTotal = v;
    }
}

contract JurorsTest is ProtocolBase {
    bytes4 private constant WRONG_CHAIN = bytes4(keccak256("WrongChain()"));
    uint256 private constant COOLDOWN = 3 days;

    StubRegistry internal registry;
    StubMarkets internal markets;
    BlinkJurors internal jurors;
    address internal resolution = actor("resolution");
    address internal alice = actor("alice");
    address internal bob = actor("bob");
    address internal carol = actor("carol");
    uint256 private constant STREAM = 7 days;
    uint256 private constant R = 604_800_000; // 604.8 bUSD: exactly 1000 micros per second over STREAM

    function setUp() public override {
        super.setUp();
        registry = new StubRegistry();
        markets = new StubMarkets();
        jurors = new BlinkJurors(_addresses(vm.computeCreateAddress(address(this), vm.getNonce(address(this)))));
        address[3] memory who = [alice, bob, carol];
        for (uint256 i = 0; i < who.length; i++) {
            registry.register(who[i]);
            claimAs(who[i]);
            vm.prank(who[i]);
            token.approve(address(jurors), type(uint256).max);
        }
    }

    function _addresses(address jurorsAddr) internal view returns (GenerationAddresses memory a) {
        a.registry = address(registry);
        a.jurors = jurorsAddr;
        a.markets = address(markets);
        a.resolution = resolution;
        a.collateral = address(busd);
        a.token = address(token);
        a.priceSource = address(priceSource);
        a.treasury = treasury;
    }

    function stakeAs(address who, uint256 amount) internal {
        vm.prank(who);
        jurors.stake(amount);
    }

    // markets-side helper: bUSD from `from` goes in first, then markets calls notifyReward
    function notify(address from, uint256 amount) internal {
        vm.prank(from);
        busd.transfer(address(jurors), amount);
        vm.prank(address(markets));
        jurors.notifyReward(amount);
    }

    // Task 10's solvency claims for this contract
    function assertSolvent() internal view {
        require(
            token.balanceOf(address(jurors)) >= jurors.totalStaked() + jurors.totalPending() + jurors.undistributedSlashed(),
            "token solvency"
        );
        require(busd.balanceOf(address(jurors)) >= jurors.rewardsOwed(), "bUSD solvency");
        require(jurors.rewardsOwed() >= jurors.unstreamedRewards(), "unstreamed within owed");
    }

    function claimed(address who) internal returns (uint256 got) {
        uint256 before = busd.balanceOf(who);
        vm.prank(who);
        jurors.claimRewards();
        got = busd.balanceOf(who) - before;
        assertSolvent();
    }

    function near(uint256 actual, uint256 expected, uint256 tol) internal pure {
        require(actual + tol >= expected && actual <= expected + tol, "not within tolerance");
    }

    // faucet allows 1000 tokens a day, so a bigger stake needs several days
    function fundTokens(address who, uint256 claims) internal {
        for (uint256 i = 0; i < claims; i++) {
            if (i > 0) vm.warp(token.clock() + 1 days);
            claimAs(who);
        }
        vm.prank(who);
        token.approve(address(jurors), type(uint256).max);
    }

    function test_stakeCheckpointsByTimestamp() public {
        uint256 t = token.clock();
        stakeAs(alice, 100e18);
        vm.warp(t + 10);
        stakeAs(alice, 50e18);
        vm.warp(t + 20);
        eq(jurors.stakeAt(alice, t - 1), 0);
        eq(jurors.stakeAt(alice, t), 100e18);
        eq(jurors.stakeAt(alice, t + 5), 100e18);
        eq(jurors.stakeAt(alice, t + 10), 150e18);
        eq(jurors.stakeAt(alice, t + 15), 150e18);
        eq(jurors.totalStakeAt(t + 5), 100e18);
        eq(jurors.totalStakeAt(t + 10), 150e18);
        eq(jurors.totalStaked(), 150e18);
        eq(token.balanceOf(address(jurors)), 150e18);
        assertSolvent();
    }

    function test_totalStakeAtSumsJurors() public {
        uint256 t = token.clock();
        stakeAs(alice, 100e18);
        vm.warp(t + 10);
        stakeAs(bob, 300e18);
        vm.warp(t + 20);
        eq(jurors.totalStakeAt(t + 9), 100e18);
        eq(jurors.totalStakeAt(t + 10), 400e18);
        eq(jurors.stakeAt(bob, t + 9), 0);
    }

    function test_unstakeCooldown() public {
        uint256 t = token.clock();
        stakeAs(alice, 100e18);
        vm.warp(t + 10);
        uint256 t1 = token.clock();
        vm.prank(alice);
        jurors.requestUnstake(40e18);
        eq(jurors.stakeAt(alice, t1), 60e18);
        eq(jurors.totalStaked(), 60e18);
        eq(jurors.totalPending(), 40e18);
        eq(token.balanceOf(alice), 900e18);
        assertSolvent();

        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.CooldownActive.selector);
        vm.prank(alice);
        j.withdrawUnstaked();

        vm.warp(t1 + COOLDOWN - 1);
        vm.expectRevert(BlinkJurors.CooldownActive.selector);
        vm.prank(alice);
        j.withdrawUnstaked();

        vm.warp(t1 + COOLDOWN);
        vm.prank(alice);
        jurors.withdrawUnstaked();
        eq(token.balanceOf(alice), 940e18);
        eq(jurors.totalPending(), 0);
        assertSolvent();

        vm.expectRevert(BlinkJurors.NothingToWithdraw.selector);
        vm.prank(alice);
        j.withdrawUnstaked();
    }

    function test_secondRequestRestartsCooldownForTheWholePending() public {
        stakeAs(alice, 100e18);
        vm.prank(alice);
        jurors.requestUnstake(10e18);
        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.prank(alice);
        jurors.requestUnstake(10e18);
        uint256 t1 = token.clock();
        vm.warp(t1 + COOLDOWN - 1);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.CooldownActive.selector);
        vm.prank(alice);
        j.withdrawUnstaked();
        vm.warp(t1 + COOLDOWN);
        vm.prank(alice);
        jurors.withdrawUnstaked();
        eq(token.balanceOf(alice), 920e18);
    }

    function test_unstakeBadAmounts() public {
        stakeAs(alice, 100e18);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.InvalidAmount.selector);
        vm.prank(alice);
        j.requestUnstake(0);
        vm.expectRevert(BlinkJurors.InsufficientStake.selector);
        vm.prank(alice);
        j.requestUnstake(100e18 + 1);
        vm.expectRevert(BlinkJurors.InvalidAmount.selector);
        vm.prank(alice);
        j.stake(0);
    }

    function test_unstakeRefusedWhenItBreaksSecurityBound() public {
        stakeAs(alice, 1_000e18);
        // price 1e6 micros per token: attack cost = 1000 * 1 / 2 = 500 bUSD, which the stub payout just meets
        eq(jurors.attackCostMicros(), 500e6);
        markets.setOpenPayoutTotal(500e6);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.UnstakeBreaksSecurity.selector);
        vm.prank(alice);
        j.requestUnstake(1);

        markets.setOpenPayoutTotal(400e6); // leaves room for a 200-token exit (cost 400) but not 201
        vm.prank(alice);
        jurors.requestUnstake(200e18);
        vm.expectRevert(BlinkJurors.UnstakeBreaksSecurity.selector);
        vm.prank(alice);
        j.requestUnstake(1e18);

        markets.setOpenPayoutTotal(0);
        vm.prank(alice);
        jurors.requestUnstake(800e18);
        eq(jurors.totalStaked(), 0);
        assertSolvent();
    }

    function test_securityMultipleScalesTheBound() public {
        stakeAs(alice, 1_000e18);
        registry.setSecurityBps(20000); // attack cost must be twice the open payout
        markets.setOpenPayoutTotal(250e6);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.UnstakeBreaksSecurity.selector);
        vm.prank(alice);
        j.requestUnstake(1);
    }

    function test_rewardsSplitByStakeAndTime() public {
        stakeAs(alice, 100e18);
        stakeAs(bob, 300e18);
        uint256 t0 = token.clock();
        notify(carol, 400e6);
        vm.warp(t0 + STREAM);
        // each claim is at most 1 micro below exact (final floor); the 1e18-scaled rate truncation is below 1e-9
        near(claimed(alice), 100e6, 1);
        near(claimed(bob), 300e6, 1);

        // a juror staking after the stream ended gets none of it
        stakeAs(carol, 400e18);
        vm.warp(token.clock() + STREAM);
        eq(claimed(carol), 0);

        // second notify: all three stream by stake
        t0 = token.clock();
        notify(alice, 100e6);
        vm.warp(t0 + STREAM);
        near(claimed(carol), 50e6, 1);
    }

    function test_rewardsAreNotPaidInstantly() public {
        stakeAs(alice, 100e18);
        uint256 t0 = token.clock();
        notify(carol, R);
        eq(claimed(alice), 0); // nothing has streamed yet
        eq(jurors.unstreamedRewards(), R);
        vm.warp(t0 + STREAM / 2);
        near(claimed(alice), R / 2, 1);
        near(jurors.unstreamedRewards(), R / 2, 1);
    }

    function test_justInTimeStakerEarnsOnlyForTheSecondsItIsStaked() public {
        address whale = actor("whale");
        registry.register(whale);
        fundTokens(whale, 10);
        stakeAs(alice, 100e18);
        stakeAs(whale, 9_900e18); // 99% of the pool, one second before the notify
        uint256 t0 = token.clock();
        vm.warp(t0 + 1);
        notify(carol, R);
        vm.warp(t0 + 2);
        // one second of the stream (R / 604800 = 1000 micros) times its 99% share; paying R * 99% at once would be 598.7 bUSD
        eq(claimed(whale), 990);
        eq(claimed(alice), 10);
    }

    function test_stakerJoiningHalfwayGetsOnlyTheRestOfTheStream() public {
        stakeAs(alice, 100e18);
        stakeAs(bob, 100e18);
        uint256 t0 = token.clock();
        notify(carol, R);
        vm.warp(t0 + STREAM / 2);
        near(claimed(alice), 151_200_000, 1); // half the stream split two ways
        stakeAs(carol, 100e18);
        vm.warp(t0 + STREAM);
        uint256 aliceSecondHalf = claimed(alice);
        near(aliceSecondHalf, 100_800_000, 1); // half the stream split three ways
        near(claimed(carol), aliceSecondHalf, 1); // same stake, same window as alice's second half
        near(claimed(bob), 252_000_000, 1);
    }

    function test_notifyRestartsThePeriodAndRollsTheRemainder() public {
        stakeAs(alice, 100e18);
        uint256 t0 = token.clock();
        notify(carol, R);
        vm.warp(t0 + STREAM / 2);
        notify(bob, R); // R/2 unstreamed joins R and restarts the 7 days
        near(jurors.unstreamedRewards(), R + R / 2, 2);
        vm.warp(t0 + STREAM / 2 + STREAM);
        near(claimed(alice), 2 * R, 2);
        near(jurors.rewardsOwed(), 0, 3);
    }

    function test_rewardAccruesAcrossStakeChanges() public {
        stakeAs(alice, 100e18);
        uint256 t0 = token.clock();
        notify(bob, 100e6);
        vm.warp(t0 + STREAM);
        stakeAs(alice, 100e18); // settles the first stream before the stake doubles
        t0 = token.clock();
        notify(bob, 100e6);
        vm.warp(t0 + STREAM);
        near(claimed(alice), 200e6, 2);
    }

    function test_unstakedAmountEarnsNoReward() public {
        stakeAs(alice, 100e18);
        stakeAs(bob, 100e18);
        vm.prank(alice);
        jurors.requestUnstake(100e18);
        uint256 t0 = token.clock();
        notify(carol, 100e6);
        vm.warp(t0 + STREAM);
        eq(claimed(alice), 0);
        near(claimed(bob), 100e6, 1);
    }

    function test_notifyWithNoStakeGoesToTheTreasury() public {
        eq(busd.balanceOf(treasury), 0);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.RewardNotFunded.selector); // an unfunded notify cannot drain bUSD to the treasury
        vm.prank(address(markets));
        j.notifyReward(1e6);
        notify(carol, 60e6);
        eq(busd.balanceOf(treasury), 60e6);
        eq(busd.balanceOf(address(jurors)), 0);
        eq(jurors.rewardsOwed(), 0);
        stakeAs(alice, 100e18);
        vm.warp(token.clock() + STREAM);
        eq(claimed(alice), 0); // the earlier notify is not carried to a later staker
        eq(busd.balanceOf(treasury), 60e6);
    }

    function test_streamTimeWithNoStakeGoesToTheTreasury() public {
        stakeAs(alice, 100e18);
        uint256 t0 = token.clock();
        notify(carol, R);
        vm.warp(t0 + STREAM / 2);
        vm.prank(alice);
        jurors.requestUnstake(100e18); // everyone leaves at the halfway mark
        eq(jurors.totalStaked(), 0);

        vm.warp(t0 + STREAM * 3 / 4);
        stakeAs(bob, 100e18); // the idle quarter goes to the treasury, not to bob
        near(busd.balanceOf(treasury), R / 4, 1);
        assertSolvent();

        vm.warp(t0 + STREAM);
        near(claimed(bob), R / 4, 1); // only the last quarter, while he was staked
        near(claimed(alice), R / 2, 1);
        near(busd.balanceOf(treasury), R / 4, 1);
        near(jurors.rewardsOwed(), 0, 3);
    }

    function test_streamEndingWithNoStakeGoesToTheTreasury() public {
        stakeAs(alice, 100e18);
        uint256 t0 = token.clock();
        notify(carol, R);
        vm.warp(t0 + STREAM / 2);
        vm.prank(alice);
        jurors.requestUnstake(100e18);
        vm.warp(t0 + STREAM + 1 days);
        stakeAs(bob, 100e18); // joins after the stream is over
        near(busd.balanceOf(treasury), R / 2, 1);
        vm.warp(token.clock() + STREAM);
        eq(claimed(bob), 0);
        near(claimed(alice), R / 2, 1);
    }

    function test_notifyAuthAndFunding() public {
        stakeAs(alice, 100e18);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(alice);
        j.notifyReward(1);

        vm.expectRevert(BlinkJurors.RewardNotFunded.selector); // nothing transferred in
        vm.prank(address(markets));
        j.notifyReward(1e6);

        vm.prank(carol);
        busd.transfer(address(jurors), 10e6);
        vm.expectRevert(BlinkJurors.RewardNotFunded.selector); // asks for more than arrived
        vm.prank(resolution);
        j.notifyReward(11e6);
        vm.prank(resolution); // resolution may notify too
        j.notifyReward(10e6);
        // the same bUSD cannot be notified twice
        vm.expectRevert(BlinkJurors.RewardNotFunded.selector);
        vm.prank(address(markets));
        j.notifyReward(1e6);
    }

    function test_onlyResolutionSlashes() public {
        stakeAs(alice, 100e18);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(alice);
        j.slash(alice, 10e18, address(jurors));
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(address(markets));
        j.slash(alice, 10e18, address(jurors));
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(alice);
        j.reward(alice, 1);

        uint256 t = token.clock();
        vm.warp(t + 10);
        vm.prank(resolution);
        jurors.slash(alice, 30e18, address(jurors));
        eq(jurors.stakeAt(alice, t + 10), 70e18);
        eq(jurors.stakeAt(alice, t + 9), 100e18);
        eq(jurors.totalStakeAt(t + 10), 70e18);
        eq(jurors.totalStaked(), 70e18);
        assertSolvent();
    }

    function test_slashedTokensStayAndRewardPaysFromThem() public {
        stakeAs(alice, 100e18);
        stakeAs(bob, 100e18);
        vm.prank(resolution);
        jurors.slash(alice, 30e18, address(jurors));
        eq(token.balanceOf(address(jurors)), 200e18); // nothing left the contract
        eq(jurors.undistributedSlashed(), 30e18);
        eq(jurors.totalStaked(), 170e18);
        assertSolvent();

        vm.prank(resolution);
        jurors.reward(bob, 20e18);
        eq(token.balanceOf(bob), 920e18);
        eq(jurors.undistributedSlashed(), 10e18);
        eq(jurors.totalStaked(), 170e18); // reward is paid out, not restaked
        assertSolvent();

        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.InsufficientSlashed.selector);
        vm.prank(resolution);
        j.reward(bob, 10e18 + 1);
        vm.prank(resolution);
        jurors.reward(bob, 10e18);
        eq(jurors.undistributedSlashed(), 0);
        assertSolvent();
    }

    function test_slashToAnotherAddressMovesTokens() public {
        stakeAs(alice, 100e18);
        address sink = actor("sink");
        vm.prank(resolution);
        jurors.slash(alice, 30e18, sink);
        eq(token.balanceOf(sink), 30e18);
        eq(jurors.undistributedSlashed(), 0);
        eq(jurors.totalStaked(), 70e18);
        assertSolvent();
    }

    function test_slashCannotBeDodgedByRequestingUnstake() public {
        stakeAs(alice, 100e18);
        vm.prank(alice);
        jurors.requestUnstake(80e18); // 20 staked, 80 pending
        vm.prank(resolution);
        jurors.slash(alice, 50e18, address(jurors)); // 20 from stake, 30 from the pending request
        eq(jurors.totalStaked(), 0);
        eq(jurors.totalPending(), 50e18);
        eq(jurors.undistributedSlashed(), 50e18);
        assertSolvent();

        vm.warp(block.timestamp + COOLDOWN);
        vm.prank(alice);
        jurors.withdrawUnstaked();
        eq(token.balanceOf(alice), 950e18); // 900 + 50 left of the request
        assertSolvent();
    }

    function test_slashIsCappedAndNeverReverts() public {
        stakeAs(alice, 100e18);
        vm.prank(resolution);
        jurors.slash(alice, 500e18, address(jurors));
        eq(jurors.totalStaked(), 0);
        eq(jurors.undistributedSlashed(), 100e18);
        vm.prank(resolution);
        jurors.slash(alice, 1e18, address(jurors)); // nothing left to take
        vm.prank(resolution);
        jurors.slash(bob, 1e18, address(jurors)); // never staked
        eq(jurors.undistributedSlashed(), 100e18);
        assertSolvent();
    }

    function test_slashKeepsAccruedRewardsAndStopsFutureOnes() public {
        stakeAs(alice, 100e18);
        stakeAs(bob, 100e18);
        uint256 t0 = token.clock();
        notify(carol, 200e6);
        vm.warp(t0 + STREAM);
        vm.prank(resolution);
        jurors.slash(alice, 100e18, address(jurors));
        t0 = token.clock();
        notify(carol, 100e6);
        vm.warp(t0 + STREAM);
        near(claimed(alice), 100e6, 1); // earned before the slash
        near(claimed(bob), 200e6, 1);
    }

    function test_openVoteBlocksWithdrawButNotRequestAndSlashStillBites() public {
        stakeAs(alice, 100e18);
        vm.prank(resolution);
        jurors.lockVote(alice);
        eq(jurors.openVotes(alice), 1);

        vm.prank(alice);
        jurors.requestUnstake(80e18); // still allowed
        vm.warp(token.clock() + COOLDOWN + 1 days);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.OpenVotes.selector);
        vm.prank(alice);
        j.withdrawUnstaked();

        vm.prank(resolution); // the pending request is still slashable: 20 from stake, 30 from the request
        jurors.slash(alice, 50e18, address(jurors));
        eq(jurors.totalStaked(), 0);
        eq(jurors.totalPending(), 50e18);
        eq(jurors.undistributedSlashed(), 50e18);

        vm.expectRevert(BlinkJurors.OpenVotes.selector);
        vm.prank(alice);
        j.withdrawUnstaked();

        vm.prank(resolution);
        jurors.unlockVote(alice);
        vm.prank(alice);
        jurors.withdrawUnstaked();
        eq(token.balanceOf(alice), 950e18);
        assertSolvent();
    }

    function test_voteLocksCount() public {
        stakeAs(alice, 100e18);
        vm.prank(alice);
        jurors.requestUnstake(10e18);
        vm.startPrank(resolution);
        jurors.lockVote(alice);
        jurors.lockVote(alice); // two open disputes
        jurors.unlockVote(alice);
        vm.stopPrank();
        eq(jurors.openVotes(alice), 1);
        vm.warp(token.clock() + COOLDOWN);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.OpenVotes.selector);
        vm.prank(alice);
        j.withdrawUnstaked();
        vm.prank(resolution);
        jurors.unlockVote(alice);
        vm.prank(alice);
        jurors.withdrawUnstaked();

        vm.expectRevert(BlinkJurors.NoOpenVote.selector);
        vm.prank(resolution);
        j.unlockVote(alice);
    }

    function test_onlyResolutionLocksVotes() public {
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(alice);
        j.lockVote(alice);
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(address(markets));
        j.lockVote(alice);
        vm.expectRevert(BlinkJurors.UnauthorizedCaller.selector);
        vm.prank(alice);
        j.unlockVote(alice);
    }

    function test_unregisteredCannotStake() public {
        address stranger = actor("stranger");
        claimAs(stranger);
        vm.prank(stranger);
        token.approve(address(jurors), type(uint256).max);
        BlinkJurors j = jurors;
        vm.expectRevert(BlinkJurors.NotRegistered.selector);
        vm.prank(stranger);
        j.stake(1e18);
    }

    function test_constructorChecksAddressAndChain() public {
        GenerationAddresses memory a = _addresses(actor("not-me"));
        vm.expectRevert(BlinkJurors.WrongAddress.selector);
        new BlinkJurors(a);

        a = _addresses(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        a.registry = address(0);
        vm.expectRevert(BlinkJurors.WrongAddress.selector);
        new BlinkJurors(a);

        a = _addresses(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        a.treasury = address(0);
        vm.expectRevert(BlinkJurors.WrongAddress.selector);
        new BlinkJurors(a);

        a = _addresses(vm.computeCreateAddress(address(this), vm.getNonce(address(this))));
        vm.chainId(1);
        vm.expectRevert(WRONG_CHAIN);
        new BlinkJurors(a);
    }

    function testFuzz_claimsNeverExceedNotified(uint96 sa, uint96 sb, uint96 reward1, uint96 reward2, uint32 gap) public {
        uint256 a = bound(sa, 1, 1_000e18);
        uint256 b = bound(sb, 1, 1_000e18);
        uint256 r1 = bound(reward1, 1, 500e6); // carol funds both from her 1000 bUSD
        uint256 r2 = bound(reward2, 1, 500e6);
        uint256 dt = bound(gap, 1, STREAM * 2);
        stakeAs(alice, a);
        notify(carol, r1);
        vm.warp(token.clock() + dt);
        stakeAs(bob, b);
        notify(carol, r2);
        vm.warp(token.clock() + STREAM);
        uint256 paid = claimed(alice) + claimed(bob);
        require(paid <= r1 + r2, "overpaid");
        require(r1 + r2 - paid <= 3, "dust beyond rounding"); // one micro per claimant plus rate truncation
    }

    // whatever is notified ends up with the jurors or the treasury, even across a window with nothing staked
    function testFuzz_notifiedSplitsBetweenJurorsAndTreasury(uint96 reward1, uint32 stayFor, uint32 idleFor) public {
        uint256 r = bound(reward1, 1, 1_000e6);
        uint256 stay = bound(stayFor, 1, STREAM);
        uint256 idle = bound(idleFor, 0, STREAM);
        stakeAs(alice, 100e18);
        notify(carol, r);
        vm.warp(token.clock() + stay);
        vm.prank(alice);
        jurors.requestUnstake(100e18);
        vm.warp(token.clock() + idle);
        stakeAs(bob, 100e18);
        vm.warp(token.clock() + STREAM);
        uint256 total = claimed(alice) + claimed(bob) + busd.balanceOf(treasury);
        require(total <= r, "overpaid");
        require(r - total <= 6, "dust beyond rounding");
        require(busd.balanceOf(address(jurors)) <= 6, "stranded");
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return lo + (x % (hi - lo + 1));
    }
}
