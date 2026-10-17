# Public Alpha deployment runbook

中文摘要：本手冊列出 Base Sepolia Alpha 從空白基礎設施到就緒驗收的部署順序；所有對外操作、簽署、廣播、建置資源與支出均由使用者明確核准後執行。

This runbook describes a provider-neutral deployment on Base Sepolia. It supports one small `linux/arm64` app VM for API, Worker and Indexer, plus a separate signer VM. PostgreSQL and private object storage may be self-hosted or selected later. It does not select providers, publish endpoints, or supply credentials. Start with [`deployments/base-sepolia/env.example`](../deployments/base-sepolia/env.example); every `<TO BE PROVIDED: …>` marker must be replaced in a protected, untracked runtime file.

## Guardrails and inputs

- Chain ID is **84532 only**. Mainnet chain ID 8453 is refused as `MAINNET_REFUSED`.
- `BLINK_CHAIN_ID` is a preflight-only fixed protocol assertion; offline preflight cannot query the RPC's real chain. The Signer and Indexer verify the connected chain at startup. `BLINK_ALLOW_TEST_CLOCK` is test-only and **must be unset in deployment**.
- Use one `blink_api`, `blink_worker`, `blink_indexer`, and `blink_signer` login, each in its own least-privilege group. Use separate schema-owner, migration, registration, restore and operator credentials only for the administrative commands that need them. Never mount an administrative credential into a service.
- API receives its business database grants; Worker receives only its job and feature grants; Indexer receives chain/projection grants; Signer receives only signing-policy, intent and nonce access. Keep ADMIN, proposer, challenger and arbiter wallets manual and outside the automated Worker/Signer path. Worker research and execution must use their separate job allowlists and caller credentials; no worker has chain private keys.
- The signer runs on its separate host and accepts traffic only on a private network. Its key files are mounted read-only, owned/readable by its service user, and mode `0600`. No key or URL credential belongs in a public variable, image, log, checked-in file, or command argument.
- A1 images are built from `infra/Dockerfile.<service>` and use the pinned `node:22.23.1-bookworm-slim` base tag; the build record lists digest `sha256:6c74791e557ce11fc957704f6d4fe134a7bc8d6f5ca4403205b2966bd488f6b3`. Rebuild and record the actual base digest when producing a release image. The runtime image is non-root and contains only its service bundle. See `docs/M5_SERVICE_IMAGES.md` on the A1 branch for the image contract.
- `pnpm deploy:preflight <env-file>` is offline. It does not resolve hosts or contact PostgreSQL, an RPC, a webhook, or any other service. A passing result checks policy and local signer key-file existence/mode; it does not prove that a sink is writable or reachable.
- `WORKER_API_URL` must use HTTPS between hosts. Plain HTTP is allowed only for loopback (`localhost`, `127.0.0.1`, or `[::1]`), matching `@blink/client`: either colocate the Worker with the API and use loopback, or provide an internal HTTPS API endpoint to a separately hosted Worker.
- Service configuration variable names, grouped by owner, are listed below. Optional features may leave their related values unset; the matching service parser rejects incomplete feature groups.

### Environment variables

