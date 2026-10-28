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

## Task 4 — resolution-side reference agents: proposer, challenger, juror, keeper (2026-10-27)

Scope: the four roles that settle a market, as ticks of the Task 2 runtime. The market-side roles (creator, maker, forecaster, trader) are Task 3. Only the contracts' public surface, the public API and `@blink/client` are used; `pnpm check:boundaries` is unchanged.

### What was built

- **`proposer`** (`examples/agents/src/roles/proposer.ts`): for an OPEN market past `closeAt` and before `proposalDeadline`, asks its model for the outcome. With one it uploads the evidence bytes to `/v1/content`, approves exactly the bond (`bondFor` of `proposerBondBps` of the maximum payout) and calls `propose` with `evidenceURI = /v1/content/<hash>`. When a round of its own dispute settles against its proposal, and the model's `appeal` says so, it approves the doubled bond and calls `appeal` once per dispute.
- **`challenger`**: in a PENDING market's creation window it calls `challengeCreation` with the ground its model finds (`CREATION_GROUND`) and the uploaded evidence. For a PROPOSED market inside its challenge window it calls `challengeResult` when the model's outcome differs from the proposed one, or when the proposal's evidence bytes cannot be fetched from `/v1/content` (a 404, `CONTENT_UNAVAILABLE` or a hash mismatch): an unsupported proposal, the P2 Task 12 rule.
- **`juror`**: for each open dispute round in its commit phase it decides a vote, saves `"<choice>:<salt>"` to `state.salts` **before** the commit transaction is sent, and commits `voteCommitment(...)`. Creation dispute: 1 iff the model objects. Result dispute: the model's outcome; an unsupported proposal is voted against (the other outcome). It never votes where it is the creator, challenger or proposer or holds a position (it skips, creates no salt, logs `skipped_vote`), and skips when the contract says it is not eligible (`ConflictedJuror`, `InsufficientCredit`, `NoWeight`, `DeadlineViolation`). It reveals in the reveal phase, and once the dispute is final it settles the votes (losers first, anyone's, so one absent juror cannot block the rest) and claims rewards.
- **`keeper`**: `open` after the creation window; `finalizeUnchallenged`; `finalizeTimeout` past `hardDeadline` (any non-final state); `settleRound` after the reveal phase; `finalizeDispute` after the appeal window; `distributeFees` of FINAL markets; `anchor` of every closed forecast-window root `BlinkAnchor` does not hold. A transaction that loses a race to another keeper (`InvalidState`, `AlreadySettled`, `AlreadyDistributed`, `AlreadyAnchored`) is logged once as `{event:"raced"}`; any other failure propagates.
- **Shared helpers** (`examples/agents/src/lib/resolution.ts`): chain time, paged market lists, evidence availability, bonds, and `attempt`, which matches a revert by its **custom error name**. A transaction that was mined and reverted is replayed with `simulateContract` to get the name.
- **`agentAbi`**: `registry.bondFor`, and the custom errors the roles tell apart (`markets`: `InvalidState`, `AlreadyDistributed`, `CreationWindowActive`, `CreationChallengePending`; `resolution`: `MissingRole`, `InvalidState`, `DeadlineViolation`, `AlreadySettled`, `LosersPending`, `NoMoreAppeals`, `ConflictedJuror`, `InsufficientCredit`, `NoWeight`, `InvalidVote`; `anchor`: `AlreadyAnchored`). The artifact-match test now also compares `error` entries.
- **`main.ts`**: the four roles are added to `ROLE_TICKS`.
- **Platform**: `startAlphaPlatform({ backend: "pglite", publicReadLimit })` takes an optional public read bucket (default unchanged: 60 calls, then 1 a second per client IP).

### Decisions and limitations

