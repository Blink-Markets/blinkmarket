// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolScenario} from "./Lifecycle.t.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {IBlinkResolution} from "../../src/protocol/interfaces/IBlinkResolution.sol";
import {Role, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";

contract ProtocolHandler is ProtocolScenario {
    uint256 public count;
    uint256 public successfulCreates;
    uint256 public successfulUnstakes;
    mapping(uint256 => uint256) public escrow;
    mapping(uint256 => uint256) public fees;
    mapping(uint256 => uint256) public creationBonds;
    mapping(uint256 => uint256) public resolutionBonds;
    mapping(address => uint256) public free;
    mapping(uint256 => mapping(address => uint256)) public yes;
    mapping(uint256 => mapping(address => uint256)) public no;
    mapping(uint256 => uint256) public disputeOf;
    mapping(uint256 => bool) public creationDispute;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public committed;
    mapping(uint256 => mapping(uint256 => mapping(address => bool))) public revealed;
    mapping(uint256 => mapping(uint256 => mapping(address => uint8))) public choices;
    mapping(uint256 => uint256) public challengeEnd;
    uint256 public appeals;
    uint256 public redemptions;
    uint256 public voteSettlements;
    mapping(uint256 => uint256) public finalizedAt;
    bool public securityViolation;

    function setUp() public override {
        super.setUp();
        free[maker] = 300e6; free[maker2] = 300e6;
        create(99);
        _open(1);
        fill(0, 0, 0, 9);
        fill(0, 1, 1, 9);
    }

    function create(uint64 rawPairs) public {
        if (count == 2 || !registry.hasRole(creator, Role.CREATOR)) return;
        uint64 pairs = rawPairs % 300 + 1;
        uint64 now_ = token.clock();
        uint256 payout = uint256(pairs) * 1e6;
        uint256 bond = registry.bondFor(creator, Role.CREATOR, payout * p.creationBondBps / 10000);
        vm.prank(creator);
        try markets.createMarket(IBlinkMarkets.CreateArgs(templateId, keccak256(abi.encode(++serial)),
            "fixture://invariant", false, now_ + 1 days, now_ + 2 days, now_ + 4 days, pairs)) returns (uint256 id) {
            ++count; ++successfulCreates;
            creationBonds[id] = bond;
            _checkSecurity();
        } catch (bytes memory reason) {
            require(bytes4(reason) == BlinkMarkets.SecurityBoundExceeded.selector, "unexpected create failure");
            require((markets.openPayoutTotal() + payout) * p.securityMultipleBps > jurors.attackCostMicros() * 10000,
                "security rejection without violation");
        }
    }

    function register(uint256 seed) external {
        address who = address(uint160(0xA000 + seed % 4));
        if (!registry.isRegistered(who)) _identity(who);
    }

    function stake(uint256 seed, uint96 amount) external {
        address who = seed % 2 == 0 ? j1 : j2;
        uint256 balance = token.balanceOf(who);
        if (balance == 0) return;
        vm.prank(who); jurors.stake(uint256(amount) % balance + 1);
    }

    function unstake(uint256 seed, uint96 amount) external {
        address who = seed % 2 == 0 ? j1 : j2;
        uint256 active = jurors.stakeAt(who, token.clock());
        if (active == 0) return;
        vm.prank(who);
        try jurors.requestUnstake(uint256(amount) % active + 1) {
            ++successfulUnstakes; _checkSecurity();
        } catch (bytes memory reason) {
            require(bytes4(reason) == BlinkJurors.UnstakeBreaksSecurity.selector, "unexpected unstake failure");
        }
    }

    function withdraw(uint256 seed) external {
        address who = seed % 2 == 0 ? j1 : j2;
        (uint256 amount, uint256 at) = jurors.pendingUnstake(who);
        if (amount == 0 || token.clock() < at || jurors.openVotes(who) != 0) return;
        vm.prank(who); jurors.withdrawUnstaked();
    }

    function fill(uint256 seed, uint256 seller, uint8 side, uint64 rawQty) public {
        uint256 id = seed % count + 1;
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.OPEN || token.clock() < m.openAt || token.clock() + 30 >= m.closeAt) return;
        address who = seller % 2 == 0 ? maker : maker2;
        uint64 qty = rawQty % 10 + 1;
        if (m.totalMintedPairs + qty > m.maxPairs || free[who] < uint256(qty) * 500000) return;
        _fill(id, seller % 2 == 0 ? MAKER_KEY : MAKER2_KEY, taker, side % 2, qty);
        uint256 notional = uint256(qty) * 1e6;
        escrow[id] += notional;
        fees[id] += (notional / 2) * p.feeBps / 10000;
        free[who] -= notional / 2;
        if (side % 2 == 0) { yes[id][taker] += qty; no[id][who] += qty; }
        else { no[id][taker] += qty; yes[id][who] += qty; }
    }

    function _checkSecurity() private {
        if (markets.openPayoutTotal() * p.securityMultipleBps > jurors.attackCostMicros() * 10000) securityViolation = true;
        require(!securityViolation, "successful call broke security bound");
    }

    // Each call advances one public protocol phase, preserving random interleaving across the two markets.
    function progress(uint256 seed, uint8 action) public {
        uint256 id = seed % count + 1;
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state == MarketState.FINAL || m.state == MarketState.CANCELLED) return;
        if (token.clock() >= m.hardDeadline) { _timeout(id); return; }
        if (m.state == MarketState.PENDING && !m.creationChallenged) {
            if (action % 4 == 0 && token.clock() < m.openAt && registry.hasRole(challenger, Role.CHALLENGER)) {
                uint256 bond = registry.bondFor(challenger, Role.CHALLENGER, markets.maxPayout(id) * p.challengeBondBps / 10000);
                vm.prank(challenger); disputeOf[id] = resolution.challengeCreation(id, 1, EVIDENCE);
                creationDispute[id] = true; resolutionBonds[id] += bond;
            } else _open(id);
        } else if (m.state == MarketState.OPEN) {
            if (!registry.hasRole(proposer, Role.PROPOSER) || token.clock() >= m.proposalDeadline) return;
            if (token.clock() < m.closeAt) vm.warp(m.closeAt);
            uint256 bond = registry.bondFor(proposer, Role.PROPOSER, markets.maxPayout(id) * p.proposerBondBps / 10000);
            vm.prank(proposer); resolution.propose(id, Outcome.YES, EVIDENCE, "fixture://evidence");
            resolutionBonds[id] += bond;
            uint256 window = p.resultChallengeWindow[0];
            uint256 reduction = registry.creditOf(proposer, Role.PROPOSER) * p.challengeWindowStepSeconds;
            window = reduction >= window - p.minResultChallengeWindow[0] ? p.minResultChallengeWindow[0] : window - reduction;
            challengeEnd[id] = token.clock() + window;
        } else if (m.state == MarketState.PROPOSED) {
            if (token.clock() < challengeEnd[id] && action % 3 != 0 && registry.hasRole(challenger, Role.CHALLENGER)) {
                uint256 bond = registry.bondFor(challenger, Role.CHALLENGER, markets.maxPayout(id) * p.challengeBondBps / 10000);
                vm.prank(challenger); disputeOf[id] = resolution.challengeResult(id, EVIDENCE);
                resolutionBonds[id] += bond;
            } else {
                if (token.clock() < challengeEnd[id]) vm.warp(challengeEnd[id]);
                if (token.clock() >= m.hardDeadline) { _timeout(id); return; }
                resolution.finalizeUnchallenged(id); _recordFinal(id);
            }
        } else _arbitrate(id, action);
    }

    function _arbitrate(uint256 id, uint8 action) private {
        uint256 dispute = disputeOf[id];
        (IBlinkResolution.Dispute memory d, IBlinkResolution.Round memory r) = resolution.getDispute(dispute);
        if (r.settled) {
            if (token.clock() < r.appealEnd && action % 3 == 0 && d.appealRound + 1 < p.maxRounds) {
                bool challengerWon = r.leadingChoice == 1;
                address appellant = challengerWon ? (creationDispute[id] ? creator : proposer) : challenger;
                vm.prank(appellant); resolution.appeal(dispute); ++appeals;
                resolutionBonds[id] += d.lastBond * 2;
            } else {
                if (token.clock() < r.appealEnd) vm.warp(r.appealEnd);
                if (token.clock() >= markets.getMarket(id).hardDeadline) { _timeout(id); return; }
                resolution.finalizeDispute(dispute); resolutionBonds[id] = 0;
                if (creationDispute[id]) {
                    if (r.leadingChoice == 1) creationBonds[id] = 0;
                    disputeOf[id] = 0; creationDispute[id] = false;
                } else _recordFinal(id);
            }
        } else if (token.clock() < r.commitEnd) {
            address who = action % 2 == 0 ? j1 : j2;
            if (!committed[dispute][d.currentRound][who]
                && jurors.stakeAt(who, r.snapshotAt) != 0 && jurors.slashableStake(who) != 0
                && registry.meetsThreshold(who, Role.JUROR, p.roundCreditThreshold[r.level])) {
                uint8 choice = (action / 2) % 2;
                _commit(dispute, who, choice);
                committed[dispute][d.currentRound][who] = true;
                choices[dispute][d.currentRound][who] = choice;
            } else vm.warp(r.commitEnd);
        } else if (token.clock() < r.revealEnd) {
            address who = action % 2 == 0 ? j1 : j2;
            if (committed[dispute][d.currentRound][who] && !revealed[dispute][d.currentRound][who] && action % 5 != 0) {
                vm.prank(who); resolution.revealVote(dispute, choices[dispute][d.currentRound][who], EVIDENCE);
                revealed[dispute][d.currentRound][who] = true;
            } else vm.warp(r.revealEnd);
        } else resolution.settleRound(dispute);
    }

    function settle(uint256 disputeSeed, uint256 roundSeed, uint256 actorSeed) public {
        // IDs are sequential and there can be a creation and result dispute for each market.
        uint256 dispute = disputeSeed % 4 + 1;
        (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
        if (d.challenger == address(0)) return;
        uint256 round = roundSeed % (d.currentRound + 1);
        address who = actorSeed % 2 == 0 ? j1 : j2;
        if (!committed[dispute][round][who]) return;
        try resolution.settleVote(dispute, round, who) { ++voteSettlements; } catch (bytes memory reason) {
            bytes4 error = bytes4(reason);
            require(error == BlinkResolution.InvalidState.selector || error == BlinkResolution.AlreadySettled.selector
                || error == BlinkResolution.LosersPending.selector, "unexpected vote settlement failure");
        }
    }

    function tick(uint32 delta) external { vm.warp(token.clock() + uint256(delta) % 6 hours); }

    function _recordFinal(uint256 id) private {
        resolutionBonds[id] = 0; creationBonds[id] = 0; finalizedAt[id] = token.clock();
    }

    function _timeout(uint256 id) private { resolution.finalizeTimeout(id); _recordFinal(id); }

    function distribute(uint256 seed) public {
        uint256 id = seed % count + 1;
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.FINAL || m.feesDistributed) return;
        markets.distributeFees(id); fees[id] = 0;
    }

    function redeem(uint256 seed, uint256 actorSeed) public {
        uint256 id = seed % count + 1;
        address who = actorSeed % 3 == 0 ? taker : actorSeed % 3 == 1 ? maker : maker2;
        IBlinkMarkets.Market memory m = markets.getMarket(id);
        if (m.state != MarketState.FINAL || yes[id][who] + no[id][who] == 0) return;
        uint256 payout = m.finalOutcome == Outcome.YES ? yes[id][who] * 1e6
            : m.finalOutcome == Outcome.NO ? no[id][who] * 1e6 : (yes[id][who] + no[id][who]) * 500000;
        uint256 before = busd.balanceOf(who);
        vm.prank(who); markets.redeem(id);
        require(busd.balanceOf(who) == before + payout, "redemption differs from ghost positions");
        escrow[id] -= payout; yes[id][who] = 0; no[id][who] = 0; ++redemptions;
    }

    function claim(uint256 seed) external {
        vm.prank(seed % 2 == 0 ? j1 : j2); jurors.claimRewards();
    }

    function assertSolvency() public view {
        uint256 marketLiability = free[maker] + free[maker2];
        uint256 resolutionLiability;
        for (uint256 id = 1; id <= count; ++id) {
            IBlinkMarkets.Market memory m = markets.getMarket(id);
            require(m.escrowMicros == escrow[id] && markets.feePool(id) == fees[id]
                && m.creationBond == creationBonds[id], "ghost market ledger mismatch");
            marketLiability += escrow[id] + fees[id] + creationBonds[id];
            resolutionLiability += resolutionBonds[id];
            address[3] memory accounts = [taker, maker, maker2];
            for (uint256 a; a < accounts.length; ++a) {
                (uint256 y, uint256 n) = markets.getPosition(id, accounts[a]);
                require(y == yes[id][accounts[a]] && n == no[id][accounts[a]], "ghost position mismatch");
            }
        }
        require(markets.makerFree(maker) == free[maker] && markets.makerFree(maker2) == free[maker2], "ghost free mismatch");
        require(busd.balanceOf(address(markets)) >= marketLiability, "markets insolvent");
        require(busd.balanceOf(address(resolution)) >= resolutionLiability, "resolution insolvent");
        require(token.balanceOf(address(jurors)) >= jurors.totalStaked() + jurors.totalPending() + jurors.undistributedSlashed(),
            "juror token insolvent");
        require(busd.balanceOf(address(jurors)) >= jurors.rewardsOwed(), "juror rewards insolvent");
    }

    function assertDeadline() external view {
        for (uint256 id = 1; id <= count; ++id) {
            IBlinkMarkets.Market memory m = markets.getMarket(id);
            if (m.state == MarketState.FINAL && m.finalOutcome == Outcome.INVALID) {
                require(finalizedAt[id] >= m.hardDeadline, "INVALID finalized early");
            }
        }
    }

    function finish() external {
        for (uint256 id = 1; id <= count; ++id) {
            IBlinkMarkets.Market memory m = markets.getMarket(id);
            if (m.state != MarketState.FINAL && m.state != MarketState.CANCELLED) {
                if (token.clock() < m.hardDeadline) vm.warp(m.hardDeadline);
                _timeout(id);
            }
            if (markets.getMarket(id).state == MarketState.FINAL) {
                distribute(id - 1);
                for (uint256 a; a < 3; ++a) redeem(id - 1, a);
                require(escrow[id] == 0, "residual escrow");
            }
        }
        // Settle losers across every attempt before retrying coherent claims.
        for (uint256 pass; pass < 2; ++pass) {
            for (uint256 dispute = 1; dispute <= 4; ++dispute) {
                (IBlinkResolution.Dispute memory d,) = resolution.getDispute(dispute);
                if (d.challenger == address(0)) continue;
                for (uint256 round; round <= d.currentRound; ++round) {
                    settle(dispute - 1, round, 0); settle(dispute - 1, round, 1);
                }
            }
        }
        require(jurors.openVotes(j1) + jurors.openVotes(j2) == 0, "residual vote locks");
        assertSolvency();
    }
}

