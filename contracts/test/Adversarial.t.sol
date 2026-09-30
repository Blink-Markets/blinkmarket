// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase, BlinkMarket, BlinkTestUSD, IBlinkMarket} from "./TestBase.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract HostileToken is ERC20 {
    bool public failTransfer;
    bool public attack;
    bool public reentered;
    bytes4 public reentryError;
    address public target;
    constructor() ERC20("Hostile test double", "BAD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function configure(address target_, bool fail_, bool attack_) external {
        target = target_;
        failTransfer = fail_;
        attack = attack_;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!failTransfer, "transfer failure");
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        require(!failTransfer, "transfer failure");
        if (attack) {
            bytes memory reason;
            (reentered, reason) = target.call(abi.encodeCall(IBlinkMarket.redeem, (1)));
            reentryError = bytes4(reason);
        }
        return super.transferFrom(from, to, amount);
    }
}

contract WrongDecimals is ERC20 {
    constructor() ERC20("Wrong", "WRONG") {}
}

contract AdversarialTest is TestBase {
    function test_transferFailureRollbackAndReentrancy() public {
        HostileToken bad = new HostileToken();
        market = new BlinkMarket(address(bad), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        id = newMarket(10000, 500);
        bad.mint(maker, 1000e6);
        bad.mint(TAKER, 1000e6);
        vm.startPrank(maker);
        bad.approve(address(market), type(uint256).max);
        market.depositMaker(100e6);
        vm.stopPrank();
        vm.prank(TAKER);
        bad.approve(address(market), type(uint256).max);
        vm.prank(ADMIN);
        market.setTakerAllowed(TAKER, true);
        IBlinkMarket.Quote memory q = quote(0, 100, 6000);
        bytes memory sig = signature(q);
        bad.configure(address(market), true, false);
        vm.expectRevert();
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        require(!market.consumed(market.hashQuote(q)));
        eq(market.makerFreeBalance(), 100e6);
        eq(market.getMarket(id).escrowMicros, 0);
        bad.configure(address(market), false, true);
        fill(q);
        require(!bad.reentered(), "reentry succeeded");
        require(
            bad.reentryError() == bytes4(keccak256("ReentrancyGuardReentrantCall()")), "guard did not block reentry"
        );
        finalize(IBlinkMarket.Outcome.YES);
        bad.configure(address(market), true, false);
        vm.expectRevert();
        vm.prank(TAKER);
        market.redeem(id);
        (uint256 yes,) = market.getPosition(id, TAKER);
        eq(yes, 100);
        eq(market.getMarket(id).escrowMicros, 100e6);
        vm.expectRevert();
        vm.prank(maker);
        market.withdrawMaker(1e6);
        eq(market.makerFreeBalance(), 60e6);
        bad.configure(address(market), false, false);
        vm.prank(TAKER);
        market.redeem(id);
        eq(market.getMarket(id).escrowMicros, 0);
    }

    function test_nonCanonicalSignatureAndWrongAsset() public {
        IBlinkMarket.Quote memory q = quote(0, 1, 5000);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, market.hashQuote(q));
        uint256 curveN = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
        bytes memory high = abi.encodePacked(r, bytes32(curveN - uint256(s)), uint8(v == 27 ? 28 : 27));
        vm.expectRevert(BlinkMarket.InvalidSignature.selector);
        vm.prank(TAKER);
        market.fillQuote(q, high);
        WrongDecimals bad = new WrongDecimals();
        vm.expectRevert(BlinkMarket.InvalidCollateral.selector);
        new BlinkMarket(address(bad), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        vm.expectRevert(BlinkMarket.InvalidAddress.selector);
        new BlinkMarket(address(token), address(this), ADMIN, PROPOSER, CHALLENGER, ARBITER);
        vm.expectRevert(BlinkMarket.InvalidAddress.selector);
        new BlinkMarket(address(token), maker, address(0), PROPOSER, CHALLENGER, ARBITER);
        vm.expectRevert(BlinkTestUSD.UnauthorizedMinter.selector);
        vm.prank(TAKER);
        token.mint(TAKER, 1);
    }

    function test_unauthorizedRoleMatrix() public {
        IBlinkMarket.Quote memory q = quote(0, 1, 5000);
        bytes[] memory calls = new bytes[](9);
        calls[0] = abi.encodeCall(market.setMarketTradingPaused, (id, true));
        calls[1] = abi.encodeCall(market.setTakerAllowed, (TAKER, false));
        calls[2] = abi.encodeCall(market.depositMaker, (1));
        calls[3] = abi.encodeCall(market.cancelQuote, (q));
        calls[4] = abi.encodeCall(market.incrementMakerEpoch, ());
        calls[5] = abi.encodeCall(market.proposeOutcome, (id, IBlinkMarket.Outcome.YES, keccak256("r")));
        calls[6] = abi.encodeCall(market.challengeOutcome, (id, keccak256("c")));
        calls[7] = abi.encodeCall(market.arbitrate, (id, IBlinkMarket.Outcome.NO, keccak256("a")));
        calls[8] = abi.encodeCall(
            market.createMarket,
            (
                keccak256("x"),
                "x",
                IBlinkMarket.Mode.REPLAY,
                uint64(1001000),
                uint64(1002000),
                uint64(1003000),
                uint32(120),
                uint64(100),
                uint64(100)
            )
        );
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory reason) = address(market).call(calls[i]);
            require(!ok);
            require(bytes4(reason) == BlinkMarket.UnauthorizedRole.selector);
        }
    }

    function test_scheduleAndCapValidation() public {
        vm.startPrank(ADMIN);
        vm.expectRevert(BlinkMarket.InvalidSchedule.selector);
        market.createMarket(keccak256("a"), "x", IBlinkMarket.Mode.LIVE, 1001000, 1002000, 1003000, 120, 100, 100);
        vm.expectRevert(BlinkMarket.InvalidSchedule.selector);
        market.createMarket(keccak256("b"), "x", IBlinkMarket.Mode.REPLAY, 1001000, 1002000, 1002120, 120, 100, 100);
        vm.expectRevert(BlinkMarket.InvalidCap.selector);
        market.createMarket(keccak256("c"), "x", IBlinkMarket.Mode.REPLAY, 1001000, 1002000, 1003000, 120, 10001, 100);
        vm.expectRevert(BlinkMarket.InvalidCap.selector);
        market.createMarket(keccak256("d"), "x", IBlinkMarket.Mode.REPLAY, 1001000, 1002000, 1003000, 120, 10000, 501);
        vm.expectRevert(BlinkMarket.InvalidSpec.selector);
        market.createMarket(bytes32(0), "x", IBlinkMarket.Mode.REPLAY, 1001000, 1002000, 1003000, 120, 100, 100);
        vm.stopPrank();
        vm.expectRevert(BlinkMarket.MarketNotFound.selector);
        market.getMarket(0);
    }
}
