# P3 reference agents and drill progress

Plan: `docs/superpowers/plans/2026-10-25-p3-reference-agents-drill.md`. Spec: `docs/superpowers/specs/2026-10-23-autonomous-market-design.md`.

## Task 1 — agent kit in `@blink/client` (2026-10-27)

Scope: the code every later P3 task imports. No contract, migration, API or service code changed.

### What was built

- **`agentAbi`** (`packages/client/src/agent-abi.ts`): `parseAbi` lists for `registry`, `jurors`, `markets`, `resolution`, `faucet`, `usd`, `platformToken` and `anchor`. They hold the writes named in the spec's role steps and the views an agent reads before acting (`hasRole`, `creditOf`, `getMarket`, `getPosition`, `getDispute`, `slashableStake`, `balanceOf`, `allowance`), plus the events a role waits for. `examples/agent/run.ts` no longer carries inline ABIs or a role number: it uses `agentAbi` and `ROLE`.
- **Constants** (`packages/client/src/protocol-constants.ts`): `ROLE`, `QUESTION_CLASS`, `MARKET_STATE`, `OUTCOME`, `CREATION_GROUND`, `voteCommitment` and `templateIdFor`.
- **`quoteTypedData(quote, deployment)`** (`packages/client/src/verify-quote.ts`): the maker-side builder of the EIP-712 Quote. `verifySignedQuote` now uses it, so both sides of a fill share one domain and one type list.
- **`GM_LT_V1`** (`packages/client/src/templates/`): the parser moved from `packages/domain/src/gm-parser.ts` (`git mv`) to `templates/gm-lt-v1.ts` and gained `gmLtV1Outcome`. `templates/index.ts` exports `GM_LT_V1 = { cls, parserHash, uri, templateId }`. The subpath `@blink/client/templates/gm-lt-v1` is exported from `package.json`.
- **Re-exports**: `parseMarketSpec` and the type `MarketSpecV02`, so an agent never imports `@blink/schemas`.

### Decisions and limitations

- **The parser hash is pinned.** `parserHash` is keccak256 of the exact bytes of `templates/gm-lt-v1.ts`, the outcome function included. `tests/client-agent-kit.test.ts` recomputes it and holds the literal. Any edit to that file, even a comment or whitespace, changes the hash; the failure message says that a changed parser is a new template (new file, new hash, new `templateId`), never an edit of `GM_LT_V1`.
- **The content URI is a path.** `uri = /v1/content/<parserHash>`. The content store names bytes by keccak256, so the parser file uploaded to any API resolves there. The template is registered on chain with this relative URI; an agent resolves it against the API it uses. Uploading the parser bytes is the job of the creator agent or the drill, not of this task.
- **`CREATION_GROUND` order is a P3 convention.** The contract only requires `ground < 3`; the order (wrong class, ambiguous, manipulable) is the one in spec section 5.3, and the docs must say it is not enforced on chain.
- **`gmLtV1Outcome` is strict.** The extraction must be exactly one key, `thresholdBps`, an integer from 1 to 9999; anything else, and any ambiguous source, gives `null`. A negative or over-100% margin still compares as parsed.
- **`agentAbi` is not exhaustive.** A later task adds the entries it needs (the test compares each entry with the artifact, so a wrong signature fails at once).
- **Artifacts.** The ABI test reads `contracts/artifacts/<name>.json` like `tests/protocol-abi.test.ts`; run `pnpm check:contracts` first on a fresh checkout.
- `docs/M3_RESOLUTION.md` still names `parseGrossMargin` as a domain function; it is a v0.1 document under a historical notice and was left as written.

### Verification

- RED: the two new test files failed with their modules missing.
- `node --import tsx --test tests/client-agent-kit.test.ts tests/gm-lt-v1.test.ts`: 29 passed, 0 failed.
- `tests/client.test.ts`, `tests/client-verify-quote.test.ts` and the two Anvil taker-agent suites (which run `examples/agent/run.ts`): 57 passed, 0 failed.
- `pnpm typecheck` and `pnpm check:boundaries` pass; `client` still depends on `schemas` only.
- `pnpm build` and `pnpm build:pages` cannot run on this host; CI runs them.

## Task 2 — `examples/agents` runtime, the trader tick and the import boundary (2026-10-27)

