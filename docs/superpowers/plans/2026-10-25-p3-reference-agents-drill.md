# P3 Reference Agents, Agent Docs and the Autonomous Drill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independent reference agents for every market role, agent documentation good enough to onboard from, and the one-command `pnpm alpha:autonomous` drill that runs all five §2.1 scenarios to the end with no platform role and no human step.

**Architecture:**
- `@blink/client` gains the agent kit: the agent-facing ABI, the protocol constants, the vote commitment and the GM_LT_V1 template.
- `examples/agents` is a workspace package. Each agent is its own OS process that knows only its key, the API URL, the RPC URL, a world file and its name. It reaches everything else through the public API, `@blink/client` and the contracts.
- The drill starts P2's infrastructure-only platform, then about fifteen agent processes. The world file's per-agent beliefs make every scenario deterministic.

**Tech Stack:**
- Node 22, TypeScript, pnpm workspace
- viem
- Anvil (chain 84532)
- PostgreSQL in CI; PGlite in process on hosts without PostgreSQL
- `@anthropic-ai/sdk`, only in the optional LLM demo

**Spec:** `docs/superpowers/specs/2026-10-23-autonomous-market-design.md` (§2.1, §3, §5.2–§5.12, §8, §11)

**Prerequisite:** P2 (`docs/superpowers/plans/2026-10-24-p2-offchain-protocol.md`) has passed its final review, is merged to main, and CI is green. Every P3 task starts from that main.

## Global Constraints

- Reference agents "use only the public documentation, the public API and their own keys, and must not use any internal package or privileged configuration (enforced by an import-boundary test)" (§8).
- The drill "starts only the chain, the contracts and the platform infrastructure (API, indexer, web optional), then starts several independent reference agent processes" (§2.1.2).
- "The drill may use a test parameter set (shorter deadlines), but the threshold rules must be identical to the production parameters … the drill must not add any privilege" (§2.1.2). The drill uses `presets.alpha` unchanged. It never calls `evm_increaseTime`, `anvil_setBalance` or impersonation, and it never writes to the database.
- "The platform processes' configuration contains no key for a maker, proposer, challenger, juror, keeper, creator or trader" (§2.1.3). Every platform process goes through P2's `assertNoRoleKeys`.
- Fixture models by default: "CI and the §2.1 drill use only them, and the results are reproducible" (§8).
- The LLM demo "receives only `/llms.txt` and the documentation, uses the operator's own model key … It is not in CI" (§8).
- Anti-goal: "The website or documentation claims a capability that is not implemented yet" (§3).
- Docs state the trust assumption as "**Under the publicly listed assumptions**, honesty is the provably best strategy", and say that the drill uses a fixed test price (§5.12).
- Chain 84532 only, on local Anvil. No deployment, no paid service and no broadcast to a public network (`AGENTS.md`).
- English for all code comments, docs and commit messages. Every commit ends with its implementer's `Co-Authored-By` line.
- Web-consumed changes run `pnpm build` in CI, because this host cannot run Turbopack.

## Review Focus

1. **An agent restarts mid-dispute** (a juror between commit and reveal; a proposer after proposing). It must resume from its state file, never commit twice and still reveal. Test: Task 4 `juror restarted after commit still reveals`.
2. **The API answers `503 INDEX_STALE` or `429` with `Retry-After`.** The agent backs off, acts on no stale read, and its loop keeps running. Test: Task 2 `loop backs off on INDEX_STALE and 429 and keeps ticking`.
3. **Two agents race one permissionless action**: two keepers finalize the same market, or two creators claim the same suggestion. The loser logs the revert or `409` once and moves on, with no crash and no retry storm. Tests: Task 4 `two keepers race finalize`, Task 3 `two creators race one suggestion`.
4. **The per-market cap leaves little room**: juror stake bounds `maxPairs`. The creator clamps `maxPairs` to the contract's headroom and waits when there is none, instead of sending a transaction that reverts. Test: Task 3 `creator clamps maxPairs to the security bound`.
5. **A drill scenario stalls.** Each scenario has a deadline. A failure names the scenario, the market's last indexed state and the last 20 log lines of each agent involved. It never hangs until the CI timeout. Test: Task 6 `drill reports a stalled scenario by name`.

---

## Pre-flight rulings (the controller records these in the ledger before Task 1)

- **Forecast windows in a short market.** P2 Task 10 schedules DAILY windows and a PRE_CLOSE window one hour before close. Read how the merged `scripts/local-alpha.ts` gets "a forecast in a window" inside an alpha market, and use that same mechanism. Record the normal-scenario `closeAt` offset it implies, and the CI `timeout-minutes` derived from it (the time the slowest scenario needs plus 15 minutes).
- **Juror credit phase-in.** `roundCreditThreshold` (`[0, 5, 10, 20]`) applies once `finalizedCount() >= phaseInFinalizedMarkets` (3). Fresh jurors have credit 0, so the dispute scenario's appeal round must open before the third market reaches FINAL.
  - The world file schedules the dispute market first.
  - The drill asserts that every dispute round's `creditThreshold` read from the contract is 0.
  - Nothing is overridden. This is the production cold-start rule.
