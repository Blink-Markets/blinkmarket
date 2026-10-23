// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Role, Params, GenerationAddresses} from "../BlinkTypes.sol";

interface IBlinkRegistry {
    function register() external;
    function joinRole(Role role, uint256 amount) external;
    function addRoleStake(Role role, uint256 amount) external;
    function requestRoleExit(Role role) external;
    function withdrawRole(Role role) external;
    function importCredit() external;

    function isRegistered(address account) external view returns (bool);
    function hasRole(address account, Role role) external view returns (bool);
    function roleStake(address account, Role role) external view returns (uint256);
    function creditOf(address account, Role role) external view returns (uint256);
    function bondFor(address account, Role role, uint256 baseBond) external view returns (uint256);
    function limitMultiplierBps(address account, Role role) external view returns (uint256);
    function meetsThreshold(address account, Role role, uint32 threshold) external view returns (bool);
    function params() external view returns (Params memory);
    function addresses() external view returns (GenerationAddresses memory);

    // callable only by markets, resolution or jurors of this generation
    function reportGain(address account, Role role, uint256 maxPayout) external;
    function reportLoss(address account, Role role, uint256 maxPayout) external;
    function slashRole(address account, Role role) external returns (uint256 slashed);
}
