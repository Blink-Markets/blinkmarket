// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {Params, Role, QuestionClass, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";

contract MarketsSettlementTest is ProtocolBase {
    uint256 private constant MAKER_KEY = 0xA11CE;
    bytes32 private constant EVIDENCE = keccak256("evidence");
    BlinkRegistry private registry;
    BlinkJurors private jurors;
    IBlinkMarkets private markets;
    BlinkResolution private resolution;
    Params private p;
    address private creator;
    address private maker;
    address private taker;
    address private otherTaker;
    address private proposer;
    address private challenger;
    address private juror;
    address private keeper;
    bytes32 private templateId;
    uint256 private id;
    uint256 private serial;

    function setUp() public override { _setUp(100); }

    function _setUp(uint16 feeBps) private { _setUp(feeBps, 1e6, 50); }

    function _setUp(uint16 feeBps, uint256 creditUnit, uint32 creditCap) private {
        super.setUp();
        p = defaultParams();
        p.feeBps = feeBps;
        p.treasuryShareBps = 4000;
        p.creatorShareBps = 2000;
        p.resolutionShareBps = 2000;
        p.jurorShareBps = 1500;
        p.bountyShareBps = 500;
        p.keeperTipBps = 1000;
        p.creditUnitMicros = creditUnit;
        p.creditGainCap = creditCap;
        BlinkMarkets deployed;
        (registry, jurors, deployed, resolution) = deployGeneration(p, address(0));
        markets = IBlinkMarkets(address(deployed));
        creator = _role(actor("creator"), Role.CREATOR);
        maker = _role(vm.addr(MAKER_KEY), Role.MAKER);
        taker = _role(actor("taker"), Role.TAKER);
        otherTaker = _role(actor("otherTaker"), Role.TAKER);
        proposer = _role(actor("proposer"), Role.PROPOSER);
        challenger = _role(actor("challenger"), Role.CHALLENGER);
        keeper = actor("keeper");
        juror = fundedActor("juror");
        approveBusdAs(juror, address(registry));
        vm.startPrank(juror);
        registry.register();
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(1000e18);
        vm.stopPrank();
        vm.prank(maker); markets.depositMaker(600e6);
        templateId = markets.registerTemplate(QuestionClass.A_COMPUTABLE, EVIDENCE, "fixture://template");
        id = _create(100);
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
    }

    function _role(address who, Role role) private returns (address) {
        claimAs(who);
        approveBusdAs(who, address(registry));
        vm.startPrank(who);
        registry.register();
        registry.joinRole(role, p.minRoleStake);
        vm.stopPrank();
        approveBusdAs(who, address(markets));
        approveBusdAs(who, address(resolution));
        return who;
    }

    function _create(uint64 pairs) private returns (uint256) {
        IBlinkMarkets.CreateArgs memory args = IBlinkMarkets.CreateArgs(
            templateId, keccak256(abi.encode(++serial)), "fixture://spec", false,
            token.clock() + 3 days, token.clock() + 4 days, token.clock() + 6 days, pairs
        );
        vm.prank(creator);
        return markets.createMarket(args);
    }

    function _fill(address who, uint8 side, uint64 quantity, uint16 price) private {
        IBlinkMarkets.Quote memory q = IBlinkMarkets.Quote(
            id, markets.getMarket(id).specHash, maker, who, side, quantity, price,
            token.clock(), token.clock() + 30, ++serial, markets.makerEpoch(maker)
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, markets.hashQuote(q));
        vm.prank(who); markets.fillQuote(q, abi.encodePacked(r, s, v));
    }

    function _propose(Outcome outcome) private {
        vm.warp(markets.getMarket(id).closeAt);
        vm.prank(proposer); resolution.propose(id, outcome, EVIDENCE, "fixture://evidence");
    }

    function _unchallenged(Outcome outcome) private {
        _propose(outcome);
        vm.warp(token.clock() + p.resultChallengeWindow[0]);
        resolution.finalizeUnchallenged(id);
    }

    function _timeout() private {
        vm.warp(markets.getMarket(id).hardDeadline);
        resolution.finalizeTimeout(id);
    }

    function _dispute(bool succeeds) private {
        _propose(Outcome.YES);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(id, EVIDENCE);
        uint8 choice = succeeds ? 1 : 0;
        vm.prank(juror);
        resolution.commitVote(dispute, keccak256(abi.encode(dispute, uint256(0), juror, choice, EVIDENCE)));
        (, IBlinkResolution.Round memory round) = resolution.getDispute(dispute);
        vm.warp(round.commitEnd);
        vm.prank(juror); resolution.revealVote(dispute, choice, EVIDENCE);
        vm.warp(round.revealEnd);
        resolution.settleRound(dispute);
        (, round) = resolution.getDispute(dispute);
        vm.warp(round.appealEnd);
        resolution.finalizeDispute(dispute);
    }

    function _distribute(uint256 creatorAmount, uint256 proposerAmount, uint256 bountyAmount, uint256 jurorAmount) private {
        uint256 pool = markets.feePool(id);
        uint256 creatorBefore = busd.balanceOf(creator);
        uint256 proposerBefore = busd.balanceOf(proposer);
        uint256 bountyBefore = busd.balanceOf(challenger);
        uint256 jurorsBefore = busd.balanceOf(address(jurors));
        uint256 rewardsBefore = jurors.rewardsOwed();
        uint256 treasuryBefore = busd.balanceOf(treasury);
        uint256 keeperBefore = busd.balanceOf(keeper);
        uint256 tip = (pool * p.resolutionShareBps / 10000) * p.keeperTipBps / 10000;
        vm.prank(keeper); markets.distributeFees(id);
        eq(busd.balanceOf(creator) - creatorBefore, creatorAmount);
        eq(busd.balanceOf(proposer) - proposerBefore, proposerAmount);
        eq(busd.balanceOf(challenger) - bountyBefore, bountyAmount);
        eq(busd.balanceOf(address(jurors)) - jurorsBefore, jurorAmount);
        eq(jurors.rewardsOwed() - rewardsBefore, jurorAmount);
        eq(busd.balanceOf(keeper) - keeperBefore, tip);
        eq(busd.balanceOf(treasury) - treasuryBefore,
            pool - creatorAmount - proposerAmount - bountyAmount - jurorAmount - tip);
        eq(markets.feePool(id), 0);
        require(markets.getMarket(id).feesDistributed, "distribution flag");
        vm.expectRevert(bytes4(keccak256("AlreadyDistributed()")));
        markets.distributeFees(id);
    }

    function test_feeSplitMatchesParams() public {
        _fill(taker, 0, 100, 6000); // fee pool = 600,000 micros
        _unchallenged(Outcome.YES);
        _distribute(120000, 108000, 0, 120000);
        uint256 before = busd.balanceOf(juror);
        vm.warp(token.clock() + 7 days);
        vm.prank(juror); jurors.claimRewards();
        uint256 claimed = busd.balanceOf(juror) - before;
        require(claimed >= 119999 && claimed <= 120000, "streamed fees");
    }

    function test_invalidSendsCreatorShareToJurors() public {
        _fill(taker, 0, 100, 6000);
        _timeout();
        _distribute(0, 0, 0, 348000);
    }

    function test_timeoutWithProposalSendsResolutionShareToJurors() public {
        _fill(taker, 0, 100, 6000);
        _propose(Outcome.YES);
        _timeout();
        _distribute(0, 0, 0, 348000);
    }

    function test_bountyPaidOnlyOnSuccessfulChallenge() public {
        _fill(taker, 0, 100, 6000);
        _dispute(true);
        require(resolution.bountyWinner(id) == challenger, "successful challenger");
        _distribute(120000, 0, 30000, 198000);
        _assertFinal(Outcome.NO);
    }

    function test_failedChallengeBountyGoesToJurors() public {
        _fill(taker, 0, 100, 6000);
        _dispute(false);
        require(resolution.bountyWinner(id) == proposer, "resolution records winning proposer");
        _distribute(120000, 108000, 0, 120000);
        _assertFinal(Outcome.YES);
    }

    function test_feeRoundingConservesPool() public {
        _setUp(1);
        uint256 before = busd.balanceOf(taker);
        _fill(taker, 0, 1, 101);
        eq(before - busd.balanceOf(taker), 10101);
        eq(markets.feePool(id), 1);
        _unchallenged(Outcome.YES);
        _distribute(0, 0, 0, 0); // All five shares floor to zero; treasury receives the one micro.
    }

    function _redeem(address who, Outcome outcome) private returns (uint256 payout) {
        (uint256 yes, uint256 no) = markets.getPosition(id, who);
        payout = outcome == Outcome.YES ? yes * 1e6 : outcome == Outcome.NO ? no * 1e6 : (yes + no) * 500000;
        uint256 before = busd.balanceOf(who);
        vm.prank(who); markets.redeem(id);
        eq(busd.balanceOf(who) - before, payout);
        (yes, no) = markets.getPosition(id, who);
        eq(yes + no, 0);
        vm.expectRevert(bytes4(keccak256("NoPosition()")));
        vm.prank(who); markets.redeem(id);
    }

    function _redeemOutcome(Outcome outcome) private {
        _fill(taker, 0, 11, 6001);
        _fill(otherTaker, 1, 7, 3033);
        _fill(taker, 1, 3, 4001);
        uint256 held = busd.balanceOf(address(markets));
        uint256 bond = markets.getMarket(id).creationBond;
        uint256 fees = markets.feePool(id);
        if (outcome == Outcome.INVALID) _timeout();
        else _unchallenged(outcome);
        uint256 paid;
        // Exercise both distribution orders relative to redemption.
        if (outcome == Outcome.NO) markets.distributeFees(id);
        paid += _redeem(taker, outcome);
        paid += _redeem(maker, outcome);
        paid += _redeem(otherTaker, outcome);
        if (outcome != Outcome.NO) markets.distributeFees(id);
        eq(markets.getMarket(id).escrowMicros, 0);
        eq(paid, 21e6);
        eq(held, paid + fees + bond + markets.makerFree(maker));
        eq(busd.balanceOf(address(markets)), markets.makerFree(maker));
        uint256 free = markets.makerFree(maker);
        vm.prank(maker); markets.withdrawMaker(free);
        eq(busd.balanceOf(address(markets)), 0);
    }

    function test_redeemPaysOutcome() public { _redeemOutcome(Outcome.YES); }
    function test_redeemPaysNo() public { _redeemOutcome(Outcome.NO); }
    function test_redeemPaysInvalid() public { _redeemOutcome(Outcome.INVALID); }

    function _assertFinal(Outcome outcome) private view {
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        eq(uint256(m.state), uint256(MarketState.FINAL));
        eq(uint256(m.finalOutcome), uint256(outcome));
        eq(m.creationBond, 0);
        eq(markets.finalizedCount(), 1);
        eq(markets.openPayoutTotal(), 0);
        eq(markets.openPayoutByCreator(creator), 0);
    }

    function test_finalReturnsBondReportsCreditAndUnlocksCreatorOnce() public {
        uint256 before = busd.balanceOf(creator);
        uint256 bond = markets.getMarket(id).creationBond;
        vm.prank(creator); registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(creator); registry.withdrawRole(Role.CREATOR);
        _unchallenged(Outcome.YES);
        _assertFinal(Outcome.YES);
        eq(busd.balanceOf(creator) - before, bond);
        eq(registry.creditOf(creator, Role.CREATOR), p.creditGainCap);
        vm.prank(creator); registry.withdrawRole(Role.CREATOR);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        vm.prank(address(resolution)); markets.finalize(id, Outcome.YES);
        eq(markets.finalizedCount(), 1);
    }

    function test_timeoutPendingAndOpenReturnBondAndReportLoss() public {
        vm.prank(address(markets)); registry.reportGain(creator, Role.CREATOR, 100e6);
        uint256 before = busd.balanceOf(creator);
        uint256 bond = markets.getMarket(id).creationBond;
        _timeout();
        _assertFinal(Outcome.INVALID);
        eq(busd.balanceOf(creator) - before, bond);
        eq(registry.creditOf(creator, Role.CREATOR), 0);
        uint256 pending = _create(10);
        vm.warp(markets.getMarket(pending).hardDeadline);
        resolution.finalizeTimeout(pending);
        eq(markets.finalizedCount(), 2);
        eq(markets.openPayoutTotal(), 0);
        vm.prank(creator); registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(creator); registry.withdrawRole(Role.CREATOR);
    }

    function test_finalReleasesSecurityCapacity() public {
        _create(150);
        eq(markets.openPayoutTotal(), 250e6);
        IBlinkMarkets.CreateArgs memory args = IBlinkMarkets.CreateArgs(
            templateId, keccak256("over capacity"), "fixture://spec", false,
            token.clock() + 4 days, token.clock() + 5 days, token.clock() + 7 days, 1
        );
        vm.expectRevert(BlinkMarkets.SecurityBoundExceeded.selector);
        vm.prank(creator); markets.createMarket(args);
        _unchallenged(Outcome.YES);
        eq(markets.openPayoutTotal(), 150e6);
        eq(markets.openPayoutByCreator(creator), 150e6);
        vm.prank(creator); markets.createMarket(args);
        _create(99);
        eq(markets.openPayoutTotal(), 250e6);
    }

    function test_washTradingEarnsNoCredit() public {
        _setUp(100, 10e6, 1000);
        uint256 empty = _create(100);
        for (uint256 i; i < 100; ++i) _fill(taker, uint8(i % 2), 1, 5000);
        _unchallenged(Outcome.YES);
        uint256 tradedCredit = registry.creditOf(creator, Role.CREATOR);
        id = empty;
        markets.open(id);
        _unchallenged(Outcome.YES);
        eq(registry.creditOf(creator, Role.CREATOR) - tradedCredit, tradedCredit);
        eq(tradedCredit, 10); // 100 bUSD cap / 10 bUSD per point; no volume term or cap saturation.
        eq(registry.creditOf(maker, Role.MAKER), 0);
        eq(registry.creditOf(taker, Role.TAKER), 0);
    }

    function test_settlementRequiresFinalAndKnownMarket() public {
        _fill(taker, 0, 1, 5000);
        vm.expectRevert(BlinkMarkets.InvalidState.selector); markets.distributeFees(id);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        vm.prank(taker); markets.redeem(id);
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector); markets.distributeFees(0);
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector); markets.redeem(0);
        _unchallenged(Outcome.YES);
        vm.expectRevert(bytes4(keccak256("NoPosition()"))); markets.redeem(id);
    }

    function test_zeroFeePoolStillDistributesOnce() public {
        _unchallenged(Outcome.YES);
        _distribute(0, 0, 0, 0);
    }

    function testFuzz_feeSplitConservesPool(uint64 rawQuantity, uint16 rawPrice) public {
        _fill(taker, 0, rawQuantity % 100 + 1, rawPrice % 9999 + 1);
        uint256 pool = markets.feePool(id);
        uint256 resolutionShare = pool * p.resolutionShareBps / 10000;
        _unchallenged(Outcome.YES);
        _distribute(pool * p.creatorShareBps / 10000,
            resolutionShare - resolutionShare * p.keeperTipBps / 10000, 0,
            pool * p.jurorShareBps / 10000 + pool * p.bountyShareBps / 10000);
    }
}
