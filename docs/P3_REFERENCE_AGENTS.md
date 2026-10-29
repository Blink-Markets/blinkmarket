# P3 reference agents and autonomous drill delivery

P3 delivered an agent kit, independent reference agents for every role, public agent documentation, an autonomous local drill and an optional LLM demo. The platform provides infrastructure and does not play a role. Nothing is deployed: the current protocol and services have no public deployment. Tasks 1–7 and 7b are merged and CI is green; the P3 whole-branch review follows. See [progress](P3_AGENTS_PROGRESS.md) and the [roadmap](ROADMAP.md).

## Agent kit

`@blink/client` supplies `agentAbi`, protocol constants, `voteCommitment`, `templateIdFor`, `quoteTypedData`, quote verification and market-spec validation. `GM_LT_V1` computes a class A outcome from archived source bytes. Its parser hash pins the exact source bytes, including the outcome function; changing them requires a new template. The creator uploads those bytes to the hash-addressed content store.

## Runtime contract

Each process in `examples/agents` takes `BLINK_AGENT_NAME`, `BLINK_AGENT_ROLES`, `BLINK_API_URL`, `BLINK_RPC_URL`, `BLINK_AGENT_KEY`, `BLINK_WORLD` and `BLINK_AGENT_STATE_DIR`. The RPC must be loopback and chain ID 84532. Onboarding registers and stakes as needed, proves wallet control and obtains an API key; a restart replaces the previous key. State is saved by temporary file and rename, including creation intents, pending fills and juror salts before sending. The loop honors `Retry-After` for rate limiting and stale indexes; other errors are logged and retried on later ticks. Secrets are masked in logs. See the [reference-agent guide](../examples/agents/README.md) for the environment and behavior.

## Import boundary

The reference-agent source may use its own files, `@blink/client`, its template subpath, `viem` and Node built-ins. The boundary check rejects internal packages, internal source or contract artifacts, and local `parseAbi` calls. Agents use public documentation, the public API, contracts and their own keys; platform service environments pass `assertNoRoleKeys`.

## Roles

- **Creator:** registers templates, uploads exact spec bytes, posts the bond and creates markets within contract limits; it can claim human suggestions and journals creation intent.
- **Maker:** deposits collateral, signs quotes based on its model, redeems final positions from fills and invalidates outstanding quotes on shutdown.
- **Trader:** requests quotes, verifies them, checks its model's edge, fills with an exact approval and redeems. It reconciles uncertain fills before replacing them.
- **Forecaster:** signs and submits its model's probability for open windows.
- **Proposer:** uploads evidence and proposes an outcome, and may appeal a lost round.
- **Challenger:** challenges objectionable creation or an outcome that disagrees with its model, including a proposal with unavailable or damaged evidence.
- **Juror:** saves its salt before committing, reveals its vote, settles votes and claims rewards; it skips conflicts. Unsupported evidence is voted against.
- **Keeper:** calls permissionless opening, finalization, dispute settlement, fee distribution and forecast-root anchoring steps.

## World file

The fixture model reads JSON with `questions`, `suggestions` and `agents`: questions contain market specs and scheduling, suggestions map text to questions, and agents hold roles, creation choices and per-question beliefs. Titles identify questions. Class A outcomes are computed from the listed archived source file and parser when the agent has a belief. The drill uses [`examples/agents/worlds/drill.json`](../examples/agents/worlds/drill.json); fixture models make the CI run reproducible.

## Autonomous drill

`pnpm alpha:autonomous` starts local Anvil, contracts and key-free platform infrastructure, then independent agents with distinct funded test accounts. It uses unchanged alpha protocol parameters, no chain-time manipulation, impersonation or direct database writes by the drill, and a fixed test price. Its five scenarios cover normal class A settlement, a result dispute and appeal, a creation challenge, a no-proposal timeout, and a human suggestion. It checks public API results against chain events and balances, credit and an index rebuild.

The roster has 14 agents: two creators, two makers, two traders, one forecaster, an honest and a lying proposer, one challenger, three jurors and one keeper. The creation-challenged creator and lying proposer have no later duties. The PostgreSQL `autonomous` CI job runs the success drill and a stalled-timeout regression, retaining logs on failure. On 2026-10-28 its success test took 934 s and the job about 18.5 minutes. The original PGlite run took 954 s: normal 454 s, dispute 447 s, creation 92 s, timeout 904 s and suggestion 454 s.

## Optional LLM demo

`examples/llm-agent` starts from `/llms.txt` and public documentation, uses the operator's model credentials and guarded tools, and keeps wallet and API secrets in memory with a redacted transcript. It is not in CI. The live demo has not been run, so autonomous onboarding through the live model remains unverified.

The final-review fix round adds origin-bound wallet challenge checks, proposer appeal recovery, maker position redemption and scenario deadline races. Full verification of this round is pending.

## Known limitations

- The CDP server-wallet check is manual and not in CI. The operator ran it on 2026-10-29 with `@coinbase/cdp-sdk` 1.60.0: 1 test passed in 185 s. CDP smart accounts (ERC-4337) remain unverified.
- The drill uses EOA makers; it does not exercise a contract-wallet maker. P2's local alpha covers an ERC-1271 maker.
- The drill covers timeout when nobody proposes; arbitration reaching no conclusion is covered only by forge.
- The `client-agent-uncertain-fill` receipt wait has flaked under load and is parked for whole-branch review.
- The reference runtime and LLM demo validate wallet challenges against the configured API origin, wallet, action and expiry before signing. A different binding origin fails closed. The live LLM demo has never been run.
- Suggestion claims are not exclusive between distinct creators, and slashed agents do not automatically restore their role stake.

## Verification

The merged tree at `8947f8d` was measured on 2026-10-29; these are recorded runs, not a deployment:

| Command | Result |
| --- | --- |
| `pnpm check` | 640 tests passed, 0 failed (886 s) |
| `pnpm build:services` | passed (2 s) |
| `pnpm test:service-build` | 4/4 passed (1 s) |
| `pnpm test:postgres` | 37/37 passed (86 s) |
| `pnpm drill:restore:test` | 1/1 passed (77 s) |
| `pnpm alpha:local` | 1/1 passed (374 s) |
| `pnpm test:anvil` | 73/73 passed (671 s) |
| `forge test --root contracts` | 240/240 passed in 17 suites, 0 skipped (219 s) |

`pnpm test:browsers`, `pnpm build` and `pnpm build:pages` run in CI because the development host cannot run Turbopack. The check, contracts, browsers and autonomous CI jobs were green on `61fc27f`.

## Implementation rulings

The [plan's pre-flight rulings](superpowers/plans/2026-10-25-p3-reference-agents-drill.md#pre-flight-rulings-the-controller-records-these-in-the-ledger-before-task-1) and controller ledger settled the implementation: later roles can extend the artifact-checked ABI; the trader move preserves the existing uncertain-fill tests; parallel tasks append their own progress sections; the public docs scan covers all pages. The drill reuses the local alpha forecast schedule, schedules the dispute before the juror credit phase-in and asserts each round's threshold without overriding it. The no-submission timeout and EOA makers leave the other paths to existing forge and P2 tests. The SDK call shape was checked against installed types, and the CDP operator run was kept separate from implementation. Under the publicly listed assumptions, honesty is the provably best strategy; see the [trust assumptions](P1_PROTOCOL_CONTRACTS.md#trust-assumptions).
