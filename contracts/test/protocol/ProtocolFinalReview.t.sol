// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {ProtocolScenario} from "./Lifecycle.t.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {Role, MarketState, Outcome, Params} from "../../src/protocol/BlinkTypes.sol";

contract ProtocolFinalReviewTest is ProtocolScenario {
    function setUp() public override {
        ProtocolBase.setUp();
        Params memory params = defaultParams();
        params.creditUnitMicros = 1e6;
        _setupGeneration(params);
    }

    function _minimumArgs() internal view returns (IBlinkMarkets.CreateArgs memory a) {
        uint64 now_ = token.clock();
        a = IBlinkMarkets.CreateArgs(templateId, EVIDENCE, "fixture://minimum", false,
            now_ + 1 days, now_ + 1 days + 1, 0, 100);
        a.hardDeadline = a.proposalDeadline + p.resultChallengeWindow[0]
            + uint64(p.maxRounds) * (p.commitSeconds + p.revealSeconds + p.appealSeconds) + 1;
    }

    function test_shortArbitrationSchedulesRevert() public {
        IBlinkMarkets.CreateArgs memory a = _minimumArgs();
        uint64 validDeadline = a.hardDeadline;
        a.hardDeadline = a.proposalDeadline + 3601;
        vm.expectRevert(BlinkMarkets.InvalidSchedule.selector);
        vm.prank(creator); markets.createMarket(a);
        a.hardDeadline = validDeadline - 1;
        vm.expectRevert(BlinkMarkets.InvalidSchedule.selector);
        vm.prank(creator); markets.createMarket(a);
        a.hardDeadline = validDeadline;
        vm.prank(creator); markets.createMarket(a);
    }

    function test_latestProposalChallengeAndEveryAppealFinishBeforeDeadline() public {
        IBlinkMarkets.CreateArgs memory a = _minimumArgs();
        vm.prank(creator); uint256 id = markets.createMarket(a);
        _open(id);
        _fill(id, MAKER_KEY, taker, 1, 10); // cheap NO position cannot obtain an INVALID half payout
        vm.warp(a.proposalDeadline - 1);
        vm.prank(proposer); resolution.propose(id, Outcome.YES, EVIDENCE, "fixture://evidence");
        vm.warp(uint256(a.proposalDeadline) + p.resultChallengeWindow[0] - 2);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(id, EVIDENCE);
        for (uint256 level; level < p.maxRounds; ++level) {
            _round(dispute, 0, 0);
            (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
            eq(r.appealEnd, r.revealEnd + p.appealSeconds);
            if (level + 1 < p.maxRounds) {
                vm.warp(r.appealEnd - 1);
                vm.prank(challenger); resolution.appeal(dispute);
            }
        }
        _finalize(dispute);
        require(token.clock() < a.hardDeadline, "honest arbitration ran out of time");
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.FINAL));
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.YES));
        uint256 before = busd.balanceOf(taker);
        vm.prank(taker); markets.redeem(id);
        eq(busd.balanceOf(taker), before); // no 5 bUSD INVALID payout to the losing side
    }

    function test_lateSettlementDoesNotExtendAppealWindow() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        _commit(dispute, j1, 0);
        (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        vm.warp(r.commitEnd); vm.prank(j1); resolution.revealVote(dispute, 0, EVIDENCE);
        vm.warp(r.revealEnd + p.appealSeconds + 1);
        resolution.settleRound(dispute);
        (, IBlinkResolution.Round memory settled) = resolution.getDispute(dispute);
        eq(settled.appealEnd, r.revealEnd + p.appealSeconds);
        resolution.finalizeDispute(dispute);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.YES));
    }

    function test_unfinishableAppealRevertsAndPriorResultStands() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        uint256 deadline = markets.getMarket(id).hardDeadline;
        // A delayed restart consumes the otherwise sufficient initial arbitration budget.
        vm.warp(deadline - 2 * (p.commitSeconds + p.revealSeconds));
        resolution.settleRound(dispute);
        _round(dispute, 0, 0);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        vm.prank(challenger); resolution.appeal(dispute);
        vm.warp(token.clock() + 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector);
        vm.prank(challenger); resolution.appeal(dispute);
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
        eq(d.currentRound, 1); eq(d.appealRound, 0);
        _finalize(dispute);
        eq(token.clock(), deadline - p.appealSeconds);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.YES));
    }

    function test_overturnedRoundSettlesTokensAgainstFinalChoice() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        uint256 before1 = token.balanceOf(j1);
        uint256 before2 = token.balanceOf(j2);
        _round(dispute, 1, 0); // NO majority, honest YES minority
        vm.expectRevert(BlinkResolution.InvalidState.selector); resolution.settleVote(dispute, 0, j2);
        vm.expectRevert(BlinkResolution.InvalidState.selector); resolution.settleVote(dispute, 0, j1);
        vm.prank(proposer); resolution.appeal(dispute);
        vm.expectRevert(BlinkResolution.InvalidState.selector); resolution.settleVote(dispute, 0, j2);
        eq(jurors.openVotes(j1), 1); eq(jurors.openVotes(j2), 1);
        eq(jurors.slashableStake(j1), 510e18); eq(jurors.slashableStake(j2), 490e18);
        _round(dispute, 0, 0); _finalize(dispute);
        vm.expectRevert(BlinkResolution.LosersPending.selector); resolution.settleVote(dispute, 0, j2);
        resolution.settleVote(dispute, 0, j1);
        uint256 slash = uint256(510e18) * p.incoherentSlashBps / 10000;
        eq(token.balanceOf(j1), before1);
        eq(jurors.slashableStake(j1), 510e18 - slash);
        eq(jurors.openVotes(j1), 1); // appeal vote still locked
        resolution.settleVote(dispute, 0, j2);
        eq(token.balanceOf(j2), before2 + slash);
        eq(jurors.slashableStake(j2), 490e18);
        eq(jurors.openVotes(j2), 1);
        eq(registry.creditOf(j1, Role.JUROR), 0); eq(registry.creditOf(j2, Role.JUROR), 0);
        resolution.settleVote(dispute, 1, j1); resolution.settleVote(dispute, 1, j2);
        eq(jurors.openVotes(j1), 0); eq(jurors.openVotes(j2), 0);
        eq(token.balanceOf(j1), before1); eq(token.balanceOf(j2), before2 + slash);
        eq(jurors.slashableStake(j1), 510e18 - slash); eq(jurors.slashableStake(j2), 490e18);
        eq(jurors.undistributedSlashed(), 0);
    }

    function test_roundWithNoFinalChoiceVotersRetainsPool() public {
        uint256 id = _create(100); uint256 dispute = _resultDispute(id);
        _round(dispute, 1, 1);
        vm.prank(proposer); resolution.appeal(dispute);
        _round(dispute, 0, 0); _finalize(dispute);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        eq(jurors.undistributedSlashed(), 50e18);
        resolution.settleVote(dispute, 1, j1); resolution.settleVote(dispute, 1, j2);
        eq(jurors.undistributedSlashed(), 50e18);
        eq(jurors.openVotes(j1) + jurors.openVotes(j2), 0);
    }

    function _proposeNow(uint256 id) internal {
        vm.prank(proposer); resolution.propose(id, Outcome.YES, EVIDENCE, "fixture://evidence");
    }

    function test_phaseInCrossingDuringAppealKeepsFrozenGate() public {
        uint256 first = _create(1); uint256 second = _create(1); uint256 third = _create(1);
        uint256 target = _create(20); uint256 later = _create(20);
        _open(first); _open(second); _open(third); _open(target); _open(later);
        vm.warp(markets.getMarket(first).closeAt);
        _proposeNow(first); _proposeNow(second); _proposeNow(third);
        vm.warp(token.clock() + p.resultChallengeWindow[0]);
        resolution.finalizeUnchallenged(first); resolution.finalizeUnchallenged(second);
        eq(markets.finalizedCount(), 2);
        _proposeNow(target);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(target, EVIDENCE);
        _round(dispute, 1, 1);
        vm.prank(proposer); resolution.appeal(dispute);
        _commit(dispute, j1, 0);
        resolution.finalizeUnchallenged(third);
        eq(markets.finalizedCount(), 3); eq(registry.creditOf(j2, Role.JUROR), 0);
        _commit(dispute, j2, 0); // still admitted after another market crosses phase-in
        _proposeNow(later);
        vm.prank(challenger); uint256 nextDispute = resolution.challengeResult(later, EVIDENCE);
        _round(nextDispute, 1, 1);
        vm.prank(proposer); resolution.appeal(nextDispute);
        _expectCreditRejection(nextDispute, j2);
    }

    function _expectCreditRejection(uint256 dispute, address who) internal {
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
        bytes32 commitment = keccak256(abi.encode(dispute, d.currentRound, who, uint8(0), EVIDENCE));
        vm.expectRevert(BlinkResolution.InsufficientCredit.selector);
        vm.prank(who); resolution.commitVote(dispute, commitment);
    }

    function test_frozenGateUsesLiveCreditAtThreshold() public {
        uint256 first = _create(1); uint256 second = _create(1); uint256 creditMarket = _create(5);
        uint256 target = _create(20);
        _open(first); _open(second); _open(creditMarket); _open(target);
        vm.warp(markets.getMarket(first).closeAt);
        _proposeNow(first); _proposeNow(second); _proposeNow(creditMarket);
        vm.prank(challenger); uint256 creditDispute = resolution.challengeResult(creditMarket, EVIDENCE);
        _round(creditDispute, 0, 0); _finalize(creditDispute);
        resolution.finalizeUnchallenged(first); resolution.finalizeUnchallenged(second);
        eq(markets.finalizedCount(), 3);
        vm.prank(challenger); registry.addRoleStake(Role.CHALLENGER, 10e6);
        _proposeNow(target);
        vm.prank(challenger); uint256 dispute = resolution.challengeResult(target, EVIDENCE);
        _round(dispute, 1, 1);
        vm.prank(proposer); resolution.appeal(dispute);
        _expectCreditRejection(dispute, j2);
        resolution.settleVote(creditDispute, 0, j2);
        eq(registry.creditOf(j2, Role.JUROR), p.roundCreditThreshold[1]);
        _commit(dispute, j2, 0); // own deferred credit can change admission, as accepted by R41
    }
}
