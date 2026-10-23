// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BlinkFaucet} from "../../src/protocol/BlinkFaucet.sol";
import {BlinkToken} from "../../src/protocol/BlinkToken.sol";
import {BlinkTestUSD} from "../../src/BlinkTestUSD.sol";
import {FixedPriceSource} from "../../src/protocol/FixedPriceSource.sol";
import {BlinkRegistry} from "../../src/protocol/BlinkRegistry.sol";
import {BlinkJurors} from "../../src/protocol/BlinkJurors.sol";
import {BlinkMarkets} from "../../src/protocol/BlinkMarkets.sol";
import {BlinkResolution} from "../../src/protocol/BlinkResolution.sol";
import {Params, GenerationAddresses} from "../../src/protocol/BlinkTypes.sol";

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
    address internal treasury;

    function setUp() public virtual {
        vm.chainId(84532);
        vm.warp(1_000_000);
        faucet = new BlinkFaucet();
        busd = faucet.busd();
        token = faucet.token();
        priceSource = new FixedPriceSource(TOKEN_PRICE_MICROS);
        treasury = actor("treasury");
    }

    // Test values satisfying every Params invariant (shares sum 10000, maxRounds <= 4, min windows <= windows).
    function defaultParams() internal pure returns (Params memory p) {
        p.registrationFee = 10e6;
        p.minRoleStake = 100e6;
        p.roleExitCooldown = 1 days;
        p.feeBps = 100;
        p.treasuryShareBps = 3000;
        p.creatorShareBps = 2500;
        p.resolutionShareBps = 1500;
        p.jurorShareBps = 1500;
        p.bountyShareBps = 1500;
        p.keeperTipBps = 500;
        p.creationBondBps = 500;
        p.proposerBondBps = 500;
        p.challengeBondBps = 500;
        p.jurorBondCutBps = 2000;
        p.maxCreditDiscountBps = 5000;
        p.creditDiscountStepBps = 100;
        p.creditMultiplierStepBps = 500;
        p.maxCreditMultiplierBps = 40_000;
        p.creatorExposureMultiple = 50_000;
        p.creationWindow = [uint64(1 hours), 4 hours, 1 days];
        p.firstUseExtraWindow = 1 hours;
        p.resultChallengeWindow = [uint64(1 hours), 4 hours, 1 days];
        p.minResultChallengeWindow = [uint64(10 minutes), 30 minutes, 1 hours];
        p.challengeWindowStepSeconds = 60;
        p.commitSeconds = 1 hours;
        p.revealSeconds = 1 hours;
        p.appealSeconds = 1 hours;
        p.maxRounds = 3;
        p.quorumBps = [uint16(2000), 3000, 4000, 5000];
        p.nonRevealSlashBps = 1000;
        p.incoherentSlashBps = 500;
        p.roleSlashBps = 1000;
        p.jurorUnstakeCooldown = 2 days;
        p.securityMultipleBps = 20_000;
        p.maxMarketPairs = 10_000;
        p.maxTakerShares = 500;
        p.maxFillShares = 100;
        p.creditHalfLife = 30 days;
        p.creditUnitMicros = 100e6;
        p.creditGainCap = 50;
        p.creditLossMultiplier = 3;
        p.classCCreditThreshold = 10;
        p.roundCreditThreshold = [uint32(0), 5, 10, 20];
        p.phaseInFinalizedMarkets = 3;
        p.importDiscountBps = 5000;
        p.replayAllowed = true;
    }

    // Addresses of a generation whose four contracts the deployer creates next, in order
    // registry, jurors, markets, resolution (nonce n..n+3).
    function predictGeneration(address deployer, address previous) internal view returns (GenerationAddresses memory a) {
        uint64 n = vm.getNonce(deployer);
        a.registry = vm.computeCreateAddress(deployer, n);
        a.jurors = vm.computeCreateAddress(deployer, n + 1);
        a.markets = vm.computeCreateAddress(deployer, n + 2);
        a.resolution = vm.computeCreateAddress(deployer, n + 3);
        a.collateral = address(busd);
        a.token = address(token);
        a.priceSource = address(priceSource);
        a.treasury = treasury;
        a.previousRegistry = previous;
    }

    function fundedActor(string memory label) internal returns (address who) {
        who = actor(label);
        claimAs(who);
    }

    function deployGeneration(Params memory p, address previous) internal returns (
        BlinkRegistry registry, BlinkJurors jurors, BlinkMarkets markets, BlinkResolution resolution
    ) {
        GenerationAddresses memory a = predictGeneration(address(this), previous);
        registry = new BlinkRegistry(p, a);
        jurors = new BlinkJurors(a);
        markets = new BlinkMarkets(a);
        resolution = new BlinkResolution(a);
    }

    function approveBusdAs(address who, address spender) internal {
        vm.prank(who);
        busd.approve(spender, type(uint256).max);
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
