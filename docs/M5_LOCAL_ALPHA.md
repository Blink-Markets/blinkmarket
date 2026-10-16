# M5 local Alpha harness — Task 16b delivery

中文摘要：本地 Alpha 以真实 PostgreSQL、Anvil 和服务组件验证三种 REPLAY 结算及投影恢复；外部代理步骤使用 Task 15 的示例代理，终局化走 worker 的 keeper 任务。

This slice implements Task 16 Rules 1–3. The external-agent step runs Task 15's
`examples/agent/run.ts` with one added bound on receipt waits (see below), and the normal
and timeout scenarios are finalized by the worker's real `keeper.finalize` job, not
by a direct contract call. Health, readiness and the acceptance matrix are Task 16a's
separate scope, and this harness alone does not complete M5.

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

## Bounds and failure cleanup

A stalled run fails with its stage instead of hanging CI. `runLocalAlpha` takes an
`AbortSignal`; the test combines its runner signal with a 200 s deadline
(`ALPHA_DEADLINE_MS`, inside the test's own 240 s timeout), and a direct run aborts
on that deadline, Ctrl-C or SIGTERM. On abort the stalled work is abandoned, every
shutdown runs, and the run rejects with `LIFECYCLE_ABORTED during <stage>: <reason>`.
Further limits: child processes (evidence import, chain rebuild) have a 60 s
timeout and are killed on abort; PostgreSQL logins have a 10 s connect and a 30 s
statement timeout; Anvil receipt waits, including the example agent's (its
`waitMs.receipt`, default unchanged at viem's 180 s), end after 10 s.

Shutdown never skips a resource. Worker, API, signer, Anvil and the temporary
directory are each attempted independently (10 s per step; the HTTP servers drop
their connections instead of draining them), then the pools, the random database and
its logins (30 s per step). Once teardown starts, the database helper refuses new
logins and pools, so an abandoned run cannot create what teardown has already listed. Failures are collected and reported
together as an `AggregateError` that lists the scenario error first. Covered without
the full scenario by `tests/alpha-lifecycle.test.ts` (rejecting, throwing and
hanging stoppers, abort mid-run, stalled child), `tests/postgres/database-lifecycle.test.ts`
(statement and connect timeouts, database teardown with a failing pool) and the
aborted-run tests in `tests/alpha/local-alpha.test.ts`, which abort a real run at
five points (before Anvil exists, then 0 to 600 ms after it starts) and require that
no Anvil, random database or login role remains.

## Exercised flow

The harness starts an ephemeral loopback Anvil using the project's Foundry
resolver, chain ID 84532, the public development mnemonic and base fee/gas price
of 1 wei. It uses Task 4's verified deployer with a distinct deployer account,
registers the deployment, funds the maker pool, reads signer keys from temporary
0600 files, and starts the signer and trading API (RFQ on its own login, as
`apps/api` composes it) on ephemeral loopback ports. The worker runs the real job
loop with `buildExecution` from `apps/worker` (faucet mint, keeper finalization and
transaction dispatch, with the business clock allowed to shift) plus the forecast and
evaluation handlers. The chain indexer and transaction tracker follow the chain from a
background loop, as `apps/indexer` does. Forecasts and evaluation run through the real
PostgreSQL queue; reservation reconciliation uses the real reconciler on demand.

Each scenario imports reviewed offline evidence with `evidence-admin.ts`, submits
a direct candidate through the invited discovery client, approves it through the
admin API, sends the returned creation calldata from the development admin
wallet, reconciles the receipt, and indexes the market. The normal window
scheduler creates windows. The harness opens the last window, runs both platform
forecasters and baseline with the deterministic fixture gateway through their
own invited API clients, closes the window, and reads the ensemble snapshot.

For every scenario a new taker wallet and a new invited agent are created, the admin
allows the wallet and the example agent runs against the API: it binds the wallet,
claims the faucet, requests and verifies a quote, approves exactly the cost, fills,
tracks the transaction and waits for the indexed position. Blocks are mined every
200 ms while it works so a quote's head block is never old. Scenarios still advance
at least 24h of business time, which the forecast budget days need.

After the agent holds its position, the harness closes the market and drives the
resolution path below. The agent then sees FINAL through the API and redeems itself;
its reported outcome and payout are asserted against the contract. The keeper
scenarios call the worker's periodic scheduler (`execution.tick`) until the
`keeper.finalize` job has signed and `tx.dispatch` has included the finalization, and
require exactly one finalization signing intent for the market.

| Scenario | Resolution path                                      | Outcome | Taker payout      | Maker payout      |
| -------- | ---------------------------------------------------- | ------- | ----------------- | ----------------- |
| normal   | Propose YES; keeper finalizes after challenge period | YES     | 10,000,000 micros | 0                 |
| dispute  | Propose YES; challenge; arbiter decides NO           | NO      | 0                 | 10,000,000 micros |
| timeout  | No proposal; keeper finalizes at hard deadline       | INVALID | 5,000,000 micros  | 5,000,000 micros  |

The maker redeems in the harness. Assertions compare indexed state, market parameters,
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
explicit allowance (`buildExecution` takes `allowTestClock`, false unless a caller
passes it; the worker never does). Production startup checks and gas caps remain
unchanged.

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

| Command                                                                | Result                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `pnpm alpha:local` with the supplied local PostgreSQL URL              | PASS: 3 tests incl. aborted-run teardown; harness 4.6 s idle, 58-82 s under heavy load (no artifact compile) |
| `pnpm check`                                                           | PASS: 506 tests, no skips; typechecks, contract compilation and boundaries                                   |
| `pnpm exec tsc --noEmit`                                               | PASS                                                                                                         |
| `pnpm build`                                                           | Existing Google Fonts downloads unavailable under the no-external-network constraint                         |
| `NEXT_FONT_GOOGLE_MOCKED_RESPONSES=/tmp/t12-font-mocks.cjs pnpm build` | PASS: full build, TypeScript and prerendering with temporary offline CSS using local Arial                   |
| `pnpm build:services && pnpm test:service-build`                       | PASS: 5 tests                                                                                                |
| `pnpm test:postgres` with the supplied local PostgreSQL URL            | PASS: 34 tests, no skips                                                                                     |
| `pnpm test:anvil`                                                      | PASS: 44 tests, no skips                                                                                     |

The offline build validates source resolution and route generation; production
font downloads and font appearance remain unverified. No font source/config
changes or temporary fixtures are committed. The controller's untracked Task 16b
report contains RED/GREEN evidence and command results. Local-only verification
does not cover hosted services, public testnet, paid providers or external user
acceptance.
