// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IBlinkPriceSource {
    /// @notice bUSD micros per 1e18 token units; a conservative price.
    function tokenPriceMicros() external view returns (uint256);
}
