// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkFaucet} from "../../src/protocol/BlinkFaucet.sol";
import {BlinkToken} from "../../src/protocol/BlinkToken.sol";
import {BlinkTestUSD} from "../../src/BlinkTestUSD.sol";
import {FixedPriceSource} from "../../src/protocol/FixedPriceSource.sol";
import {IBlinkPriceSource} from "../../src/protocol/interfaces/IBlinkPriceSource.sol";

contract FaucetTest is ProtocolBase {
    bytes4 private constant WRONG_CHAIN = bytes4(keccak256("WrongChain()"));

    function test_faucetIsMinterOfBoth() public view {
        require(busd.minter() == address(faucet), "busd minter");
        require(token.minter() == address(faucet), "token minter");
        eq(busd.decimals(), 6);
        eq(token.decimals(), 18);
        require(keccak256(bytes(token.symbol())) == keccak256("tBLINK"), "symbol");
    }

    function test_claimOncePerInterval() public {
        address alice = actor("alice");
        uint256 t0 = token.clock();
        claimAs(alice);
        eq(busd.balanceOf(alice), 1_000e6);
        eq(token.balanceOf(alice), 1_000e18);
        eq(faucet.nextClaimAt(alice), t0 + 1 days);

        vm.expectRevert(BlinkFaucet.ClaimTooSoon.selector);
        vm.prank(alice);
        faucet.claim();

        vm.warp(t0 + 1 days - 1);
        vm.expectRevert(BlinkFaucet.ClaimTooSoon.selector);
        vm.prank(alice);
        faucet.claim();

        vm.warp(t0 + 1 days);
        claimAs(alice);
        eq(busd.balanceOf(alice), 2_000e6);
        eq(token.balanceOf(alice), 2_000e18);

        claimAs(actor("bob"));
        eq(busd.balanceOf(actor("bob")), 1_000e6);
    }

    function test_tokenVotesUseTimestamps() public {
        eq(token.clock(), block.timestamp);
        require(keccak256(bytes(token.CLOCK_MODE())) == keccak256("mode=timestamp"), "clock mode");
        faucet.claim();
        token.delegate(address(this));
        uint256 t = token.clock(); // external call: viaIR would re-read block.timestamp after the warp
        vm.warp(t + 10);
        eq(token.getPastVotes(address(this), t), 1_000e18);
        eq(token.getPastVotes(address(this), t), token.balanceOf(address(this)));
    }

    function test_onlyMinterMints() public {
        BlinkToken t = token;
        vm.expectRevert(BlinkToken.UnauthorizedMinter.selector);
        t.mint(address(this), 1);
        BlinkTestUSD b = busd;
        vm.expectRevert(BlinkTestUSD.UnauthorizedMinter.selector);
        b.mint(address(this), 1);
    }

    function test_fixedPrice() public {
        IBlinkPriceSource source = new FixedPriceSource(2e6);
        eq(source.tokenPriceMicros(), 2e6);
        vm.expectRevert(FixedPriceSource.InvalidPrice.selector);
        new FixedPriceSource(0);
    }

    function test_wrongChainReverts() public {
        vm.chainId(1);
        vm.expectRevert(WRONG_CHAIN);
        new BlinkToken(address(this));
        vm.expectRevert(WRONG_CHAIN);
        new FixedPriceSource(1);
        vm.expectRevert(WRONG_CHAIN);
        new BlinkFaucet();
    }

    function test_tokenRejectsZeroMinter() public {
        vm.expectRevert(BlinkToken.InvalidMinter.selector);
        new BlinkToken(address(0));
    }
}
