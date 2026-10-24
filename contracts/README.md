# Blink contracts

The repo keeps two non-upgradeable contract sets side by side. The chain ID is fixed at 84532, and local tests use the same ID.

- **v0.1:** `src/BlinkMarket.sol` and `src/BlinkTestUSD.sol`. Fixed roles, maker free collateral, fully collateralised fills, EIP-712, cancel/epoch, internal positions, proposal/challenge/arbitration/timeout/redeem. The off-chain services still use this ABI. The historical `alpha-2` deployment does not mean P1 is deployed. See the [M0/M1 delivery record](../docs/M0_M1_DELIVERY.md).
- **P1:** `src/protocol/`. Registered identity, self-service role stakes, multi-maker RFQ, credit, market-creation challenge, snapshot commit/reveal arbitration, doubled-stake appeals, fee distribution, a seven-day juror reward stream, faucet and next-generation governance. The four contracts are deployed in order at predicted addresses, and their addresses are fixed in the constructors. There is no owner, admin, pause, initialiser or upgrade entry point; governance can only adopt the next generation. For the full delivery, parameters and known limitations see the [P1 delivery record](../docs/P1_PROTOCOL_CONTRACTS.md). P1 is not deployed yet; P2 adds the deployment tooling and the off-chain services.

Pinned tools: Solidity 0.8.30, OpenZeppelin 5.6.1, Foundry 1.7.1, EVM Cancun, optimizer 200, viaIR. Foundry is version-locked through npm and needs no global install; the first native compile downloads the pinned solc.

Run from the repo root:

```sh
pnpm check:contracts
pnpm test:contracts
pnpm test:contracts:seeds
node --import tsx --test tests/protocol-artifacts.test.ts
pnpm check:boundaries
```

`check:contracts` compiles both contract sets, writes the ABI, ABI hash, creation bytecode and its hash to `contracts/artifacts/`, and checks that runtime bytecode does not exceed the EIP-170 limit of 24,576 bytes. The artifacts are not committed. The ABI test scans every concrete P1 contract (the Governor is covered separately by its proposal-limit tests); only the settlement hooks `setProposed` and `setDisputed` on the markets are exempt.

`test:contracts` covers v0.1, the P1 unit and fuzz tests, a real generation lifecycle, malicious collateral, and independent ghost-ledger invariants. `test:contracts:seeds` runs `LedgerInvariantTest` and `ProtocolInvariantTest` with seeds 0x01 and 0x02 each; every invariant runs 128 runs x 64 operations. Each run forces the remaining markets, fee shares, redemptions and vote unlocks to complete, then checks that escrow returns to zero and that the contracts are solvent.

Run through the package scripts or `scripts/foundry.mjs`, so that the original npm wrapper does not swallow a child's failure exit code. CI already uses the fixed runner. The v0.1 `pnpm replay` can still start its own loopback Anvil and run the three historical REPLAY flows; it is not an autonomous-agent drill for P1.

The P1 `getDispute` returns the current round. The commitment and `settleVote(disputeId, round, juror)` use `currentRound` (it increments on every reopen and appeal), while `appealRound` is the index for the quorum and credit parameters. Settle all losers of the same appeal level first, then claim the token reward of coherent jurors; credit for the final round waits for `finalizeDispute`. After a timeout, votes that are not yet settled are only unlocked. The bUSD reward goes through the seven-day stream and cannot be claimed in full at notify time.

A real deployment must check the manifest, the ABI and runtime bytecode hashes, the address getters and the collateral; the 6-decimal precision alone is not enough to identify the asset. `proposedOutcome` and `finalOutcome` must be read together with the state to know whether they exist. The test parameters are not the production economic parameters. The fixed price and the faucet assets have no real value, and the contracts have not had an external security audit.
