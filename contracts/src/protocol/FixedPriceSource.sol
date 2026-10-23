// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBlinkPriceSource} from "./interfaces/IBlinkPriceSource.sol";

/// @notice Testnet price of the platform token. Immutable; the token has no real value.
contract FixedPriceSource is IBlinkPriceSource {
    error WrongChain();
    error InvalidPrice();
    uint256 public immutable tokenPriceMicros;

    constructor(uint256 priceMicros) {
        if (block.chainid != 84532) revert WrongChain();
        if (priceMicros == 0) revert InvalidPrice();
        tokenPriceMicros = priceMicros;
    }
}