| Service or command          | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                         | `BLINK_API_MODE`, `API_HOST`, `API_PORT`, `API_DATABASE_URL`, `WALLET_BINDING_ORIGIN`, `SPEC_OBJECT_DIRECTORY`, `SPEC_PUBLIC_ORIGIN`, `EVIDENCE_OBJECT_DIRECTORY`, `BLINK_DEPLOYMENT_ID`, `SIGNER_URL`, `SIGNER_CALLER_TOKEN`, `BASE_SEPOLIA_RPC_URL`                                                                                                                                                                                                                                                    |
| Worker                      | `WORKER_ENABLED`, `WORKER_DATABASE_URL`, `WORKER_PLATFORM_OPERATOR_ID`, `WORKER_API_URL`, `WORKER_MODEL_FIXTURES`, `WORKER_DISCOVERY_API_KEY`, `WORKER_DISCOVERY_MODEL`, `WORKER_FORECASTER_A_API_KEY`, `WORKER_FORECASTER_B_API_KEY`, `WORKER_BASELINE_API_KEY`, `WORKER_SIGNER_CALLER_TOKEN`, `WORKER_TRADER_API_KEY`, `WORKER_TRADER_FORECASTER_ROLE`, `ALERT_SINK`, `ALERT_FILE_PATH`, `ALERT_WEBHOOK_URL`, `ALERT_RPC_FAILURES`, `ALERT_REALERT_MINUTES`, `ALERT_KEEPER_OVERDUE_SECONDS`            |
| Indexer                     | `INDEXER_CREATION_POLLING_ENABLED`, `INDEXER_TX_TRACKING_ENABLED`, `INDEXER_DATABASE_URL`, `INDEXER_PORT`, `INDEXER_HOST`, `INDEXER_POLL_INTERVAL_MS`, `INDEXER_LEASE_MS`, `INDEXER_RECONCILIATION_DEADLINE_MS`, `INDEXER_RETRY_BASE_MS`, `INDEXER_RETRY_MAX_MS`, `INDEXER_PENDING_POLL_MS`, `INDEXER_CONFIRMED_POLL_MS`, `INDEXER_REVERTED_POLL_MS`, `INDEXER_RPC_TIMEOUT_MS`, `CHAIN_INDEXER_ENABLED`, `INDEXER_DEPLOYMENT_ID`, `INDEXER_CHAIN_POLL_MS`, `INDEXER_CHAIN_RANGE`, `BASE_SEPOLIA_RPC_URL` |
| Signer                      | `SIGNER_ENABLED`, `SIGNER_HOST`, `SIGNER_PORT`, `SIGNER_DATABASE_URL`, `BASE_SEPOLIA_RPC_URL`, `SIGNER_DEPLOYMENT_ID`, `SIGNER_CALLERS`, `SIGNER_MAKER_KEY_FILE`, `SIGNER_KEEPER_KEY_FILE`, `SIGNER_FAUCET_KEY_FILE`, `SIGNER_TRADER_KEY_FILE`, `SIGNER_L1_FEE_MODE`                                                                                                                                                                                                                                     |
| Setup and operator commands | `DATABASE_URL`, `DEPLOYMENT_ADMIN_DATABASE_URL`, `DEPLOY_RPC_URL`, `CONTRACT_ARTIFACT_DIRECTORY`, `RESTORE_ADMIN_DATABASE_URL`, `BLINK_API_URL`, `BLINK_ADMIN_API_KEY`                                                                                                                                                                                                                                                                                                                                   |
| Preflight-only / test-only  | `BLINK_CHAIN_ID` (fixed to 84532; preflight does not query RPC chain state), `BLINK_ALLOW_TEST_CLOCK` (must be unset in deployment)                                                                                                                                                                                                                                                                                                                                                                      |
| Local verification only     | `TEST_POSTGRES_ADMIN_URL` for `pnpm drill:alerts` and `pnpm alpha:local`; neither command exercises the remote Base Sepolia alert sink or deployment.                                                                                                                                                                                                                                                                                                                                                    |

Never place a secret-looking value in any `NEXT_PUBLIC_*` variable. Production must set `ALERT_SINK` explicitly to `file` or `webhook`; stdout is not an acceptable deployment sink. A non-loopback webhook URL must use HTTPS.

## Procedure

Each numbered stage is ordered. A stage marked **USER ACTION — needs explicit approval** must stop for the user's approval before the operator executes it. The operator may prepare commands and reviewable artifacts in advance.

**Infrastructure prerequisite — USER ACTION — needs explicit approval:** from an empty environment, provision the app VM, separate signer VM, PostgreSQL, private object storage, networking/ACLs, and any DNS/TLS endpoint selected by the user. This can incur spend and creates externally reachable infrastructure. The runbook names no provider; do not provision until the user chooses the resources and approves the action. Keep the app VM sized for `linux/arm64` images.

### 1. Contracts

Prepare and inspect the verified artifact directory and target RPC configuration. Run `pnpm contracts:deploy --deployment-id <id> --admin <address> --result-proposer <address> --challenger <address> --arbiter <address> --maker <address> --faucet-minter <address> --deployer <address>` in dry-run mode and review the full deployment plan, chain ID, deployer address, constructor values, artifact hashes and estimated transactions. Do not supply a real deployer key in shell history or logs.

The broadcast command writes the verified manifest to the path given by `--out`; steps 2 and 4 consume that exact file. Before execution, choose a new, protected output path that does not already exist.

**USER ACTION — needs explicit approval:** after reviewing the dry run, the user sets `DEPLOYER_PRIVATE_KEY` privately in their own shell session through their chosen secret-handling method (never echo or record its value), then executes `pnpm contracts:deploy --deployment-id <id> --admin <address> --result-proposer <address> --challenger <address> --arbiter <address> --maker <address> --faucet-minter <address> --out <manifest-file> --broadcast` against chain ID 84532. This broadcasts deployment transactions. Save the resulting deployment ID, addresses, transaction hashes and deployment block in the protected deployment record. Do not publish secrets or put the deployer key in a service env file.

