// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Permissionless first-seen timestamp for a 32-byte root (forecast window roots, spec §5.10).
/// A root can be anchored once; the stored time is the block timestamp of that first call.
contract BlinkAnchor {
    error WrongChain();
    error ZeroRoot();
    error AlreadyAnchored();
    event Anchored(bytes32 indexed root, address indexed by, uint64 at);

    mapping(bytes32 => uint64) public anchoredAt;

    constructor() {
        if (block.chainid != 84532) revert WrongChain();
    }

    function anchor(bytes32 root) external {
        if (root == bytes32(0)) revert ZeroRoot();
        if (anchoredAt[root] != 0) revert AlreadyAnchored();
        uint64 at = uint64(block.timestamp);
        anchoredAt[root] = at;
        emit Anchored(root, msg.sender, at);
    }
}
