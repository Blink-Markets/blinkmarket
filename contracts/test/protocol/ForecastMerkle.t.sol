// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Pins the vector that tests/forecast-merkle.test.ts must reproduce: the off-chain forecast
/// window tree (leaf = keccak256(bytes.concat(keccak256(abi.encode(digest)))), sorted-pair hashing,
/// an odd last node carried up) verifies with OpenZeppelin MerkleProof.verify.
contract ForecastMerkleTest {
    uint256 internal constant COUNT = 5;

    function _digests() internal pure returns (bytes32[COUNT] memory d) {
        for (uint256 i = 0; i < COUNT; i++) d[i] = keccak256(abi.encodePacked("blink-forecast-digest-", i));
    }

    function _leaf(bytes32 digest) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(digest))));
    }

    function _pair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    function _sortedLeaves() internal pure returns (bytes32[] memory leaves) {
        bytes32[COUNT] memory d = _digests();
        leaves = new bytes32[](COUNT);
        for (uint256 i = 0; i < COUNT; i++) leaves[i] = _leaf(d[i]);
        for (uint256 i = 1; i < COUNT; i++)
            for (uint256 j = i; j > 0 && leaves[j - 1] > leaves[j]; j--) {
                (leaves[j - 1], leaves[j]) = (leaves[j], leaves[j - 1]);
            }
    }

    /// Root and proof of `leaves[index]` by the same rule the TypeScript tree uses.
    function _rootAndProof(bytes32[] memory leaves, uint256 index) internal pure returns (bytes32, bytes32[] memory) {
        bytes32[] memory proof = new bytes32[](8);
        uint256 used;
        bytes32[] memory level = leaves;
        while (level.length > 1) {
            if ((index ^ 1) < level.length) proof[used++] = level[index ^ 1];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i = 0; i < level.length; i += 2)
                next[i / 2] = i + 1 < level.length ? _pair(level[i], level[i + 1]) : level[i];
            level = next;
            index >>= 1;
        }
        bytes32[] memory trimmed = new bytes32[](used);
        for (uint256 i = 0; i < used; i++) trimmed[i] = proof[i];
        return (level[0], trimmed);
    }

    function test_everyLeafVerifiesWithOpenZeppelin() public pure {
        bytes32[] memory leaves = _sortedLeaves();
        (bytes32 root, ) = _rootAndProof(leaves, 0);
        for (uint256 i = 0; i < leaves.length; i++) {
            (bytes32 r, bytes32[] memory proof) = _rootAndProof(leaves, i);
            require(r == root, "root differs");
            require(MerkleProof.verify(proof, root, leaves[i]), "proof rejected");
        }
    }

    error Root(bytes32 root);

    function test_pinnedVector() public pure {
        bytes32[] memory leaves = _sortedLeaves();
        (bytes32 root, ) = _rootAndProof(leaves, 0);
        if (root != PINNED_ROOT) revert Root(root);
    }

    bytes32 internal constant PINNED_ROOT = 0x7afdf524a16341781fad2ea11713a925f30da75940cf6144379c5e0397bdab40;
}
