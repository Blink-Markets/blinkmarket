# M0 / M1 delivery and verification

The M0 contract wrap-up and the M1 ledger are implemented locally. No external chain was deployed, and no API business handler is enabled. The original product spec is unchanged. The backend business wiring of the detailed design belongs to M2/M3.

## M0 work packages

| Work | Delivered |
| --- | --- |
| A1 | PublicMarketRef requires deploymentId and a decimal chain marketId; MarketRecordId is an internal UUID brand; uint64/256 range checks |
| A2 | v0.1.1 resolutionPolicy, keeps the v0.1 reader, deterministic one-pass encoding and keccak256, reads the original bytes to verify the hash, and the local object store publishes atomically after staging completes |
| A3 | Non-placeholder manifest schema, chain ID / deployment ID / role checks, offline validator; the read-only RPC verifier checks same-block code/ABI hashes, roles, asset, caps and the safe replay lower bound, and rejects on a reorg |
| A4 | economic intent / nonce allocation / quote / reservation / sign request/result, caller scope types; chain hash snapshot, queue fencing ACK, opaque transaction handle |
| A5 | PostgreSQL migration runner + checksum/advisory lock/transaction, 0001 domains/roles/audit/idempotency/outbox/jobs; UnitOfWork bound to a real connection |
| A6 | Shared request/response schemas for the 22 business endpoints, OpenAPI generation, decimal/ID/error contracts, client schema validation; the API returns 400 for malformed requests and 501 for valid but unwired ones |

The Int domain uses NUMERIC with integer/uint256 CHECKs, instead of NUMERIC(78,0), which would round decimals automatically before the check. This way 1.5 is rejected explicitly. Probability is limited to 6 decimal places, and floating point is not used for amounts.

The new spec freeze accepts v0.1.1, and v0.1 can still be read and verified. A LIVE placeholder and an expired closeAt are rejected. Whether a source is truly official, the company allowlist and human approval still need M2 use cases, and the schema does not replace those judgments.

## M1 work packages

| Work | Delivered |
| --- | --- |
| B1/B2 | BlinkTestUSD with a fixed minter, five fixed and distinct BlinkMarket roles, mainnet rejection, market creation / caps / pause / allowlist / maker collateral |
| B3 | Standard EIP-712/ECDSA, whole-quote YES/NO fills, consumed/cancelled/epoch, opposite share counts on the two sides, full collateralization |
| B4 | proposal/challenge/arbitrate, permissionless finalization/timeout, YES/NO/INVALID redemption, independent proposed/final outcome |
| B5 | Behavior/fuzz/adversarial tests, a ghost ledger stateful invariant, fixed-seed reruns and a final liquidation at the end of each run |
| B6 | Generated ABI/bytecode and hashes; one-shot Anvil replays of normal / dispute / timeout, TS and contract digests match, escrow=0 after both sides redeem |

Compiler/dependencies: solc 0.8.30, OpenZeppelin 5.6.1, Foundry 1.7.1, viaIR, optimizer 200, Cancun. The versions and the lockfile are kept. The standard library provides the signature/token call mechanics, which does not mean Blink itself has had a security audit.

