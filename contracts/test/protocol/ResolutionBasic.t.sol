// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {Role, QuestionClass, MarketState, Outcome, GenerationAddresses} from "../../src/protocol/BlinkTypes.sol";

contract ResolutionMarketsStub {
    mapping(uint256 => IBlinkMarkets.Market) private _markets;
    address public immutable resolution;
    uint256 public proposedCalls;
    uint256 public disputedCalls;
    uint256 public creationChallengeCalls;
    uint256 public finalizeCalls;

    constructor(address resolution_) {
        resolution = resolution_;
    }

    function seed(uint256 id, IBlinkMarkets.Market calldata m) external {
        _markets[id] = m;
    }

    function getMarket(uint256 id) external view returns (IBlinkMarkets.Market memory) {
        require(_markets[id].creator != address(0), "unknown market");
        return _markets[id];
    }

    function maxPayout(uint256 id) external view returns (uint256) {
        return uint256(_markets[id].maxPairs) * 1e6;
    }

    function openPayoutTotal() external pure returns (uint256) {
        return 0;
    }

    function finalizedCount() external view returns (uint256) {
        return finalizeCalls;
    }

    function markCreationChallenged(uint256 id) external {
        require(msg.sender == resolution && _markets[id].state == MarketState.PENDING, "bad creation hook");
        _markets[id].creationChallenged = true;
        creationChallengeCalls++;
    }

    function setProposed(uint256 id) external {
        require(msg.sender == resolution && _markets[id].state == MarketState.OPEN, "bad proposal hook");
        _markets[id].state = MarketState.PROPOSED;
        proposedCalls++;
    }

    function setDisputed(uint256 id) external {
        require(msg.sender == resolution && _markets[id].state == MarketState.PROPOSED, "bad dispute hook");
        _markets[id].state = MarketState.DISPUTED;
        disputedCalls++;
    }

    function finalize(uint256 id, Outcome outcome) external {
        require(msg.sender == resolution, "resolution only");
        require(_markets[id].state != MarketState.FINAL && _markets[id].state != MarketState.CANCELLED, "terminal");
        _markets[id].state = MarketState.FINAL;
        _markets[id].finalOutcome = outcome;
        finalizeCalls++;
    }
}

