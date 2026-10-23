// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {Params, GenerationAddresses, Role, QuestionClass, MarketState, Outcome} from "../../src/protocol/BlinkTypes.sol";

contract MarketsTradingTest is ProtocolBase {
    uint256 private constant M1_KEY = 0xA11CE;
    uint256 private constant M2_KEY = 0xB0B;
    bytes32 private constant TYPEHASH = keccak256(
        "Quote(uint256 marketId,bytes32 specHash,address maker,address taker,uint8 side,uint64 quantity,uint16 priceBps,uint64 validAfter,uint64 expiresAt,uint256 nonce,uint256 epoch)"
    );
    BlinkRegistry private registry;
    BlinkJurors private jurors;
    IBlinkMarkets private markets;
    GenerationAddresses private generation;
    Params private p;
    address private creator;
    address private m1;
    address private m2;
    address private taker;
    bytes32 private templateId;
    uint256 private id;
    uint256 private serial;

    event QuoteFilled(
        uint256 indexed marketId, bytes32 indexed digest, address maker, address indexed taker,
        uint8 side, uint64 quantity, uint16 priceBps, uint256 takerCost, uint256 makerCost, uint256 fee
    );

    function setUp() public override {
        super.setUp();
        p = defaultParams();
        generation = predictGeneration(address(this), address(0));
        registry = new BlinkRegistry(p, generation);
        jurors = new BlinkJurors(generation);
        markets = IBlinkMarkets(address(new BlinkMarkets(generation)));
        new BlinkResolution(generation);
        creator = fundedActor("creator");
        m1 = vm.addr(M1_KEY);
        m2 = vm.addr(M2_KEY);
        claimAs(m1);
        claimAs(m2);
        taker = fundedActor("taker");
        _join(creator, Role.CREATOR);
        _join(m1, Role.MAKER);
        _join(m2, Role.MAKER);
        _join(taker, Role.TAKER);
        address juror = fundedActor("juror");
        for (uint256 i; i < 3; ++i) {
            address donor = address(uint160(uint256(keccak256(abi.encode("donor", i)))));
            claimAs(donor);
            vm.prank(donor);
            token.transfer(juror, 1000e18);
        }
        approveBusdAs(juror, address(registry));
        vm.prank(juror);
        registry.register();
        vm.startPrank(juror);
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(4000e18);
        vm.stopPrank();
        vm.prank(m1);
        markets.depositMaker(600e6);
        vm.prank(m2);
        markets.depositMaker(600e6);
        templateId = markets.registerTemplate(QuestionClass.A_COMPUTABLE, keccak256("parser"), "fixture://template");
        id = _create(600);
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
    }

    function _join(address who, Role role) private {
        approveBusdAs(who, address(registry));
        vm.startPrank(who);
        registry.register();
        registry.joinRole(role, p.minRoleStake);
        vm.stopPrank();
        approveBusdAs(who, address(markets));
    }

    function _create(uint64 maxPairs) private returns (uint256) {
        IBlinkMarkets.CreateArgs memory a = IBlinkMarkets.CreateArgs(
            templateId, keccak256(abi.encode(++serial)), "fixture://spec", false,
            uint64(token.clock() + 3 days), uint64(token.clock() + 4 days), uint64(token.clock() + 6 days), maxPairs
        );
        vm.prank(creator);
        return markets.createMarket(a);
    }

    function _quote(address maker, uint8 side, uint64 quantity, uint16 price) private returns (IBlinkMarkets.Quote memory q) {
        q = IBlinkMarkets.Quote(
            id, markets.getMarket(id).specHash, maker, taker, side, quantity, price,
            uint64(token.clock()), uint64(token.clock() + 30), ++serial, markets.makerEpoch(maker)
        );
    }

    // Independent EIP-712 encoding also checks the protocol's name, version, chain and address.
    function _digest(IBlinkMarkets.Quote memory q) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("Blink RFQ"), keccak256("0.2"), block.chainid, address(markets)
        ));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(TYPEHASH, q))));
    }

    function _sign(IBlinkMarkets.Quote memory q) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(q.maker == m2 ? M2_KEY : M1_KEY, _digest(q));
        return abi.encodePacked(r, s, v);
    }

    function _fill(IBlinkMarkets.Quote memory q) private {
        require(markets.hashQuote(q) == _digest(q), "quote domain mismatch");
        bytes memory sig = _sign(q);
        vm.prank(q.taker);
        markets.fillQuote(q, sig);
        require(markets.consumed(_digest(q)), "filled quote not consumed");
    }

    function _fail(IBlinkMarkets.Quote memory q, string memory errorName) private {
        bytes memory sig = _sign(q);
        vm.expectRevert(bytes4(keccak256(bytes(errorName))));
        vm.prank(q.taker);
        markets.fillQuote(q, sig);
    }

    function _position(address who, uint256 yes, uint256 no) private view {
        (uint256 actualYes, uint256 actualNo) = markets.getPosition(id, who);
        eq(actualYes, yes);
        eq(actualNo, no);
    }

    function test_twoMakersQuoteSameMarket() public {
        _fill(_quote(m1, 0, 100, 6000));
        _fill(_quote(m2, 1, 50, 3000));
        _position(m1, 0, 100);
        _position(m2, 50, 0);
        _position(taker, 100, 50);
        eq(markets.makerFree(m1), 560e6);
        eq(markets.makerFree(m2), 565e6);
        eq(markets.getMarket(id).totalMintedPairs, 150);
        eq(markets.getMarket(id).escrowMicros, 150e6);
        eq(markets.feePool(id), 0.75e6);
        _solvent();
    }

    function test_feeChargedToTaker() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 100, 6000);
        uint256 beforeBalance = busd.balanceOf(taker);
        bytes memory sig = _sign(q);
        vm.expectEmit(true, true, true, true);
        emit QuoteFilled(id, _digest(q), m1, taker, 0, 100, 6000, 60e6, 40e6, 0.6e6);
        vm.prank(taker);
        markets.fillQuote(q, sig);
        eq(beforeBalance - busd.balanceOf(taker), 60.6e6);
        eq(markets.feePool(id), 0.6e6);
        _solvent();
    }

    function test_unregisteredOrExitedRolesCannotTrade() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        vm.prank(m1);
        registry.requestRoleExit(Role.MAKER);
        _fail(q, "MissingRole()");
        q = _quote(m2, 0, 1, 6000);
        q.taker = fundedActor("unregistered");
        _fail(q, "MissingRole()");
        approveBusdAs(q.taker, address(registry));
        vm.prank(q.taker);
        registry.register();
        _fail(q, "MissingRole()");
        q.taker = taker;
        vm.prank(taker);
        registry.requestRoleExit(Role.TAKER);
        _fail(q, "MissingRole()");
    }

    function test_quoteReplayAndEpochPerMaker() public {
        IBlinkMarkets.Quote memory q1 = _quote(m1, 0, 10, 6000);
        IBlinkMarkets.Quote memory q2 = _quote(m2, 1, 10, 6000);
        vm.prank(m1);
        markets.incrementMakerEpoch();
        eq(markets.makerEpoch(m1), 1);
        eq(markets.makerEpoch(m2), 0);
        _fail(q1, "EpochMismatch()");
        _fill(q2);
        _fail(q2, "QuoteAlreadyConsumed()");
        vm.expectRevert(bytes4(keccak256("QuoteAlreadyConsumed()")));
        vm.prank(m2);
        markets.cancelQuote(q2);
    }

    function test_cannotFillPendingOrClosed() public {
        id = _create(10);
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        _fail(q, "MarketNotOpen()");
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
        vm.warp(markets.getMarket(id).closeAt);
        q = _quote(m1, 0, 1, 6000);
        _fail(q, "MarketClosed()");
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.OPEN));
    }

    function test_rejectedCreationCannotTradeBeforeOpenAt() public {
        id = _create(10);
        vm.startPrank(generation.resolution);
        markets.markCreationChallenged(id);
        markets.resolveCreation(id, false, address(0));
        vm.stopPrank();
        eq(uint256(markets.getMarket(id).state), uint256(MarketState.OPEN));
        _fail(_quote(m1, 0, 1, 6000), "MarketNotOpen()");
        vm.warp(markets.getMarket(id).openAt);
        _fill(_quote(m1, 0, 1, 6000));
    }

    function test_delayedOpenCannotTradeAfterCloseAt() public {
        id = _create(10);
        vm.warp(markets.getMarket(id).closeAt + 1);
        markets.open(id);
        _fail(_quote(m1, 0, 1, 6000), "MarketClosed()");
    }

    function test_nonOpenStatesCannotTrade() public {
        vm.prank(generation.resolution);
        markets.setProposed(id);
        _fail(_quote(m1, 0, 1, 6000), "MarketNotOpen()");
        vm.prank(generation.resolution);
        markets.setDisputed(id);
        _fail(_quote(m1, 0, 1, 6000), "MarketNotOpen()");
        vm.prank(generation.resolution);
        markets.finalize(id, Outcome.YES);
        _fail(_quote(m1, 0, 1, 6000), "MarketNotOpen()");
        id = _create(10);
        vm.startPrank(generation.resolution);
        markets.markCreationChallenged(id);
        markets.resolveCreation(id, true, taker);
        vm.stopPrank();
        _fail(_quote(m1, 0, 1, 6000), "MarketNotOpen()");
    }

    function test_takerCannotBeMaker() public {
        vm.prank(m1);
        registry.joinRole(Role.TAKER, p.minRoleStake);
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        q.taker = m1;
        _fail(q, "InvalidTaker()");
    }

    function test_onlyNamedTakerCanFill() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        bytes memory sig = _sign(q);
        vm.expectRevert(bytes4(keccak256("InvalidTaker()")));
        vm.prank(m2);
        markets.fillQuote(q, sig);
    }

    function test_cancelIsMakerScopedAndIdempotent() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        vm.expectRevert(bytes4(keccak256("InvalidTaker()")));
        vm.prank(m2);
        markets.cancelQuote(q);
        vm.prank(m1);
        markets.cancelQuote(q);
        require(markets.cancelled(_digest(q)), "quote not cancelled");
        vm.prank(m1);
        markets.cancelQuote(q);
        _fail(q, "QuoteAlreadyCancelled()");
        q.maker = m2;
        _fill(q);
    }

    function test_invalidSpecSideQuantityAndPrice() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        q.specHash = keccak256("wrong spec");
        _fail(q, "InvalidSpec()");
        _fail(_quote(m1, 2, 1, 6000), "InvalidSide()");
        _fail(_quote(m1, 0, 0, 6000), "InvalidQuantity()");
        _fail(_quote(m1, 0, p.maxFillShares + 1, 6000), "InvalidQuantity()");
        _fail(_quote(m1, 0, type(uint64).max, 6000), "InvalidQuantity()");
        _fail(_quote(m1, 0, 1, 0), "InvalidPrice()");
        _fail(_quote(m1, 0, 1, 10000), "InvalidPrice()");
    }

    function test_takerCapCountsBothSidesAndMakers() public {
        for (uint256 i; i < 5; ++i) _fill(_quote(i % 2 == 0 ? m1 : m2, uint8(i % 2), 100, 6000));
        _fail(_quote(m2, 1, 1, 6000), "CapExceeded()");
        eq(markets.getMarket(id).totalMintedPairs, 500);
    }

    function test_marketCapCountsAllMakersAndTakers() public {
        id = _create(10);
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
        _fill(_quote(m1, 0, 6, 6000));
        address other = fundedActor("other taker");
        _join(other, Role.TAKER);
        IBlinkMarkets.Quote memory q = _quote(m2, 1, 4, 6000);
        q.taker = other;
        _fill(q);
        _fail(_quote(m2, 1, 1, 6000), "CapExceeded()");
    }

    function test_quoteTimeBounds() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        q.validAfter += 1;
        _fail(q, "InvalidQuoteTime()");
        vm.warp(q.validAfter);
        _fill(q);
        q = _quote(m1, 0, 1, 6000);
        q.expiresAt = q.validAfter + 61;
        _fail(q, "InvalidQuoteTime()");
        q.expiresAt = q.validAfter + 60;
        _fill(q);
        q = _quote(m1, 0, 1, 6000);
        vm.warp(q.expiresAt);
        _fail(q, "InvalidQuoteTime()");
        q = _quote(m1, 0, 1, 6000);
        q.expiresAt = q.validAfter;
        _fail(q, "InvalidQuoteTime()");
        q.expiresAt = q.validAfter - 1;
        _fail(q, "InvalidQuoteTime()");
        vm.warp(markets.getMarket(id).closeAt - 30);
        q = _quote(m1, 0, 1, 6000);
        q.expiresAt += 1;
        _fail(q, "InvalidQuoteTime()");
        q.expiresAt -= 1;
        _fill(q);
    }

    function test_invalidSignatureAndDomain() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        bytes memory sig = _sign(q);
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        vm.prank(taker);
        markets.fillQuote(q, hex"00");
        q.priceBps = 5000;
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        vm.prank(taker);
        markets.fillQuote(q, sig);
        q.priceBps = 6000;
        q.maker = m2;
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        vm.prank(taker);
        markets.fillQuote(q, sig);
        q.maker = m1;
        vm.chainId(8453);
        vm.expectRevert(bytes4(keccak256("InvalidSignature()")));
        vm.prank(taker);
        markets.fillQuote(q, sig);
        vm.chainId(84532);
        _fill(q);
    }

    function test_makerFundsAreIndependentAndExitCanRecoverFreeCollateral() public {
        uint256 beforeBalance = busd.balanceOf(m1);
        vm.prank(m1);
        markets.withdrawMaker(600e6);
        eq(busd.balanceOf(m1) - beforeBalance, 600e6);
        eq(markets.makerFree(m1), 0);
        eq(markets.makerFree(m2), 600e6);
        _fail(_quote(m1, 0, 1, 6000), "InsufficientMakerBalance()");
        vm.prank(m1);
        markets.depositMaker(100e6);
        _fill(_quote(m1, 0, 100, 6000));
        vm.prank(m1);
        registry.requestRoleExit(Role.MAKER);
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 1, 6000);
        vm.prank(m1);
        markets.cancelQuote(q);
        require(markets.cancelled(_digest(q)), "exited maker cannot cancel");
        vm.prank(m1);
        markets.incrementMakerEpoch();
        eq(markets.makerEpoch(m1), 1);
        vm.warp(token.clock() + p.roleExitCooldown);
        vm.prank(m1);
        registry.withdrawRole(Role.MAKER);
        vm.prank(m1);
        markets.withdrawMaker(60e6);
        eq(markets.makerFree(m1), 0);
        _position(m1, 0, 100);
        _solvent();
    }

    function test_invalidDepositsWithdrawalsAndMissingRole() public {
        vm.expectRevert(bytes4(keccak256("InvalidAmount()")));
        vm.prank(m1);
        markets.depositMaker(0);
        vm.expectRevert(bytes4(keccak256("InvalidAmount()")));
        vm.prank(m1);
        markets.withdrawMaker(0);
        vm.expectRevert(bytes4(keccak256("InsufficientMakerBalance()")));
        vm.prank(m1);
        markets.withdrawMaker(600e6 + 1);
        vm.expectRevert(bytes4(keccak256("InsufficientMakerBalance()")));
        vm.prank(taker);
        markets.withdrawMaker(1);
        vm.expectRevert(bytes4(keccak256("MissingRole()")));
        vm.prank(taker);
        markets.depositMaker(1);
        vm.prank(m1);
        registry.requestRoleExit(Role.MAKER);
        vm.expectRevert(bytes4(keccak256("MissingRole()")));
        vm.prank(m1);
        markets.depositMaker(1);
    }

    function test_transferFailureRollsBackAllFillAccounting() public {
        IBlinkMarkets.Quote memory q = _quote(m1, 0, 100, 6000);
        bytes memory sig = _sign(q);
        vm.prank(taker);
        busd.approve(address(markets), 60e6); // covers cost, but not the fee
        vm.expectRevert();
        vm.prank(taker);
        markets.fillQuote(q, sig);
        require(!markets.consumed(_digest(q)), "failed quote consumed");
        eq(markets.makerFree(m1), 600e6);
        eq(markets.getMarket(id).escrowMicros, 0);
        eq(markets.getMarket(id).totalMintedPairs, 0);
        eq(markets.feePool(id), 0);
        _position(taker, 0, 0);
        _position(m1, 0, 0);
        approveBusdAs(taker, address(markets));
        _fill(q);
        _solvent();
    }

    function testFuzz_completeSetsAndFees(uint64 rawQuantity, uint16 rawPrice, bool noSide) public {
        uint64 quantity = rawQuantity % p.maxFillShares + 1;
        uint16 price = rawPrice % 9999 + 1;
        uint256 cost = uint256(quantity) * price * 100;
        uint256 beforeBalance = busd.balanceOf(taker);
        _fill(_quote(m1, noSide ? 1 : 0, quantity, price));
        eq(beforeBalance - busd.balanceOf(taker), cost + cost * p.feeBps / 10000);
        eq(600e6 - markets.makerFree(m1) + cost, uint256(quantity) * 1e6);
        eq(markets.getMarket(id).escrowMicros, uint256(quantity) * 1e6);
        _position(taker, noSide ? 0 : quantity, noSide ? quantity : 0);
        _position(m1, noSide ? quantity : 0, noSide ? 0 : quantity);
        _solvent();
    }

    function _solvent() private view {
        eq(busd.balanceOf(address(markets)), markets.getMarket(id).escrowMicros + markets.feePool(id)
            + markets.getMarket(id).creationBond + markets.makerFree(m1) + markets.makerFree(m2));
    }
}
