// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlinkTestUSD} from "../BlinkTestUSD.sol";
import {BlinkToken} from "./BlinkToken.sol";

/// @notice Testnet faucet: deploys bUSD and the platform token with itself as the only minter.
contract BlinkFaucet {
    error WrongChain();
    error ClaimTooSoon();
    event Claimed(address indexed account, uint256 busdMicros, uint256 tokenUnits);

    uint256 public constant CLAIM_BUSD = 1_000e6;
    uint256 public constant CLAIM_TOKEN = 1_000e18;
    uint64 public constant CLAIM_INTERVAL = 1 days;

    BlinkTestUSD public immutable busd;
    BlinkToken public immutable token;
    mapping(address => uint64) public nextClaimAt;

    constructor() {
        if (block.chainid != 84532) revert WrongChain();
        busd = new BlinkTestUSD(address(this));
        token = new BlinkToken(address(this));
    }

    function claim() external {
        if (block.timestamp < nextClaimAt[msg.sender]) revert ClaimTooSoon();
        nextClaimAt[msg.sender] = uint64(block.timestamp) + CLAIM_INTERVAL;
        busd.mint(msg.sender, CLAIM_BUSD);
        token.mint(msg.sender, CLAIM_TOKEN);
        emit Claimed(msg.sender, CLAIM_BUSD, CLAIM_TOKEN);
    }
}