contract ResolutionBasicTest is ProtocolBase {
    BlinkRegistry internal registry;
    BlinkJurors internal jurors;
    ResolutionMarketsStub internal markets;
    BlinkResolution internal resolution;
    address internal proposer;
    address internal challenger;
    address internal creator;
    address internal juror;
    bytes32 internal constant EVIDENCE = keccak256("archived bytes");
    uint256 internal constant PAYOUT = 1_000e6;
    uint256 internal constant BOND = 50e6;

    function setUp() public override {
        super.setUp();
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        registry = new BlinkRegistry(defaultParams(), a);
        jurors = new BlinkJurors(a);
        markets = new ResolutionMarketsStub(a.resolution);
        resolution = new BlinkResolution(a);
        require(address(markets) == a.markets && address(resolution) == a.resolution, "deployment order");
        proposer = fundedActor("proposer");
        challenger = fundedActor("challenger");
        creator = fundedActor("creator");
        juror = fundedActor("juror");
        _join(proposer, Role.PROPOSER);
        _join(challenger, Role.CHALLENGER);
        _join(creator, Role.CHALLENGER);
        approveBusdAs(juror, address(registry));
        vm.prank(juror);
        registry.register();
        vm.prank(juror);
        token.approve(address(jurors), type(uint256).max);
        vm.prank(juror);
        jurors.stake(100e18);
        _seed(1, MarketState.OPEN, QuestionClass.A_COMPUTABLE);
    }

    function _join(address who, Role role) internal {
        approveBusdAs(who, address(registry));
        if (!registry.isRegistered(who)) {
            vm.prank(who);
            registry.register();
        }
        vm.prank(who);
        registry.joinRole(role, 100e6);
        approveBusdAs(who, address(resolution));
    }

    function _seed(uint256 id, MarketState state, QuestionClass cls) internal {
        IBlinkMarkets.Market memory m;
        m.creator = creator;
        m.cls = cls;
        m.state = state;
        m.openAt = uint64(token.clock() + 1 hours);
        m.closeAt = uint64(token.clock());
        m.proposalDeadline = uint64(token.clock() + 1 days);
        m.hardDeadline = uint64(token.clock() + 4 days);
        m.maxPairs = 1_000;
        markets.seed(id, m);
    }

    function _propose(uint256 id) internal {
        vm.prank(proposer);
        resolution.propose(id, Outcome.YES, EVIDENCE, "ipfs://evidence");
    }

    function _gain(uint256 payout) internal {
        vm.prank(address(markets));
        registry.reportGain(proposer, Role.PROPOSER, payout);
    }

    function _challengeResult(uint256 id) internal returns (uint256) {
        vm.prank(challenger);
        return resolution.challengeResult(id, EVIDENCE);
    }

    function _assertFinal(uint256 id, Outcome outcome) internal view {
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        eq(uint256(m.state), uint256(MarketState.FINAL));
        eq(uint256(m.finalOutcome), uint256(outcome));
    }

    function test_proposeTakesBondAndWindowShrinksWithCredit() public {
        uint256 start = token.clock();
        uint256 before = busd.balanceOf(proposer);
        _propose(1);
        eq(busd.balanceOf(proposer), before - BOND);
        eq(busd.balanceOf(address(resolution)), BOND);
        require(resolution.proposerOf(1) == proposer, "proposer");
        eq(uint256(resolution.proposedOutcome(1)), uint256(Outcome.YES));
        eq(markets.proposedCalls(), 1);
        vm.warp(start + 1 hours - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(1);
        vm.warp(start + 1 hours);
        resolution.finalizeUnchallenged(1);

        _seed(2, MarketState.OPEN, QuestionClass.A_COMPUTABLE);
        start = token.clock();
        uint256 credit = registry.creditOf(proposer, Role.PROPOSER);
        uint256 discountedBond = registry.bondFor(proposer, Role.PROPOSER, BOND);
        _propose(2);
        eq(busd.balanceOf(address(resolution)), discountedBond);
        vm.warp(start + 1 hours - credit * 60 - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(2);
        vm.warp(start + 1 hours - credit * 60);
        resolution.finalizeUnchallenged(2);

        _gain(5_000e6);
        _seed(3, MarketState.OPEN, QuestionClass.A_COMPUTABLE);
        start = token.clock();
        _propose(3);
        vm.warp(start + 10 minutes - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(3);
        vm.warp(start + 10 minutes);
        resolution.finalizeUnchallenged(3);
    }

    function test_unchallengedFinalizeReturnsBondAndRaisesCredit() public {
        uint256 before = busd.balanceOf(proposer);
        uint256 start = token.clock();
        _propose(1);
        vm.warp(start + 1 hours);
        vm.prank(actor("keeper"));
        resolution.finalizeUnchallenged(1);
        eq(busd.balanceOf(proposer), before);
        eq(busd.balanceOf(address(resolution)), 0);
        eq(registry.creditOf(proposer, Role.PROPOSER), PAYOUT / defaultParams().creditUnitMicros);
        _assertFinal(1, Outcome.YES);
        require(resolution.bountyWinner(1) == address(0), "no bounty");
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.finalizeUnchallenged(1);
    }

    function test_proposerCannotChallengeSelf() public {
        _join(proposer, Role.CHALLENGER);
        _propose(1);
        vm.expectRevert(BlinkResolution.SelfChallenge.selector);
        vm.prank(proposer);
        resolution.challengeResult(1, EVIDENCE);
    }

    function test_challengeCreationOnlyWhilePending() public {
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        vm.prank(challenger);
        resolution.challengeCreation(1, 0, EVIDENCE);
        _seed(2, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        uint256 before = busd.balanceOf(challenger);
        vm.prank(challenger);
        uint256 disputeId = resolution.challengeCreation(2, 1, EVIDENCE);
        require(disputeId != 0 && markets.getMarket(2).creationChallenged, "creation dispute");
        eq(markets.creationChallengeCalls(), 1);
        eq(busd.balanceOf(challenger), before - BOND);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        vm.prank(challenger);
        resolution.challengeCreation(2, 0, EVIDENCE);
    }

    function test_unknownGroundReserved() public {
        _seed(2, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.expectRevert(BlinkResolution.UnknownGround.selector);
        vm.prank(challenger);
        resolution.challengeCreation(2, 3, EVIDENCE);
    }

    function test_onlyHardDeadlineGivesInvalid() public {
        uint256 deadline = markets.getMarket(1).hardDeadline;
        vm.warp(deadline - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeTimeout(1);
        vm.warp(deadline);
        vm.prank(actor("keeper"));
        resolution.finalizeTimeout(1);
        _assertFinal(1, Outcome.INVALID);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.finalizeTimeout(1);
    }

    function test_timeoutDuringDisputeForfeitsChallengerBond() public {
        uint256 before = busd.balanceOf(proposer);
        uint256 challengerBefore = busd.balanceOf(challenger);
        _propose(1);
        require(_challengeResult(1) != 0, "dispute id");
        eq(markets.disputedCalls(), 1);
        eq(busd.balanceOf(address(resolution)), 2 * BOND);
        uint256 deadline = markets.getMarket(1).hardDeadline;
        vm.warp(deadline);
        resolution.finalizeTimeout(1);
        _assertFinal(1, Outcome.INVALID);
        eq(busd.balanceOf(proposer), before);
        eq(busd.balanceOf(challenger), challengerBefore - BOND);
        eq(busd.balanceOf(address(resolution)), 0);
        eq(busd.balanceOf(address(jurors)), BOND);
        eq(jurors.rewardsOwed(), BOND);
        eq(registry.creditOf(proposer, Role.PROPOSER), 0);
        require(resolution.bountyWinner(1) == address(0), "timeout no bounty");
        uint256 jurorBefore = busd.balanceOf(juror);
        vm.prank(juror);
        jurors.claimRewards();
        eq(busd.balanceOf(juror), jurorBefore);
        vm.warp(deadline + 7 days);
        vm.prank(juror);
        jurors.claimRewards();
        uint256 paid = busd.balanceOf(juror) - jurorBefore;
        require(paid <= BOND && paid >= BOND - 1, "streamed reward");
    }

    function test_roleLocksUntilUnchallengedSettlement() public {
        _propose(1);
        vm.prank(proposer);
        registry.requestRoleExit(Role.PROPOSER);
        vm.warp(token.clock() + defaultParams().roleExitCooldown);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
        resolution.finalizeUnchallenged(1);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
        eq(registry.roleStake(proposer, Role.PROPOSER), 0);
    }

    function test_timeoutUnlocksBothRolesExactlyOnce() public {
        _propose(1);
        _challengeResult(1);
        vm.prank(proposer);
        registry.requestRoleExit(Role.PROPOSER);
        vm.prank(challenger);
        registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(markets.getMarket(1).hardDeadline);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(challenger);
        registry.withdrawRole(Role.CHALLENGER);
        resolution.finalizeTimeout(1);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
        vm.prank(challenger);
        registry.withdrawRole(Role.CHALLENGER);
    }

    function test_creationTimeoutForfeitsBondAndUnlocksChallenger() public {
        _seed(2, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.prank(challenger);
        resolution.challengeCreation(2, 2, EVIDENCE);
        vm.prank(challenger);
        registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(markets.getMarket(2).hardDeadline);
        resolution.finalizeTimeout(2);
        _assertFinal(2, Outcome.INVALID);
        eq(busd.balanceOf(address(jurors)), BOND);
        eq(busd.balanceOf(address(resolution)), 0);
        vm.prank(challenger);
        registry.withdrawRole(Role.CHALLENGER);
    }

    function test_proposalRequiresRoleEvidenceAndYesOrNo() public {
        vm.expectRevert(BlinkResolution.MissingRole.selector);
        vm.prank(challenger);
        resolution.propose(1, Outcome.YES, EVIDENCE, "ipfs://evidence");
        vm.expectRevert(BlinkResolution.MissingEvidence.selector);
        vm.prank(proposer);
        resolution.propose(1, Outcome.YES, bytes32(0), "ipfs://evidence");
        vm.expectRevert(BlinkResolution.MissingEvidence.selector);
        vm.prank(proposer);
        resolution.propose(1, Outcome.YES, EVIDENCE, "");
        vm.expectRevert(BlinkResolution.InvalidOutcome.selector);
        vm.prank(proposer);
        resolution.propose(1, Outcome.INVALID, EVIDENCE, "ipfs://evidence");
    }

    function test_proposalOnlyInWindowAndOpenState() public {
        IBlinkMarkets.Market memory m = markets.getMarket(1);
        m.closeAt += 1;
        markets.seed(1, m);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        _propose(1);
        vm.warp(m.closeAt);
        _propose(1);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        _propose(1);
        _seed(2, MarketState.OPEN, QuestionClass.A_COMPUTABLE);
        vm.warp(markets.getMarket(2).proposalDeadline);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        _propose(2);
        _seed(3, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        _propose(3);
    }

    function test_challengesRequireRoleEvidenceAndDistinctCreator() public {
        _propose(1);
        vm.expectRevert(BlinkResolution.MissingRole.selector);
        vm.prank(proposer);
        resolution.challengeResult(1, EVIDENCE);
        vm.expectRevert(BlinkResolution.MissingEvidence.selector);
        vm.prank(challenger);
        resolution.challengeResult(1, bytes32(0));
        _seed(2, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.expectRevert(BlinkResolution.SelfChallenge.selector);
        vm.prank(creator);
        resolution.challengeCreation(2, 0, EVIDENCE);
        vm.expectRevert(BlinkResolution.MissingRole.selector);
        vm.prank(proposer);
        resolution.challengeCreation(2, 0, EVIDENCE);
        vm.expectRevert(BlinkResolution.MissingEvidence.selector);
        vm.prank(challenger);
        resolution.challengeCreation(2, 0, bytes32(0));
    }

    function test_challengeResultOnlyBeforeWindowEnds() public {
        uint256 start = token.clock();
        _propose(1);
        vm.warp(start + 1 hours);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        _challengeResult(1);
        resolution.finalizeUnchallenged(1);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        _challengeResult(1);
    }

    function test_disputeBlocksUnchallengedFinalizeAndDuplicateChallenge() public {
        uint256 start = token.clock();
        _propose(1);
        _challengeResult(1);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        _challengeResult(1);
        vm.warp(start + 1 hours);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.finalizeUnchallenged(1);
    }

    function test_creationChallengeClosesAtOpenAt() public {
        _seed(2, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.warp(markets.getMarket(2).openAt);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        vm.prank(challenger);
        resolution.challengeCreation(2, 0, EVIDENCE);
    }

    function test_unchallengedAtHardDeadlineMustUseTimeout() public {
        _propose(1);
        vm.warp(markets.getMarket(1).hardDeadline);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(1);
        uint256 before = busd.balanceOf(proposer);
        resolution.finalizeTimeout(1);
        eq(busd.balanceOf(proposer), before + BOND);
        _assertFinal(1, Outcome.INVALID);
    }

    function test_timeoutRejectsCancelledAndAllowsPendingWithoutProposal() public {
        _seed(2, MarketState.CANCELLED, QuestionClass.A_COMPUTABLE);
        _seed(3, MarketState.PENDING, QuestionClass.A_COMPUTABLE);
        vm.warp(markets.getMarket(2).hardDeadline);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.finalizeTimeout(2);
        resolution.finalizeTimeout(3);
        _assertFinal(3, Outcome.INVALID);
    }

    function test_twoMarketsKeepBondsAndRoleLocksSeparate() public {
        _seed(2, MarketState.OPEN, QuestionClass.A_COMPUTABLE);
        uint256 start = token.clock();
        _propose(1);
        _propose(2);
        _challengeResult(2);
        eq(busd.balanceOf(address(resolution)), 3 * BOND);
        vm.prank(proposer);
        registry.requestRoleExit(Role.PROPOSER);
        vm.warp(start + 1 days);
        resolution.finalizeUnchallenged(1);
        eq(busd.balanceOf(address(resolution)), 2 * BOND);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
        vm.warp(markets.getMarket(2).hardDeadline);
        resolution.finalizeTimeout(2);
        eq(busd.balanceOf(address(resolution)), 0);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
    }

    function test_noProposalCanResolveNo() public {
        vm.prank(proposer);
        resolution.propose(1, Outcome.NO, EVIDENCE, "ipfs://no");
        eq(uint256(resolution.proposedOutcome(1)), uint256(Outcome.NO));
        vm.warp(token.clock() + 1 hours);
        resolution.finalizeUnchallenged(1);
        _assertFinal(1, Outcome.NO);
    }

    function test_constructorRejectsWrongChainAndAddress() public {
        GenerationAddresses memory a = registry.addresses();
        a.resolution = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.chainId(1);
        vm.expectRevert(BlinkResolution.WrongChain.selector);
        new BlinkResolution(a);
        vm.chainId(84532);
        a.resolution = address(1);
        vm.expectRevert(BlinkResolution.WrongAddress.selector);
        new BlinkResolution(a);
    }

    function test_classBAndCUseTheirOwnChallengeWindows() public {
        _seed(2, MarketState.OPEN, QuestionClass.B_VERIFIABLE);
        _seed(3, MarketState.OPEN, QuestionClass.C_JUDGMENT);
        uint256 start = token.clock();
        _propose(2);
        _propose(3);
        vm.warp(start + 4 hours - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(2);
        vm.warp(start + 4 hours);
        resolution.finalizeUnchallenged(2);
        vm.warp(start + 1 days - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.finalizeUnchallenged(3);
        vm.warp(start + 1 days);
        resolution.finalizeUnchallenged(3);
    }

    function test_failedBondTransferRollsBackProposalAndChallenge() public {
        vm.prank(proposer);
        busd.approve(address(resolution), 0);
        vm.expectRevert();
        _propose(1);
        require(resolution.proposerOf(1) == address(0), "proposal rolled back");
        eq(uint256(markets.getMarket(1).state), uint256(MarketState.OPEN));
        approveBusdAs(proposer, address(resolution));
        _propose(1);
        vm.prank(challenger);
        busd.approve(address(resolution), 0);
        vm.expectRevert();
        _challengeResult(1);
        eq(uint256(markets.getMarket(1).state), uint256(MarketState.PROPOSED));
        eq(busd.balanceOf(address(resolution)), BOND);
        approveBusdAs(challenger, address(resolution));
        _challengeResult(1);
        vm.prank(proposer);
        registry.requestRoleExit(Role.PROPOSER);
        vm.prank(challenger);
        registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(markets.getMarket(1).hardDeadline);
        resolution.finalizeTimeout(1);
        vm.prank(proposer);
        registry.withdrawRole(Role.PROPOSER);
        vm.prank(challenger);
        registry.withdrawRole(Role.CHALLENGER);
    }

    function test_discountedChallengeBondIsExactlyWhatTimeoutForfeits() public {
        vm.prank(address(markets));
        registry.reportGain(challenger, Role.CHALLENGER, PAYOUT);
        uint256 discounted = registry.bondFor(challenger, Role.CHALLENGER, BOND);
        require(discounted < BOND, "discount applied");
        uint256 before = busd.balanceOf(challenger);
        _propose(1);
        _challengeResult(1);
        eq(busd.balanceOf(challenger), before - discounted);
        eq(busd.balanceOf(address(resolution)), BOND + discounted);
        vm.warp(markets.getMarket(1).hardDeadline);
        resolution.finalizeTimeout(1);
        eq(jurors.rewardsOwed(), discounted);
        eq(busd.balanceOf(address(jurors)), discounted);
        eq(busd.balanceOf(address(resolution)), 0);
    }

    function test_timeoutWithNoJurorStakeForwardsForfeitToTreasury() public {
        vm.prank(juror);
        jurors.requestUnstake(100e18);
        eq(jurors.totalStaked(), 0);
        uint256 before = busd.balanceOf(treasury);
        _propose(1);
        _challengeResult(1);
        vm.warp(markets.getMarket(1).hardDeadline);
        resolution.finalizeTimeout(1);
        eq(busd.balanceOf(treasury), before + BOND);
        eq(jurors.rewardsOwed(), 0);
        eq(busd.balanceOf(address(resolution)), 0);
    }

    function test_disputeRoundEntryPointsEnforcePhaseAndConflictChecks() public {
        _propose(1);
        uint256 disputeId = _challengeResult(1);
        vm.expectRevert(BlinkResolution.ConflictedJuror.selector);
        vm.prank(proposer);
        resolution.commitVote(disputeId, EVIDENCE);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.revealVote(disputeId, 0, EVIDENCE);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        resolution.settleRound(disputeId);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.appeal(disputeId);
        vm.expectRevert(BlinkResolution.InvalidState.selector);
        resolution.finalizeDispute(disputeId);
    }
}
