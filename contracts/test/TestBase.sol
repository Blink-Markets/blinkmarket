// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlinkMarket} from "../src/BlinkMarket.sol";
import {BlinkTestUSD} from "../src/BlinkTestUSD.sol";
import {IBlinkMarket} from "../src/interfaces/IBlinkMarket.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function chainId(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant MAKER_KEY = 0xA11CE;
    address internal maker;
    address internal constant ADMIN = address(0x100);
    address internal constant PROPOSER = address(0x101);
    address internal constant CHALLENGER = address(0x102);
    address internal constant ARBITER = address(0x103);
    address internal constant TAKER = address(0x200);
    BlinkTestUSD internal token;
    BlinkMarket internal market;
    uint256 internal id;
    uint256 internal serial;

    function setUp() public virtual {
        vm.chainId(84532);
        vm.warp(1_000_000);
        maker = vm.addr(MAKER_KEY);
        token = new BlinkTestUSD(address(this));
        market = new BlinkMarket(address(token), maker, ADMIN, PROPOSER, CHALLENGER, ARBITER);
        token.mint(maker, 1_000_000e6);
        token.mint(TAKER, 1_000_000e6);
        vm.startPrank(maker);
        token.approve(address(market), type(uint256).max);
        market.depositMaker(100_000e6);
        vm.stopPrank();
        vm.prank(TAKER);
        token.approve(address(market), type(uint256).max);
        vm.prank(ADMIN);
        market.setTakerAllowed(TAKER, true);
        id = newMarket(10000, 500);
    }

    function newMarket(uint64 maxPairs, uint64 maxTaker) internal returns (uint256 result) {
        vm.prank(ADMIN);
        result = market.createMarket(
            keccak256(abi.encode(++serial)),
            "fixture://REPLAY",
            IBlinkMarket.Mode.REPLAY,
            uint64(block.timestamp + 1000),
            uint64(block.timestamp + 2000),
            uint64(block.timestamp + 3000),
            120,
            maxPairs,
            maxTaker
        );
    }

    function quote(uint8 side, uint64 quantity, uint16 price) internal returns (IBlinkMarket.Quote memory q) {
        q = IBlinkMarket.Quote(
            id,
            market.getMarket(id).specHash,
            maker,
            TAKER,
            side,
            quantity,
            price,
            uint64(block.timestamp),
            uint64(block.timestamp + 30),
            ++serial,
            market.currentMakerEpoch()
        );
    }

    function signature(IBlinkMarket.Quote memory q) internal returns (bytes memory) {
        return signDigest(market.hashQuote(q));
    }

    function signDigest(bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MAKER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function fill(IBlinkMarket.Quote memory q) internal {
        bytes memory sig = signature(q);
        vm.prank(TAKER);
        market.fillQuote(q, sig);
    }

    function failFill(IBlinkMarket.Quote memory q, bytes4 error) internal {
        bytes32 digest = market.hashQuote(q);
        uint256 balance = token.balanceOf(address(market));
        uint256 free = market.makerFreeBalance();
        uint256 escrow = market.getMarket(id).escrowMicros;
        bytes memory sig = signature(q);
        vm.expectRevert(error);
        vm.prank(TAKER);
        market.fillQuote(q, sig);
        eq(token.balanceOf(address(market)), balance);
        eq(market.makerFreeBalance(), free);
        eq(market.getMarket(id).escrowMicros, escrow);
        require(!market.consumed(digest), "failed digest consumed");
    }

    function propose(IBlinkMarket.Outcome outcome) internal {
        vm.warp(market.getMarket(id).closeAt);
        vm.prank(PROPOSER);
        market.proposeOutcome(id, outcome, keccak256("report"));
    }

    function finalize(IBlinkMarket.Outcome outcome) internal {
        propose(outcome);
        vm.warp(block.timestamp + 120);
        market.finalizeUnchallenged(id);
    }

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint mismatch");
    }
}
