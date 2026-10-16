# M5 operator status surface (A3)

中文摘要：新增唯讀管理狀態 API 與單頁終端摘要，暫停操作僅輸出 ADMIN 錢包的未簽署 calldata。

This delivery covers the A3 operator-status slice of public Alpha readiness. It does not complete M5 or authorize a deployment.

The API registers these reads in trading mode:

| Read | Contents |
| --- | --- |
| `GET /v1/admin/candidates?status=` | Current candidate revision and status, latest approval ID, deployment, exact approved budget and unsigned creation-intent reference. Restricted to the authenticated operator's candidates. The optional status uses the existing candidate state enum. |
| `GET /v1/admin/jobs?state=DEAD` | Job IDs, state, attempt limits and timestamps. Defaults to DEAD; accepts existing job states. Payloads, lease owners, dedupe keys and free-text errors are excluded. |
| `GET /v1/admin/budgets` | Current UTC business day's cap, spent, reserved and unknown research costs as decimal USD-micro strings. Released reservations contribute zero. A day without a ledger row uses the existing 20000000-micro default cap. |
| `GET /v1/admin/pause` | Indexed global and per-market pause flags plus the existing authenticated health response, including queue, index freshness, signer, budget and pool gates. A missing global projection is `null`, never an assumed unpaused state. |
| `GET /v1/admin/resolutions` | Closed OPEN markets, PROPOSED markets and DISPUTED markets, ordered by hard deadline. Includes proposal, challenge and hard deadlines and counts of the requesting operator's open advisory reports. No report text or evidence is returned. |

Missing, invalid, revoked, expired and non-admin credentials receive the normal 404 NOT_FOUND private-resource envelope on these reads. An admin of a different operator sees only that operator's candidates and report counts. Job metadata and aggregate budgets are system diagnostics, consistent with existing admin health diagnostics. Responses never select raw evidence bytes, object locations, candidate theses, API keys, signing artifacts or arbitrary job/report content. No new grants or migration are needed.

Approval metadata remains visible after approval advances the candidate to a new revision.

Candidate, job and resolution lists return the first 100 rows in deterministic order. These are bounded status views, not exhaustive exports; the CLI explicitly labels their limits. The pause list includes indexed markets in the selected deployment. Health is reused rather than reimplemented and retains its existing two-second snapshot cache. Status queries are separate reads, so the screen is not an atomic snapshot. Indexed flags can lag the chain: inspect health freshness before acting. Existing resolution-report review and triage routes are unchanged.

## CLI

Supply `BLINK_ADMIN_API_KEY` through the operator's environment; never place a key in committed configuration, command arguments, or delivery records. `BLINK_API_URL` defaults to `http://127.0.0.1:3001` and must be a bare HTTP(S) origin without credentials.

```sh
pnpm ops:status
pnpm ops:status --pause
pnpm ops:status --unpause
pnpm ops:status --pause --market 7
pnpm ops:status --unpause --market 7
```

The default command prints one screen of counts, budget amounts, indexed pause flags, shared health details, and up to five resolution deadline rows. It validates every status response and fails if any read is unavailable, rather than treating a failed request as an empty queue. Only authenticated GETs are used, with ten-second timeouts and redirects refused.

Pause and unpause options print an unsigned draft with chain ID 84532, BlinkMarket target, ADMIN required sender, zero value, calldata and warnings. They validate the deployment returned by `/v1/config` against the authenticated pause surface. Chain ID 8453 is refused with MAINNET_REFUSED; other chain IDs are rejected. There is no wallet, private key, signer invocation, RPC client or transaction submission in this command. An authorized human would separately review and execute the draft with the ADMIN wallet; that action remains outside this delivery.

## Verification

Tests cover cross-operator privacy, non-admin 404s, status filtering, safe field projection, exact money above JavaScript's safe integer range, reservation buckets, missing pause state, shared health, resolution report isolation, summary rendering, all four pause calldata variants, deployment mismatch, mainnet refusal and failed API reads. Real-PostgreSQL tests use a random database, read-only blink_api connections and cleanup on exit.

Verification results:

- `pnpm install --frozen-lockfile`: passed, lockfile unchanged.
- `pnpm typecheck`, `pnpm check:contracts`, `pnpm check:boundaries`: passed.
- `pnpm build:services && pnpm test:service-build`: passed, 5 smoke tests.
- `pnpm test:anvil`: passed with local-network permission, 50 tests.
- `pnpm test:postgres`: the concurrent run passed A3 but hit 3 existing timeout/lifecycle failures; a full sequential rerun passed all 54 tests. The historical-approval regression also passed separately. Cleanup audit found no remaining test databases or temporary login roles on the dedicated test server.
- `pnpm build`: blocked by Google Fonts fetch failures for existing Geist, Geist Mono and Kalam imports. The controller must rerun the web build where those fonts are reachable.
- `pnpm check`: typecheck and Solidity compilation passed; the sandbox unit run encountered an existing local-port EPERM. The full unit suite is rerun with local-network permission and two test files at a time; its final result is recorded below.
