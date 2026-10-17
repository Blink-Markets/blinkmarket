# Task A6 report — deployment runbook and preflight

Status: **DONE_WITH_CONCERNS**

## Implemented

- Added the provider-neutral Base Sepolia runbook in the required order: contracts, manifest verification, database migration/restore, deployment registration, Signer, Indexer catch-up, Worker, API, readiness, REPLAY smoke, and opening trading.
- Documented restore fencing, `restore:prepare`, role and owner requirements, signer nonce checks, cursor lease behavior, database-level settings, service health/readiness vantage points, alert delivery evidence, and new-deployment-ID rollback.
- Marked provisioning, database changes, publication, alert delivery, chain smoke/signatures/broadcasts, and opening or pausing trading as `USER ACTION — needs explicit approval`.
- Added `deployments/base-sepolia/env.example` with fixed chain ID 84532 and provider/runtime values represented only by `<TO BE PROVIDED: …>` markers.
- Added `pnpm deploy:preflight <env-file>`. It performs no network, DNS, or RPC calls; checks markers, chain ID including `MAINNET_REFUSED`, public-variable secrets, local signer key-file existence/mode 0600, private signer URL, explicit non-stdout alert sink, and HTTPS for non-loopback webhooks; then runs the four service configuration parsers offline.
- Added mechanical variable coverage for all four service config files and the six setup/operator scripts named in the dispatch. It asserts each discovered variable appears in both the runbook and example env.

## Files

- `docs/DEPLOYMENT_RUNBOOK.md`
- `scripts/deploy-preflight.ts`
- `tests/deploy-preflight.test.ts`
- `deployments/base-sepolia/env.example`
- `package.json`

## RED/GREEN evidence

- RED: initial `node --import tsx --test tests/deploy-preflight.test.ts` failed because the runbook did not exist and `deploy:preflight` was not registered (`ENOENT` / command not found).
- GREEN: `node --import tsx --test tests/deploy-preflight.test.ts` — 9 tests passed, 0 failed. Covers mechanical variable inventory, placeholder no-echo, chain mismatch/mainnet refusal, four secret patterns and a secret-named public variable, full fake service profile, missing and group-readable key files, public signer URL, missing/stdout alert sink, and non-HTTPS webhook.
- Filled fake profile output: `DEPLOY PREFLIGHT ok: Base Sepolia profile, environment rules passed (offline)`.
- `pnpm deploy:preflight deployments/base-sepolia/env.example` — expected exit 1; output: `PREFLIGHT_PLACEHOLDER: BLINK_API_MODE`.

## Verification

- `pnpm check` — typecheck and Solidity contract checks passed; unit suite completed with 619 passed and 71 failed. The visible failures were loopback-listener `listen EPERM` errors from the restricted sandbox. The dispatch explicitly says not to work around blocked local ports. The final boundary phase was therefore run separately.
- `pnpm check:boundaries` — passed.
- `pnpm build:services && pnpm test:service-build` — passed; 6/6 service-bundle checks.
- `git diff --check` — passed.
- No deployment, provisioning, signing, broadcast, external alert, network request, or spend was performed.

## Self-review and limitations

- The preflight never prints env values or key paths; only a rule code and variable name are reported on rejection. Test output confirms fake credentials do not appear.
- Key paths are checked locally with filesystem metadata; the preflight cannot verify remote mounts, key contents, host reachability, service grants, provider credentials, or webhook delivery. The runbook assigns webhook acceptance to a post-start user-approved action.
- The service parser calls are configuration-only and offline. Setup-command values are inventoried but their remote/database effects are intentionally not attempted by preflight.
- Full `pnpm check` remains limited by sandbox loopback restrictions (71 tests failed with `EPERM`); no escalation or workaround was attempted.

## Fix round 1

- Added table-driven signer and webhook URL tests for spoofed suffix hosts, decimal loopback, IPv4-mapped IPv6, IPv6 ULA/loopback, RFC 1918 boundaries, and link-local metadata addresses. Each rejection checks its exact preflight code; accepted rows require a complete profile to pass.
- Rebuilt variable derivation with the TypeScript AST across every `.ts` file under `apps/{api,worker,indexer,signer}/src` and package tool scripts used by the runbook. It follows direct reads, aliases, destructuring, bracket reads, dynamic lookup maps and parser helpers; a synthetic unlisted helper read proves coverage failure. `BLINK_ALLOW_TEST_CLOCK` must be absent and is rejected as `PREFLIGHT_TEST_CLOCK_FORBIDDEN`.
- Extended public-value detection for three-segment JWTs, 32+ character opaque values, AWS `AKIA` identifiers, `sk-` and `ghp_` provider tokens, key-like URL query values and long path tokens, with safe URL/chain-ID pass cases. A service env containing `DEPLOYER_PRIVATE_KEY` is rejected as `PREFLIGHT_DEPLOYER_KEY_FORBIDDEN`; that key was removed from the sample env and is supplied only in the user's shell for the approved broadcast command.
- Corrected the broadcast command to require `--out <manifest-file>`, documented that output manifest as the input to verification and registration, checked runbook package commands/arguments, and stated that no remote REPLAY smoke command exists (`pnpm alpha:local` is local only). Added `docs/M5_DEPLOYMENT_PREFLIGHT.md` with rejection codes, results and offline/sink limits.
- RED evidence: before the fixes, the expanded tests failed on unlisted test-clock and deployer-key handling and missing public token detection; the DNS/IP acceptance matrix also exposed fixture setup issues. After fixes those regressions are green.
- GREEN verification: `node --import tsx --test tests/deploy-preflight.test.ts` — 13/13; template preflight — expected exit 1, `PREFLIGHT_PLACEHOLDER: BLINK_API_MODE`; fake profile — `DEPLOY PREFLIGHT ok: Base Sepolia profile, environment rules passed (offline)`; `pnpm build:services && pnpm test:service-build` — 6/6; `pnpm typecheck && pnpm check:boundaries` — passed.
- No remote deployment, alert, signing, broadcast, provisioning or spend was performed. Full `pnpm check` is being run by the controller as specified in the fix-round dispatch.
