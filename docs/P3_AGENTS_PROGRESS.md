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