Scope: the shared runtime every reference agent uses, the existing taker example turned into the `trader` role, the platform started from one function, and the rule that keeps agents on public surfaces. Only the trader role exists so far; the other roles are Tasks 3 to 7.

### What was built

- **`@blink/examples`** (`examples/agents`, private, workspace member through `examples/*`; depends on `@blink/client` and `viem`). `src/lib/env.ts` (`loadAgentEnv`, `createContext`, `AgentContext`), `session.ts` (`onboard`), `loop.ts` (`runAgent`, `RoleTick`), `state.ts` (`loadState`, `saveState`), `model.ts` (`Model`, `fixtureModel`), `world.ts` (`World`, `parseWorld`, `loadWorld`), `log.ts` (`createLogger`), `src/main.ts` (the entry point and the role table `ROLE_TICKS`).
- **Trader.** `examples/agent/run.ts` moved to `src/roles/trader.ts` and became `trader: RoleTick` (and `createTrader(options)` for tests). `runAgent(config)` is gone; its name is the loop's now. The exactly-once logic is the same code: `sendFill` and the consumed-digest and chain-time checks that decide when a fill is lost and a replacement RFQ is allowed. One addition: the fill is written to `state.fills` before it is sent, so a tick that fails or a restart settles that record first instead of buying again.
- **Platform.** `scripts/alpha/platform.ts` exports `startAlphaPlatform({ backend })`. The `postgres` backend is T11's code moved from `scripts/local-alpha.ts` (fresh database, a login per role, API, indexer and worker as processes, the fixed worker port with its ponytail comment, `ALPHA_FORECAST_SCHEDULE`). The `pglite` backend runs the API (identity, content, suggestions, RFQ relay, transaction tracking, forecasts, market reads, metrics), the chain indexer, transaction tracking and the worker's jobs in process over PGlite with every migration. Both build the same key-free service environments and call `assertNoRoleKeys` on each. `startLocalAlpha` is now a wrapper that adds the P2 scenario helpers.
- **Boundary rule** in `scripts/check-boundaries.mjs`: files under `examples/agents/src` may import only `@blink/client`, `@blink/client/templates/gm-lt-v1`, `viem`, `viem/*`, `node:*` and their own files; they must not contain `contracts/out`, `packages/` or `apps/`; they must not call `parseAbi`. `tests/agents-runtime.test.ts` runs the checker against a temporary tree.
- **Client.** `BlinkApiError` has an optional `retryAfterSeconds` (the `Retry-After` header of the refusal), which the loop honours.

### Decisions and limitations

- **Scopes.** The wallet-proof flow takes no scope list: every key it issues has all four scopes. `onboard` therefore cannot narrow a key to its roles' scopes.
- **API key lifecycle.** The secret is never stored. Each `onboard` issues a new key and revokes the one whose id is in the state, because an account may hold only a few keys. A restart costs two wallet challenges; the API allows 10 per address and 30 per IP per hour, so a drill that restarts many agents on one machine can hit that limit.
- **`AgentContext`** has the brief's fields plus `apiUrl` (so `onboard` can replace the anonymous `client` with a keyed one), `state` is a handle (`data` and `save()`), and `log` has a `redact` method that `onboard` uses for the API secret.
- **Loopback only.** `loadAgentEnv` keeps the P2 example's rule that the node must be on this machine (`RPC_NOT_LOOPBACK`) before it checks `WRONG_CHAIN`, and the P2 `MAINNET_REFUSED` is now `WRONG_CHAIN`.
- **Faucet.** `onboard` claims when the balance is below `minRoleStake + registrationFee`, as specified; the trader claims again before a trade if the balance cannot cover the worst fill.
- **PGlite platform.** It uses the Anvil suites' test helpers (`tests/helpers/database.ts`, `anvil.ts`). It does not run the health, operator-status or alert services, and the worker's alert jobs are not scheduled. The worker's job handlers are process-wide, so one pglite platform per process.
- **Removed.** `examples/agent/` (the README's content moved into `examples/agents/README.md`). Links in the root READMEs, `docs/DEVELOPMENT.md` and two web docs pages were updated; historical P2 and M5 documents still name `examples/agent`.

### Verification

See `.superpowers/sdd/2026-10-25-p3-reference-agents-drill/task-2-report.md` for the commands and counts. `pnpm build` and `pnpm build:pages` cannot run on this host; CI runs them.