### 2. Manifest verification

After the deployment receipts are final, verify the manifest produced by step 1's `--out <manifest-file>` using `pnpm manifest:verify <manifest-file> <deployment-id>` with `BASE_SEPOLIA_RPC_URL` set to the approved Base Sepolia RPC. Confirm chain ID 84532, expected bytecode and constructor configuration. A mismatch blocks the remaining procedure; do not edit a manifest to make verification pass.

**USER ACTION — needs explicit approval:** publishing the verified manifest or making it publicly reachable is outward-facing. The user reviews and approves the publication destination and content before publishing.

### 3. Database migration

**USER ACTION — needs explicit approval:** creating database roles/logins, a database, or changing its schema provisions state. Before `pg_restore` or migrations on a fresh cluster, create the `blink_*` group roles and dedicated service logins, then verify each login belongs only to its intended group. Restore or create the database as the schema owner. For a fresh database, run `pnpm db:migrate` with `DATABASE_URL` set to the migration database. For a restore, restore the dump with `pg_restore --no-owner --exit-on-error` as the schema owner (or specify the schema owner with `--role`), then run `pnpm restore:prepare <deployment-id>` with `RESTORE_ADMIN_DATABASE_URL`.

On restore, fence the old API and signer before restoring: stop the old API and signer so no post-dump quote or reservation can be accepted. `restore:prepare` closes the quote gate, marks unreconciled reservations `OVERCOMMITTED`, and releases the dumped cursor lease. Start the indexer before worker/API; the gate remains closed until cursor freshness and reservation reconciliation pass. Reapply database-level settings such as `ALTER ROLE ... IN DATABASE ... SET`; dumps do not include them. Confirm the restore administrator is not used by any runtime service. Do not reopen trading during restore preparation.

### 4. Deployment registration

**USER ACTION — needs explicit approval:** register the same verified manifest from step 1's `--out <manifest-file>` with `pnpm deployment:register <manifest-file> <deployment-id> <registration-reason>` and the dedicated `DEPLOYMENT_ADMIN_DATABASE_URL`. Review the inserted chain ID, addresses, block and `tradingEnabled` state. Registration is an administrative database action; keep trading disabled until readiness and smoke checks pass.

### 5. Signer

**USER ACTION — needs explicit approval:** installing or updating the signer service and mounting real role-specific key files changes provisioned infrastructure. The user executes the approved signer installation and key loading. Use the private signer URL in `SIGNER_URL`; verify the listener is reachable only from approved private app hosts. Mount role-specific key files read-only with mode `0600` and verify ownership by the signer service user. Configure only the caller tokens and roles the API and Worker need. Never copy key material into an env file, image or app host.

Start the signer with its dedicated `blink_signer` login. Verify `/health/live` and `/health/ready` from the private network. Before allowing any signing after a restore, compare each signer role's allocated nonce with the chain and resolve any mismatch or pending transaction first.

**USER ACTION — needs explicit approval:** provisioning or changing the signer host, loading real signing keys, or authorizing any signature requires the user's explicit approval. The operator prepares the protected mount and configuration; the user performs the approved action.

### 6. Indexer catch-up

**USER ACTION — needs explicit approval:** installing/updating and starting the Indexer deploys a service. The user executes the approved change. Start it with `CHAIN_INDEXER_ENABLED=true`, `INDEXER_DATABASE_URL`, `INDEXER_DEPLOYMENT_ID`, and the approved `BASE_SEPOLIA_RPC_URL`. Watch `/health/chain-index` until it reports the deployment's expected range and a fresh cursor. Verify no lease holder from the old stack can commit: indexer writes are fenced by `lease_token`, and `restore:prepare` releases the restored lease. The cursor lease may be explicitly cleared only as part of controlled restore preparation; a fenced live holder's next commit then fails.

### 7. Worker

**USER ACTION — needs explicit approval:** installing/updating and starting the Worker deploys a service. The user executes the approved change. Use `WORKER_ENABLED=true`, its own `WORKER_DATABASE_URL`, and `WORKER_API_URL` over loopback on a colocated host or HTTPS between hosts. Start with deterministic, reviewed model fixtures and no live provider keys. Configure a non-stdout `ALERT_SINK` explicitly. For `file`, ensure the parent exists and the worker can append; for `webhook`, use the user-selected HTTPS endpoint. Worker `/health/ready` listens on loopback only: check it from inside the container with `docker compose exec` or from the host namespace. Do not probe it from an external orchestrator.

