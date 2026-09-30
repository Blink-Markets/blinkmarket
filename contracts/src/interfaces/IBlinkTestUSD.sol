// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Future implementation extends a pinned standard ERC-20 library.
/// @dev This is only the Blink-specific extension, not a full ERC-20 ABI.
interface IBlinkTestUSD {
    function mint(address to, uint256 amountMicros) external;
    function decimals() external view returns (uint8);
}
