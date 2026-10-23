// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IBlinkJurors {
    function stake(uint256 amount) external;
    function requestUnstake(uint256 amount) external;
    function withdrawUnstaked() external;
    function claimRewards() external;

    function stakeAt(address juror, uint256 timepoint) external view returns (uint256);
    function totalStakeAt(uint256 timepoint) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function attackCostMicros() external view returns (uint256);

    // callable by markets or resolution, after transferring the bUSD in
    function notifyReward(uint256 busdAmount) external;

    // callable by resolution only
    function slash(address juror, uint256 amount, address to) external;
    function reward(address juror, uint256 tokenAmount) external;
}
