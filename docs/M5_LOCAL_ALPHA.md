# M5 local Alpha harness — Task 16b staged delivery

中文摘要：本地 Alpha 以真实 PostgreSQL、Anvil 和服务组件验证三种 REPLAY 结算及投影恢复；示例代理接入仍待 Task 15。

This slice implements Task 16 Rules 1–3. **Agent step pending Task 15.**
The external-agent flow is isolated in `runExternalAgent` in
`scripts/local-alpha.ts`; it currently uses the existing client, public API and
viem. The controller must integrate `examples/agent/run.ts` and its typed client
when Task 15 lands. This does not complete all of Task 16 or M5. Health, readiness
and the acceptance matrix remain Task 16a's separate scope.

## Run

With dependencies installed and a dedicated local PostgreSQL administrator:

```sh
TEST_POSTGRES_ADMIN_URL=postgresql://blink_test:local-ci-only@127.0.0.1:55408/postgres pnpm alpha:local
```

The administrator must have CREATEDB/CREATEROLE privileges. The command refuses
missing configuration and non-loopback PostgreSQL hosts. It never migrates the
supplied database: it creates a random database, migrates that database, creates
separate nonprivileged service logins, and drops its database and logins afterward.
The administrator is used for provisioning, fixture registration and restore DDL;
API, indexer, worker and signer operations use their own login pools. Additional
identity, evidence and deployment administrative logins perform offline setup.

`alpha:local` generates the contract artifacts and runs
`tests/alpha/local-alpha.test.ts`. CI runs it in the `check` job against the existing
PostgreSQL service on port 5432. The entrypoint can also be run directly with
`node --import tsx scripts/local-alpha.ts` after `pnpm check:contracts`; it prints a
JSON report including wall time. The test runner prints wall time and scenario
outcomes. No external data or model provider is contacted.

## Exercised flow

The harness starts an ephemeral loopback Anvil using the project's Foundry
resolver, chain ID 84532, the public development mnemonic and base fee/gas price
of 1 wei. It uses Task 4's verified deployer with a distinct deployer account,
registers the deployment, funds the maker pool, reads signer keys from temporary
0600 files, and starts the signer and trading API on ephemeral loopback ports.
The chain indexer uses bounded synchronous ticks. Forecasts and evaluation run
through the real PostgreSQL queue and worker loop; faucet/keeper/dispatch and
reservation reconciliation use the real handlers with deterministic ticks.

Each scenario imports reviewed offline evidence with `evidence-admin.ts`, submits
a direct candidate through the invited discovery client, approves it through the
admin API, sends the returned creation calldata from the development admin
wallet, reconciles the receipt, and indexes the market. The normal window
scheduler creates windows. The harness opens the last window, runs both platform
forecasters and baseline with the deterministic fixture gateway through their
own invited API clients, closes the window, and reads the ensemble snapshot.

After the admin allows the taker, the external-agent seam proves wallet signature
binding (once), a 1,000 bUSD faucet claim, RFQ, maker signature and on-chain digest
verification, exact collateral approval, fill, transaction tracking and canonical
inclusion. The same verified taker is reused; scenarios advance at least 24h so
later faucet claims respect the real rolling wallet limit.

| Scenario | Resolution path                                      | Outcome | Taker payout      | Maker payout      |
| -------- | ---------------------------------------------------- | ------- | ----------------- | ----------------- |
| normal   | Propose YES; keeper finalizes after challenge period | YES     | 10,000,000 micros | 0                 |
| dispute  | Propose YES; challenge; arbiter decides NO           | NO      | 0                 | 10,000,000 micros |
| timeout  | No proposal; keeper finalizes at hard deadline       | INVALID | 5,000,000 micros  | 5,000,000 micros  |

Both participants redeem. Assertions compare indexed state, market parameters,
positions, escrow, maker free collateral/epoch/pause, taker permissions and consumed
quote digests with contract reads. No reservation remains HELD or
RECONCILE_REQUIRED. Evaluation runs and public REPLAY metrics count YES/NO events;
the existing metrics contract counts INVALID separately in `invalidCount`.
LIVE market/score rows and LIVE event count remain zero.

## Clock and fixture boundaries

Every jump advances Anvil and sets `blink.test_clock_offset_seconds` on all
logins using `ALTER ROLE ... IN DATABASE ... SET` and on existing pool sessions.
The owner clock setting is restricted to the random database too. Only harness
subprocesses receive `BLINK_ALLOW_TEST_CLOCK=1`; in-process clock checks receive an
explicit allowance. Production startup checks and gas caps remain unchanged.

Approval/identity currently use the existing host-clock store; the harness leaves
that behavior intact and refreshes the real deployment verification before each
approval. Approval requires `manifest.tradingEnabled=false`, while RFQ requires
true. Fixture owner writes explicitly switch this bit around approval/trading;
this is local setup, not a production activation workflow.

Anvil's finalized tag remains block 0. Faucet and keeper transactions, creation
receipts and taker tracking must reach canonical INCLUDED, never fabricated
FINALIZED. The harness verifies canonical receipts and resulting contract state;
it does not certify real network finality, reorg-free settlement or deployment
readiness.

## Restore drills

1. Run the real `chain:rebuild --verify` implementation on canonical stored events
   through `scripts/rebuild-chain-index.ts`; require no differences and identical
   complete projections afterward.
2. Stop the worker, drop the eight chain index tables and their dependent
   evaluation view, recreate exact DDL/grants from migrations 0007 and 0015, then
   index again from the original deployment block. Compare all projection maps
   (including bigint values) with the pre-drop snapshot. Application records and
   retained outbox history survive. Migrations are read, never edited or replayed
   through the migration ledger.

The drill exposed an outbox uniqueness collision after cursor loss. Cursor
initialization now starts its version at the maximum retained chain notification
version. Re-indexing emits fresh notifications without discarding history or
silencing conflicts.

## Verification

| Command                                                                | Result                                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `pnpm alpha:local` with the supplied local PostgreSQL URL              | PASS: 2 tests, three scenarios, both restores; harness 81.6 s under concurrent local load (excludes artifact compilation) |
| `pnpm check`                                                           | PASS: 495 tests, no skips; typechecks, contract compilation and boundaries                                                |
| `pnpm exec tsc --noEmit`                                               | PASS                                                                                                                      |
| `pnpm build`                                                           | Existing Google Fonts downloads unavailable under the no-external-network constraint                                      |
| `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/t12-font-mocks.cjs pnpm build` | PASS: full build, TypeScript and prerendering with temporary offline CSS using local Arial                                |
| `pnpm build:services && pnpm test:service-build`                       | PASS: 5 tests                                                                                                             |
| `pnpm test:postgres` with the supplied local PostgreSQL URL            | PASS: 30 tests, no skips                                                                                                  |
| `pnpm test:anvil`                                                      | PASS: 44 tests, no skips                                                                                                  |

The offline build validates source resolution and route generation; production
font downloads and font appearance remain unverified. No font source/config
changes or temporary fixtures are committed. The controller's untracked Task 16b
report contains RED/GREEN evidence and command results. Local-only verification
does not cover hosted services, public testnet, paid providers or external user
acceptance.
