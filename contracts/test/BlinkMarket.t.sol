// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {TestBase, BlinkMarket, BlinkTestUSD, IBlinkMarket} from "./TestBase.sol";

contract BlinkMarketTest is TestBase {
    function test_C01_yesAccounting() public {
        fill(quote(0, 100, 6000));
        eq(token.balanceOf(TAKER), 999_940e6);
        eq(market.makerFreeBalance(), 99_960e6);
        eq(market.getMarket(id).escrowMicros, 100e6);
        (uint256 yes, uint256 no) = market.getPosition(id, TAKER);
        eq(yes, 100);
        eq(no, 0);
        (yes, no) = market.getPosition(id, maker);
        eq(yes, 0);
        eq(no, 100);
    }

    function test_C02_noAccounting() public {
        fill(quote(1, 100, 6000));
        (uint256 yes, uint256 no) = market.getPosition(id, TAKER);
        eq(yes, 0);
        eq(no, 100);
        (yes, no) = market.getPosition(id, maker);
        eq(yes, 100);
        eq(no, 0);
        eq(market.getMarket(id).escrowMicros, 100e6);
        eq(market.makerFreeBalance(), 99_960e6);
    }

    function test_C03_wrongPayloadAndDomain() public {
        IBlinkMarket.Quote memory q = quote(0, 10, 6200);
        q.specHash = keccak256("wrong");
        failFill(q, BlinkMarket.InvalidSpec.selector);
        q = quote(0, 10, 6200);
        q.taker = address(123);
        failFill(q, BlinkMarket.InvalidTaker.selector);
        q = quote(0, 10, 6200);
        q.maker = address(123);
        failFill(q, BlinkMarket.InvalidTaker.selector);
        q = quote(0, 10, 6200);
        bytes memory sig = signature(q);
        vm.chainId(8453);
        vm.expectRevert(BlinkMarket.InvalidSignature.selector);
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        vm.chainId(84532);
        BlinkMarket other = new BlinkMarket(address(token), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        sig = signDigest(other.hashQuote(q));
        vm.expectRevert(BlinkMarket.InvalidSignature.selector);
        vm.prank(TAKER);
        market.fillQuote(q, sig);
    }

    function test_C04_C09_consumedCancelledEpoch() public {
        IBlinkMarket.Quote memory q = quote(0, 10, 6200);
        bytes memory sig = signature(q);
        fill(q);
        vm.expectRevert(BlinkMarket.QuoteAlreadyConsumed.selector);
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        vm.expectRevert(BlinkMarket.QuoteAlreadyConsumed.selector);
        vm.prank(maker);
        market.cancelQuote(q);
        q = quote(0, 10, 6200);
        vm.prank(maker);
        market.cancelQuote(q);
        failFill(q, BlinkMarket.QuoteAlreadyCancelled.selector);
        q = quote(0, 10, 6200);
        vm.prank(maker);
        market.incrementMakerEpoch();
        failFill(q, BlinkMarket.EpochMismatch.selector);
    }

    function test_C05_quoteBoundaries() public {
        IBlinkMarket.Quote memory q = quote(0, 10, 6200);
        q.validAfter += 1;
        failFill(q, BlinkMarket.InvalidQuoteTime.selector);
        vm.warp(q.validAfter);
        fill(q);
        q = quote(0, 10, 6200);
        vm.warp(q.expiresAt);
        failFill(q, BlinkMarket.InvalidQuoteTime.selector);
        vm.warp(market.getMarket(id).closeAt - 30);
        q = quote(0, 10, 6200);
        vm.warp(market.getMarket(id).closeAt);
        failFill(q, BlinkMarket.MarketClosed.selector);
    }

    function test_C06_badAmountsCapsAndLifetime() public {
        failFill(quote(0, 0, 1), BlinkMarket.InvalidQuantity.selector);
        failFill(quote(0, 101, 1), BlinkMarket.InvalidQuantity.selector);
        failFill(quote(0, type(uint64).max, 1), BlinkMarket.InvalidQuantity.selector);
        failFill(quote(0, 1, 0), BlinkMarket.InvalidPrice.selector);
        failFill(quote(0, 1, 10000), BlinkMarket.InvalidPrice.selector);
        failFill(quote(2, 1, 1), BlinkMarket.InvalidSide.selector);
        IBlinkMarket.Quote memory q = quote(0, 1, 1);
        q.expiresAt = q.validAfter + 61;
        failFill(q, BlinkMarket.InvalidQuoteTime.selector);
        for (uint256 i; i < 5; ++i) {
            fill(quote(uint8(i % 2), 100, 5000));
        }
        failFill(quote(0, 1, 5000), BlinkMarket.CapExceeded.selector);
        id = newMarket(10, 10);
        fill(quote(0, 10, 5000));
        failFill(quote(1, 1, 5000), BlinkMarket.CapExceeded.selector);
    }

    function test_C07_balanceAndAllowanceRollback() public {
        uint256 free = market.makerFreeBalance();
        vm.prank(maker);
        market.withdrawMaker(free);
        failFill(quote(0, 100, 6000), BlinkMarket.InsufficientMakerBalance.selector);
        vm.prank(maker);
        market.depositMaker(100e6);
        IBlinkMarket.Quote memory q = quote(0, 100, 6000);
        bytes memory sig = signature(q);
        vm.prank(TAKER);
        token.approve(address(market), 0);
        vm.expectRevert();
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        require(!market.consumed(market.hashQuote(q)));
        eq(market.getMarket(id).escrowMicros, 0);
        eq(market.makerFreeBalance(), 100e6);
        vm.prank(TAKER);
        token.approve(address(market), type(uint256).max);
        uint256 remaining = token.balanceOf(TAKER);
        vm.prank(TAKER);
        token.transfer(address(999), remaining);
        vm.expectRevert();
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        require(!market.consumed(market.hashQuote(q)));
        eq(market.makerFreeBalance(), 100e6);
    }

    function test_C08_competingQuotes() public {
        uint256 free = market.makerFreeBalance();
        vm.prank(maker);
        market.withdrawMaker(free - 40e6);
        IBlinkMarket.Quote memory a = quote(0, 100, 6000);
        IBlinkMarket.Quote memory b = quote(1, 100, 6000);
        fill(a);
        failFill(b, BlinkMarket.InsufficientMakerBalance.selector);
    }

    function testFuzz_C10_redemption(uint8 result) public {
        IBlinkMarket.Outcome outcome = IBlinkMarket.Outcome(result % 3);
        fill(quote(0, 100, 6000));
        finalize(outcome);
        uint256 beforeT = token.balanceOf(TAKER);
        uint256 beforeM = token.balanceOf(maker);
        vm.prank(TAKER);
        market.redeem(id);
        vm.prank(maker);
        market.redeem(id);
        eq(
            token.balanceOf(TAKER) - beforeT,
            outcome == IBlinkMarket.Outcome.YES ? 100e6 : outcome == IBlinkMarket.Outcome.NO ? 0 : 50e6
        );
        eq(
            token.balanceOf(maker) - beforeM,
            outcome == IBlinkMarket.Outcome.NO ? 100e6 : outcome == IBlinkMarket.Outcome.YES ? 0 : 50e6
        );
        eq(market.getMarket(id).escrowMicros, 0);
        eq(market.makerFreeBalance(), 99_960e6);
        vm.expectRevert(BlinkMarket.NoPosition.selector);
        vm.prank(TAKER);
        market.redeem(id);
    }

    function test_C11_timeoutAllNonFinalStates() public {
        for (uint256 state; state < 3; ++state) {
            if (state > 0) id = newMarket(10000, 500);
            fill(quote(0, 100, 6000));
            if (state > 0) propose(IBlinkMarket.Outcome.YES);
            if (state == 2) {
                vm.prank(CHALLENGER);
                market.challengeOutcome(id, keccak256("challenge"));
            }
            vm.warp(market.getMarket(id).hardDeadline);
            market.finalizeTimeout(id);
            eq(uint256(market.getMarket(id).finalOutcome), uint256(IBlinkMarket.Outcome.INVALID));
            vm.prank(TAKER);
            market.redeem(id);
            vm.prank(maker);
            market.redeem(id);
            eq(market.getMarket(id).escrowMicros, 0);
        }
    }

    function test_C12_challengeAndHardDeadline() public {
        propose(IBlinkMarket.Outcome.YES);
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        market.finalizeUnchallenged(id);
        vm.warp(block.timestamp + 120);
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        vm.prank(CHALLENGER);
        market.challengeOutcome(id, keccak256("c"));
        market.finalizeUnchallenged(id);
        id = newMarket(10000, 500);
        propose(IBlinkMarket.Outcome.YES);
        vm.prank(CHALLENGER);
        market.challengeOutcome(id, keccak256("c"));
        vm.warp(market.getMarket(id).hardDeadline);
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        vm.prank(ARBITER);
        market.arbitrate(id, IBlinkMarket.Outcome.NO, keccak256("a"));
        market.finalizeTimeout(id);
    }

    function test_C12_proposalAndLateFinalization() public {
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        vm.prank(PROPOSER);
        market.proposeOutcome(id, IBlinkMarket.Outcome.YES, keccak256("r"));
        vm.warp(market.getMarket(id).proposalDeadline);
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        vm.prank(PROPOSER);
        market.proposeOutcome(id, IBlinkMarket.Outcome.YES, keccak256("r"));
        id = newMarket(10000, 500);
        propose(IBlinkMarket.Outcome.YES);
        vm.warp(market.getMarket(id).hardDeadline);
        vm.expectRevert(BlinkMarket.DeadlineViolation.selector);
        market.finalizeUnchallenged(id);
        market.finalizeTimeout(id);
    }

    function test_C13_pauseAndRevocationDoNotBlockRedemption() public {
        fill(quote(0, 100, 6000));
        vm.prank(ADMIN);
        market.setGlobalTradingPaused(true);
        failFill(quote(0, 1, 5000), BlinkMarket.TradingPaused.selector);
        vm.prank(ADMIN);
        market.setTakerAllowed(TAKER, false);
        vm.prank(maker);
        market.withdrawMaker(1e6);
        finalize(IBlinkMarket.Outcome.YES);
        vm.prank(TAKER);
        market.redeem(id);
        vm.prank(maker);
        market.redeem(id);
        eq(market.getMarket(id).escrowMicros, 0);
    }

    function test_C14_rolesConstructorAndDonations() public {
        vm.expectRevert(BlinkMarket.UnauthorizedRole.selector);
        market.setGlobalTradingPaused(true);
        vm.expectRevert(BlinkMarket.UnauthorizedRole.selector);
        market.withdrawMaker(1);
        vm.expectRevert(BlinkMarket.InvalidTaker.selector);
        vm.prank(ADMIN);
        market.setTakerAllowed(ARBITER, true);
        vm.expectRevert(BlinkMarket.InvalidAddress.selector);
        new BlinkMarket(address(token), maker, maker, PROPOSER, CHALLENGER, ARBITER);
        vm.expectRevert(BlinkMarket.InvalidCollateral.selector);
        new BlinkMarket(address(0), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        vm.chainId(8453);
        vm.expectRevert(BlinkMarket.WrongChain.selector);
        new BlinkMarket(address(token), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        vm.expectRevert(BlinkTestUSD.WrongChain.selector);
        new BlinkTestUSD(address(this));
        vm.chainId(84532);
        token.mint(address(market), 7e6);
        uint256 free = market.makerFreeBalance();
        vm.prank(maker);
        market.withdrawMaker(free);
        eq(token.balanceOf(address(market)), 7e6);
        vm.expectRevert(BlinkMarket.InsufficientMakerBalance.selector);
        vm.prank(maker);
        market.withdrawMaker(1);
        (bool ok,) = address(market).call(abi.encodeWithSignature("grantRole(bytes32,address)", bytes32(0), TAKER));
        require(!ok);
    }

    function test_badSignatureEvidenceAndDuplicateSpec() public {
        IBlinkMarket.Quote memory q = quote(0, 1, 5000);
        vm.expectRevert(BlinkMarket.InvalidSignature.selector);
        vm.prank(TAKER);
        market.fillQuote(q, hex"00");
        vm.expectRevert(BlinkMarket.DuplicateSpec.selector);
        vm.prank(ADMIN);
        market.createMarket(q.specHash, "x", IBlinkMarket.Mode.REPLAY, 1001000, 1002000, 1003000, 120, 100, 100);
        vm.warp(market.getMarket(id).closeAt);
        vm.expectRevert(BlinkMarket.EmptyEvidence.selector);
        vm.prank(PROPOSER);
        market.proposeOutcome(id, IBlinkMarket.Outcome.YES, bytes32(0));
        vm.prank(PROPOSER);
        market.proposeOutcome(id, IBlinkMarket.Outcome.YES, keccak256("r"));
        vm.prank(CHALLENGER);
        market.challengeOutcome(id, keccak256("c"));
        vm.prank(ARBITER);
        market.arbitrate(id, IBlinkMarket.Outcome.NO, keccak256("a"));
        eq(uint256(market.getMarket(id).finalOutcome), uint256(IBlinkMarket.Outcome.NO));
        vm.expectRevert(BlinkMarket.InvalidState.selector);
        market.finalizeTimeout(id);
    }

    function testFuzz_costConservation(uint64 quantity, uint16 price, bool yes) public {
        quantity = uint64(uint256(quantity) % 100 + 1);
        price = uint16(uint256(price) % 9999 + 1);
        uint256 beforeT = token.balanceOf(TAKER);
        uint256 beforeM = market.makerFreeBalance();
        fill(quote(yes ? 0 : 1, quantity, price));
        eq(beforeT - token.balanceOf(TAKER) + beforeM - market.makerFreeBalance(), uint256(quantity) * 1e6);
        eq(market.getMarket(id).escrowMicros, uint256(quantity) * 1e6);
    }

    function test_marketCapAcrossAccountsAndPerMarketPause() public {
        id = newMarket(100, 100);
        fill(quote(0, 60, 5000));
        address second = address(0x201);
        token.mint(second, 100e6);
        vm.prank(second);
        token.approve(address(market), 100e6);
        vm.prank(ADMIN);
        market.setTakerAllowed(second, true);
        IBlinkMarket.Quote memory q = quote(1, 41, 5000);
        q.taker = second;
        bytes memory sig = signature(q);
        vm.expectRevert(BlinkMarket.CapExceeded.selector);
        vm.prank(second);
        market.fillQuote(q, sig);
        vm.prank(ADMIN);
        market.setMarketTradingPaused(id, true);
        failFill(quote(0, 1, 5000), BlinkMarket.TradingPaused.selector);
        id = newMarket(10000, 500);
        fill(quote(0, 1, 5000));
    }

    function test_bothSidesRedeemAndRevocationRejectsNewFill() public {
        fill(quote(0, 20, 6000));
        fill(quote(1, 30, 4000));
        vm.prank(ADMIN);
        market.setTakerAllowed(TAKER, false);
        failFill(quote(0, 1, 5000), BlinkMarket.InvalidTaker.selector);
        finalize(IBlinkMarket.Outcome.INVALID);
        uint256 beforeT = token.balanceOf(TAKER);
        vm.prank(TAKER);
        market.redeem(id);
        eq(token.balanceOf(TAKER) - beforeT, 25e6);
        vm.prank(maker);
        market.redeem(id);
        eq(market.getMarket(id).escrowMicros, 0);
        eq(market.cumulativeTakerShares(id, TAKER), 50);
    }
}