- **Restart safety.** A salt with no recorded landing is reconciled against the `VoteCommitted` event at the start of every tick, whatever the commit window; if the commit did not land and the window is open, the same saved commitment is sent again (the contract takes one vote per juror and round, so this cannot commit twice). Reveals are done before anything that calls the API.
- **Rate limit.** All agents of a drill share one client IP, and the pglite platform's public read bucket (60 calls, 1 a second) is far below what eight agents polling every 2 seconds spend. The commit, reveal and appeal windows are 30 seconds, so a drill on the default bucket will see 429s inside those windows. The Task 4 tests pass a large bucket; Task 6 needs a decision (a larger bucket for the drill, or fewer reads per tick).
- **Slashing is not repaired.** A proposer or creator that loses a dispute has its role stake slashed below the minimum and loses the role (`MissingRole` on its next transaction). The roles do not top themselves up; the tests restore the role with `addRoleStake`.
- **Damaged content.** `/v1/content` answers damaged bytes with `503 CONTENT_UNAVAILABLE`; the code is now in the schemas' `ErrorCode` (the only change to `packages/schemas`). `evidenceAvailable` treats a 404, `CONTENT_UNAVAILABLE` and a hash mismatch as unsupported evidence; every other error, a parse error included, propagates.
- **Keeper reads.** One `listMarkets` per live state per tick; a FINAL market is paged until all its windows are CLOSED with a root, so a market with a rootless window is rescanned every tick (marked `ponytail`). Ten pages of 100 per state is the ceiling.
- **Retries (fix round 1).** The juror saves its salt before every commit send, retries included; reward claims are selected from the saved state alone and retried until they succeed; the challenger keeps separate creation and result lists per market.
- **Time.** The tests move Anvil's clock to the next deadline (`evm_setNextBlockTimestamp` and a mined block) instead of waiting 330 s of real time. The platform's own clocks only gate the index's freshness, which the tests wait for.

### Verification

See `.superpowers/sdd/2026-10-25-p3-reference-agents-drill/task-4-report.md` for the commands and counts. `pnpm build` and `pnpm build:pages` cannot run on this host; CI runs them.

## Task 3 — market-side reference agents: creator, maker, trader, forecaster (2026-10-27)

Scope: the four market-side roles of `examples/agents`, each a `RoleTick`, wired into the role table of `main.ts`. The resolution-side roles are Task 4.

### What was built

