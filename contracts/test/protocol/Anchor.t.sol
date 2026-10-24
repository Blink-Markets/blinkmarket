// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ProtocolBase} from "./ProtocolBase.sol";
import {BlinkAnchor} from "../../src/protocol/BlinkAnchor.sol";

contract AnchorTest is ProtocolBase {
    event Anchored(bytes32 indexed root, address indexed by, uint64 at);

    BlinkAnchor internal anchorC;

    function setUp() public override {
        super.setUp();
        anchorC = new BlinkAnchor();
    }

    function test_anchorRecordsFirstTime() public {
        bytes32 root = keccak256("window-1");
        address alice = actor("alice");
        eq(anchorC.anchoredAt(root), 0);
        vm.expectEmit(true, true, false, true);
        emit Anchored(root, alice, uint64(block.timestamp));
        vm.prank(alice);
        anchorC.anchor(root);
        eq(anchorC.anchoredAt(root), block.timestamp);
    }

    function test_reanchorReverts() public {
        bytes32 root = keccak256("window-1");
        anchorC.anchor(root);
        uint256 first = anchorC.anchoredAt(root);
        vm.warp(block.timestamp + 100);
        vm.prank(actor("bob"));
        vm.expectRevert(BlinkAnchor.AlreadyAnchored.selector);
        anchorC.anchor(root);
        eq(anchorC.anchoredAt(root), first);
    }

    function test_zeroRootReverts() public {
        vm.expectRevert(BlinkAnchor.ZeroRoot.selector);
        anchorC.anchor(bytes32(0));
    }

    function test_wrongChainReverts() public {
        vm.chainId(1);
        vm.expectRevert(BlinkAnchor.WrongChain.selector);
        new BlinkAnchor();
    }
}
