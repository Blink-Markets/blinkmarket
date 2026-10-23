// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {BlinkGovernor} from "../../src/protocol/BlinkGovernor.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {Params, Role, QuestionClass, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";

// Shared real-generation fixture; all roles are joined by their registered actors.
abstract contract ProtocolScenario is ProtocolBase {
    uint256 internal constant MAKER_KEY = 0xA11CE;
    uint256 internal constant MAKER2_KEY = 0xB0B;
    bytes32 internal constant EVIDENCE = keccak256("protocol evidence");
    BlinkRegistry internal registry;
    BlinkJurors internal jurors;
    BlinkMarkets internal markets;
    BlinkResolution internal resolution;
    Params internal p;
    address internal creator;
    address internal maker;
    address internal maker2;
    address internal taker;
    address internal proposer;
    address internal challenger;
    address internal j1;
    address internal j2;
    bytes32 internal templateId;
    uint256 internal serial;

    function setUp() public virtual override {
        super.setUp();
        _setupGeneration(defaultParams());
    }

    function _fundIdentity(address who) internal virtual { claimAs(who); }

    function _identity(address who) internal {
        _fundIdentity(who);
        approveBusdAs(who, address(registry));
        approveBusdAs(who, address(markets));
        approveBusdAs(who, address(resolution));
        vm.prank(who); registry.register();
    }

    function _role(address who, Role role) internal returns (address) {
        _identity(who);
        vm.prank(who); registry.joinRole(role, p.minRoleStake);
        return who;
    }

    function _setupGeneration(Params memory params) internal {
        p = params;
        (registry, jurors, markets, resolution) = deployGeneration(p, address(0));
        creator = _role(actor("lifecycle creator"), Role.CREATOR);
        maker = _role(vm.addr(MAKER_KEY), Role.MAKER);
        maker2 = _role(vm.addr(MAKER2_KEY), Role.MAKER);
        taker = _role(actor("lifecycle taker"), Role.TAKER);
        proposer = _role(actor("lifecycle proposer"), Role.PROPOSER);
        challenger = _role(actor("lifecycle challenger"), Role.CHALLENGER);
        j1 = actor("lifecycle juror 1");
        j2 = actor("lifecycle juror 2");
        _identity(j1); _identity(j2);
        vm.startPrank(j1);
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(510e18);
        vm.stopPrank();
        vm.startPrank(j2);
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(490e18);
        vm.stopPrank();
        vm.prank(maker); markets.depositMaker(300e6);
        vm.prank(maker2); markets.depositMaker(300e6);
        vm.prank(creator);
        templateId = markets.registerTemplate(QuestionClass.A_COMPUTABLE, EVIDENCE, "fixture://template");
        vm.warp(token.clock() + 1);
    }

    function _create(uint64 pairs) internal returns (uint256 id) {
        uint64 now_ = token.clock();
        vm.prank(creator);
        id = markets.createMarket(IBlinkMarkets.CreateArgs(templateId, keccak256(abi.encode(++serial)),
            "fixture://spec", false, now_ + 1 days, now_ + 2 days, now_ + 4 days, pairs));
    }

    function _open(uint256 id) internal {
        uint64 at = markets.getMarket(id).openAt;
        if (token.clock() < at) vm.warp(at);
        markets.open(id);
    }

    function _quote(uint256 id, uint256 key, address buyer, uint8 side, uint64 qty)
        internal returns (IBlinkMarkets.Quote memory q, bytes memory signature)
    {
        address seller = vm.addr(key);
        q = IBlinkMarkets.Quote(id, markets.getMarket(id).specHash, seller, buyer, side, qty, 5000,
            token.clock(), token.clock() + 30, ++serial, markets.makerEpoch(seller));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, markets.hashQuote(q));
        signature = abi.encodePacked(r, s, v);
    }

    function _fill(uint256 id, uint256 key, address buyer, uint8 side, uint64 qty) internal {
        (IBlinkMarkets.Quote memory q, bytes memory sig) = _quote(id, key, buyer, side, qty);
        vm.prank(buyer); markets.fillQuote(q, sig);
    }

    function _propose(uint256 id) internal {
        vm.warp(markets.getMarket(id).closeAt);
        vm.prank(proposer); resolution.propose(id, Outcome.YES, EVIDENCE, "fixture://evidence");
    }

    function _unchallenged(uint256 id) internal {
        _propose(id);
        vm.warp(token.clock() + p.resultChallengeWindow[0]);
        resolution.finalizeUnchallenged(id);
    }

    function _resultDispute(uint256 id) internal returns (uint256 dispute) {
        _open(id); _propose(id);
        vm.prank(challenger); dispute = resolution.challengeResult(id, EVIDENCE);
    }

    function _commit(uint256 dispute, address who, uint8 choice) internal {
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
        vm.prank(who);
        resolution.commitVote(dispute, keccak256(abi.encode(dispute, d.currentRound, who, choice, EVIDENCE)));
    }

    function _round(uint256 dispute, uint8 choice1, uint8 choice2) internal {
        _commit(dispute, j1, choice1); _commit(dispute, j2, choice2);
        (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        vm.warp(r.commitEnd);
        vm.prank(j1); resolution.revealVote(dispute, choice1, EVIDENCE);
        vm.prank(j2); resolution.revealVote(dispute, choice2, EVIDENCE);
        vm.warp(r.revealEnd); resolution.settleRound(dispute);
    }

    function _finalize(uint256 dispute) internal {
        (, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        vm.warp(r.appealEnd); resolution.finalizeDispute(dispute);
    }

    function _creatorFinal(uint256 id, Outcome outcome, uint256 before, uint256 expectedCredit) internal {
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        eq(uint256(m.state), uint256(MarketState.FINAL));
        eq(uint256(m.finalOutcome), uint256(outcome));
        eq(m.creationBond, 0);
        eq(busd.balanceOf(creator) - before, uint256(m.maxPairs) * 1e6 * p.creationBondBps / 10000);
        eq(markets.openPayoutTotal(), 0);
        eq(markets.openPayoutByCreator(creator), 0);
        eq(markets.finalizedCount(), 1);
        eq(registry.creditOf(creator, Role.CREATOR), expectedCredit);
        vm.prank(creator); registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(creator); registry.withdrawRole(Role.CREATOR);
        vm.expectRevert(BlinkResolution.InvalidState.selector); resolution.finalizeTimeout(id);
        eq(markets.finalizedCount(), 1);
    }
}

contract LifecycleTest is ProtocolScenario {
    function test_normalPath() public {
        uint256 id = _create(100); _open(id);
        _fill(id, MAKER_KEY, taker, 0, 10);
        _fill(id, MAKER2_KEY, taker, 1, 10);
        _unchallenged(id);
        vm.prank(actor("keeper")); markets.distributeFees(id);
        vm.prank(taker); markets.redeem(id);
        vm.prank(maker); markets.redeem(id);
        vm.prank(maker2); markets.redeem(id);
        uint256 free = markets.makerFree(maker);
        vm.prank(maker); markets.withdrawMaker(free);
        free = markets.makerFree(maker2);
        vm.prank(maker2); markets.withdrawMaker(free);
        vm.warp(token.clock() + 7 days);
        vm.prank(j1); jurors.claimRewards();
        vm.prank(j2); jurors.claimRewards();
        eq(busd.balanceOf(creator), 890025000);
        eq(busd.balanceOf(maker), 885e6);
        eq(busd.balanceOf(maker2), 895e6);
        eq(busd.balanceOf(taker), 889900000);
        eq(busd.balanceOf(proposer), 890014250);
        eq(busd.balanceOf(challenger), 890e6);
        eq(busd.balanceOf(actor("keeper")), 750);
        eq(busd.balanceOf(treasury), 80030000);
        eq(busd.balanceOf(address(registry)), 600e6);
        eq(busd.balanceOf(address(markets)), 0);
        eq(busd.balanceOf(address(resolution)), 0);
        eq(markets.getMarket(id).escrowMicros, 0);
        uint256 total = busd.balanceOf(creator) + busd.balanceOf(maker) + busd.balanceOf(maker2)
            + busd.balanceOf(taker) + busd.balanceOf(proposer) + busd.balanceOf(challenger)
            + busd.balanceOf(j1) + busd.balanceOf(j2) + busd.balanceOf(actor("keeper"))
            + busd.balanceOf(treasury) + busd.balanceOf(address(registry)) + busd.balanceOf(address(jurors));
        eq(total, 8 * faucet.CLAIM_BUSD());
        eq(total, busd.totalSupply());
        require(busd.balanceOf(j1) > 990e6 && busd.balanceOf(j2) > 990e6, "stream paid both jurors");
        eq(busd.balanceOf(address(jurors)), jurors.rewardsOwed());
    }

    function test_disputeWithAppeal() public {
        uint256 id = _create(100);
        uint256 dispute = _resultDispute(id);
        _round(dispute, 1, 1);
        vm.prank(proposer); resolution.appeal(dispute);
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
        eq(d.currentRound, 1); eq(d.appealRound, 1); eq(d.lastBond, 10e6);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        _round(dispute, 0, 0); _finalize(dispute);
        resolution.settleVote(dispute, 1, j1); resolution.settleVote(dispute, 1, j2);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.YES));
        eq(jurors.openVotes(j1) + jurors.openVotes(j2), 0);
        eq(busd.balanceOf(address(resolution)), 0);
        eq(registry.creditOf(j1, Role.JUROR), 1);
        vm.prank(proposer); registry.requestRoleExit(Role.PROPOSER);
        vm.prank(challenger); registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(token.clock() + 7 days);
        vm.prank(j1); jurors.claimRewards(); vm.prank(j2); jurors.claimRewards();
        vm.prank(proposer); registry.withdrawRole(Role.PROPOSER);
        vm.prank(challenger); registry.withdrawRole(Role.CHALLENGER);
    }

    function test_creationChallengeUpheld() public {
        uint256 id = _create(100);
        vm.prank(challenger); uint256 dispute = resolution.challengeCreation(id, 1, EVIDENCE);
        _round(dispute, 1, 1); _finalize(dispute);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.CANCELLED));
        eq(markets.openPayoutTotal(), 0); eq(markets.finalizedCount(), 0);
        eq(markets.getMarket(id).creationBond, 0);
        vm.prank(creator); registry.requestRoleExit(Role.CREATOR);
        vm.warp(token.clock() + 7 days);
        vm.prank(j1); jurors.claimRewards(); vm.prank(j2); jurors.claimRewards();
        vm.prank(creator); registry.withdrawRole(Role.CREATOR);
    }

    function test_timeoutInvalid() public {
        uint256 id = _create(100); _open(id);
        _fill(id, MAKER_KEY, taker, 0, 10);
        vm.warp(markets.getMarket(id).hardDeadline - 1);
        vm.expectRevert(BlinkResolution.DeadlineViolation.selector); resolution.finalizeTimeout(id);
        vm.warp(markets.getMarket(id).hardDeadline); resolution.finalizeTimeout(id);
        uint256 before = busd.balanceOf(taker);
        vm.prank(taker); markets.redeem(id);
        eq(busd.balanceOf(taker) - before, 5e6);
        vm.prank(maker); markets.redeem(id);
        eq(markets.getMarket(id).escrowMicros, 0);
        eq(uint256(markets.getMarket(id).finalOutcome), uint256(Outcome.INVALID));
    }

    function test_creatorFinalAfterCreationDisputeTimeout() public {
        uint256 id = _create(100);
        vm.prank(challenger); uint256 dispute = resolution.challengeCreation(id, 1, EVIDENCE);
        _commit(dispute, j1, 1);
        uint256 before = busd.balanceOf(creator);
        vm.warp(markets.getMarket(id).hardDeadline); resolution.finalizeTimeout(id);
        resolution.settleVote(dispute, 0, j1);
        eq(jurors.openVotes(j1), 0);
        _creatorFinal(id, Outcome.INVALID, before, 0);
        vm.prank(challenger); registry.requestRoleExit(Role.CHALLENGER);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(challenger); registry.withdrawRole(Role.CHALLENGER);
    }

    function test_creatorFinalAfterRejectedCreationDispute() public {
        uint256 id = _create(100);
        vm.prank(challenger); uint256 dispute = resolution.challengeCreation(id, 1, EVIDENCE);
        _round(dispute, 0, 0); _finalize(dispute);
        resolution.settleVote(dispute, 0, j1); resolution.settleVote(dispute, 0, j2);
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.OPEN));
        uint256 before = busd.balanceOf(creator);
        _unchallenged(id);
        _creatorFinal(id, Outcome.YES, before, 2);
    }

    function test_generationTwoImportsCredit() public {
        uint256 id = _create(200); _open(id); _unchallenged(id);
        (BlinkRegistry next,,,) = deployGeneration(p, address(registry));
        BlinkGovernor gov = new BlinkGovernor(token, 1 days, 3 days, 10e18, 4, 2 days);
        vm.prank(creator); token.delegate(creator);
        vm.warp(token.clock() + 1);
        address[] memory targets = new address[](1); targets[0] = address(gov);
        uint256[] memory values = new uint256[](1);
        bytes[] memory calls = new bytes[](1); calls[0] = abi.encodeCall(gov.adoptSuccessor, (address(next)));
        vm.prank(creator); uint256 proposal = gov.propose(targets, values, calls, "adopt real generation two");
        vm.warp(gov.proposalSnapshot(proposal) + 1);
        vm.prank(creator); gov.castVote(proposal, 1);
        vm.warp(gov.proposalDeadline(proposal) + 1);
        gov.execute(targets, values, calls, keccak256("adopt real generation two"));
        require(gov.successor() == address(0), "adoption delay");
        vm.warp(gov.successorEffectiveAt());
        require(gov.successor() == address(next), "governance adopted real registry");
        uint256 before = busd.balanceOf(creator);
        vm.prank(creator); next.register();
        vm.prank(creator); next.importCredit();
        eq(busd.balanceOf(creator), before);
        eq(next.creditOf(creator, Role.CREATOR), registry.creditOf(creator, Role.CREATOR) * p.importDiscountBps / 10000);
        eq(next.creditOf(creator, Role.CREATOR), 1);
        vm.expectRevert(BlinkRegistry.AlreadyImported.selector);
        vm.prank(creator); next.importCredit();
    }
}
