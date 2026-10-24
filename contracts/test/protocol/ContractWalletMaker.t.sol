// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {MockErc1271Wallet} from "./MockErc1271Wallet.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {IBlinkMarkets} from "../../src/protocol/interfaces/IBlinkMarkets.sol";
import {Role, QuestionClass} from "../../src/protocol/BlinkTypes.sol";

contract ContractWalletMakerTest is ProtocolBase {
    uint256 private constant OWNER_KEY = 0xA11CE;
    uint256 private constant OTHER_KEY = 0xB0B;
    uint256 private constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    BlinkRegistry private registry;
    BlinkMarkets private markets;
    MockErc1271Wallet private wallet;
    address private owner;
    address private taker;
    uint256 private id;

    event QuoteFilled(
        uint256 indexed marketId, bytes32 indexed digest, address maker, address indexed taker,
        uint8 side, uint64 quantity, uint16 priceBps, uint256 takerCost, uint256 makerCost, uint256 fee
    );

    function setUp() public override {
        super.setUp();
        BlinkJurors jurors;
        (registry, jurors, markets,) = deployGeneration(defaultParams(), address(0));
        owner = vm.addr(OWNER_KEY);
        wallet = new MockErc1271Wallet(owner);
        _execute(address(faucet), abi.encodeCall(faucet.claim, ()));
        _execute(address(busd), abi.encodeCall(busd.approve, (address(registry), type(uint256).max)));
        _execute(address(registry), abi.encodeCall(registry.register, ()));
        _execute(address(registry), abi.encodeCall(registry.joinRole, (Role.MAKER, 100e6)));
        _execute(address(busd), abi.encodeCall(busd.approve, (address(markets), type(uint256).max)));
        _execute(address(markets), abi.encodeCall(markets.depositMaker, (600e6)));

        claimAs(owner);
        _join(owner, Role.MAKER);
        vm.prank(owner);
        markets.depositMaker(600e6);
        taker = fundedActor("taker");
        _join(taker, Role.TAKER);
        address creator = fundedActor("creator");
        _join(creator, Role.CREATOR);
        address juror = fundedActor("juror");
        approveBusdAs(juror, address(registry));
        vm.startPrank(juror);
        registry.register();
        token.approve(address(jurors), type(uint256).max);
        jurors.stake(1000e18);
        vm.stopPrank();
        bytes32 templateId = markets.registerTemplate(QuestionClass.A_COMPUTABLE, keccak256("parser"), "fixture://template");
        IBlinkMarkets.CreateArgs memory a = IBlinkMarkets.CreateArgs(
            templateId, keccak256("spec"), "fixture://spec", false,
            uint64(block.timestamp + 3 days), uint64(block.timestamp + 4 days), uint64(block.timestamp + 6 days), 200
        );
        vm.prank(creator);
        id = markets.createMarket(a);
        vm.warp(markets.getMarket(id).openAt);
        markets.open(id);
    }

    function _join(address who, Role role) private {
        approveBusdAs(who, address(registry));
        vm.startPrank(who);
        registry.register();
        registry.joinRole(role, 100e6);
        vm.stopPrank();
        approveBusdAs(who, address(markets));
    }

    function _execute(address target, bytes memory data) private returns (bytes memory) {
        vm.prank(owner);
        return wallet.execute(target, 0, data);
    }

    function _quote(address maker) private view returns (IBlinkMarkets.Quote memory) {
        return IBlinkMarkets.Quote(
            id, markets.getMarket(id).specHash, maker, taker, 0, 100, 6000,
            uint64(block.timestamp), uint64(block.timestamp + 30), 1, markets.makerEpoch(maker)
        );
    }

    function _sign(IBlinkMarkets.Quote memory q, uint256 key) private returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, markets.hashQuote(q));
        return abi.encodePacked(r, s, v);
    }

    function _expectFill(IBlinkMarkets.Quote memory q) private {
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.expectEmit(true, true, true, true);
        emit QuoteFilled(id, markets.hashQuote(q), q.maker, taker, 0, 100, 6000, 60e6, 40e6, 0.6e6);
        vm.prank(taker);
        markets.fillQuote(q, sig);
        require(markets.consumed(markets.hashQuote(q)), "quote not consumed");
    }

    function _fail(IBlinkMarkets.Quote memory q, bytes memory sig, bytes4 error) private {
        bool wasConsumed = markets.consumed(markets.hashQuote(q));
        vm.expectRevert(error);
        vm.prank(taker);
        markets.fillQuote(q, sig);
        require(markets.consumed(markets.hashQuote(q)) == wasConsumed, "failed fill changed consumption");
    }

    function test_contractWalletMakerQuoteFills() public {
        IBlinkMarkets.Quote memory q = _quote(address(wallet));
        uint256 beforeBalance = busd.balanceOf(taker);
        _expectFill(q);
        eq(beforeBalance - busd.balanceOf(taker), 60.6e6);
        eq(markets.feePool(id), 0.6e6);
        eq(markets.makerFree(address(wallet)), 560e6);
        (uint256 walletYes, uint256 walletNo) = markets.getPosition(id, address(wallet));
        eq(walletYes, 0);
        eq(walletNo, 100);
        (uint256 takerYes, uint256 takerNo) = markets.getPosition(id, taker);
        eq(takerYes, 100);
        eq(takerNo, 0);
        _fail(q, _sign(q, OWNER_KEY), BlinkMarkets.QuoteAlreadyConsumed.selector);
        q.maker = owner;
        _expectFill(q);
        eq(markets.makerFree(owner), markets.makerFree(address(wallet)));
        (uint256 eoaYes, uint256 eoaNo) = markets.getPosition(id, owner);
        eq(eoaYes, walletYes);
        eq(eoaNo, walletNo);
        eq(markets.feePool(id), 1.2e6);
        eq(markets.getMarket(id).escrowMicros, 200e6);
    }

    function test_contractWalletWrongSignerReverts() public {
        IBlinkMarkets.Quote memory q = _quote(address(wallet));
        _fail(q, _sign(q, OTHER_KEY), BlinkMarkets.InvalidSignature.selector);
    }

    function test_contractWalletRejectingReverts() public {
        IBlinkMarkets.Quote memory q = _quote(address(wallet));
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(owner);
        wallet.setMode(1);
        _fail(q, sig, BlinkMarkets.InvalidSignature.selector);
    }

    function test_contractWalletRevertingReverts() public {
        IBlinkMarkets.Quote memory q = _quote(address(wallet));
        bytes memory sig = _sign(q, OWNER_KEY);
        vm.prank(owner);
        wallet.setMode(2);
        _fail(q, sig, BlinkMarkets.InvalidSignature.selector);
    }

    function test_contractWalletCancelAndEpoch() public {
        IBlinkMarkets.Quote memory q = _quote(address(wallet));
        bytes memory sig = _sign(q, OWNER_KEY);
        _execute(address(markets), abi.encodeCall(markets.cancelQuote, (q)));
        require(markets.cancelled(markets.hashQuote(q)), "quote not cancelled");
        _fail(q, sig, BlinkMarkets.QuoteAlreadyCancelled.selector);
        q.nonce = 2;
        sig = _sign(q, OWNER_KEY);
        _execute(address(markets), abi.encodeCall(markets.incrementMakerEpoch, ()));
        eq(markets.makerEpoch(address(wallet)), 1);
        _fail(q, sig, BlinkMarkets.EpochMismatch.selector);
    }

    function test_eoaHighSStillRejected() public {
        IBlinkMarkets.Quote memory q = _quote(owner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, markets.hashQuote(q));
        bytes memory highS = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        _fail(q, highS, BlinkMarkets.InvalidSignature.selector);
        _expectFill(q);
    }

    function test_eoaCompactSignatureStillRejected() public {
        IBlinkMarkets.Quote memory q = _quote(owner);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(OWNER_KEY, markets.hashQuote(q));
        bytes32 vs = bytes32(uint256(s) | (uint256(v - 27) << 255));
        _fail(q, abi.encodePacked(r, vs), BlinkMarkets.InvalidSignature.selector);
        _expectFill(q);
    }

    function test_walletControlsAreOwnerOnly() public {
        vm.expectRevert(bytes("not owner"));
        vm.prank(taker);
        wallet.setMode(1);
        vm.expectRevert(bytes("not owner"));
        vm.prank(taker);
        wallet.execute(address(markets), 0, abi.encodeCall(markets.incrementMakerEpoch, ()));
        eq(markets.makerEpoch(address(wallet)), 0);
    }
}