- **Timeout scenario.** It covers "nobody submits". The "arbitration reaches no conclusion" branch is already covered by the P1 forge suites, and the drill does not repeat it.
- **Contract-wallet makers.** P2 Task 11 already proves an ERC-1271 maker. The drill's makers are EOAs, because deploying `MockErc1271Wallet` is test-only.
- **CDP SDK wallets.** P2 Task 12 says "P3 verifies CDP SDK wallets". That needs the operator's Coinbase Developer Platform credentials, which are an external service. P3 does not do it unless the user supplies credentials. The docs say EOA and ERC-1271 wallets are supported and name no CDP result.

---

### Task 1: Agent kit in `@blink/client`

**Files:**
- Create:
  - `packages/client/src/agent-abi.ts`
  - `packages/client/src/protocol-constants.ts`
  - `packages/client/src/templates/index.ts`
  - `tests/client-agent-kit.test.ts`
- Move: `packages/domain/src/gm-parser.ts` → `packages/client/src/templates/gm-lt-v1.ts` (`git mv`), and `tests/gm-parser.test.ts` → `tests/gm-lt-v1.test.ts`.
- Modify:
  - `packages/domain/src/index.ts`: drop the parser export
  - `packages/client/src/index.ts`
  - `packages/client/package.json`: `exports` gains `"./templates/gm-lt-v1": "./src/templates/gm-lt-v1.ts"`
  - `docs/P3_AGENTS_PROGRESS.md`: create it with a Task 1 section

**Interfaces:**
- Consumes (P2):
  - T9's `verifySignedQuote`, `approvalFor` and the RFQ client methods;
  - T7's read methods (`deployment`, `markets`, `market`, `spec`, `disputes`, `dispute`, `fees`, `account`, `positions`, `templates`);
  - T8's content and suggestion methods;
  - T10's forecast methods.
- Produces:
  - **`agentAbi`**: `{ registry, jurors, markets, resolution, faucet, usd, platformToken, anchor }`. Each entry is a `parseAbi` list of exactly the functions and events the reference agents and the docs use: every write named in the spec's role steps, plus the views agents read (`hasRole`, `creditOf`, `getMarket`, `getPosition`, `getDispute`, `slashableStake`, `balanceOf`, `allowance`).
    - Delete T9's inline `parseAbi` lists in its taker example and use `agentAbi`.
    - If T9 left no maker-side builder, add `quoteTypedData(quote, deployment)` beside `verifySignedQuote`, and make `verifySignedQuote` use it.
  - **`ROLE`, `QUESTION_CLASS`, `MARKET_STATE`, `OUTCOME`**: `as const` objects copied from the Solidity enums.
  - **`CREATION_GROUND = { WRONG_CLASS: 0, AMBIGUOUS: 1, MANIPULABLE: 2 }`**: the spec's §5.3 order. The contract only bounds `ground < 3`, so this order is a P3 decision, and the docs say so.
  - **`voteCommitment({ disputeId, round, juror, choice, salt }): Hex`**: `keccak256(abi.encode(disputeId, round, juror, choice, salt))`, with the Solidity parameter types.
  - **`templateIdFor(cls: number, parserHash: Hex, uri: string): Hex`**: `keccak256(abi.encode(cls, parserHash, uri))`.
  - **`GM_LT_V1`**: `{ cls: QUESTION_CLASS.A_COMPUTABLE, parserHash, uri, templateId }`.
    - `parserHash` is keccak256 of the exact bytes of `templates/gm-lt-v1.ts`.
    - `uri` is `/v1/content/${parserHash}`: the parser bytes uploaded to the content store, resolved against whichever API an agent uses.
  - **`gmLtV1Outcome(sourceText: string, extraction: string): "YES" | "NO" | null`**, inside `gm-lt-v1.ts`, so that the hash covers it.
    - `extraction` is the JSON `{"thresholdBps":<integer 1..9999>}`.
    - It returns YES iff the parsed `valueBps < thresholdBps`, and null when the parse is ambiguous or the extraction is invalid.
  - **Re-exports from `@blink/schemas`**: `parseMarketSpec` and the type `MarketSpecV02`, so that agents never import schemas.

- [ ] **Step 1: Write the failing tests.**
  - `tests/client-agent-kit.test.ts`:
    - `agentAbi matches the compiled artifacts`: every function and event signature exists, byte for byte, in `contracts/out` (the same comparison `tests/protocol-abi.test.ts` makes).
    - `enums match the Solidity sources`: parse the `enum` blocks under `contracts/src/protocol`.
    - `GM_LT_V1 parserHash pins the parser bytes`: `keccak256(readFileSync(gm-lt-v1.ts)) === GM_LT_V1.parserHash`, and the pinned literal is in the test. Changing the parser means a new template, so the test says that in its failure message.
    - `GM_LT_V1 templateId equals templateIdFor(cls, parserHash, uri)`.
    - `voteCommitment encodes the reveal tuple`: compare it with `encodeAbiParameters` over the types read from the `revealVote` ABI entry.
  - `tests/gm-lt-v1.test.ts`:
    - the moved parser cases, unchanged;
    - `gmLtV1Outcome` gives YES below the threshold, NO at or above it, and null for an ambiguous source and for `{"thresholdBps":0}`.
