// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {IBlinkRegistry} from "../../src/protocol/interfaces/IBlinkRegistry.sol";
import {Role, Params, GenerationAddresses} from "../../src/protocol/BlinkTypes.sol";

// Stand-in for the jurors, markets and resolution slots: an authorized reporter that also answers finalizedCount().
contract StubReporter {
    uint256 public finalizedCount;

    function setFinalizedCount(uint256 n) external {
        finalizedCount = n;
    }

    function gain(IBlinkRegistry r, address who, Role role, uint256 maxPayout) external {
        r.reportGain(who, role, maxPayout);
    }

    function loss(IBlinkRegistry r, address who, Role role, uint256 maxPayout) external {
        r.reportLoss(who, role, maxPayout);
    }

    function slash(IBlinkRegistry r, address who, Role role) external returns (uint256) {
        return r.slashRole(who, role);
    }

    function lock(IBlinkRegistry r, address who, Role role) external {
        r.lockRole(who, role);
    }

    function unlock(IBlinkRegistry r, address who, Role role) external {
        r.unlockRole(who, role);
    }
}

contract RegistryTest is ProtocolBase {
    struct Gen {
        BlinkRegistry registry;
        StubReporter jurors;
        StubReporter markets;
        StubReporter resolution;
    }

    BlinkRegistry internal registry;
    StubReporter internal jurors;
    StubReporter internal markets;
    StubReporter internal resolution;
    address internal alice;
    address internal bob;

    function setUp() public override {
        super.setUp();
        Gen memory g = _deploy(defaultParams(), address(0));
        registry = g.registry;
        jurors = g.jurors;
        markets = g.markets;
        resolution = g.resolution;
        alice = fundedActor("alice");
        bob = fundedActor("bob");
        approveBusdAs(alice, address(registry));
        approveBusdAs(bob, address(registry));
    }

    function _deploy(Params memory p, address previous) internal returns (Gen memory g) {
        GenerationAddresses memory a = predictGeneration(address(this), previous);
        g.registry = new BlinkRegistry(p, a);
        g.jurors = new StubReporter();
        g.markets = new StubReporter();
        g.resolution = new StubReporter();
        require(address(g.jurors) == a.jurors && address(g.markets) == a.markets, "slot");
        require(address(g.resolution) == a.resolution, "slot");
    }

    function _register(address who) internal {
        vm.prank(who);
        registry.register();
    }

    function _join(address who, Role role, uint256 amount) internal {
        vm.prank(who);
        registry.joinRole(role, amount);
    }

    function test_generationWiringRejectsWrongSelf() public {
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        a.registry = actor("elsewhere");
        Params memory p = defaultParams();
        vm.expectRevert(BlinkRegistry.WrongAddress.selector);
        new BlinkRegistry(p, a);

        GenerationAddresses memory w = registry.addresses();
        require(w.registry == address(registry), "registry");
        require(w.jurors == address(jurors), "jurors");
        require(w.markets == address(markets), "markets");
        require(w.resolution == address(resolution), "resolution");
        require(w.collateral == address(busd) && w.token == address(token), "tokens");
        require(w.priceSource == address(priceSource) && w.treasury == treasury, "pre-existing");
        require(w.previousRegistry == address(0), "previous");
    }

    function test_constructorRejectsZeroAddressesAndWrongChain() public {
        Params memory p = defaultParams();
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        a.treasury = address(0);
        vm.expectRevert(BlinkRegistry.InvalidAddress.selector);
        new BlinkRegistry(p, a);

        a = predictGeneration(address(this), address(0));
        a.markets = address(0);
        vm.expectRevert(BlinkRegistry.InvalidAddress.selector);
        new BlinkRegistry(p, a);

        a = predictGeneration(address(this), address(0));
        a.token = address(0);
        vm.expectRevert(BlinkRegistry.InvalidAddress.selector);
        new BlinkRegistry(p, a);

        a = predictGeneration(address(this), address(0));
        a.priceSource = address(0);
        vm.expectRevert(BlinkRegistry.InvalidAddress.selector);
        new BlinkRegistry(p, a);

        a = predictGeneration(address(this), address(0));
        a.previousRegistry = actor("not a contract");
        vm.expectRevert(BlinkRegistry.InvalidAddress.selector);
        new BlinkRegistry(p, a);

        a = predictGeneration(address(this), address(0));
        vm.chainId(1);
        vm.expectRevert(BlinkRegistry.WrongChain.selector);
        new BlinkRegistry(p, a);
    }

    function test_constructorRejectsInvalidParams() public {
        Params memory p = defaultParams();
        p.bountyShareBps += 1;
        _expectInvalid(p);

        p = defaultParams();
        p.maxRounds = 5;
        _expectInvalid(p);

        p = defaultParams();
        p.creditHalfLife = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.creditUnitMicros = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.maxCreditMultiplierBps = 9_999;
        _expectInvalid(p);

        p = defaultParams();
        p.roleSlashBps = 10_001;
        _expectInvalid(p);

        p = defaultParams();
        p.maxCreditDiscountBps = 10_001;
        _expectInvalid(p);

        p = defaultParams();
        p.importDiscountBps = 10_001;
        _expectInvalid(p);

        p = defaultParams();
        p.quorumBps[3] = 10_001;
        _expectInvalid(p);

        p = defaultParams();
        p.maxRounds = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.creationBondBps = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.proposerBondBps = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.challengeBondBps = 0;
        _expectInvalid(p);

        p = defaultParams();
        p.securityMultipleBps = 0;
        _expectInvalid(p);

        for (uint256 i; i < 3; ++i) {
            p = defaultParams();
            p.minResultChallengeWindow[i] = p.resultChallengeWindow[i] + 1;
            _expectInvalid(p);
        }

        p = defaultParams();
        p.minResultChallengeWindow = p.resultChallengeWindow; // equal is allowed
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        new BlinkRegistry(p, a);
    }

    function _expectInvalid(Params memory p) internal {
        GenerationAddresses memory a = predictGeneration(address(this), address(0));
        vm.expectRevert(BlinkRegistry.InvalidParams.selector);
        new BlinkRegistry(p, a);
    }

    function test_paramsAreStoredAsDeployed() public view {
        Params memory p = registry.params();
        Params memory d = defaultParams();
        eq(p.registrationFee, d.registrationFee);
        eq(p.creditHalfLife, d.creditHalfLife);
        eq(p.quorumBps[3], d.quorumBps[3]);
        eq(p.resultChallengeWindow[2], d.resultChallengeWindow[2]);
        eq(p.roundCreditThreshold[3], d.roundCreditThreshold[3]);
        require(p.replayAllowed, "replay");
    }

    function test_registrationFeeGoesToTreasuryAndIsFinal() public {
        uint256 fee = registry.params().registrationFee;
        uint256 treasuryBefore = busd.balanceOf(treasury);
        uint256 aliceBefore = busd.balanceOf(alice);
        require(!registry.isRegistered(alice), "not yet");
        _register(alice);
        require(registry.isRegistered(alice), "registered");
        eq(busd.balanceOf(treasury), treasuryBefore + fee);
        eq(busd.balanceOf(alice), aliceBefore - fee);
        eq(busd.balanceOf(address(registry)), 0); // nothing held that could be returned

        vm.expectRevert(BlinkRegistry.AlreadyRegistered.selector);
        _register(alice);
        eq(busd.balanceOf(treasury), treasuryBefore + fee);
    }

    function test_roleStakeExitCooldown() public {
        uint256 minStake = registry.params().minRoleStake;
        uint256 cooldown = registry.params().roleExitCooldown;

        vm.expectRevert(BlinkRegistry.NotRegistered.selector);
        _join(alice, Role.PROPOSER, minStake);

        _register(alice);
        vm.expectRevert(BlinkRegistry.StakeTooLow.selector);
        _join(alice, Role.PROPOSER, minStake - 1);

        uint256 before = busd.balanceOf(alice);
        _join(alice, Role.PROPOSER, minStake);
        require(registry.hasRole(alice, Role.PROPOSER), "active");
        require(!registry.hasRole(alice, Role.CHALLENGER), "other role");
        eq(registry.roleStake(alice, Role.PROPOSER), minStake);
        eq(busd.balanceOf(alice), before - minStake);
        eq(busd.balanceOf(address(registry)), minStake);

        uint256 t0 = token.clock();
        vm.prank(alice);
        registry.requestRoleExit(Role.PROPOSER);
        require(!registry.hasRole(alice, Role.PROPOSER), "in exit cannot act");
        eq(registry.roleStake(alice, Role.PROPOSER), minStake);

        vm.expectRevert(BlinkRegistry.CooldownActive.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.PROPOSER);

        vm.warp(t0 + cooldown - 1);
        vm.expectRevert(BlinkRegistry.CooldownActive.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.PROPOSER);

        vm.warp(t0 + cooldown);
        vm.prank(alice);
        registry.withdrawRole(Role.PROPOSER);
        eq(busd.balanceOf(alice), before);
        eq(busd.balanceOf(address(registry)), 0);
        eq(registry.roleStake(alice, Role.PROPOSER), 0);
        require(!registry.hasRole(alice, Role.PROPOSER), "gone");
    }

    function test_roleInExitCannotTopUpRejoinOrReExit() public {
        _register(alice);
        _join(alice, Role.MAKER, 100e6);

        vm.expectRevert(BlinkRegistry.RoleAlreadyJoined.selector);
        _join(alice, Role.MAKER, 100e6);
        vm.expectRevert(BlinkRegistry.NotExiting.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.MAKER);

        vm.prank(alice);
        registry.addRoleStake(Role.MAKER, 50e6);
        eq(registry.roleStake(alice, Role.MAKER), 150e6);
        vm.expectRevert(BlinkRegistry.InvalidAmount.selector);
        vm.prank(alice);
        registry.addRoleStake(Role.MAKER, 0);
        vm.expectRevert(BlinkRegistry.RoleNotActive.selector);
        vm.prank(alice);
        registry.addRoleStake(Role.TAKER, 1);

        vm.prank(alice);
        registry.requestRoleExit(Role.MAKER);
        vm.expectRevert(BlinkRegistry.RoleNotActive.selector);
        vm.prank(alice);
        registry.addRoleStake(Role.MAKER, 1);
        vm.expectRevert(BlinkRegistry.RoleNotActive.selector);
        vm.prank(alice);
        registry.requestRoleExit(Role.MAKER);
        vm.expectRevert(BlinkRegistry.RoleAlreadyJoined.selector);
        _join(alice, Role.MAKER, 100e6);

        vm.warp(token.clock() + registry.params().roleExitCooldown);
        vm.prank(alice);
        registry.withdrawRole(Role.MAKER);
        _join(alice, Role.MAKER, 100e6); // a withdrawn role can be joined again
        require(registry.hasRole(alice, Role.MAKER), "rejoined");
    }

    function test_jurorRoleUsesTokenNotBusd() public {
        require(!registry.hasRole(alice, Role.JUROR), "unregistered");
        _register(alice);
        require(registry.hasRole(alice, Role.JUROR), "registration is enough");
        eq(registry.roleStake(alice, Role.JUROR), 0);

        vm.expectRevert(BlinkRegistry.JurorUsesToken.selector);
        _join(alice, Role.JUROR, 100e6);
        vm.expectRevert(BlinkRegistry.JurorUsesToken.selector);
        vm.prank(alice);
        registry.addRoleStake(Role.JUROR, 1);
        vm.expectRevert(BlinkRegistry.JurorUsesToken.selector);
        vm.prank(alice);
        registry.requestRoleExit(Role.JUROR);
        vm.expectRevert(BlinkRegistry.JurorUsesToken.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.JUROR);
    }

    function test_onlyReportersChangeCredit() public {
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        vm.prank(alice);
        registry.reportGain(alice, Role.CREATOR, 1_000e6);
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        vm.prank(alice);
        registry.reportLoss(alice, Role.CREATOR, 1_000e6);
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        vm.prank(alice);
        registry.slashRole(alice, Role.CREATOR);
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        vm.prank(alice);
        registry.lockRole(alice, Role.CREATOR);
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        vm.prank(alice);
        registry.unlockRole(alice, Role.CREATOR);

        StubReporter stranger = new StubReporter(); // a contract from outside the generation
        IBlinkRegistry r = registry;
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        stranger.gain(r, alice, Role.CREATOR, 1_000e6);
        vm.expectRevert(BlinkRegistry.UnauthorizedReporter.selector);
        stranger.lock(r, alice, Role.CREATOR);

        markets.gain(r, alice, Role.CREATOR, 1_000e6);
        resolution.gain(r, alice, Role.PROPOSER, 1_000e6);
        jurors.gain(r, alice, Role.JUROR, 1_000e6);
        eq(registry.creditOf(alice, Role.CREATOR), 10);
        eq(registry.creditOf(alice, Role.PROPOSER), 10);
        eq(registry.creditOf(alice, Role.JUROR), 10);
        eq(registry.creditOf(alice, Role.MAKER), 0);
    }

    // Oracle vectors for tests/protocol-reducer.test.ts; uses real registry storage and creditOf.
    // Zero-decayed losses must leave the event-reconstructed credit clock intact.
    function test_indexerZeroDecayedLossLeavesClockUnchanged() public {
        uint256 half = registry.params().creditHalfLife;
        markets.gain(registry, alice, Role.CREATOR, 100e6);
        markets.gain(registry, bob, Role.CREATOR, 100e6);
        uint256 t0 = token.clock();
        vm.warp(t0 + half);
        markets.loss(registry, bob, Role.CREATOR, 100e6);
        vm.warp(t0 + half * 3 / 2);
        markets.gain(registry, alice, Role.CREATOR, 100e6);
        markets.gain(registry, bob, Role.CREATOR, 100e6);
        eq(registry.creditOf(alice, Role.CREATOR), 1);
        eq(registry.creditOf(bob, Role.CREATOR), 1);
        vm.warp(t0 + half * 2);
        eq(registry.creditOf(alice, Role.CREATOR), 0);
        eq(registry.creditOf(bob, Role.CREATOR), registry.creditOf(alice, Role.CREATOR));
    }

    function test_indexerZeroDecayedLossWritesNothingAndEmitsNothing() public {
        markets.gain(registry, bob, Role.CREATOR, 100e6);
        vm.warp(token.clock() + registry.params().creditHalfLife);
        vm.record();
        vm.recordLogs();
        markets.loss(registry, bob, Role.CREATOR, 100e6);
        (, bytes32[] memory writes) = vm.accesses(address(registry));
        eq(writes.length, 0);
        eq(vm.getRecordedLogs().length, 0);
    }

    function test_indexerCreditDecayVectors() public {
        markets.gain(registry, alice, Role.CREATOR, 5_000e6);
        markets.gain(registry, alice, Role.CREATOR, 5_000e6);
        uint256 t0 = token.clock();
        uint256 half = registry.params().creditHalfLife;
        eq(registry.creditOf(alice, Role.CREATOR), 100);
        vm.warp(t0 + half);
        eq(registry.creditOf(alice, Role.CREATOR), 50);
        vm.warp(t0 + half * 5 / 2);
        eq(registry.creditOf(alice, Role.CREATOR), 25);
        vm.warp(t0 + half * 40);
        eq(registry.creditOf(alice, Role.CREATOR), 0);
    }

    function test_creditGainLossAndDecay() public {
        IBlinkRegistry r = registry;
        uint256 half = registry.params().creditHalfLife;
        eq(registry.params().creditUnitMicros, 100e6);
        eq(registry.params().creditGainCap, 50);
        eq(registry.params().creditLossMultiplier, 3);

        markets.gain(r, alice, Role.CREATOR, 1_000e6);
        eq(registry.creditOf(alice, Role.CREATOR), 10);
        resolution.loss(r, alice, Role.CREATOR, 1_000e6); // 30 > 10: floored, not negative
        eq(registry.creditOf(alice, Role.CREATOR), 0);

        markets.gain(r, alice, Role.CREATOR, 100_000e6); // 1000 units, capped at 50
        eq(registry.creditOf(alice, Role.CREATOR), 50);
        resolution.loss(r, alice, Role.CREATOR, 100e6); // 1 unit * 3
        eq(registry.creditOf(alice, Role.CREATOR), 47);
        markets.gain(r, alice, Role.CREATOR, 99e6); // below one unit: no credit
        eq(registry.creditOf(alice, Role.CREATOR), 47);

        resolution.loss(r, alice, Role.CREATOR, 100_000e6); // capped unit 50 * 3 = 150
        eq(registry.creditOf(alice, Role.CREATOR), 0);
        markets.gain(r, alice, Role.CREATOR, 4_000e6);
        eq(registry.creditOf(alice, Role.CREATOR), 40);

        uint256 t0 = token.clock();
        vm.warp(t0 + half - 1);
        eq(registry.creditOf(alice, Role.CREATOR), 40);
        vm.warp(t0 + half);
        eq(registry.creditOf(alice, Role.CREATOR), 20);
        vm.warp(t0 + 2 * half);
        eq(registry.creditOf(alice, Role.CREATOR), 10);
        vm.warp(t0 + 40 * half);
        eq(registry.creditOf(alice, Role.CREATOR), 0);

        // roles do not share credit
        eq(registry.creditOf(alice, Role.PROPOSER), 0);
        eq(registry.creditOf(bob, Role.CREATOR), 0);
    }

    function test_decayKeepsThePartialPeriod() public {
        IBlinkRegistry r = registry;
        uint256 half = registry.params().creditHalfLife;
        markets.gain(r, alice, Role.CREATOR, 4_000e6);
        uint256 t0 = token.clock();

        vm.warp(t0 + half + half / 2);
        eq(registry.creditOf(alice, Role.CREATOR), 20);
        markets.gain(r, alice, Role.CREATOR, 100e6); // materialises 40 -> 20, then +1
        eq(registry.creditOf(alice, Role.CREATOR), 21);

        vm.warp(t0 + 2 * half); // one period after the materialised point, not after the write
        eq(registry.creditOf(alice, Role.CREATOR), 10);
    }

    function test_bondDiscountHasFloor() public {
        IBlinkRegistry r = registry;
        uint256 base = 1_000e6;
        eq(registry.bondFor(alice, Role.PROPOSER, base), base);

        resolution.gain(r, alice, Role.PROPOSER, 1_000e6); // credit 10 -> 10% off
        eq(registry.bondFor(alice, Role.PROPOSER, base), 900e6);
        eq(registry.bondFor(alice, Role.CHALLENGER, base), base); // other role, no discount

        resolution.gain(r, alice, Role.PROPOSER, 100_000e6);
        eq(registry.creditOf(alice, Role.PROPOSER), 60);
        eq(registry.bondFor(alice, Role.PROPOSER, base), 500e6); // 60% requested, floor at 50%
        resolution.gain(r, alice, Role.PROPOSER, 100_000e6);
        eq(registry.bondFor(alice, Role.PROPOSER, base), 500e6);
        eq(registry.bondFor(alice, Role.PROPOSER, 3), 2); // rounds up, never under half
    }

    function test_bondNeverBelowFloorFuzz(uint128 base, uint8 gains) public {
        for (uint256 i; i < gains % 6; ++i) {
            resolution.gain(registry, alice, Role.CREATOR, 100_000e6);
        }
        uint256 bond = registry.bondFor(alice, Role.CREATOR, base);
        require(bond <= base, "never above base");
        require(bond * 2 >= base, "never below the floor");
    }

    function test_limitMultiplier() public {
        IBlinkRegistry r = registry;
        eq(registry.limitMultiplierBps(alice, Role.CREATOR), 10_000);
        markets.gain(r, alice, Role.CREATOR, 1_000e6); // credit 10, +500 bps each
        eq(registry.limitMultiplierBps(alice, Role.CREATOR), 15_000);
        eq(registry.limitMultiplierBps(alice, Role.MAKER), 10_000);
        markets.gain(r, alice, Role.CREATOR, 100_000e6);
        eq(registry.creditOf(alice, Role.CREATOR), 60);
        eq(registry.limitMultiplierBps(alice, Role.CREATOR), 40_000); // 10_000 + 60 * 500 lands exactly on the cap
        markets.gain(r, alice, Role.CREATOR, 100_000e6);
        eq(registry.limitMultiplierBps(alice, Role.CREATOR), 40_000);
    }

    function test_thresholdPhaseIn() public {
        IBlinkRegistry r = registry;
        eq(registry.params().phaseInFinalizedMarkets, 3);
        require(registry.meetsThreshold(alice, Role.JUROR, 10), "phase-in: open to zero credit");
        markets.setFinalizedCount(2);
        require(registry.meetsThreshold(alice, Role.JUROR, 10), "still phasing in");
        markets.setFinalizedCount(3);
        require(!registry.meetsThreshold(alice, Role.JUROR, 10), "closed after phase-in");
        require(registry.meetsThreshold(alice, Role.JUROR, 0), "zero threshold");

        jurors.gain(r, alice, Role.JUROR, 1_000e6); // credit 10
        require(registry.meetsThreshold(alice, Role.JUROR, 10), "meets");
        require(!registry.meetsThreshold(alice, Role.JUROR, 11), "does not meet");
        require(!registry.meetsThreshold(bob, Role.JUROR, 10), "other identity");
    }

    function test_slashRoleMovesStakeToTreasury() public {
        _register(alice);
        _join(alice, Role.PROPOSER, 100e6);
        uint256 treasuryBefore = busd.balanceOf(treasury);

        uint256 slashed = resolution.slash(registry, alice, Role.PROPOSER); // roleSlashBps = 10%
        eq(slashed, 10e6);
        eq(busd.balanceOf(treasury), treasuryBefore + 10e6);
        eq(registry.roleStake(alice, Role.PROPOSER), 90e6);
        eq(busd.balanceOf(address(registry)), 90e6);

        vm.prank(alice);
        registry.requestRoleExit(Role.PROPOSER);
        eq(markets.slash(registry, alice, Role.PROPOSER), 9e6); // still slashable during the cooldown
        eq(registry.roleStake(alice, Role.PROPOSER), 81e6);

        uint256 before = busd.balanceOf(alice);
        vm.warp(token.clock() + registry.params().roleExitCooldown);
        vm.prank(alice);
        registry.withdrawRole(Role.PROPOSER);
        eq(busd.balanceOf(alice), before + 81e6);
        eq(busd.balanceOf(address(registry)), 0);

        eq(jurors.slash(registry, alice, Role.PROPOSER), 0); // nothing left
        eq(jurors.slash(registry, alice, Role.JUROR), 0); // juror stake lives in the token
        eq(jurors.slash(registry, bob, Role.CREATOR), 0);
    }

    function test_slashedRoleIsInactiveUntilToppedUp() public {
        uint256 minStake = registry.params().minRoleStake;
        _register(alice);
        _join(alice, Role.PROPOSER, minStake);
        require(registry.hasRole(alice, Role.PROPOSER), "active at the minimum");

        uint256 slashed = resolution.slash(registry, alice, Role.PROPOSER);
        eq(slashed, minStake / 10);
        eq(registry.roleStake(alice, Role.PROPOSER), minStake - slashed);
        require(!registry.hasRole(alice, Role.PROPOSER), "below the minimum cannot act");

        vm.prank(alice);
        registry.addRoleStake(Role.PROPOSER, slashed - 1); // still one micro short
        require(!registry.hasRole(alice, Role.PROPOSER), "still short");
        vm.prank(alice);
        registry.addRoleStake(Role.PROPOSER, 1);
        eq(registry.roleStake(alice, Role.PROPOSER), minStake);
        require(registry.hasRole(alice, Role.PROPOSER), "topped up");

        // an exiting role is inactive whatever its stake, and a slash cannot revive it
        vm.prank(alice);
        registry.requestRoleExit(Role.PROPOSER);
        require(!registry.hasRole(alice, Role.PROPOSER), "exiting at the minimum");
        markets.slash(registry, alice, Role.PROPOSER);
        require(registry.roleStake(alice, Role.PROPOSER) < minStake, "slashed in exit");
        require(!registry.hasRole(alice, Role.PROPOSER), "exiting below the minimum");
    }

    function test_openObligationsBlockWithdrawal() public {
        IBlinkRegistry r = registry;
        _register(alice);
        _join(alice, Role.CREATOR, 100e6);

        vm.expectRevert(BlinkRegistry.NoObligation.selector);
        markets.unlock(r, alice, Role.CREATOR);

        markets.lock(r, alice, Role.CREATOR);
        resolution.lock(r, alice, Role.CREATOR); // counters stack across reporters
        require(registry.hasRole(alice, Role.CREATOR), "a lock does not deactivate the role");

        vm.prank(alice);
        registry.requestRoleExit(Role.CREATOR); // exit may be requested with obligations open
        vm.warp(token.clock() + registry.params().roleExitCooldown);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.CREATOR);

        eq(markets.slash(registry, alice, Role.CREATOR), 10e6); // the stake stays slashable meanwhile
        markets.unlock(r, alice, Role.CREATOR);
        vm.expectRevert(BlinkRegistry.OpenObligations.selector);
        vm.prank(alice);
        registry.withdrawRole(Role.CREATOR);

        uint256 before = busd.balanceOf(alice);
        resolution.unlock(r, alice, Role.CREATOR);
        vm.expectRevert(BlinkRegistry.NoObligation.selector);
        resolution.unlock(r, alice, Role.CREATOR);
        vm.prank(alice);
        registry.withdrawRole(Role.CREATOR);
        eq(busd.balanceOf(alice), before + 90e6);

        // locks are per (account, role)
        markets.lock(r, alice, Role.CREATOR);
        _join(alice, Role.MAKER, 100e6);
        vm.prank(alice);
        registry.requestRoleExit(Role.MAKER);
        vm.warp(token.clock() + registry.params().roleExitCooldown);
        vm.prank(alice);
        registry.withdrawRole(Role.MAKER);
    }

    function test_importFromPreviousGeneration() public {
        IBlinkRegistry r = registry;
        _register(alice);
        markets.gain(r, alice, Role.CREATOR, 4_000e6); // 40
        jurors.gain(r, alice, Role.JUROR, 2_000e6); // 20

        Gen memory g2 = _deploy(defaultParams(), address(registry));
        BlinkRegistry second = g2.registry;
        require(second.addresses().previousRegistry == address(registry), "previous");
        approveBusdAs(alice, address(second));
        approveBusdAs(bob, address(second));
        uint256 fee = second.params().registrationFee;

        uint256 aliceBefore = busd.balanceOf(alice);
        vm.prank(alice);
        second.register(); // already registered in the previous generation: free
        eq(busd.balanceOf(alice), aliceBefore);
        require(second.isRegistered(alice), "registered");

        uint256 bobBefore = busd.balanceOf(bob);
        vm.prank(bob);
        second.register(); // new identity pays
        eq(busd.balanceOf(bob), bobBefore - fee);

        eq(second.creditOf(alice, Role.CREATOR), 0); // nothing until imported
        vm.prank(alice);
        second.importCredit();
        eq(second.creditOf(alice, Role.CREATOR), 20); // importDiscountBps = 50%
        eq(second.creditOf(alice, Role.JUROR), 10);
        eq(second.creditOf(alice, Role.PROPOSER), 0);
        eq(registry.creditOf(alice, Role.CREATOR), 40); // the previous generation is only read

        vm.expectRevert(BlinkRegistry.AlreadyImported.selector);
        vm.prank(alice);
        second.importCredit();

        vm.prank(bob);
        second.importCredit(); // nothing to bring, but it is flagged and cannot be repeated
        eq(second.creditOf(bob, Role.CREATOR), 0);
        vm.expectRevert(BlinkRegistry.AlreadyImported.selector);
        vm.prank(bob);
        second.importCredit();
    }

    function test_importRequiresPreviousGenerationAndRegistration() public {
        _register(alice);
        vm.expectRevert(BlinkRegistry.NothingToImport.selector);
        vm.prank(alice);
        registry.importCredit();

        Gen memory g2 = _deploy(defaultParams(), address(registry));
        vm.expectRevert(BlinkRegistry.NotRegistered.selector);
        vm.prank(alice);
        g2.registry.importCredit();
    }

    function test_importUsesDecayedCreditAndKeepsEarnedCredit() public {
        IBlinkRegistry r = registry;
        _register(alice);
        markets.gain(r, alice, Role.CREATOR, 4_000e6); // 40
        vm.warp(token.clock() + registry.params().creditHalfLife); // previous credit is now 20

        Gen memory g2 = _deploy(defaultParams(), address(registry));
        g2.markets.gain(g2.registry, alice, Role.CREATOR, 1_000e6); // earned 10 here first
        approveBusdAs(alice, address(g2.registry));
        vm.prank(alice);
        g2.registry.register();
        vm.prank(alice);
        g2.registry.importCredit();
        eq(g2.registry.creditOf(alice, Role.CREATOR), 20); // 10 earned + 20 * 50%
    }
}
