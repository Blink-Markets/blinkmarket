// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {TestBase, Vm, BlinkMarket, BlinkTestUSD, IBlinkMarket} from "./TestBase.sol";

/// @dev Independent ghost positions/collateral updated from successful operation inputs.
contract LedgerHandler {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    BlinkMarket public market;
    BlinkTestUSD public token;
    address public maker;
    address private constant ADMIN = address(0x100);
    uint256 public ghostFree;
    uint256 public ghostDonations;
    mapping(address => uint256) public ghostWallet;
    mapping(uint256 => uint256) public ghostPairs;
    mapping(uint256 => uint256) public ghostEscrow;
    mapping(uint256 => mapping(address => uint256)) public ghostYes;
    mapping(uint256 => mapping(address => uint256)) public ghostNo;
    mapping(uint256 => mapping(address => uint256)) public ghostBought;
    uint256 private nonce;

    constructor(BlinkMarket m, BlinkTestUSD t, address maker_) {
        market = m;
        token = t;
        maker = maker_;
        ghostFree = 100_000e6;
        ghostWallet[maker] = 900_000e6;
        for (uint256 i; i < 3; ++i) {
            ghostWallet[actor(i)] = 1_000_000e6;
        }
    }

    function actor(uint256 seed) public view returns (address) {
        return seed % 4 == 3 ? maker : address(uint160(0x200 + seed % 4));
    }

    function fill(uint256 seed, uint256 accountSeed, uint64 shares, uint16 price, bool yes) external {
        uint256 id = seed % 2 + 1;
        address taker = actor(accountSeed % 3);
        IBlinkMarket.Market memory m = market.getMarket(id);
        if (m.state != IBlinkMarket.State.OPEN || block.timestamp + 30 > m.closeAt) return;
        shares = uint64(uint256(shares) % 100 + 1);
        price = uint16(uint256(price) % 9999 + 1);
        IBlinkMarket.Quote memory q = IBlinkMarket.Quote(
            id,
            m.specHash,
            maker,
            taker,
            yes ? 0 : 1,
            shares,
            price,
            uint64(block.timestamp),
            uint64(block.timestamp + 30),
            ++nonce,
            market.currentMakerEpoch()
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xA11CE, market.hashQuote(q));
        uint256 paid = uint256(shares) * price * 100;
        bytes4 expectedError;
        if (market.globalTradingPaused() || m.paused) {
            expectedError = BlinkMarket.TradingPaused.selector;
        } else if (ghostPairs[id] + shares > m.maxPairs || ghostBought[id][taker] + shares > m.maxTakerShares) {
            expectedError = BlinkMarket.CapExceeded.selector;
        } else if (ghostFree < uint256(shares) * 1e6 - paid) {
            expectedError = BlinkMarket.InsufficientMakerBalance.selector;
        }
        if (expectedError != bytes4(0)) vm.expectRevert(expectedError);
        vm.prank(taker);
        market.fillQuote(q, abi.encodePacked(r, s, v));
        if (expectedError == bytes4(0)) {
            ghostFree -= uint256(shares) * 1e6 - paid;
            ghostWallet[taker] -= paid;
            ghostEscrow[id] += uint256(shares) * 1e6;
            ghostPairs[id] += shares;
            ghostBought[id][taker] += shares;
            if (yes) {
                ghostYes[id][taker] += shares;
                ghostNo[id][maker] += shares;
            } else {
                ghostNo[id][taker] += shares;
                ghostYes[id][maker] += shares;
            }
        }
    }

    function deposit(uint256 amount) external {
        amount = amount % 1000e6 + 1;
        vm.prank(maker);
        market.depositMaker(amount);
        ghostFree += amount;
        ghostWallet[maker] -= amount;
    }

    function withdraw(uint256 amount) external {
        amount = amount % 1000e6 + 1;
        if (amount > ghostFree) {
            vm.expectRevert(BlinkMarket.InsufficientMakerBalance.selector);
            vm.prank(maker);
            market.withdrawMaker(amount);
            return;
        }
        vm.prank(maker);
        market.withdrawMaker(amount);
        ghostFree -= amount;
        ghostWallet[maker] += amount;
    }

    function pause(bool paused, bool global, uint256 seed) external {
        vm.prank(ADMIN);
        if (global) market.setGlobalTradingPaused(paused);
        else market.setMarketTradingPaused(seed % 2 + 1, paused);
    }

    function epoch() external {
        vm.prank(maker);
        market.incrementMakerEpoch();
    }

    function cancel(uint256 seed) external {
        uint256 id = seed % 2 + 1;
        IBlinkMarket.Quote memory q = IBlinkMarket.Quote(
            id,
            market.getMarket(id).specHash,
            maker,
            actor(seed % 3),
            0,
            1,
            5000,
            uint64(block.timestamp),
            uint64(block.timestamp + 30),
            ++nonce,
            market.currentMakerEpoch()
        );
        vm.prank(maker);
        market.cancelQuote(q);
    }

    function tick(uint32 delta) external {
        vm.warp(block.timestamp + uint256(delta) % 300);
    }

    function resolve(uint256 seed, uint8 result, uint8 action) external {
        uint256 id = seed % 2 + 1;
        IBlinkMarket.Market memory m = market.getMarket(id);
        if (m.state == IBlinkMarket.State.FINAL) return;
        if (block.timestamp >= m.hardDeadline) {
            market.finalizeTimeout(id);
            return;
        }
        IBlinkMarket.Outcome outcome = IBlinkMarket.Outcome(result % 3);
        if (m.state == IBlinkMarket.State.OPEN && block.timestamp >= m.closeAt && block.timestamp < m.proposalDeadline)
        {
            vm.prank(address(0x101));
            market.proposeOutcome(id, outcome, keccak256("r"));
        } else if (m.state == IBlinkMarket.State.PROPOSED) {
            if (block.timestamp < uint256(m.proposedAt) + m.challengeSeconds) {
                if (action % 2 == 0) {
                    vm.prank(address(0x102));
                    market.challengeOutcome(id, keccak256("c"));
                }
            } else {
                market.finalizeUnchallenged(id);
            }
        } else if (m.state == IBlinkMarket.State.DISPUTED && action % 2 == 0) {
            vm.prank(address(0x103));
            market.arbitrate(id, outcome, keccak256("a"));
        }
    }

    function redeem(uint256 seed, uint256 accountSeed) external {
        uint256 id = seed % 2 + 1;
        IBlinkMarket.Market memory m = market.getMarket(id);
        address account = actor(accountSeed);
        if (m.state != IBlinkMarket.State.FINAL || ghostYes[id][account] + ghostNo[id][account] == 0) return;
        uint256 payout = m.finalOutcome == IBlinkMarket.Outcome.YES
            ? ghostYes[id][account] * 1e6
            : m.finalOutcome == IBlinkMarket.Outcome.NO
                ? ghostNo[id][account] * 1e6
                : (ghostYes[id][account] + ghostNo[id][account]) * 500000;
        uint256 beforeBalance = token.balanceOf(account);
        vm.prank(account);
        market.redeem(id);
        require(token.balanceOf(account) == beforeBalance + payout, "ghost payout");
        ghostWallet[account] += payout;
        ghostEscrow[id] -= payout;
        ghostYes[id][account] = 0;
        ghostNo[id][account] = 0;
    }

    function donate(uint256 amount, uint256 accountSeed) external {
        amount = amount % 100e6;
        address account = actor(accountSeed % 3);
        vm.prank(account);
        token.transfer(address(market), amount);
        ghostWallet[account] -= amount;
        ghostDonations += amount;
    }
}