- [ ] **Step 2: Run** `node --import tsx --test tests/client-agent-kit.test.ts tests/gm-lt-v1.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the files above. `pnpm check:boundaries` must still pass, with `client` allowed only `schemas`.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm test && pnpm check:boundaries && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: agent kit in the client with pinned ABI, constants and the GM_LT_V1 template`.

### Task 2: `examples/agents` package, shared agent runtime and the import boundary

**Files:**
- Create:
  - `examples/agents/package.json`: `@blink/examples`, private, deps `@blink/client: workspace:*` and `viem`
  - `examples/agents/src/main.ts`
  - `examples/agents/src/lib/{env,session,loop,state,model,world}.ts`
  - `examples/agents/README.md`, which replaces `examples/agent/README.md`
  - `scripts/alpha/platform.ts`
  - `tests/agents-runtime.test.ts`
- Move: `examples/agent/run.ts` → `examples/agents/src/roles/trader.ts` (the spec's trader is the RFQ taker), rewritten as a `RoleTick`. Delete `examples/agent/`.
- Modify:
  - `pnpm-workspace.yaml`: add `examples/*`
  - `scripts/check-boundaries.mjs`: add the `examples` rule below
  - `scripts/local-alpha.ts`: start the platform through `startAlphaPlatform`
  - the client-agent Anvil test from P2 T9: point it at the moved trader
  - `docs/P3_AGENTS_PROGRESS.md`

**Interfaces:**
- **Env.** `loadAgentEnv(env): Promise<AgentEnv>` reads:

  | Variable | Notes |
  |---|---|
  | `BLINK_AGENT_NAME` | |
  | `BLINK_AGENT_ROLES` | comma list of `creator,maker,trader,forecaster,proposer,challenger,juror,keeper` |
  | `BLINK_API_URL` | |
  | `BLINK_RPC_URL` | |
  | `BLINK_AGENT_KEY` | 0x-hex; never logged |
  | `BLINK_WORLD` | path |
  | `BLINK_AGENT_STATE_DIR` | |

  It rejects with `WRONG_CHAIN` unless `eth_chainId` is 84532, and with `MISSING_ENV:<name>` for a missing variable.
- **Context.** `type AgentContext = { name, roles, client, publicClient, walletClient, account, deployment, model, state, log }`. `deployment` comes from `client.deployment()`, never from a file.
- **Session.** `onboard(ctx): Promise<void>` is idempotent:
  1. faucet `claim` when the bUSD balance is below `minRoleStake + registrationFee`;
  2. `register` when the account is unregistered;
  3. `joinRole(role)` with `minRoleStake` from `deployment.params`, for each role in `BLINK_AGENT_ROLES` except trader;
  4. for jurors, approve and `stake` the whole platform-token balance;
  5. create an API key through the T6 wallet-proof flow, with the scopes its roles need.
- **Loop.** `type RoleTick = (ctx: AgentContext) => Promise<void>`. `runAgent(ctx, ticks: RoleTick[], { tickMs, signal })` runs every tick each period.
  - A `BlinkApiError` of `503 INDEX_STALE` or `429` skips the rest of that tick, honours `Retry-After` (default 5 s), and logs `{event:"backoff"}`.
  - Any other error is logged as `{event:"tick_error", code}`, and the loop continues.
  - SIGTERM stops it after the current tick.
- **Log.** `log(event: string, fields?: Record<string, unknown>)` writes one JSON line to stdout with `ts, agent, event`. It never logs the key or the API secret. A test greps the output for both.
- **State.** `loadState(dir)` and `saveState(dir, state)`: JSON, written to a temp file and renamed. Commit salts, the API key id and acted-on market ids live there.
- **Model** (`lib/model.ts`):
  ```ts
  type MarketView = { marketId: bigint; specHash: Hex; spec: MarketSpecV02 };
  type QuestionDraft = { key: string; spec: MarketSpecV02; closeInSeconds: number; maxPairs: number };
  interface Model {
    questions(): Promise<QuestionDraft[]>;
    fromSuggestion(text: string): Promise<QuestionDraft | null>;
    probabilityBps(m: MarketView): Promise<number | null>;
    outcome(m: MarketView): Promise<{ outcome: "YES" | "NO"; evidence: Uint8Array } | null>;
    creationObjection(m: MarketView): Promise<{ ground: keyof typeof CREATION_GROUND; evidence: Uint8Array } | null>;
    appeal(m: MarketView): Promise<boolean>;
  }
  function fixtureModel(world: World, agentName: string): Model;
  ```
- **World** (`lib/world.ts`). `World` is validated with a strict schema written in the example (examples cannot import zod from schemas; hand-written checks are fine):
  - `questions: Record<key, { spec, closeInSeconds, maxPairs, sources?: Record<httpsUrl, relativeFile> }>`
  - `suggestions: Record<text, key>`
  - `agents: Record<name, { roles, creates?: key[], claimsSuggestions?: boolean, beliefs: Record<key, { outcome?, probabilityBps?, objection?, appeal? }> }>`
  - Markets match questions by `spec.title`, which must be unique in the world.
  - For a class A market, `outcome` runs `gmLtV1Outcome` over the agent's source bytes and never reads `beliefs.outcome`.
  - An agent with no belief and no source for a market answers null.
- **Platform.** `startAlphaPlatform({ backend: "postgres" | "pglite" }): Promise<{ apiUrl, rpcUrl, webUrl?, deploymentId, stop() }>`, in `scripts/alpha/platform.ts`.
  - Extract it from T11's `scripts/local-alpha.ts`.
  - The `pglite` backend runs the API, indexer and worker in process over PGlite, as the Anvil tests already do.
  - Both backends call `assertNoRoleKeys` on every platform config's env.
- **Entry point.** `node --import tsx examples/agents/src/main.ts` runs `loadAgentEnv`, then `onboard`, then `runAgent` with the ticks for its roles.
- **Boundary rule**, in `check-boundaries.mjs`:
  - Files under `examples/agents/src` may import only `@blink/client`, `@blink/client/templates/gm-lt-v1`, `viem`, `viem/*`, `node:*` and relative paths inside `examples/agents`.
  - They must not contain the strings `contracts/out`, `packages/` or `apps/`.
  - They must not call `parseAbi` (ABIs come from `agentAbi`).

- [ ] **Step 1: Write the failing tests** in `tests/agents-runtime.test.ts`:
  - `loadAgentEnv rejects a missing variable and a non-84532 chain`, against a stub RPC.
  - `loop backs off on INDEX_STALE and 429 and keeps ticking`: a stub tick throws each error once; assert the backoff log lines, the honoured `Retry-After` and a third successful tick.
  - `state survives a rename-write and a reload`.
  - `fixture model answers only from its own beliefs`: two agents, one world, different answers; class A computes from source bytes.
  - `logs never contain the key or the API secret`.
  - `boundary check rejects an examples import of @blink/schemas, an adapters path and an inline parseAbi`: run `check-boundaries.mjs` against a temp fixture tree.
- [ ] **Step 2: Run** `node --import tsx --test tests/agents-runtime.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the files above.
- [ ] **Step 4: Run** the Step 2 command and the T9 client-agent Anvil test (`node --import tsx --test tests/anvil/client-agent.test.ts`), then `pnpm test && pnpm check:boundaries && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: reference agent runtime with fixture models, state, backoff and an enforced import boundary`.

### Task 3: Market-side agents: creator, maker, trader, forecaster

**Files:**
- Create: `examples/agents/src/roles/{creator,maker,forecaster}.ts`, `tests/anvil/agents-market-roles.test.ts`
- Modify: `examples/agents/src/roles/trader.ts`, `examples/agents/src/main.ts` (the role table), `docs/P3_AGENTS_PROGRESS.md`

**Interfaces:**
- Consumes: Task 1 `agentAbi`, `GM_LT_V1` and `templateIdFor`; Task 2 `RoleTick`, `AgentContext`, `Model` and `startAlphaPlatform`.
- Produces: `creator`, `maker`, `trader` and `forecaster`, each a `RoleTick`.
- **`creator`**:
  - **Questions.** For each `model.questions()` draft not yet in state:
    1. When a draft is class A, register `GM_LT_V1` if `templates()` lacks it (`registerTemplate` is idempotent), after uploading the parser bytes, read through `import.meta.resolve("@blink/client/templates/gm-lt-v1")`.
    2. Upload the spec bytes to `/v1/content`.
    3. Approve the creation bond.
    4. Call `createMarket` with `specURI = /v1/content/<specHash>`, clamping `maxPairs`.
  - **Suggestions** (when `claimsSuggestions`): claim an open suggestion through the T8 route, build the spec with `model.fromSuggestion(text)`, and set `spec.suggestionId`.
  - **Clamp.** Clamp `maxPairs` to the headroom from the contract views that `createMarket` checks. When the headroom is under one pair, log `cap_exhausted` and retry on a later tick.
- **`maker`**:
  - Deposit once to a working balance.
  - For each open RFQ in a market where `model.probabilityBps` is non-null, sign a quote with `quoteTypedData`:
    - the price is the model probability plus or minus a fixed 300 bps half-spread, clamped to 1..9999;
    - the lifetime is 30 s.
  - Call `incrementMakerEpoch` on SIGTERM.
- **`trader`**: T9's taker flow as a tick:
  1. RFQ on markets where the model's edge against the best quote is at least 500 bps;
  2. `verifySignedQuote`;
  3. approve;
  4. `fillQuote`;
  5. `redeem` once the market is FINAL.
- **`forecaster`**: for each open window of a market with a non-null probability, sign the T10 `Forecast` struct and submit it, once per window, recorded in state.

- [ ] **Step 1: Write the failing tests** in `tests/anvil/agents-market-roles.test.ts`, on `startAlphaPlatform({ backend: "pglite" })`. Ticks run in process; tests may advance Anvil time.
  - `creator registers GM_LT_V1 once and creates a class A market whose spec bytes hash to specHash`
  - `creator claims a suggestion and records suggestionId`
  - `two creators race one suggestion`: one creates; the other logs the `409` once and creates nothing.
  - `creator clamps maxPairs to the security bound`: with juror stake lowered, the market is created with the clamped `maxPairs`; with none, there is no transaction and one `cap_exhausted` line.
  - `maker quotes only where its model has a view, and trader fills the better of two quotes`
  - `trader redeems after FINAL and the payout equals getPosition`
  - `forecaster submits one signed forecast per window and the API verifies it`
- [ ] **Step 2: Run** `node --import tsx --test tests/anvil/agents-market-roles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the role files.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm test && pnpm test:anvil && pnpm check:boundaries`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: creator, maker, trader and forecaster reference agents`.

### Task 4: Resolution-side agents: proposer, challenger, juror, keeper

**Files:**
- Create: `examples/agents/src/roles/{proposer,challenger,juror,keeper}.ts`, `tests/anvil/agents-resolution-roles.test.ts`
- Modify: `examples/agents/src/main.ts`, `docs/P3_AGENTS_PROGRESS.md`

**Interfaces:**
- Consumes: Task 1 `voteCommitment`, `CREATION_GROUND`, `OUTCOME` and `gmLtV1Outcome`; Task 2 runtime.
- Produces: `proposer`, `challenger`, `juror` and `keeper`, each a `RoleTick`.
- **`proposer`**: for an OPEN market past `closeAt` with no proposal, when `model.outcome` is non-null:
  1. upload the evidence bytes;
  2. `propose(id, outcome, evidenceHash, "/v1/content/<hash>")`, after approving the bond;
  3. `appeal` a lost round when `model.appeal` is true.
- **`challenger`**:
  - For a PENDING market with a `model.creationObjection`, call `challengeCreation(id, CREATION_GROUND[ground], evidenceHash)`.
  - For a PROPOSED market, call `challengeResult` when the model's outcome differs from the proposed one, or when the proposal's evidence bytes cannot be fetched from `/v1/content`.
- **`juror`**:
  - **Commit.** For each dispute round in its commit phase where it is not conflicted, build the commitment with `voteCommitment` and a random 32-byte salt, then `commitVote`. The salt is saved to state *before* the transaction is sent.
  - **Choice.** For a CREATION dispute the choice is 1 iff the model objects (1 upholds). For a RESULT dispute:
    - the choice is the model's outcome;
    - a proposal whose evidence bytes cannot be fetched counts as unsupported, which is a vote against the proposer (the P2 Task 12 rule).
  - **Later phases.** `revealVote` in the reveal phase; `settleVote` and `claimRewards` after settlement.
- **`keeper`**: calls whichever permissionless transitions are due.
  - `open` after the creation window.
  - `finalizeUnchallenged` and `finalizeTimeout`.
  - `settleRound` and `finalizeDispute`.
  - `distributeFees`.
  - `anchor` for window roots without an anchor.
  - A revert from losing a race is logged once as `{event:"raced"}`.

- [ ] **Step 1: Write the failing tests** in `tests/anvil/agents-resolution-roles.test.ts`. Same harness; tests may advance Anvil time.
  - `honest proposer proposes the computed class A outcome with archived evidence and keeper finalizes it`
  - `challenger challenges a wrong proposal, jurors vote the truth, the proposer appeals once and loses again, and the proposer bond goes to the challenger`
  - `upheld creation challenge cancels the market and pays the creator bond to the challenger`
  - `no proposer means finalizeTimeout and INVALID`
  - `juror votes against a proposal whose evidence bytes are missing`
  - `juror restarted after commit still reveals`: kill the tick context after commit, rebuild it from the state dir, and assert one commit and one reveal.
  - `conflicted juror never commits`: a juror holding a position in the market.
  - `two keepers race finalize`: one succeeds; the other logs `raced` once.
- [ ] **Step 2: Run** `node --import tsx --test tests/anvil/agents-resolution-roles.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the role files.
- [ ] **Step 4: Run** the Step 2 command, then `pnpm test && pnpm test:anvil && pnpm check:boundaries`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: proposer, challenger, juror and keeper reference agents`.

### Task 5: Agent documentation and `/llms.txt`

**Files:**
- Modify `apps/web/content/docs/`:
  - rewrite `agents.md` (the entry page: choose a role), `roles.md`, `lifecycle.md`, `concepts.md`, `faq.md` and `client.md`;
  - rename `joining.md` → `onboarding.md`; rewrite `trader.md`.
- Create, in `apps/web/content/docs/`:
  - one page per role: `creator.md`, `maker.md`, `forecaster.md` (rewritten), `proposer.md`, `challenger.md`, `juror.md`, `keeper.md`;
  - `contracts.md`;
  - `trust.md`.
- Delete: `question-proposer.md`, `resolution-reporter.md`.
- Modify, outside the pages:
  - `apps/web/lib/docs/ia.ts` (`DOC_SLUGS`, `DOC_GROUPS`)
  - `apps/web/lib/docs/llms.ts`
  - `tests/web-docs-content.test.ts`
  - `docs/P3_AGENTS_PROGRESS.md`
- Test: `tests/agent-docs-coverage.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 1–4: the exact calls each role makes;
  - `agentAbi`;
  - P2's OpenAPI generator (the `api` page stays generated).
- **Role pages.** Each one has exactly these H2 headings, in order (§8's list): `Duties`, `Stake or bond`, `Income`, `Credit`, `Risks`, `Steps`.
  - `Steps` lists each API route and each contract call in order, named exactly as in `agentAbi` and the OpenAPI document.
  - Parameter values are never hard-coded. Pages name the `Params` field and say to read it from `GET /v1/deployment` (`params`).
- **`contracts.md`.** It renders every `agentAbi` signature, grouped by contract. A test regenerates the list and compares it.
- **`trust.md`.** It carries §5.12's assumption sentence verbatim, the fixed test price notice, the cold-start cap behavior, and the `CREATION_GROUND` numbering as a P3 decision.
- **`/llms.txt`.** It follows the llmstxt.org shape:
  - an H1 `Blink`;
  - a blockquote summary;
  - `## Start here`: `agents`, `onboarding`, `trust`;
  - `## Roles`: the eight role pages;
  - `## Reference`: `contracts`, `api`, `errors`, `client`.
  - Each link is absolute, to the page's generated `.md` under `/docs/`.

- [ ] **Step 1: Write the failing tests** in `tests/agent-docs-coverage.test.ts`:
  - `every role page has the six sections in order`
  - `every agentAbi function and every client method the examples call appears in the docs`: scan `examples/agents/src` for `functionName:` literals and `client.<method>(` calls.
  - `contracts.md lists exactly the agentAbi signatures`
  - `llms.txt links every docs page and only existing pages`
  - `no page claims unimplemented capability`: none of `invitation`, `Candidates`, `no public API`, `operator approval`, `approved by Blink` (v0.1 phrases). Stating a limit such as "the relay polls; there is no push delivery" is allowed.
  - `trust.md carries the assumption sentence and the fixed test price notice`
- [ ] **Step 2: Run** `node --import tsx --test tests/agent-docs-coverage.test.ts tests/web-docs-content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the pages**, update `ia.ts` and `llms.ts`, and update `tests/web-docs-content.test.ts` for the new slugs.
- [ ] **Step 4: Run** the Step 2 command and `pnpm test && pnpm typecheck`, then push to a branch and confirm that CI's `pnpm build` and `pnpm build:pages` pass. Expected: PASS.
- [ ] **Step 5: Commit** `docs: agent documentation and llms.txt for choosing a role and onboarding`.

### Task 6: `pnpm alpha:autonomous`

**Files:**
- Create:
  - `scripts/alpha-autonomous.ts`
  - `examples/agents/worlds/drill.json`, and its source files under `examples/agents/worlds/sources/`
  - `tests/alpha/autonomous.test.ts`
- Modify:
  - `package.json`: `alpha:autonomous`, which runs `node --import tsx scripts/alpha-autonomous.ts`
  - `.github/workflows/ci.yml`: an `autonomous` job with a PostgreSQL service, Foundry, the `timeout-minutes` from the pre-flight ruling, and the `tmp/alpha-autonomous/` logs uploaded on failure
  - `.gitignore`: `tmp/`
  - `docs/P3_AGENTS_PROGRESS.md`

**Interfaces:**
- Consumes: `startAlphaPlatform`, the agent entry point, the world file and the role ticks.
- **Usage.** `pnpm alpha:autonomous [--backend postgres|pglite]`:
  - `postgres` (the default, used in CI) needs `TEST_POSTGRES_ADMIN_URL` and runs the platform as separate processes;
  - `pglite` runs it in process, for hosts without PostgreSQL.
  - Agents are always separate `node` processes.
- **Agent environments.** The orchestrator gives each agent only the Task 2 env, with a distinct Anvil test account as its key. The orchestrator's own `process.env` and every platform config must pass `assertNoRoleKeys`.
- **Roster.** About fifteen agents, one or more roles each:
  - two creators;
  - two makers;
  - two traders;
  - one forecaster;
  - an honest proposer;
  - a lying proposer that knows only the dispute question and appeals;
  - one challenger;
  - three jurors, who never trade;
  - one keeper.
  - The world file assigns the beliefs.
- **Suggestion.** The orchestrator plays the human: it posts the world's suggestion anonymously through `POST /v1/suggestions` and does nothing else.
- **Assertions.** Read through the public API, with on-chain cross-checks; each scenario has its own deadline.
  - **normal (class A):**
    - created → OPEN with no challenge;
    - two quotes and a fill;
    - a forecast in a window, with an anchored root;
    - a proposal whose `evidenceHash` equals the uploaded source bytes' keccak256;
    - FINAL;
    - fees equal to `FeesDistributed`;
    - every trader redeemed.
  - **dispute (class B):**
    - challenge, round 1, one appeal, round 2;
    - FINAL with the true outcome;
    - the lying proposer's bond is slashed to the challenger;
    - every round's `creditThreshold` is 0 (pre-flight ruling);
    - traders redeemed.
  - **creation challenge:** CANCELLED, never OPEN; the creator's bond is with the challenger.
  - **timeout:** INVALID; traders redeemed at 0.5 per share.
  - **suggestion:**
    - the suggestion shows `MARKET_CREATED`;
    - the spec's `suggestionId` equals it;
    - the market reaches FINAL and redeems.
  - **all scenarios:**
    - for every agent and role, credit from `GET /v1/accounts/:address` equals `creditOf`;
    - rebuilding the index equals the incremental index;
    - no platform env holds a role key.
- **Report.** `tmp/alpha-autonomous/report.json` holds each scenario's pass or fail. Agent logs go to `tmp/alpha-autonomous/agents/<name>.log`.
- **Exit status.** 0 only when every scenario passed.

- [ ] **Step 1: Write the failing test** in `tests/alpha/autonomous.test.ts`:
  - It runs the drill with the `postgres` backend, and is skipped with a printed reason when `TEST_POSTGRES_ADMIN_URL` is absent.
  - It asserts that every report scenario is `pass`.
  - `drill reports a stalled scenario by name`: run with a world whose timeout-scenario keeper is removed, and a 60 s scenario deadline. Assert the failure names `timeout`, the market's indexed state and the agents' last log lines, and that the drill exits non-zero well before the job timeout.
- [ ] **Step 2: Run** `pnpm alpha:autonomous --backend pglite` locally. Expected: it fails, because the drill does not exist yet.
- [ ] **Step 3: Implement** the script and the world file.
- [ ] **Step 4: Run** `pnpm alpha:autonomous --backend pglite`, then `pnpm check`. Expected: every scenario passes locally. Then push to a branch and confirm the CI `autonomous` job is green with the `postgres` backend.
- [ ] **Step 5: Commit** `test: one-command autonomous drill runs all five scenarios with independent agent processes`.

### Task 7: Optional LLM agent demo

**Files:**
- Create:
  - `examples/llm-agent/package.json`: `@blink/llm-agent-demo`, private, deps `@anthropic-ai/sdk`, `zod`, `@blink/client` and `viem`; script `demo` runs `node --import tsx src/main.ts`
  - `examples/llm-agent/src/{main,tools}.ts`
  - `examples/llm-agent/README.md`
  - `tests/llm-agent-tools.test.ts`
- Modify: `scripts/check-boundaries.mjs` (the `examples/llm-agent` rule), `docs/P3_AGENTS_PROGRESS.md`

**Interfaces:**
- **Inputs.** The env is `ANTHROPIC_API_KEY` (or any credential the SDK resolves), `BLINK_WEB_URL`, `BLINK_API_URL`, `BLINK_RPC_URL`, `BLINK_AGENT_KEY`, and the optional settings below.

  | Setting | Default |
  |---|---|
  | `BLINK_LLM_MODEL` | `claude-opus-5-5` |
  | `BLINK_LLM_MAX_TURNS` | 60 |
  | `BLINK_LLM_MAX_TXS` | 50 |

  The only starting context is the text of `/llms.txt`, fetched once into the system prompt.
- **Loop.**
  - `client.beta.messages.toolRunner({ model, max_tokens: 16000, output_config: { effort: "high" }, cache_control: { type: "ephemeral" }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", system, tools, messages })`.
  - Iterate it with `for await`. Stop at `BLINK_LLM_MAX_TURNS`, and exit non-zero on `stop_reason === "refusal"`.
  - Thinking stays at the model default (adaptive).
  - If the installed SDK's types reject `fallbacks`, drop that field and its beta, and say so in the README.
- **Tools** (`tools.ts`): `betaZodTool` from `@anthropic-ai/sdk/helpers/beta/zod`, or `betaTool` with a hand-validated JSON Schema if the SDK's zod helper rejects the repo's zod major version.
  - `fetch_doc({ path })`: a GET on `BLINK_WEB_URL`, same origin only, at most 200 KB of text.
  - `api_request({ method: "GET" | "POST", path, body? })`: `BLINK_API_URL`, `/v1/` paths only, sending the session API key once obtained.
  - `chain_read({ address, signature, args })` and `chain_write({ address, signature, args })`:
    - `signature` is one human-readable ABI function;
    - `address` must be in `GET /v1/deployment`;
    - the chain must be 84532;
    - writes count against `BLINK_LLM_MAX_TXS`.
  - `sign_typed_data({ domain, types, primaryType, message })`: `domain.chainId` must be 84532.
  - `wait({ seconds })`: at most 120.
  - Every tool result is a JSON string. A guard failure returns `is_error` with a code.
- **Transcript.** It goes to `tmp/llm-agent/<iso-time>.jsonl` (tool calls and results), with the key and the API secret redacted.
- **Boundary.** `examples/llm-agent/src` may import only `@anthropic-ai/sdk`, `@anthropic-ai/sdk/*`, `zod`, `@blink/client`, `viem`, `viem/*`, `node:*` and relative paths. In particular, nothing from `examples/agents`.

- [ ] **Step 1: Write the failing tests** in `tests/llm-agent-tools.test.ts`. They are unit tests, run in CI, and never call the Anthropic API.
  - `fetch_doc refuses another origin and truncates at 200 KB`
  - `chain_write refuses an address outside the deployment, a non-84532 chain and the 51st transaction`
  - `sign_typed_data refuses a foreign chainId`
  - `transcript redacts the key and the API secret`
- [ ] **Step 2: Run** `node --import tsx --test tests/llm-agent-tools.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** The README explains:
  - running the demo against `pnpm alpha:local`;
  - that the operator pays the model cost;
  - what the transcript shows about whether the docs were enough.
- [ ] **Step 4: Run** the Step 2 command and `pnpm test && pnpm check:boundaries && pnpm typecheck`. Expected: PASS. The live demo is not run by the implementer or by CI.
- [ ] **Step 5: Commit** `feat: optional LLM agent demo that onboards from llms.txt with guarded tools`.

### Task 8: P3 delivery docs

**Files:**
- Create: `docs/P3_REFERENCE_AGENTS.md`, structured like `docs/P2_OFFCHAIN_PROTOCOL.md`.
- Modify:
  - `docs/ROADMAP.md`: tick P3 only when Tasks 1–7 are merged and CI is green;
  - the current-status paragraphs of `README.md` and `README.zh-TW.md`;
  - `CONTEXT.md`: the reference agent, world file and drill terms;
  - `docs/P3_AGENTS_PROGRESS.md`: final state.

- [ ] **Step 1: Write `docs/P3_REFERENCE_AGENTS.md`**, covering:
  - the agent kit;
  - the runtime contract (env, state, backoff);
  - the import boundary;
  - each role's behavior;
  - the world-file format;
  - the drill: its scenarios, its roster, the measured run time, and the CI job;
  - the LLM demo, and its not-in-CI status;
  - the pre-flight rulings;
  - known limitations: the CDP wallets are unverified, there is no contract-wallet maker in the drill, and the "arbitration reaches no conclusion" path is covered only by forge;
  - test commands with measured counts.
- [ ] **Step 2: Run** `pnpm check && pnpm build`, the build in CI. Expected: PASS.
- [ ] **Step 3: Commit and push** `docs: record P3 reference agents and autonomous drill delivery`.

---

## Execution waves

| Wave | Tasks | Why |
|---|---|---|
| A | 1 | Everything imports the agent kit. |
| B | 2 | The runtime and the boundary are shared by every role. |
| C | 3 ∥ 4 | They use different role files and the same runtime. Merge 3 first, then rebase 4 onto it (their only overlap is `main.ts`'s role table). |
| D | 5 ∥ 6 | The docs describe Tasks 1–4; the drill uses them. They share no files. |
| E | 7 | It needs the Task 5 docs as its only knowledge. |
| F | 8 | |

## Self-review notes

- **Spec coverage:**
  - §8: Tasks 2–5 and 7.
  - §2.1.2 scenarios: Task 6.
  - §2.1.3: `assertNoRoleKeys` in Task 2's `startAlphaPlatform` and Task 6's orchestrator.
  - §2.1.4: Task 6's fee and credit checks.
  - §5.3 (GM_LT_V1 with a published hash, recompute from archived bytes): Tasks 1 and 4.
  - §5.12 (docs statement): Task 5.
  - §3 anti-goal: Task 5's claim scan.
  - Covered elsewhere: §2.1.1 and §2.1.5 by P1/P2; §2.1.6 and the website by P4.
- **Carried from P2 Task 12:**
  - the juror rule for unfetchable evidence (Task 4 and Task 5);
  - the CDP wallet verification (pre-flight ruling; needs the user's credentials);
  - replacing the v0.1 role pages (Task 5).
