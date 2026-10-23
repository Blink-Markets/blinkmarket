// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlinkFaucet} from "../../src/protocol/BlinkFaucet.sol";
import {BlinkToken} from "../../src/protocol/BlinkToken.sol";
import {BlinkTestUSD} from "../../src/BlinkTestUSD.sol";
import {FixedPriceSource} from "../../src/protocol/FixedPriceSource.sol";

interface Vm {
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function roll(uint256) external;
    function chainId(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
    function expectEmit(bool, bool, bool, bool) external;
    function getNonce(address) external view returns (uint64);
    function computeCreateAddress(address, uint256) external pure returns (address);
}

abstract contract ProtocolBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 internal constant TOKEN_PRICE_MICROS = 1_000_000;
    BlinkFaucet internal faucet;
    BlinkTestUSD internal busd;
    BlinkToken internal token;
    FixedPriceSource internal priceSource;

    function setUp() public virtual {
        vm.chainId(84532);
        vm.warp(1_000_000);
        faucet = new BlinkFaucet();
        busd = faucet.busd();
        token = faucet.token();
        priceSource = new FixedPriceSource(TOKEN_PRICE_MICROS);
    }

    function actor(string memory label) internal pure returns (address) {
        return address(uint160(uint256(keccak256(bytes(label)))));
    }

    function claimAs(address who) internal {
        vm.prank(who);
        faucet.claim();
    }

    function eq(uint256 a, uint256 b) internal pure {
        require(a == b, "uint mismatch");
    }
}
