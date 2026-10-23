// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {Role, QuestionClass, MarketState, Outcome, Params, GenerationAddresses} from "../../src/protocol/BlinkTypes.sol";

// Task 5's unmerged position surface; creation and resolution hooks use the real markets implementation.
contract DisputeMarkets is BlinkMarkets {
    mapping(uint256 => mapping(address => uint256)) internal positions;
    uint256 internal finalized;

    constructor(GenerationAddresses memory a) BlinkMarkets(a) {}

    function seedPosition(uint256 id, address who, uint256 amount) external { positions[id][who] = amount; }
    function seedFinalized(uint256 amount) external { finalized = amount; }
    function finalizedCount() public view override returns (uint256) { return finalized; }
    function getPosition(uint256 id, address who) external view returns (uint256, uint256) {
        return (positions[id][who], 0);
    }
}

contract ResolutionDisputeTest is ProtocolBase {
    BlinkRegistry internal registry;
    BlinkJurors internal jurors;
    DisputeMarkets internal markets;
    BlinkResolution internal resolution;
    address internal creator;
    address internal proposer;
    address internal challenger;
    address internal j1;
    address internal j2;
    address internal j3;
    uint256 internal marketId;
    uint256 internal constant BOND = 1e6;
    bytes32 internal constant SALT = keccak256("salt");
    bytes32 internal constant EVIDENCE = keccak256("evidence");

    function setUp() public override {
        super.setUp();
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        Params memory p = defaultParams();
        p.creditUnitMicros = 1e6;
        registry = new BlinkRegistry(p, a);
        jurors = new BlinkJurors(a);
        markets = new DisputeMarkets(a);
        resolution = new BlinkResolution(a);
        creator = _role("creator", Role.CREATOR);
        proposer = _role("proposer", Role.PROPOSER);
        challenger = _role("challenger", Role.CHALLENGER);
        j1 = _juror("j1", 60e18);
        j2 = _juror("j2", 30e18);
        j3 = _juror("j3", 10e18);
        bytes32 template = markets.registerTemplate(QuestionClass.A_COMPUTABLE, EVIDENCE, "ipfs://template");
        uint64 start = token.clock();
        vm.prank(creator);
        marketId = markets.createMarket(IBlinkMarkets.CreateArgs({
            templateId: template, specHash: EVIDENCE, specURI: "ipfs://spec", replay: false,
            closeAt: uint64(start + 3 hours), proposalDeadline: uint64(start + 1 days),
            hardDeadline: uint64(start + 4 days), maxPairs: 20
        }));
    }

    function _role(string memory label, Role role) internal returns (address who) {
        who = fundedActor(label);
        approveBusdAs(who, address(registry));
        vm.prank(who); registry.register();
        vm.prank(who); registry.joinRole(role, 100e6);
        approveBusdAs(who, address(markets));
        approveBusdAs(who, address(resolution));
    }

    function _juror(string memory label, uint256 amount) internal returns (address who) {
        who = fundedActor(label);
        approveBusdAs(who, address(registry));
        vm.prank(who); registry.register();
        vm.prank(who); token.approve(address(jurors), type(uint256).max);
        vm.prank(who); jurors.stake(amount);
    }

    function _result() internal returns (uint256 id) {
        vm.warp(markets.getMarket(marketId).openAt);
        markets.open(marketId);
        vm.warp(markets.getMarket(marketId).closeAt);
        vm.prank(proposer); resolution.propose(marketId, Outcome.YES, EVIDENCE, "ipfs://evidence");
        vm.prank(challenger); id = resolution.challengeResult(marketId, EVIDENCE);
    }

    function _commit(uint256 id, uint256 round, address who, uint8 choice) internal {
        vm.prank(who);
        resolution.commitVote(id, keccak256(abi.encode(id, round, who, choice, SALT)));
    }

    function _reveal(uint256 id, address who, uint8 choice) internal {
        vm.prank(who); resolution.revealVote(id, choice, SALT);
    }

    function _majority(uint256 id, uint256 round) internal {
        _commit(id, round, j1, 1); _commit(id, round, j2, 1); _commit(id, round, j3, 0);
        vm.warp(token.clock() + 1 hours);
        _reveal(id, j1, 1); _reveal(id, j2, 1); _reveal(id, j3, 0);
        vm.warp(token.clock() + 1 hours);
        resolution.settleRound(id);
    }

    function test_honestMajorityOverturnsLie() public {
        uint256 id = _result();
        uint256 before = busd.balanceOf(challenger);
        _majority(id, 0);
        vm.warp(token.clock() + 1 hours);
        resolution.finalizeDispute(id);
        eq(uint256(markets.getMarket(marketId).state), uint256(MarketState.FINAL));
        eq(uint256(markets.getMarket(marketId).finalOutcome), uint256(Outcome.NO));
        eq(busd.balanceOf(challenger), before + BOND + BOND * 8000 / 10000);
        uint256 tokenBefore = token.balanceOf(j1);
        resolution.settleVote(id, 0, j3);
        resolution.settleVote(id, 0, j1);
        resolution.settleVote(id, 0, j2);
        eq(jurors.stakeAt(j3, token.clock()), 95e17);
        eq(token.balanceOf(j1), tokenBefore + uint256(5e17) * 60 / 90);
        eq(jurors.openVotes(j1), 0);
        eq(registry.roleStake(proposer, Role.PROPOSER), 90e6);
        eq(registry.creditOf(j1, Role.JUROR), 20);
        require(resolution.bountyWinner(marketId) == challenger, "bounty winner");
        vm.warp(token.clock() + 7 days);
        uint256 busdBefore = busd.balanceOf(j1);
        vm.prank(j1); jurors.claimRewards();
        require(busd.balanceOf(j1) > busdBefore, "streamed reward");
        eq(busd.balanceOf(address(resolution)), 0);
    }

    function test_stakeAfterSnapshotHasNoWeight() public {
        uint256 id = _result();
        address late = _juror("late", 100e18);
        vm.expectRevert(BlinkResolution.NoWeight.selector);
        _commit(id, 0, late, 1);
    }

    function test_splitStakeSameWeight() public {
        vm.prank(j1); jurors.stake(40e18);
        uint256 id = _result();
        _majority(id, 0);
        (, IBlinkResolution.Round memory first) = resolution.getDispute(id);
        vm.warp(token.clock() + 1 hours);
        resolution.finalizeDispute(id);
        // Compare one 100-token identity with two identities totaling 100 on a fresh dispute.
        address a = _juror("split-a", 50e18);
        address b = _juror("split-b", 50e18);
        vm.warp(token.clock() + 1);
        // A second market uses the same real market creation path.
        bytes32 template = markets.registerTemplate(QuestionClass.A_COMPUTABLE, EVIDENCE, "ipfs://template");
        uint64 start = token.clock();
        vm.prank(creator);
        marketId = markets.createMarket(IBlinkMarkets.CreateArgs(template, keccak256("second"), "ipfs://second", false,
            start + 3 hours, start + 1 days, start + 4 days, 20));
        vm.prank(proposer); registry.addRoleStake(Role.PROPOSER, 10e6);
        id = _result();
        _commit(id, 0, a, 1); _commit(id, 0, b, 1); _commit(id, 0, j2, 1); _commit(id, 0, j3, 0);
        vm.warp(token.clock() + 1 hours);
        _reveal(id, a, 1); _reveal(id, b, 1); _reveal(id, j2, 1); _reveal(id, j3, 0);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        (, IBlinkResolution.Round memory second) = resolution.getDispute(id);
        eq(first.revealedWeight[1], second.revealedWeight[1]);
        eq(first.leadingChoice, second.leadingChoice);
    }

    function test_noQuorumRestartsRound() public {
        _juror("reserve", 100e18);
        uint256 id = _result();
        // j3 has 5% of snapshot stake, below the 20% quorum.
        _commit(id, 0, j3, 1);
        vm.warp(token.clock() + 1 hours); _reveal(id, j3, 1);
        vm.warp(token.clock() + 1 hours);
        vm.expectEmit(true, false, false, true);
        emit IBlinkResolution.RoundRestarted(id, 0, uint64(token.clock() - 1));
        resolution.settleRound(id);
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(id);
        eq(d.currentRound, 1); eq(d.appealRound, 0);
        eq(uint256(markets.getMarket(marketId).state), uint256(MarketState.DISPUTED));
        resolution.settleVote(id, 0, j3);
        eq(jurors.openVotes(j3), 0);
    }

    function test_nonRevealIsSlashed() public {
        uint256 id = _result();
        _commit(id, 0, j1, 1); _commit(id, 0, j3, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 1);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        resolution.settleVote(id, 0, j3);
        eq(jurors.stakeAt(j3, token.clock()), 9e18);
        eq(jurors.openVotes(j3), 0);
        vm.expectRevert(BlinkResolution.AlreadySettled.selector); resolution.settleVote(id, 0, j3);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        resolution.settleVote(id, 0, j3); // final credit after an earlier slash/unlock
        resolution.settleVote(id, 0, j1);
        eq(jurors.openVotes(j3), 0);
    }

    function test_conflictedJurorsCannotCommit() public {
        uint256 id = _result();
        markets.seedPosition(marketId, j1, 1);
        address[4] memory conflicted = [creator, proposer, challenger, j1];
        for (uint256 i; i < conflicted.length; ++i) {
            vm.expectRevert(BlinkResolution.ConflictedJuror.selector);
            _commit(id, 0, conflicted[i], 1);
        }
    }

    function test_appealDoublesBondAndRaisesThreshold() public {
        uint256 id = _result(); _majority(id, 0);
        uint256 before = busd.balanceOf(proposer);
        vm.prank(proposer); resolution.appeal(id);
        eq(busd.balanceOf(proposer), before - 2 * BOND);
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(id);
        eq(d.appealRound, 1); eq(d.lastBond, 2 * BOND);
        markets.seedFinalized(3);
        vm.expectRevert(BlinkResolution.InsufficientCredit.selector); _commit(id, 1, j1, 1);
        vm.prank(address(markets)); registry.reportGain(j1, Role.JUROR, 5e6);
        _commit(id, 1, j1, 1);
    }

    function test_maxRoundsStopsAppeals() public {
        uint256 id = _result(); _majority(id, 0);
        vm.prank(proposer); resolution.appeal(id);
        _majority(id, 1);
        vm.prank(proposer); resolution.appeal(id);
        _majority(id, 2);
        vm.expectRevert(BlinkResolution.NoMoreAppeals.selector);
        vm.prank(proposer); resolution.appeal(id);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        eq(busd.balanceOf(address(resolution)), 0);
    }

    function _creation() internal returns (uint256 id) {
        vm.warp(token.clock() + 1);
        vm.prank(challenger); id = resolution.challengeCreation(marketId, 0, EVIDENCE);
    }

    function test_creationUpheldCancelsMarketAndPaysChallenger() public {
        vm.prank(address(markets)); registry.reportGain(creator, Role.CREATOR, 20e6);
        uint256 id = _creation(); uint256 before = busd.balanceOf(challenger);
        _majority(id, 0);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        eq(uint256(markets.getMarket(marketId).state), uint256(MarketState.CANCELLED));
        eq(busd.balanceOf(challenger), before + BOND + BOND * 8000 / 10000);
        eq(registry.creditOf(creator, Role.CREATOR), 0);
        eq(registry.roleStake(creator, Role.CREATOR), 90e6);
        eq(markets.openPayoutTotal(), 0);
    }

    function test_loserCanBeSettledByThirdParty() public {
        uint256 id = _result(); _majority(id, 0);
        vm.prank(actor("keeper")); resolution.settleVote(id, 0, j3);
        eq(jurors.stakeAt(j3, token.clock()), 95e17);
        eq(jurors.openVotes(j3), 0);
    }

    function test_coherentCannotClaimBeforeAllLosersSettled() public {
        uint256 id = _result(); _majority(id, 0);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        vm.expectRevert(BlinkResolution.LosersPending.selector); resolution.settleVote(id, 0, j1);
        resolution.settleVote(id, 0, j3);
        resolution.settleVote(id, 0, j1);
    }

    function test_settleVoteAfterFinalizeTimeoutOnlyUnlocks() public {
        uint256 id = _result(); _commit(id, 0, j1, 1); _commit(id, 0, j3, 0);
        uint256 before = token.balanceOf(j1);
        vm.warp(markets.getMarket(marketId).hardDeadline); resolution.finalizeTimeout(marketId);
        resolution.settleVote(id, 0, j1); resolution.settleVote(id, 0, j3);
        eq(jurors.openVotes(j1), 0); eq(jurors.openVotes(j3), 0);
        eq(jurors.stakeAt(j3, token.clock()), 10e18); eq(token.balanceOf(j1), before);
        eq(registry.creditOf(j1, Role.JUROR), 0);
        vm.expectRevert(BlinkResolution.AlreadySettled.selector); resolution.settleVote(id, 0, j1);
    }

    function test_restartedRoundSlashesOnlyNonRevealers() public {
        uint256 id = _result();
        _commit(id, 0, j2, 0); _commit(id, 0, j3, 1);
        // No reveals makes a tie with no winning weight, even though committed quorum is met.
        vm.warp(token.clock() + 2 hours); resolution.settleRound(id);
        resolution.settleVote(id, 0, j2);
        eq(jurors.stakeAt(j2, token.clock()), 27e18);
        _commit(id, 1, j1, 1);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 1);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        vm.expectRevert(BlinkResolution.LosersPending.selector); resolution.settleVote(id, 1, j1);
        resolution.settleVote(id, 0, j3);
        uint256 before = token.balanceOf(j1); resolution.settleVote(id, 1, j1);
        eq(token.balanceOf(j1), before + 4e18);
    }

    function test_tiedRevealersUnlockWithoutSlash() public {
        _juror("reserve", 100e18);
        uint256 id = _result();
        // Move j1's 30 tokens before the next dispute snapshot through a restart.
        vm.prank(j1); jurors.requestUnstake(30e18);
        vm.warp(token.clock() + 2 hours); resolution.settleRound(id);
        _commit(id, 1, j1, 0); _commit(id, 1, j2, 1); _commit(id, 1, j3, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 0); _reveal(id, j2, 1);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        resolution.settleVote(id, 1, j1); resolution.settleVote(id, 1, j2); resolution.settleVote(id, 1, j3);
        eq(jurors.stakeAt(j1, token.clock()), 30e18); eq(jurors.stakeAt(j2, token.clock()), 30e18);
        eq(jurors.stakeAt(j3, token.clock()), 9e18);
    }

    function test_creationRejectedAllowsLaterResultDispute() public {
        uint256 id = _creation();
        _commit(id, 0, j1, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 0);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        vm.prank(proposer); resolution.propose(marketId, Outcome.YES, EVIDENCE, "ipfs://evidence");
        vm.prank(challenger); registry.addRoleStake(Role.CHALLENGER, 10e6);
        vm.prank(challenger); uint256 resultId = resolution.challengeResult(marketId, EVIDENCE);
        require(resultId != id, "new dispute");
    }

    function test_timeoutSettlesAppellantRolesAndBonds() public {
        uint256 id = _result(); _majority(id, 0);
        address appellant = _role("appellant", Role.PROPOSER);
        uint256 before = busd.balanceOf(appellant);
        vm.prank(appellant); resolution.appeal(id);
        vm.expectRevert(BlinkResolution.ConflictedJuror.selector); _commit(id, 1, appellant, 0);
        vm.warp(markets.getMarket(marketId).hardDeadline); resolution.finalizeTimeout(marketId);
        eq(busd.balanceOf(appellant), before);
        vm.prank(appellant); registry.requestRoleExit(Role.PROPOSER);
        vm.warp(token.clock() + 1 days);
        vm.prank(appellant); registry.withdrawRole(Role.PROPOSER);
        resolution.settleVote(id, 0, j1); resolution.settleVote(id, 0, j2); resolution.settleVote(id, 0, j3);
        eq(busd.balanceOf(address(resolution)), 0);
    }

    function test_invalidChoiceCannotFinalizeBeforeHardDeadline() public {
        uint256 id = _result(); _commit(id, 0, j1, 2);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 2);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(id); eq(d.currentRound, 1);
        eq(uint256(markets.getMarket(marketId).state), uint256(MarketState.DISPUTED));
    }

    function test_commitRevealBoundariesAndReplayProtection() public {
        uint256 id = _result();
        vm.expectRevert(BlinkResolution.InvalidVote.selector);
        vm.prank(j1); resolution.commitVote(id, bytes32(0));
        _commit(id, 0, j1, 1);
        vm.expectRevert(BlinkResolution.InvalidVote.selector); _commit(id, 0, j1, 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); _reveal(id, j1, 1);
        vm.warp(token.clock() + 1 hours);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); _commit(id, 0, j2, 1);
        vm.expectRevert(BlinkResolution.InvalidVote.selector);
        vm.prank(j1); resolution.revealVote(id, 1, keccak256("wrong"));
        vm.expectRevert(BlinkResolution.InvalidVote.selector); _reveal(id, j1, 0);
        vm.expectRevert(BlinkResolution.InvalidVote.selector); _reveal(id, j1, 3);
        _reveal(id, j1, 1);
        vm.expectRevert(BlinkResolution.InvalidVote.selector); _reveal(id, j1, 1);
        vm.warp(token.clock() + 1 hours);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); _reveal(id, j2, 1);
        resolution.settleRound(id);
        vm.expectRevert(BlinkResolution.AlreadySettled.selector); resolution.settleRound(id);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); resolution.finalizeDispute(id);
        vm.warp(token.clock() + 1 hours);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        vm.prank(proposer); resolution.appeal(id);
        resolution.finalizeDispute(id);
        vm.expectRevert(BlinkResolution.InvalidState.selector); resolution.finalizeDispute(id);
    }

    function test_rewardUsesActualCappedSlash() public {
        uint256 id = _result(); _majority(id, 0);
        vm.prank(address(resolution)); jurors.slash(j3, 99e17, treasury);
        resolution.settleVote(id, 0, j3);
        eq(jurors.undistributedSlashed(), 1e17);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        uint256 before = token.balanceOf(j1); resolution.settleVote(id, 0, j1);
        eq(token.balanceOf(j1), before + uint256(1e17) * 60 / 90);
    }

    function test_openVoteBlocksWithdrawalUntilExactlyOneUnlock() public {
        uint256 id = _result(); _commit(id, 0, j3, 0); _commit(id, 0, j1, 1);
        vm.prank(j3); jurors.requestUnstake(10e18);
        vm.warp(token.clock() + 1 hours); _reveal(id, j3, 0); _reveal(id, j1, 1);
        vm.warp(token.clock() + 2 days);
        vm.expectRevert(BlinkJurors.OpenVotes.selector);
        vm.prank(j3); jurors.withdrawUnstaked();
        resolution.settleRound(id); resolution.settleVote(id, 0, j3);
        uint256 before = token.balanceOf(j3);
        vm.prank(j3); jurors.withdrawUnstaked();
        eq(token.balanceOf(j3), before + 95e17);
        eq(jurors.openVotes(j3), 0);
    }

    function test_finalRoundAloneAwardsJurorCredit() public {
        uint256 id = _result(); _majority(id, 0);
        resolution.settleVote(id, 0, j3);
        vm.prank(proposer); resolution.appeal(id);
        resolution.settleVote(id, 0, j1);
        eq(registry.creditOf(j1, Role.JUROR), 0);
        _majority(id, 1);
        resolution.settleVote(id, 1, j3);
        eq(registry.creditOf(j3, Role.JUROR), 0);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        resolution.settleVote(id, 1, j1);
        eq(registry.creditOf(j1, Role.JUROR), 20);
        vm.expectRevert(BlinkResolution.AlreadySettled.selector); resolution.settleVote(id, 1, j1);
    }

    function test_appellantWinningBondsAndPrizesSplitProRata() public {
        uint256 id = _result(); _majority(id, 0);
        address appellant = _role("appellant", Role.PROPOSER);
        vm.prank(appellant); resolution.appeal(id);
        _commit(id, 1, j1, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 0);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        uint256 beforeProposer = busd.balanceOf(proposer);
        uint256 beforeAppellant = busd.balanceOf(appellant);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        uint256 prize = BOND * 8000 / 10000;
        eq(busd.balanceOf(proposer), beforeProposer + BOND + prize / 3);
        eq(busd.balanceOf(appellant), beforeAppellant + 2 * BOND + prize - prize / 3);
        eq(busd.balanceOf(address(resolution)), 0);
        require(resolution.bountyWinner(marketId) == proposer, "proposer bounty");
    }

    function test_timeoutForfeitsChallengerSideAppeal() public {
        uint256 id = _result();
        _commit(id, 0, j1, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 0);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        address appellant = _role("appellant", Role.CHALLENGER);
        vm.prank(appellant); resolution.appeal(id);
        uint256 before = busd.balanceOf(appellant);
        vm.warp(markets.getMarket(marketId).hardDeadline); resolution.finalizeTimeout(marketId);
        eq(busd.balanceOf(appellant), before);
        eq(jurors.rewardsOwed(), 3 * BOND);
        vm.prank(appellant); registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(token.clock() + 1 days);
        vm.prank(appellant); registry.withdrawRole(Role.CHALLENGER);
    }

    function test_repeatedAppealPosterGetsOneRolePenalty() public {
        uint256 id = _result(); _majority(id, 0);
        vm.prank(proposer); resolution.appeal(id);
        _majority(id, 1);
        vm.prank(proposer); resolution.appeal(id);
        _majority(id, 2);
        vm.warp(token.clock() + 1 hours); resolution.finalizeDispute(id);
        eq(registry.roleStake(proposer, Role.PROPOSER), 90e6);
        vm.prank(proposer); registry.requestRoleExit(Role.PROPOSER);
        vm.warp(token.clock() + 1 days);
        vm.prank(proposer); registry.withdrawRole(Role.PROPOSER);
    }

    function test_originalPartyCannotAppealOnOppositeSide() public {
        uint256 id = _result();
        _commit(id, 0, j1, 0);
        vm.warp(token.clock() + 1 hours); _reveal(id, j1, 0);
        vm.warp(token.clock() + 1 hours); resolution.settleRound(id);
        vm.prank(proposer); registry.joinRole(Role.CHALLENGER, 100e6);
        vm.expectRevert(BlinkResolution.SelfChallenge.selector);
        vm.prank(proposer); resolution.appeal(id);
    }
}
