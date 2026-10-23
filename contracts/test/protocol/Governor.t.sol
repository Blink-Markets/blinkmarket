// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkGovernor} from "../../src/protocol/BlinkGovernor.sol";
import {IGovernor} from "@openzeppelin/contracts/governance/IGovernor.sol";

contract GovernorTest is ProtocolBase {
    uint48 private constant VOTING_DELAY = 1 days;
    uint32 private constant VOTING_PERIOD = 3 days;
    uint256 private constant THRESHOLD = 10e18;
    uint256 private constant QUORUM_PERCENT = 4;
    uint64 private constant ADOPTION_DELAY = 2 days;
    uint8 private constant VOTE_FOR = 1;

    BlinkGovernor internal gov;
    address internal alice;
    address internal bob;
    address internal gen2;
    address internal gen3;
    address internal markets;

    function setUp() public override {
        super.setUp();
        gov = new BlinkGovernor(token, VOTING_DELAY, VOTING_PERIOD, THRESHOLD, QUORUM_PERCENT, ADOPTION_DELAY);
        alice = actor("alice");
        bob = actor("bob");
        gen2 = actor("registry-gen2");
        gen3 = actor("registry-gen3");
        markets = actor("markets");
        claimAs(alice);
        claimAs(bob);
        vm.prank(alice);
        token.delegate(alice);
        vm.prank(bob);
        token.delegate(bob);
        vm.warp(token.clock() + 1); // delegation checkpoints become readable one second later
    }

    function _one(address target, bytes memory data)
        internal
        pure
        returns (address[] memory t, uint256[] memory v, bytes[] memory c)
    {
        t = new address[](1);
        t[0] = target;
        v = new uint256[](1);
        c = new bytes[](1);
        c[0] = data;
    }

    function _adoptCall(address registry) internal pure returns (bytes memory) {
        return abi.encodeCall(BlinkGovernor.adoptSuccessor, (registry));
    }

    function _proposeAdopt(address registry, string memory desc) internal returns (uint256 id) {
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(address(gov), _adoptCall(registry));
        vm.prank(alice);
        id = gov.propose(t, v, c, desc);
    }

    function _voteAndExecute(uint256 id, address registry, string memory desc) internal {
        vm.warp(gov.proposalSnapshot(id) + 1);
        vm.prank(alice);
        gov.castVote(id, VOTE_FOR);
        vm.warp(gov.proposalDeadline(id) + 1);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(address(gov), _adoptCall(registry));
        gov.execute(t, v, c, keccak256(bytes(desc)));
    }

    function _expectOnlySuccessor(address[] memory t, uint256[] memory v, bytes[] memory c) internal {
        vm.expectRevert(BlinkGovernor.OnlySuccessorProposals.selector);
        vm.prank(alice);
        gov.propose(t, v, c, "not allowed");
    }

    function test_adoptSuccessorAfterVoteAndDelay() public {
        eq(uint256(uint160(gov.successor())), 0);
        uint256 id = _proposeAdopt(gen2, "adopt gen2");
        _voteAndExecute(id, gen2, "adopt gen2");

        uint64 effectiveAt = gov.successorEffectiveAt();
        eq(effectiveAt, gov.adoptionDelay() + gov.proposalDeadline(id) + 1);
        require(gov.pendingSuccessor() == gen2, "pending");
        require(gov.successor() == address(0), "old value until the delay passes");

        vm.warp(effectiveAt - 1);
        require(gov.successor() == address(0), "still old one second early");
        vm.warp(effectiveAt);
        require(gov.successor() == gen2, "gen2 after the delay");
    }

    function test_secondAdoptionKeepsPreviousUntilItsOwnDelay() public {
        uint256 id = _proposeAdopt(gen2, "adopt gen2");
        _voteAndExecute(id, gen2, "adopt gen2");
        vm.warp(gov.successorEffectiveAt());
        require(gov.successor() == gen2, "gen2 effective");

        uint256 id3 = _proposeAdopt(gen3, "adopt gen3");
        _voteAndExecute(id3, gen3, "adopt gen3");
        require(gov.successor() == gen2, "gen2 stays until gen3's delay passes");
        vm.warp(gov.successorEffectiveAt());
        require(gov.successor() == gen3, "gen3 after its delay");
    }

    function test_pendingAdoptionCanBeReplacedBeforeItTakesEffect() public {
        // a vote takes 4 days, so only a delay longer than that leaves gen2 pending when gen3 passes
        gov = new BlinkGovernor(token, VOTING_DELAY, VOTING_PERIOD, THRESHOLD, QUORUM_PERCENT, 10 days);
        uint256 id = _proposeAdopt(gen2, "adopt gen2");
        _voteAndExecute(id, gen2, "adopt gen2");
        uint256 id3 = _proposeAdopt(gen3, "adopt gen3"); // gen2 has not become effective yet
        _voteAndExecute(id3, gen3, "adopt gen3");
        require(gov.successor() == address(0), "neither effective yet");
        vm.warp(gov.successorEffectiveAt());
        require(gov.successor() == gen3, "gen2 was replaced, never effective");
    }

    function test_adoptRejectsZeroAddress() public {
        uint256 id = _proposeAdopt(address(0), "adopt nothing");
        vm.warp(gov.proposalSnapshot(id) + 1);
        vm.prank(alice);
        gov.castVote(id, VOTE_FOR);
        vm.warp(gov.proposalDeadline(id) + 1);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(address(gov), _adoptCall(address(0)));
        vm.expectRevert(BlinkGovernor.InvalidSuccessor.selector);
        gov.execute(t, v, c, keccak256(bytes("adopt nothing")));
    }

    function test_cannotProposeOtherActions() public {
        bytes memory transferCall = abi.encodeCall(token.transfer, (bob, 1));
        bytes memory otherCall = abi.encodeWithSignature("createMarket(uint64)", 1);
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(address(token), transferCall);
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(markets, otherCall);
        _expectOnlySuccessor(t, v, c);

        // the adoptSuccessor selector aimed at any other target
        (t, v, c) = _one(address(token), _adoptCall(gen2));
        _expectOnlySuccessor(t, v, c);

        // the governor's own settings and non-adoptSuccessor selectors
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.setVotingDelay, (0)));
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.setVotingPeriod, (1)));
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.setProposalThreshold, (0)));
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.updateQuorumNumerator, (1)));
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.cancel, (t, v, c, bytes32(0))));
        _expectOnlySuccessor(t, v, c);

        // calldata with no selector at all (would hit the receive function) or a truncated one
        (t, v, c) = _one(address(gov), "");
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), hex"aabbcc");
        _expectOnlySuccessor(t, v, c);

        _mixedProposalsRevert(transferCall);
    }

    function _mixedProposalsRevert(bytes memory transferCall) private {
        address[] memory t = new address[](2);
        uint256[] memory v = new uint256[](2);
        bytes[] memory c = new bytes[](2);
        t[0] = address(gov);
        c[0] = _adoptCall(gen2);

        t[1] = address(token); // adoptSuccessor plus a token call
        c[1] = transferCall;
        _expectOnlySuccessor(t, v, c);

        t[1] = address(gov); // adoptSuccessor plus a settings change on the governor
        c[1] = abi.encodeCall(gov.setVotingDelay, (0));
        _expectOnlySuccessor(t, v, c);

        t[0] = address(gov); // order does not matter
        c[0] = abi.encodeCall(gov.setVotingDelay, (0));
        c[1] = _adoptCall(gen2);
        _expectOnlySuccessor(t, v, c);
    }

    function test_relayCannotBypassRestriction() public {
        bytes memory relayToken = abi.encodeCall(gov.relay, (address(token), 0, abi.encodeCall(token.transfer, (bob, 1))));
        bytes memory relayGov = abi.encodeCall(gov.relay, (address(gov), 0, abi.encodeCall(gov.setVotingDelay, (0))));

        // not callable by anyone outside an executed proposal
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, alice));
        vm.prank(alice);
        gov.relay(address(token), 0, "");
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, alice));
        vm.prank(alice);
        gov.setVotingDelay(0);
        vm.expectRevert(abi.encodeWithSelector(IGovernor.GovernorOnlyExecutor.selector, alice));
        vm.prank(alice);
        gov.adoptSuccessor(gen2);

        // and a proposal cannot carry relay, so it is never reachable through execution either
        (address[] memory t, uint256[] memory v, bytes[] memory c) = _one(address(gov), relayToken);
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), relayGov);
        _expectOnlySuccessor(t, v, c);
        (t, v, c) = _one(address(gov), abi.encodeCall(gov.relay, (address(gov), 0, _adoptCall(gen2))));
        _expectOnlySuccessor(t, v, c);
    }

    function test_votesUseSnapshot() public {
        uint256 id = _proposeAdopt(gen2, "adopt gen2");
        uint256 snapshot = gov.proposalSnapshot(id);
        vm.warp(snapshot + 1);
        address carol = actor("carol");
        address dave = actor("dave");

        // after the snapshot: alice moves everything to carol, dave mints fresh tokens
        vm.prank(alice);
        token.transfer(carol, 1_000e18);
        vm.prank(carol);
        token.delegate(carol);
        claimAs(dave);
        vm.prank(dave);
        token.delegate(dave);
        vm.warp(token.clock() + 1);

        eq(gov.getVotes(carol, snapshot), 0);
        eq(gov.getVotes(dave, snapshot), 0);
        eq(gov.getVotes(alice, snapshot), 1_000e18);
        eq(gov.quorum(snapshot), 2_000e18 * QUORUM_PERCENT / 100); // dave's mint does not raise it

        vm.prank(carol);
        gov.castVote(id, VOTE_FOR);
        vm.prank(dave);
        gov.castVote(id, VOTE_FOR);
        (, uint256 forVotes,) = gov.proposalVotes(id);
        eq(forVotes, 0);
        vm.prank(alice);
        gov.castVote(id, VOTE_FOR);
        (, forVotes,) = gov.proposalVotes(id);
        eq(forVotes, 1_000e18);
    }

    function test_constructorRequiresBaseSepolia() public {
        vm.chainId(1);
        vm.expectRevert(BlinkGovernor.WrongChain.selector);
        new BlinkGovernor(token, VOTING_DELAY, VOTING_PERIOD, THRESHOLD, QUORUM_PERCENT, ADOPTION_DELAY);
    }
}