contract LedgerInvariantTest is TestBase {
    LedgerHandler private handler;

    function setUp() public override {
        super.setUp();
        // The second market can hit its aggregate cap before all three personal caps.
        newMarket(600, 500);
        for (uint256 i = 1; i < 3; ++i) {
            address taker = address(uint160(0x200 + i));
            token.mint(taker, 1_000_000e6);
            vm.prank(taker);
            token.approve(address(market), type(uint256).max);
            vm.prank(ADMIN);
            market.setTakerAllowed(taker, true);
        }
        handler = new LedgerHandler(market, token, maker);
        // Every run starts with mixed-side exposure for every taker in both markets.
        // This prevents vacuous runs where time advances before any successful fill.
        for (uint256 i; i < 2; ++i) {
            for (uint256 a; a < 3; ++a) {
                handler.fill(i, a, 9, 3999, true);
                handler.fill(i, a, 9, 5999, false);
            }
        }
    }

    function targetContracts() public view returns (address[] memory targets) {
        targets = new address[](1);
        targets[0] = address(handler);
    }

    function afterInvariant() public {
        // Always settle/redeem the remaining positions, even when a random run has not advanced far enough.
        for (uint256 i = 1; i <= 2; ++i) {
            uint256 deadline = market.getMarket(i).hardDeadline;
            if (block.timestamp < deadline) vm.warp(deadline);
            handler.resolve(i - 1, 2, 0);
            uint256 first = uint256(keccak256(abi.encode(block.timestamp, handler.ghostPairs(i)))) % 4;
            for (uint256 a; a < 4; ++a) {
                handler.redeem(i - 1, (first + a) % 4);
            }
            require(market.getMarket(i).escrowMicros == 0, "residual escrow");
        }
        invariant_ghostLedgerAndSolvency();
    }

    function testFuzz_multiUserSettlement(uint256 seed, uint8 outcome) public {
        // Interleave users and markets, then exercise every redemption permutation.
        for (uint256 j; j < 24; ++j) {
            uint256 random = uint256(keccak256(abi.encode(seed, j)));
            handler.fill(j % 2, (j / 2) % 3, uint64(random), uint16(random >> 64), random % 2 == 0);
            invariant_ghostLedgerAndSolvency();
        }
        vm.warp(market.getMarket(1).closeAt);
        for (uint256 i; i < 2; ++i) {
            handler.resolve(i, outcome % 3, 0);
        }
        vm.warp(block.timestamp + 120);
        for (uint256 i; i < 2; ++i) {
            handler.resolve(i, outcome % 3, 0);
        }
        uint256[4] memory order = [uint256(0), 1, 2, 3];
        uint256 permutation = seed % 24;
        for (uint256 remaining = 4; remaining > 0; --remaining) {
            uint256 index = permutation % remaining;
            permutation /= remaining;
            uint256 account = order[index];
            order[index] = order[remaining - 1];
            for (uint256 i; i < 2; ++i) {
                handler.redeem(i, account);
                invariant_ghostLedgerAndSolvency();
                // Already redeemed accounts cannot collect again.
                address redeemer = handler.actor(account);
                vm.expectRevert(BlinkMarket.NoPosition.selector);
                vm.prank(redeemer);
                market.redeem(i + 1);
            }
        }
        require(market.getMarket(1).escrowMicros + market.getMarket(2).escrowMicros == 0, "residual escrow");
    }

    function invariant_ghostLedgerAndSolvency() public view {
        require(market.makerFreeBalance() == handler.ghostFree(), "free mismatch");
        uint256 escrow;
        for (uint256 i = 1; i <= 2; ++i) {
            IBlinkMarket.Market memory m = market.getMarket(i);
            escrow += m.escrowMicros;
            uint256 expectedEscrow = handler.ghostEscrow(i);
            uint256 totalYes;
            uint256 totalNo;
            for (uint256 a; a < 4; ++a) {
                address account = handler.actor(a);
                uint256 yes = handler.ghostYes(i, account);
                uint256 no = handler.ghostNo(i, account);
                totalYes += yes;
                totalNo += no;
                (uint256 y, uint256 n) = market.getPosition(i, account);
                require(y == yes && n == no, "account position");
                require(token.balanceOf(account) == handler.ghostWallet(account), "wallet mismatch");
                require(market.cumulativeTakerShares(i, account) == handler.ghostBought(i, account), "cumulative cap");
                require(handler.ghostBought(i, account) <= m.maxTakerShares, "personal cap exceeded");
            }
            if (m.state == IBlinkMarket.State.FINAL) {
                expectedEscrow = m.finalOutcome == IBlinkMarket.Outcome.YES
                    ? totalYes * 1e6
                    : m.finalOutcome == IBlinkMarket.Outcome.NO ? totalNo * 1e6 : (totalYes + totalNo) * 500000;
            }
            require(expectedEscrow == handler.ghostEscrow(i), "outstanding payout mismatch");
            require(m.escrowMicros == expectedEscrow && m.totalMintedPairs == handler.ghostPairs(i), "market mismatch");
            require(m.totalMintedPairs <= m.maxPairs, "market cap exceeded");
            if (m.state != IBlinkMarket.State.FINAL) {
                require(totalYes == m.totalMintedPairs, "pairs yes");
                require(totalNo == m.totalMintedPairs, "pairs no");
            }
        }
        require(
            token.balanceOf(address(market)) == escrow + market.makerFreeBalance() + handler.ghostDonations(),
            "solvency mismatch"
        );
    }
}
