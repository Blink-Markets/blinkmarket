# Base Sepolia deployment runbook and preflight (A6)

> Partly historical: the preflight, signer-key-file and signer-host checks described here belong to the v0.1 deployment. The signer is gone, and the preflight now also refuses any key-like variable (`PREFLIGHT_PLATFORM_ROLE_KEY_FORBIDDEN`, P2 Task 11). See [P2 off-chain protocol](P2_OFFCHAIN_PROTOCOL.md).

This delivery adds [the deployment runbook](DEPLOYMENT_RUNBOOK.md), a marker-only [Base Sepolia environment template](../deployments/base-sepolia/env.example), and `pnpm deploy:preflight <env-file>`. The preflight uses the API, Worker, Indexer and Signer config parsers offline and validates the required production profile. The mechanical test derives environment reads from every TypeScript file under the four service `src` trees and the TypeScript tool scripts called by runbook package commands.

## Rejection codes

| Code                               | Rejection                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `PREFLIGHT_USAGE`                  | No env-file argument was supplied.                                              |
| `PREFLIGHT_ENV_FILE`               | The named env file could not be read.                                           |
| `PREFLIGHT_ENV_SYNTAX`             | A line does not use the supported `NAME=value` form.                            |
| `PREFLIGHT_PLACEHOLDER`            | A value still contains `<TO BE PROVIDED`.                                       |
| `PREFLIGHT_CHAIN_ID`               | `BLINK_CHAIN_ID` is missing or is not 84532.                                    |
| `MAINNET_REFUSED`                  | `BLINK_CHAIN_ID` is 8453.                                                       |
| `PREFLIGHT_TEST_CLOCK_FORBIDDEN`   | `BLINK_ALLOW_TEST_CLOCK` is present; it must be unset in deployment.            |
| `PREFLIGHT_DEPLOYER_KEY_FORBIDDEN` | `DEPLOYER_PRIVATE_KEY` appears in the service env file.                         |
| `PREFLIGHT_PUBLIC_SECRET`          | A `NEXT_PUBLIC_*` value or variable name looks secret-like.                     |
| `PREFLIGHT_KEY_FILE_MISSING`       | No signer key path is configured, or a configured signer key file is missing.   |
| `PREFLIGHT_KEY_FILE_MODE`          | A signer key file is not exactly mode 0600.                                     |
| `PREFLIGHT_SIGNER_URL`             | `SIGNER_URL` is malformed, credentialed, or not loopback/RFC 1918/IPv6 ULA.     |
| `PREFLIGHT_WORKER_API_URL`         | `WORKER_API_URL` is malformed, credentialed, or not HTTPS/HTTP loopback.        |
| `PREFLIGHT_ALERT_SINK`             | `ALERT_SINK` is missing, stdout, invalid, or incomplete.                        |
| `PREFLIGHT_WEBHOOK_HTTPS`          | A non-loopback webhook is not HTTPS, or the webhook has credentials/fragment.   |
| `PREFLIGHT_SERVICE_CONFIGURATION`  | A required service is disabled or its production config parser rejects the env. |
| `PREFLIGHT_INTERNAL_ERROR`         | An unexpected preflight failure occurred; values are not printed.               |

Every rejection prints only its code and, where applicable, the variable name. It never prints env values or key paths. The preflight is offline: it performs no network, DNS, PostgreSQL, webhook or RPC calls. `BLINK_CHAIN_ID` therefore checks the declared protocol profile only; the Signer and Indexer verify the connected chain at startup.

## Verification

Run these from the repository root:

- `node --import tsx --test tests/deploy-preflight.test.ts` — expected result recorded below.
- `pnpm deploy:preflight deployments/base-sepolia/env.example` — expected to fail with `PREFLIGHT_PLACEHOLDER` until markers are filled.
- Run `pnpm deploy:preflight <scratch-env-file>` against the test's complete fake profile — expected offline success; no real provider values are used.
- `pnpm build:services && pnpm test:service-build` — checks the service bundles.
- `pnpm typecheck && pnpm check:boundaries` — type and package-boundary checks.

The preflight checks key-file existence and permissions on the machine where it runs, but cannot check remote mount permissions, credentials, service connectivity, database grants, the real RPC chain, or alert delivery. In particular, it cannot determine whether the alert sink is writable or reachable. Verify the actual sink after startup with an approved controlled alert and preserve the successful receipt/delivery evidence; `pnpm drill:alerts` is local test coverage and is not remote sink acceptance.

Remote Base Sepolia REPLAY smoke does not yet have a repository command. `pnpm alpha:local` is the closest existing equivalent and exercises local PostgreSQL plus local Anvil only; it is not remote deployment evidence. All provisioning, signatures, broadcasts, spends, publication, live alerts and trading-state changes remain explicit user actions as detailed in the runbook.

### Results (fix round 1)

- `node --import tsx --test tests/deploy-preflight.test.ts` — 13 passed, 0 failed, including the host tables and an explicit fake-profile success message.
- `pnpm deploy:preflight deployments/base-sepolia/env.example` — expected exit 1 with `PREFLIGHT_PLACEHOLDER: BLINK_API_MODE`.
- Fake profile — `DEPLOY PREFLIGHT ok: Base Sepolia profile, environment rules passed (offline)`.
- `pnpm build:services && pnpm test:service-build` — passed; 6/6 bundle checks.
- `pnpm typecheck && pnpm check:boundaries` — passed.

### A9 follow-ups

The Signer now reads deployment `enabled` and manifest `tradingEnabled` in the request transaction. Quotes follow flag changes immediately while transaction signing remains gated by `enabled`, so keeper finalize still signs with trading off. Dispatcher failures now reach the worker as `JobError`s with their original code and retryability. Preflight enforces the `@blink/client` HTTPS-or-loopback rule for `WORKER_API_URL`; the runbook describes colocated loopback and cross-host HTTPS layouts.

Verification: `pnpm typecheck` passed. Focused signer, dispatcher, job-failure and preflight tests passed (66/66); the final job-failure rerun passed 8/8 and confirmed `SIGN_REJECTED:POLICY` is dead-lettered under its actual code. `pnpm build:services && pnpm test:service-build` passed (6/6 bundle checks), and `pnpm check:boundaries` passed. `pnpm check` could not complete because a suite test opening an ephemeral loopback listener received `listen EPERM` in this sandbox. The A9 brief also names `docs/M5_SERVICE_IMAGES.md`, which is absent from this worktree; no edit was possible there.

Fix round 1 shared the exact `@blink/client` HTTP loopback host policy with preflight, covered admin metrics for a dead dispatcher job, and made `ForecastScheduleError` a `JobError`. The focused review-round suite passed 54/54, `pnpm typecheck` passed, and service bundles passed 6/6. `pnpm build` could not fetch existing Google Fonts because network access is unavailable; `tests/client.test.ts` could not bind its loopback listener (`listen EPERM`). `ModelCallError` remains gateway-internal: all worker model jobs use `createBudgetedModelCaller`, which catches gateway errors and converts them to `JobError` before they reach job handlers.