- **Creator** (`src/roles/creator.ts`). For each draft of `model.questions()` not yet created: clamp `maxPairs` to what `createMarket` accepts now (market cap, the juror security bound `attackCost * 10000 / securityMultipleBps - openPayoutTotal`, and the creator's exposure limit), register the template if neither its state nor `GET /v1/templates` has it (`GM_LT_V1` after uploading the parser bytes read through `import.meta.resolve("@blink/client/templates/gm-lt-v1")`; class B and C use `registerTemplate(cls, 0x0, "blink:generic-v1")`), upload the exact spec bytes, approve the creation bond, call `createMarket` with `specURI = /v1/content/<specHash>`. With no room it logs `cap_exhausted` (again only when the room changes), sends nothing and tries again on a later tick. The chosen draft or suggestion is saved first (`state.intents`: exact spec bytes and `specHash`); a later tick or a restart reuses those bytes without asking the model, looks for its own `MarketCreated` with that hash, and marks the item done only after the market exists, so a creation that landed but was not recorded is not paid for twice, whatever the model now answers.
- **Suggestions.** The creator claims only suggestions whose status is `OPEN` and for which `model.fromSuggestion(text)` has a draft. The claimed id is saved before the spec is built (`spec.suggestionId` is set); a claim from an earlier run is resumed. A `409 ALREADY_CLAIMED` is logged once as `suggestion_already_claimed` and nothing is created for it.
- **Maker** (`src/roles/maker.ts`). Deposits 100 bUSD once (sent with an explicit nonce read after the approval is mined and saved first; an unresolved attempt is re-sent with the same nonce, so it lands at most once, and every tick asks the chain for a `MakerDeposited` of its own first), then quotes each open RFQ in a market where `model.probabilityBps` is non-null: the model's probability for the RFQ's side plus 300 bps (clamped to 1..9999), signed with `quoteTypedData`, living 30 s (or until close). `makerStop` sends `incrementMakerEpoch`; `main` calls it after the loop ends on SIGTERM/SIGINT (`ROLE_STOPS`).
- **Forecaster** (`src/roles/forecaster.ts`). Signs the `Forecast` struct for every OPEN window of an OPEN market where the model has a view and submits it, once per window (window ids in the state).
- **Trader** (`src/roles/trader.ts`). Takes only markets whose spec can be read and where the model has a view; the side is the one the model favours (YES from 50%). After the first verified quote it waits a grace period (twice the poll interval by default) so that a second maker can undercut it, then takes the cheapest still good quote. If the model's probability for that side beats the price by less than 500 bps it logs `no_edge` and records the market as passed. The rest (pending-fill journal, exactly-once fill, redemption, backoff) is unchanged.
- **Shared schema.** `ApiErrorCode` gained `ALREADY_CLAIMED`: the suggestion claim route answers `409 ALREADY_CLAIMED` but the code was not in the enum, so the client threw a `ZodError` instead of `BlinkApiError` (the same gap M5 fixed for the faucet codes). One line in `packages/schemas/src/core.ts`; no route changed.
- **agentAbi** gained `registry.limitMultiplierBps`, `registry.bondFor`, `jurors.attackCostMicros`, `markets.openPayoutTotal`, `markets.openPayoutByCreator` and the `MakerDeposited` event.

### Decisions and limitations

- **Claims are not exclusive (P2).** Each creator claims a suggestion once; two different creators can both claim it and both create a market, each posting its own bond, because `DuplicateSpec` is per creator. The creator therefore reads the queue for `OPEN` suggestions only. What is tested is a duplicated process with one key. Distinct creators that read `OPEN` at the same instant can both create: a known limit.
- **The edge is measured against quotes.** There are no quotes before an RFQ, so the trader posts an RFQ where it has a view and gates the fill on the 500 bps edge. A market passed on is not looked at again.
- **Unreadable specs.** A market whose spec cannot be read, or that the model has no view on, is never traded: no RFQ and no fill. There is one code path and no compatibility flag. The P2 trader scenarios keep their assertions; their harness changed instead: `rfq-stack` stores a readable spec for the market it creates, and the harness model gives a 7000 bps view of every market (the makers there quote 4000).
- **Class B and C template.** One generic template per class (`registerTemplate(cls, 0x0, "blink:generic-v1")`), registered by whichever creator needs it first; its first use gets the longer creation window. The URI is a constant in `creator.ts`.
- **Schedule.** `closeInSeconds` counts from the end of the creation window including the extra first-use window, which is always added (a reviewed template just gives a market that is open slightly longer). The proposal deadline is close plus 120 s; the hard deadline adds the result challenge window, `maxRounds` rounds and 60 s of slack.
- **Log noise.** `cap_exhausted` is logged once per draft or suggestion while the room is unchanged (per process; a restart says it once more).

## Task 6 — one-command autonomous reference-agent drill (2026-10-28)

### Built

- Added `pnpm alpha:autonomous` with separate agent processes, distinct funded Anvil accounts, per-scenario deadlines, JSON reports, and per-agent logs. The 14-agent world covers two creators, two makers, two traders, a forecaster, honest and lying proposers, a challenger, three jurors, and a keeper. The creation-challenged creator and lying proposer have no later duties.
- The drill runs normal class A, result dispute, creation challenge, no-proposal timeout, and suggestion scenarios. It cross-checks public API results against chain events and balances, role credit, and an incremental-index rebuild.
- Class A fixture judgements require the agent's own belief entry; a regression test and drill assertions verify the lying proposer acts only on its dispute market.
- Added a public API read-bucket setting for the shared loopback IP. Production remains at capacity 60 with refill 1 per second; the drill uses capacity 600 and refill 100 per second. Anvil account-count support supplies distinct funded accounts without platform wallet funding.
- CI runs both the PostgreSQL success drill and the named stalled-timeout regression, and retains `tmp/alpha-autonomous/` on failure. Its 31-minute limit is `ceil(904s/60)+15m`, based on the measured timeout scenario.

### Schedule and R6

The deployment parameters give `creationWindow + firstUseExtraWindow = 90s`, a 120-second proposal window, a 60-second result challenge window, three 90-second dispute rounds, and 60 seconds of hard-deadline margin. The world uses `closeInSeconds = 300` for normal, suggestion, and timeout, and 200 for the challenged result market.

- Normal and suggestion close at +390s and can first finalize at +452s. Dispute round 2 opens at +442s, so neither is finalized before it opens.
- The timeout market reaches its hard deadline at +900s (`390 + 120 + 60 + 3×90 + 60`). It has no proposer. Even the conservative upper bound of normal plus suggestion is two finalized markets, below the phase-in threshold of three; the computed finalized count at round-2 opening is zero. Creation is CANCELLED and does not increment `finalizedCount`.
- The drill checks `creditThreshold == 0` on every creation and result dispute round. It does not alter protocol parameters or chain time.

### Verification status

- `pnpm check:contracts`, `pnpm build:services`, the four service build smoke tests, `pnpm exec tsc --noEmit`, and `git diff --check` passed.
- The final PGlite run passed all scenarios and global checks in 954s: normal 454s, dispute 447s, creation 92s, timeout 904s, suggestion 454s. It spent 14 wallet challenges. A previous run exposed that the public account API uses uppercase role names (`TAKER` for the agent's `trader`); the drill now maps and cross-checks those names. Final PostgreSQL and `pnpm check` results are recorded in the Task 6 external report.