### 8. API

**USER ACTION — needs explicit approval:** installing/updating and starting the API deploys a service and may expose an endpoint. The user executes the approved change. Use `BLINK_API_MODE=trading`, its own `API_DATABASE_URL`, the registered `BLINK_DEPLOYMENT_ID`, approved Base Sepolia RPC, private `SIGNER_URL`, and its restricted caller token. Confirm public binding and TLS termination match the reviewed architecture, object directories are writable by the service, and logs contain no credentials. Keep trading disabled and do not issue external credentials yet.

### 9. Readiness

Check API `/health/live`, `/health/ready`, `/v1/health`, Indexer `/health/chain-index`, Worker `/health/ready` from its permitted local vantage, and Signer `/health/ready` from the private network. Require API status `ready`, `tradingEnabled: false`, and no readiness reasons; require fresh indexer cursor, signer connectivity, and resolved queue/gate reasons. A live response alone does not establish readiness. Run `pnpm ops:status` using `BLINK_API_URL` and `BLINK_ADMIN_API_KEY`; review cursor, queue, budget, pause and resolution deadlines. Do not treat empty or unavailable status data as a clean result.

**USER ACTION — needs explicit approval:** triggering a live alert sends an outward-facing message. The existing `pnpm drill:alerts` command runs the local alert-delivery tests and does not prove the configured remote sink. After the Worker is running, the user approves one controlled alert (for example, a pause/clear cycle prepared with `pnpm ops:status --pause` and `pnpm ops:status --unpause`); the authorized user separately signs and broadcasts those drafts. Verify the actual sink receives the alert and the delivery job reaches `SUCCEEDED`; preserve its identifier and sink receipt/delivery record. Sink reachability is a post-start check, not a preflight claim.

### 10. REPLAY smoke

There is no remote Base Sepolia REPLAY smoke command in the repository. The closest existing equivalent is `pnpm alpha:local`, which uses local PostgreSQL and local Anvil with chain ID 84532 and deterministic fixtures; it does not exercise the remote deployment. Do not report it as remote acceptance evidence. A target-specific REPLAY smoke procedure remains an operational gap.

**USER ACTION — needs explicit approval:** any future target-chain REPLAY smoke may sign or broadcast transactions. The user must approve its exact commands and test-asset effects before execution. Record forecast, quote/fill, indexing, resolution and redeem evidence that the approved procedure actually exercises. It must not call a paid model/data provider or use a mainnet endpoint.

### 11. Open trading

The Signer reads the deployment's `tradingEnabled` flag for each quote request, so the next quote observes a trading-state change without a Signer restart. Transaction signing remains governed by the deployment `enabled` kill switch; keeper finalize remains available while trading is off.

Review all prior evidence, alerts and current operator status. Use `pnpm ops:status` once more and confirm no pause, stale cursor, unresolved reservation, signer nonce issue, failed alert delivery or readiness reason. Prepare `pnpm ops:status --unpause` to produce the unsigned ADMIN draft; inspect it before an authorized human uses the ADMIN wallet. The pause/unpause options only print unsigned drafts.

**USER ACTION — needs explicit approval:** opening trading changes the deployment's externally observable state. The user explicitly approves the specific deployment and executes the reviewed ADMIN action. To pause later, run `pnpm ops:status --pause` (or `--pause --market <id>`), inspect the unsigned draft and warnings, then the authorized user separately signs and broadcasts it. Never treat the draft command as execution.

## Rollback and restore

**USER ACTION — needs explicit approval:** rollback creates a new deployment and may provision resources, publish a manifest, sign, broadcast, or incur spend. It means a **new deployment ID**, never an in-place contract change. Keep the previous deployment record and contracts immutable. Prepare a fresh deployment and manifest, verify it, and follow the complete ordered procedure above. If restoring data, first fence the old API and signer, restore as the schema owner, run `restore:prepare`, reapply database-level settings, check signer nonces against chain state, then start Indexer and wait for cursor freshness and reservation reconciliation before considering the gate. The new deployment remains closed until readiness, alert-delivery evidence and REPLAY smoke pass.

## Preflight

Run `pnpm deploy:preflight deployments/base-sepolia/env.example` before filling provider values; it is expected to fail with `PREFLIGHT_PLACEHOLDER`. After preparing a protected local env file and `0600` signer key files, run `pnpm deploy:preflight <protected-env-file>`. The command never prints values and makes no network, DNS or RPC calls. A pass checks policy shape only; it does not validate credential correctness, host availability, database grants, image contents, TLS termination, signer nonce, or alert sink reachability.
