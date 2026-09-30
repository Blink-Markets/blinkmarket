// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice No-value Base Sepolia test asset. No upgrade or minter rotation.
contract BlinkTestUSD is ERC20 {
    error WrongChain();
    error InvalidMinter();
    error UnauthorizedMinter();
    address public immutable minter;

    constructor(address minter_) ERC20("Blink Test USD", "bUSD") {
        if (block.chainid != 84532) revert WrongChain();
        if (minter_ == address(0)) revert InvalidMinter();
        minter = minter_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amountMicros) external {
        if (msg.sender != minter) revert UnauthorizedMinter();
        _mint(to, amountMicros);
    }
}