contract ProtocolInvariantTest {
    ProtocolHandler private handler;

    function setUp() public { handler = new ProtocolHandler(); handler.setUp(); }

    struct FuzzSelector { address addr; bytes4[] selectors; }

    function targetSelectors() public view returns (FuzzSelector[] memory selected) {
        bytes4[] memory selectors = new bytes4[](14);
        selectors[0] = handler.create.selector; selectors[1] = handler.register.selector;
        selectors[2] = handler.stake.selector; selectors[3] = handler.unstake.selector;
        selectors[4] = handler.withdraw.selector; selectors[5] = handler.fill.selector;
        selectors[6] = handler.progress.selector; selectors[7] = handler.settle.selector;
        selectors[8] = handler.tick.selector; selectors[9] = handler.distribute.selector;
        selectors[10] = handler.redeem.selector; selectors[11] = handler.claim.selector;
        selectors[12] = handler.progress.selector; selectors[13] = handler.progress.selector;
        selected = new FuzzSelector[](1); selected[0] = FuzzSelector(address(handler), selectors);
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1); targets[0] = address(handler);
    }

    function invariant_protocolSolvency() public view { handler.assertSolvency(); }
    function invariant_securityBound() public view { require(!handler.securityViolation(), "unsafe successful operation"); }
    function invariant_noInvalidBeforeHardDeadline() public view { handler.assertDeadline(); }
    function afterInvariant() public { handler.finish(); }

    function test_handlerReachesAppealAndRedemption() public {
        handler.create(49);
        handler.progress(0, 1); // propose market 1
        handler.progress(0, 1); // challenge
        handler.progress(0, 0); handler.progress(0, 1); // commit both
        handler.progress(0, 0); // advance to reveal
        handler.progress(0, 1); handler.progress(0, 0); // reveal (action 0 deliberately skips)
        handler.progress(0, 1); // settle
        handler.progress(0, 0); // appeal
        for (uint256 i; i < 20; ++i) handler.progress(0, uint8(i % 4));
        handler.finish();
        invariant_protocolSolvency(); invariant_securityBound(); invariant_noInvalidBeforeHardDeadline();
        require(handler.successfulCreates() == 2, "two market creation coverage");
        require(handler.appeals() > 0 && handler.redemptions() > 0 && handler.voteSettlements() > 0, "deep path coverage");
    }
}