## Verification commands

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:contracts
pnpm test:contracts:seeds
pnpm replay
pnpm api:spec
pnpm build
```

After the review fixes: the TypeScript and basic dependency-direction checks passed; 14 Node tests passed; 24 Foundry tests/invariants passed. The three fuzz tests run 256 cases each, and the stateful invariant runs 128 runs × 64 calls each time. An extra fixed 0x01/0x02 run of 8192 calls each and a multi-user settlement fuzz also passed, and every run liquidates all remaining positions at its end.

The PGlite tests use a real PostgreSQL engine (WASM, single session). They actually tested: migration rerun, rejection of a checksum mismatch, maximum uint256 precision, rejection of decimals / negatives / overflow, no DDL and no audit-modification privilege for the roles, and a trigger that rejects truncate. They also verify that the implicit ROLLBACK after UnitOfWork catches a SQL error must be reported as a failure, and that a COMMIT works normally after a savepoint recovery. **Real PostgreSQL multi-connection / deployment environments were not tested.** The connection lifecycle is tested separately with a fake pool, and M2 needs to add real DB concurrency race/recovery acceptance.

The deployment verifier's wrong-code / role / ABI / reorg tests use a mock RPC. Added cases cover a deployment start that is too late, two contracts deployed at different heights, genesis / early start points, future blocks, and historical state that cannot be queried. There is no real Sepolia deployment to verify against. The local replay runs on a real Anvil EVM with the bytecode compiled in this change. Asset metadata, typed digests, transaction receipts and positions / escrow are all asserted against the chain.

On-disk tests of the local object store: 16 concurrent writers write the same 1 MiB content, and each is read back and verified right after it succeeds. A leftover half-written staging file was also simulated, confirming that a retry is not affected and that an existing corrupted final object is not overwritten. No process-kill or power-loss fault injection was done.

| REPLAY | Final outcome | Taker payout | Maker payout | Remaining escrow |
| --- | --- | ---: | ---: | ---: |
| normal | YES | 100 bUSD | 0 | 0 |
| dispute | NO | 0 | 100 bUSD | 0 |
| timeout | INVALID | 50 bUSD | 50 bUSD | 0 |

Every scenario is 100 YES @ 6000 bps: the taker pays 60 and the maker posts 40 as collateral. The report and spec bytes are written to contracts/artifacts and are marked LOCAL_REPLAY_ONLY. The test chain is destroyed when the process ends, and its addresses must not be used as formal deployment addresses.

## C01–C15 mapping

- C01/C02: yesAccounting/noAccounting and integer cost fuzz.
- C03/C04: wrongPayloadAndDomain, consumedCancelledEpoch, high-s signature rejection; local cross-check of the TS digest.
- C05/C06: quoteBoundaries, badAmountsCapsAndLifetime, cross-account market cap, cumulative shares on both sides.
- C07/C08/C09: balance/allowance and malicious-token rollback, competingQuotes, cancel/fill ordering and epoch.
- C10/C11/C12: three-outcome fuzz, two-sided redeem, three non-FINAL timeouts, proposal/challenge/hardDeadline boundaries.
- C13/C14: global/market pause, new fills rejected after an allowlist revocation but redemption still possible, permission matrix, wrong chain/asset/role, donation cannot be withdrawn.
- C15: independent ghost free/pairs/positions/cumulative/wallet ledgers for three takers plus a maker, across two markets. Each run first builds a two-sided position for every taker, then randomly interleaves deposit/fill/cancel/epoch/pause/time/outcome/redeem/donation. It checks each person's cumulative cap, the cross-user market cap, all unredeemed positions, wallet balances, and full fund conservation including donations, and liquidates everything at the end. A new 256-case fuzz samples the 24 redemption orderings of four people and the YES/NO/INVALID outcomes. It checks the ledger after every redemption and rejects a duplicate claim. fill/deposit/withdraw no longer swallow unexpected errors with a catch-all.
- Extra: reentry deterministically returns the ReentrancyGuard error, redeem/withdraw state rolls back when a transfer fails, and mint permission and nonexistent markets are rejected.

## Implementation limits and next stage

There is no authentication, no server-side reservation/quote policy, no indexer sync, no production signer, no S3, no LLM, no product UI and no public trading. The TypeScript ports/scopes are wiring contracts, not network/security isolation that has been put in place. Client requestQuote validates only the wire schema and provides no automatic trade execution. M2 should check the manifest/signature/calldata/policy before sending an order.

FileObjectStore provides local put-if-absent and hash checking. It does not provide cloud WORM or any guarantee against tampering by the file owner. Tampering is detected on read. The DB immutable audit is protected by the runtime role/trigger, and the DB owner is still a trusted administrator.

Three P2 items from the review have been fixed: UnitOfWork checks the COMMIT command; the object store uses a staging file on the same filesystem, file sync, publishing by hard link without overwriting, and directory sync; deploymentBlock is an inclusive safe replay lower bound, and the block before it is verified to have no code at either address. An abnormal exit may leave an orphan `.pending-*` directory, which does not pollute the formal hash path. An existing corrupted formal file still fails closed and needs manual investigation. It is never overwritten automatically. For the historical RPC requirement and the definition of the start point, see [Operations](OPERATIONS.md).

The whole repo does not yet have an initial Git commit, so no release gitCommit or formal manifest is invented. The next stage is M2: identity, business tables, outbox, wiring spec storage to the API, on-chain indexing, and RFQ reservation. No external deployment was done in this round.
