// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {Params, GenerationAddresses, Role, QuestionClass, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";

// Only phase-in is stubbed; creation uses the real registry and jurors.
contract CreationMarketsHarness is BlinkMarkets {
    uint256 private count;

    constructor(GenerationAddresses memory a) BlinkMarkets(a) {}

    function stubFinalizedCount(uint256 value) external { count = value; }
    function finalizedCount() public view override returns (uint256) { return count; }
}

contract MarketsCreationTest is ProtocolBase {
    BlinkRegistry private registry;
    BlinkJurors private jurors;
    CreationMarketsHarness private markets;
    GenerationAddresses private generation;
    Params private p;
    address private creator;
    address private juror;
    address private challenger;
    bytes32 private templateId;
    uint256 private serial;

    function setUp() public override {
        super.setUp();
        p = defaultParams();
        p.creationBondBps = 1000;
        p.creatorExposureMultiple = 10;
        p.replayAllowed = false;
        generation = predictGeneration(address(this), address(0));
        registry = new BlinkRegistry(p, generation);
        jurors = new BlinkJurors(generation);
        markets = new CreationMarketsHarness(generation);
        creator = fundedActor("creator");
        juror = fundedActor("juror");
        challenger = fundedActor("challenger");
        for (uint256 i; i < 19; ++i) {
            address donor = address(uint160(uint256(keccak256(abi.encode("donor", i)))));
            claimAs(donor);
            vm.prank(donor);
            token.transfer(juror, 1000e18);
            if (i == 0) {
                vm.prank(donor);
                busd.transfer(creator, 1000e6);
            }
        }
        _register(creator);
        _register(juror);
        vm.prank(creator);
        registry.joinRole(Role.CREATOR, 500e6);
        approveBusdAs(creator, address(markets));
        vm.startPrank(juror);
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(20_000e18);
        vm.stopPrank();
        templateId = markets.registerTemplate(QuestionClass.A_COMPUTABLE, keccak256("parser"), "fixture://template");
    }

    function _register(address who) private {
        approveBusdAs(who, address(registry));
        vm.prank(who);
        registry.register();
    }

    function _args(uint64 pairs) private returns (IBlinkMarkets.CreateArgs memory a) {
        a.templateId = templateId;
        a.specHash = keccak256(abi.encode(++serial));
        a.specURI = "fixture://spec";
        a.closeAt = uint64(token.clock() + 3 days);
        a.proposalDeadline = a.closeAt + 1 days;
        a.hardDeadline = a.proposalDeadline + 2 days;
        a.maxPairs = pairs;
    }

    function _create(uint64 pairs) private returns (uint256) {
        IBlinkMarkets.CreateArgs memory a = _args(pairs);
        vm.prank(creator);
        return markets.createMarket(a);
    }

    function _open(uint256 id) private {
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
    }

    function _challenge(uint256 id) private {
        vm.prank(generation.resolution);
        markets.markCreationChallenged(id);
    }

    function test_createTakesBondScaledByMaxPayout() public {
        uint256 before = busd.balanceOf(creator);
        uint256 id = _create(1000);
        eq(before - busd.balanceOf(creator), 100e6);
        eq(busd.balanceOf(address(markets)), 100e6);
        eq(markets.maxPayout(id), 1000e6);
        eq(markets.getMarket(id).creationBond, 100e6);
        eq(markets.openPayoutTotal(), 1000e6);
        eq(markets.openPayoutByCreator(creator), 1000e6);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.PENDING));
        require(keccak256(bytes(markets.specURI(id))) == keccak256("fixture://spec"), "URI");
    }

    function test_marketCreatedEventCarriesURI() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        uint64 openAt = uint64(token.clock()) + p.creationWindow[0] + p.firstUseExtraWindow;
        vm.expectEmit(true, true, true, true);
        emit IBlinkMarkets.MarketCreated(1, creator, a.specHash, a.specURI, a.templateId,
            QuestionClass.A_COMPUTABLE, false, openAt, a.closeAt, a.proposalDeadline, a.hardDeadline, a.maxPairs, 100e6);
        vm.prank(creator);
        markets.createMarket(a);
    }

    function test_failedBondTransferRollsBackCreationAndRoleLock() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        vm.prank(creator);
        busd.approve(address(markets), 0);
        vm.expectRevert();
        vm.prank(creator);
        markets.createMarket(a);
        eq(markets.nextMarketId(), 1);
        eq(markets.openPayoutTotal(), 0);
        eq(markets.openPayoutByCreator(creator), 0);
        require(!markets.usedSpecHashes(keccak256(abi.encode(creator, a.specHash))), "spec consumed on revert");
        vm.prank(creator);
        registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(creator);
        registry.withdrawRole(Role.CREATOR);
        vm.prank(creator);
        registry.joinRole(Role.CREATOR, 500e6);
        approveBusdAs(creator, address(markets));
        vm.prank(creator);
        uint256 id = markets.createMarket(a);
        eq(markets.getMarket(id).openAt, token.clock() + p.creationWindow[0] + p.firstUseExtraWindow);
    }

    function testFuzz_cancellationConservesBondAndReleasesExposure(uint64 input) public {
        uint64 pairs = input % 5000 + 1;
        uint256 id = _create(pairs);
        uint256 bond = markets.getMarket(id).creationBond;
        uint256 before = busd.balanceOf(challenger);
        _challenge(id);
        vm.prank(generation.resolution);
        markets.resolveCreation(id, true, challenger);
        uint256 cut = bond * p.jurorBondCutBps / 10_000;
        eq(busd.balanceOf(challenger) - before, bond - cut);
        eq(busd.balanceOf(address(jurors)), cut);
        eq(jurors.rewardsOwed(), cut);
        eq(busd.balanceOf(address(markets)), 0);
        eq(markets.openPayoutTotal(), 0);
        eq(markets.openPayoutByCreator(creator), 0);
        eq(markets.maxPayout(id), uint256(pairs) * 1e6);
    }

    function test_onlyCreatorsCreate() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        vm.expectRevert(BlinkMarkets.MissingRole.selector);
        vm.prank(juror);
        markets.createMarket(a);
    }

    function test_classARequiresParser() public {
        vm.expectRevert(BlinkMarkets.MissingParser.selector);
        markets.registerTemplate(QuestionClass.A_COMPUTABLE, bytes32(0), "fixture://bad");
        bytes32 b = markets.registerTemplate(QuestionClass.B_VERIFIABLE, bytes32(0), "fixture://b");
        require(b == keccak256(abi.encode(QuestionClass.B_VERIFIABLE, bytes32(0), "fixture://b")), "template hash");
    }

    function test_firstTemplateUseHasLongerWindow() public {
        uint256 createdAt = token.clock();
        uint256 first = _create(1000);
        eq(markets.getMarket(first).openAt, createdAt + p.creationWindow[0] + p.firstUseExtraWindow);
        _open(first);
        // Re-registering cannot reset the completed template review.
        markets.registerTemplate(QuestionClass.A_COMPUTABLE, keccak256("parser"), "fixture://template");
        uint256 second = _create(1000);
        eq(markets.getMarket(second).openAt, token.clock() + p.creationWindow[0]);
    }

    function test_smallFirstAndLargeSecondBothGetExtraWindow() public {
        uint256 first = _create(1);
        uint256 second = _create(1000);
        uint256 expected = token.clock() + p.creationWindow[0] + p.firstUseExtraWindow;
        eq(markets.getMarket(first).openAt, expected);
        eq(markets.getMarket(second).openAt, expected);
    }

    function test_cancelledFirstUseDoesNotReviewTemplate() public {
        uint256 first = _create(1);
        _challenge(first);
        vm.prank(generation.resolution);
        markets.resolveCreation(first, true, challenger);
        uint256 second = _create(1000);
        eq(markets.getMarket(second).openAt, token.clock() + p.creationWindow[0] + p.firstUseExtraWindow);
    }

    function test_rejectedCreationChallengeReviewsTemplate() public {
        uint256 first = _create(1);
        _challenge(first);
        vm.prank(generation.resolution);
        markets.resolveCreation(first, false, challenger);
        uint256 second = _create(1000);
        eq(markets.getMarket(second).openAt, token.clock() + p.creationWindow[0]);
    }

    function test_classCNeedsCreditAfterPhaseIn() public {
        templateId = markets.registerTemplate(QuestionClass.C_JUDGMENT, bytes32(0), "fixture://c");
        _create(1000);
        markets.stubFinalizedCount(p.phaseInFinalizedMarkets);
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        vm.expectRevert(BlinkMarkets.InsufficientCredit.selector);
        vm.prank(creator);
        markets.createMarket(a);
        vm.prank(generation.resolution);
        registry.reportGain(creator, Role.CREATOR, 1000e6);
        vm.prank(creator);
        markets.createMarket(a);
    }

    function test_createRefusedAboveGlobalSecurityBound() public {
        eq(jurors.attackCostMicros(), 10_000e6);
        _create(5000);
        address other = fundedActor("other-creator");
        _register(other);
        vm.prank(other);
        registry.joinRole(Role.CREATOR, 100e6);
        IBlinkMarkets.CreateArgs memory a = _args(1);
        vm.expectRevert(BlinkMarkets.SecurityBoundExceeded.selector);
        vm.prank(other);
        markets.createMarket(a);
    }

    function test_creatorExposureLimitGrowsWithCredit() public {
        address other = fundedActor("small-creator");
        _register(other);
        vm.prank(other);
        registry.joinRole(Role.CREATOR, 100e6);
        approveBusdAs(other, address(markets));
        IBlinkMarkets.CreateArgs memory a = _args(1001);
        vm.expectRevert(BlinkMarkets.CreatorLimitExceeded.selector);
        vm.prank(other);
        markets.createMarket(a);
        vm.prank(generation.resolution);
        registry.reportGain(other, Role.CREATOR, 1000e6);
        vm.prank(other);
        uint256 id = markets.createMarket(a);
        eq(markets.maxPayout(id), 1001e6);
        eq(markets.getMarket(id).creationBond, registry.bondFor(other, Role.CREATOR, 100_100_000));
    }

    function test_replayRejectedUnlessAllowed() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        a.replay = true;
        vm.expectRevert(BlinkMarkets.ReplayNotAllowed.selector);
        vm.prank(creator);
        markets.createMarket(a);
    }

    function test_openOnlyAfterWindowWithoutChallenge() public {
        uint256 id = _create(1000);
        vm.warp(markets.getMarket(id).openAt - 1);
        vm.expectRevert(BlinkMarkets.CreationWindowActive.selector);
        markets.open(id);
        _open(id);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.OPEN));
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.open(id);
    }

    function test_challengeBlocksOpenAndRejectedChallengeRespectsWindow() public {
        uint256 id = _create(1000);
        uint256 openAt = markets.getMarket(id).openAt;
        _challenge(id);
        vm.expectRevert(BlinkMarkets.CreationChallengePending.selector);
        markets.open(id);
        vm.prank(generation.resolution);
        markets.resolveCreation(id, false, challenger);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.OPEN));
        eq(markets.getMarket(id).openAt, openAt);
        require(!markets.getMarket(id).creationChallenged, "challenge not cleared");
        eq(markets.getMarket(id).creationBond, 100e6);
        eq(markets.openPayoutTotal(), 1000e6);
    }

    function test_rejectedChallengeAfterWindowUsesNow() public {
        uint256 id = _create(1000);
        _challenge(id);
        vm.warp(markets.getMarket(id).openAt + 10);
        vm.prank(generation.resolution);
        markets.resolveCreation(id, false, challenger);
        eq(markets.getMarket(id).openAt, token.clock());
    }

    function test_upheldChallengeReleasesExposureAndStreamsBondCut() public {
        uint256 id = _create(1000);
        uint256 other = _create(500);
        uint256 before = busd.balanceOf(challenger);
        _challenge(id);
        vm.prank(generation.resolution);
        markets.resolveCreation(id, true, challenger);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.CANCELLED));
        eq(markets.getMarket(id).creationBond, 0);
        eq(markets.maxPayout(id), 1000e6);
        eq(markets.openPayoutTotal(), markets.maxPayout(other));
        eq(markets.openPayoutByCreator(creator), 500e6);
        eq(busd.balanceOf(challenger) - before, 80e6);
        eq(busd.balanceOf(address(markets)), 50e6);
        eq(jurors.rewardsOwed(), 20e6);
        eq(busd.balanceOf(address(jurors)), 20e6);
        uint256 jurorBefore = busd.balanceOf(juror);
        vm.prank(juror);
        jurors.claimRewards();
        eq(busd.balanceOf(juror), jurorBefore);
        vm.warp(token.clock() + jurors.REWARD_STREAM_SECONDS());
        vm.prank(juror);
        jurors.claimRewards();
        uint256 paid = busd.balanceOf(juror) - jurorBefore;
        require(paid <= 20e6 && paid >= 20e6 - 1, "streamed cut");
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        vm.prank(generation.resolution);
        markets.resolveCreation(id, true, challenger);
    }

    function test_creatorStakeRemainsLockedUntilAllCreationsCancelled() public {
        uint256 first = _create(1000);
        uint256 second = _create(1000);
        _challenge(first);
        _challenge(second);
        vm.prank(creator);
        registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(generation.resolution);
        markets.resolveCreation(first, true, challenger);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(creator);
        registry.withdrawRole(Role.CREATOR);
        vm.prank(generation.resolution);
        markets.resolveCreation(second, true, challenger);
        vm.prank(creator);
        registry.withdrawRole(Role.CREATOR);
        eq(registry.roleStake(creator, Role.CREATOR), 0);
    }

    function test_onlyResolutionCanCallHooks() public {
        uint256 id = _create(1000);
        vm.expectRevert(BlinkMarkets.UnauthorizedCaller.selector);
        markets.markCreationChallenged(id);
        vm.expectRevert(BlinkMarkets.UnauthorizedCaller.selector);
        markets.resolveCreation(id, true, challenger);
        vm.expectRevert(BlinkMarkets.UnauthorizedCaller.selector);
        markets.setProposed(id);
        vm.expectRevert(BlinkMarkets.UnauthorizedCaller.selector);
        markets.setDisputed(id);
        vm.expectRevert(BlinkMarkets.UnauthorizedCaller.selector);
        markets.finalize(id, Outcome.YES);
    }

    function test_resolutionStateHooks() public {
        uint256 id = _create(1000);
        _open(id);
        vm.prank(generation.resolution);
        markets.setProposed(id);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.PROPOSED));
        vm.prank(generation.resolution);
        markets.setDisputed(id);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.DISPUTED));
        vm.prank(generation.resolution);
        markets.finalize(id, Outcome.NO);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.FINAL));
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.NO));
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        vm.prank(generation.resolution);
        markets.finalize(id, Outcome.YES);
    }

    function test_hooksRejectInvalidCreationAndResultTransitions() public {
        uint256 id = _create(1000);
        vm.startPrank(generation.resolution);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.resolveCreation(id, true, challenger);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.setProposed(id);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.setDisputed(id);
        markets.markCreationChallenged(id);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.markCreationChallenged(id);
        vm.expectRevert(BlinkMarkets.InvalidAddress.selector);
        markets.resolveCreation(id, true, address(0));
        markets.resolveCreation(id, true, challenger);
        vm.expectRevert(BlinkMarkets.InvalidState.selector);
        markets.finalize(id, Outcome.NO);
        vm.stopPrank();
    }

    function test_duplicateSpecAndUnknownTemplateRejected() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        vm.prank(creator);
        markets.createMarket(a);
        vm.expectRevert(BlinkMarkets.DuplicateSpec.selector);
        vm.prank(creator);
        markets.createMarket(a);
        a = _args(1000);
        a.templateId = bytes32(0);
        vm.expectRevert(BlinkMarkets.TemplateNotFound.selector);
        vm.prank(creator);
        markets.createMarket(a);
    }

    function test_otherCreatorCannotFrontRunSpecHash() public {
        address other = fundedActor("front-runner");
        _register(other);
        vm.prank(other);
        registry.joinRole(Role.CREATOR, 100e6);
        approveBusdAs(other, address(markets));
        IBlinkMarkets.CreateArgs memory a = _args(1);
        vm.prank(other);
        uint256 hostile = markets.createMarket(a);
        a.maxPairs = 1000;
        vm.prank(creator);
        uint256 intended = markets.createMarket(a);
        eq(markets.maxPayout(intended), 1000e6);
        require(markets.usedSpecHashes(keccak256(abi.encode(other, a.specHash))), "other creator spec missing");
        require(markets.usedSpecHashes(keccak256(abi.encode(creator, a.specHash))), "creator spec missing");
        _challenge(hostile);
        vm.prank(generation.resolution);
        markets.resolveCreation(hostile, true, challenger);
        _expectCreateError(a, BlinkMarkets.DuplicateSpec.selector);
        vm.expectRevert(BlinkMarkets.DuplicateSpec.selector);
        vm.prank(other);
        markets.createMarket(a);
    }

    function test_closeAtEqualToOpenAtRejected() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        a.closeAt = uint64(token.clock()) + p.creationWindow[0] + p.firstUseExtraWindow;
        _expectCreateError(a, BlinkMarkets.InvalidSchedule.selector);
    }

    function test_closeAtBeforeOpenAtRejected() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        a.closeAt = uint64(token.clock()) + p.creationWindow[0] + p.firstUseExtraWindow - 1;
        _expectCreateError(a, BlinkMarkets.InvalidSchedule.selector);
    }

    function test_closeAtOneSecondAfterOpenAtAccepted() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        a.closeAt = uint64(token.clock()) + p.creationWindow[0] + p.firstUseExtraWindow + 1;
        vm.prank(creator);
        uint256 id = markets.createMarket(a);
        eq(markets.getMarket(id).openAt + 1, markets.getMarket(id).closeAt);
    }

    function test_invalidSpecScheduleAndCapsRejected() public {
        IBlinkMarkets.CreateArgs memory a = _args(1000);
        a.specURI = "";
        _expectCreateError(a, BlinkMarkets.InvalidSpec.selector);
        a = _args(1000);
        a.specHash = bytes32(0);
        _expectCreateError(a, BlinkMarkets.InvalidSpec.selector);
        a = _args(1000);
        a.closeAt = uint64(token.clock());
        _expectCreateError(a, BlinkMarkets.InvalidSchedule.selector);
        a = _args(1000);
        a.hardDeadline = a.proposalDeadline + p.resultChallengeWindow[0];
        _expectCreateError(a, BlinkMarkets.InvalidSchedule.selector);
        a = _args(0);
        _expectCreateError(a, BlinkMarkets.InvalidCap.selector);
        a = _args(p.maxMarketPairs + 1);
        _expectCreateError(a, BlinkMarkets.InvalidCap.selector);
    }

    function _expectCreateError(IBlinkMarkets.CreateArgs memory a, bytes4 err) private {
        vm.expectRevert(err);
        vm.prank(creator);
        markets.createMarket(a);
    }

    function test_missingMarketViewsAndOpenRevert() public {
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector);
        markets.getMarket(0);
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector);
        markets.specURI(1);
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector);
        markets.maxPayout(1);
        vm.expectRevert(BlinkMarkets.MarketNotFound.selector);
        markets.open(1);
    }

    function test_constructorChecksChainAndPredictedAddress() public {
        GenerationAddresses memory a = generation;
        a.markets = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.chainId(1);
        vm.expectRevert(BlinkMarkets.WrongChain.selector);
        new BlinkMarkets(a);
        vm.chainId(84532);
        a.markets = address(0);
        vm.expectRevert(BlinkMarkets.WrongAddress.selector);
        new BlinkMarkets(a);
    }
}
