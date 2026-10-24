# M2.1 — Invitation identity and wallet binding

> Historical (v0.1): the invitation scheme described here was replaced by self-serve wallet identity in P2 Task 6; see [P2 progress](P2_OFFCHAIN_PROGRESS.md).

M2 has started, but **the whole vertical trading flow is not finished**. This slice first wires the identity feature to a real PostgreSQL adapter and HTTP. Candidate / evidence / approved market creation, Indexer/reorg, RFQ/reservation, Signer and transaction tracking are still not wired up. There is no external deployment, no paid model call, and no new private key has been injected into an automated service.

## Delivered in this change

| Layer                 | Implementation                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Schema                | Invitation scopes, wallet challenge / verification request/response, identity error codes                                   |
| Database              | 0002_identity: operators, agents, api_keys, wallet_challenges, wallet_bindings; FKs, uniqueness and per-role privileges     |
| Application           | Key verification, one-time EOA binding, transactional idempotency, audit; depends on ports, not on SQL or viem              |
| Adapters              | PostgreSQL repository, SHA-256 / constant-time hash comparison, viem personal-sign address recovery                         |
| API                   | Two auth endpoints are enabled once identity mode is chosen; trading endpoints that are not enabled still return no fake success |
| Admin                 | Invite / issue key / revoke CLI protected by a database role; no public self-signup or key-issuing endpoint                 |
| Client                | createWalletChallenge / verifyWallet; transports and validates the contract only, holds no private key and signs nothing automatically |
| Deployment foundation | Each of the four Node services has its own bundle, a separate migration/admin bundle, and an API Dockerfile; the API host/port is configurable |

The API key format is `blink_<key UUID>.<256-bit random secret hex>`. The secret is shown only when issued, and the DB stores a SHA-256 hash. The high-entropy random value of an API key is not a user password. The validity period defaults to 30 days and can be shortened to 1–30 days. Every operation and every idempotent resend re-checks the validity period and the revocation state. The admin scope is not the on-chain ADMIN, and grants no private key or funds privileges.

## Enablement and secure defaults

The default is `BLINK_API_MODE=scaffold`, which still starts without a DB. The identity feature is wired in only when `identity` is chosen explicitly and `API_DATABASE_URL` and `WALLET_BINDING_ORIGIN` are provided. No `.env` file is read. The shell, container or deployment platform injects the environment variables each process needs.

API startup rejects a DB account that is a superuser / CREATEDB / CREATEROLE, an identity admin, or has identity/operations DDL privileges. Use a separate LOGIN that has `blink_api` membership. Migrations and key issuing use a separate admin identity. The template does not create a fixed password for the user.

In identity mode, `/v1/config.stage` is `m2-identity`. `tradingEnabled=false` and `deployment=null` do not change. `/health/ready` and `/v1/health` still return 503: the identity feature can be tested, which does not mean the full trading platform is ready. `/openapi.json` marks only the two identity paths as enabled, and the others stay not-implemented. The static OpenAPI describes the scaffold by default. Whether a feature is enabled is as the runtime document says.

## Binding and consistency rules

- A challenge uses the fixed origin set on the server and does not read the user's Host header. HTTPS is required, and HTTP is allowed only for localhost/loopback in local development.
- The signed message states explicitly that it only binds the identity and does not authorize trading, token approvals or withdrawals. It includes chain 84532, the origin, the address, the key, the agent, the challenge ID, a random nonce and a five-minute validity period. The exact message, as the code produces it, is:

  ```text
  Blink Market wallet identity binding v1
  This signature only binds your identity. It does not authorize trading, token approvals, or withdrawals.
  Origin: <origin>
  Chain ID: 84532
  Address: <lowercase address>
  Key ID: <key UUID>
  Agent ID: <agent UUID>
  Challenge ID: <challenge UUID>
  Nonce: <nonce>
  Issued At: <ISO 8601 time>
  Expires At: <ISO 8601 time, five minutes after Issued At>
  ```

- Verification uses only the original message stored in the DB. It does not accept a message or an arbitrary chain sent by the user. It is currently EOA personal-sign and does not support ERC-1271.
- Each agent is allowed one binding that cannot be overwritten, and one on-chain address cannot be bound to another agent. Changing the key can keep the agent identity, but a key cannot verify a challenge created by another key. A self-service rebind / recovery flow has not been designed, and an existing relationship is not released automatically.
- Each key may have at most 5 unexpired, unconsumed challenges at once. This is a state quota, not full public traffic rate limiting. Ingress rate limiting is still needed before going public.
- The idempotency scope is operator + HTTP method/path + key. The payload hash also includes the authenticated key ID, the fixed origin and the normalized body, which stops a different key of the same operator from getting another's binding result. Changing the JSON key order or the address case does not add a challenge.
- A completed request returns the original result, including a challenge that has since expired. A new key means a new business request. A consumed nonce cannot be reused with a new idempotency key. A failed signature verification also stores a final result, and the same key cannot be used to swap in a different payload.
- The lock order for the identity transaction is: API key shared lock → idempotency advisory lock/record → agent row → challenge → binding/audit. A revocation waits for existing transactions that use that key to finish. After waiting for a resource lock, the time is re-checked, so queueing does not extend validity.
- An in-flight request in the same scope gets 409 REQUEST_IN_PROGRESS through `pg_try_advisory_xact_lock`. After the transaction commits, a retry gets the original result. A SQL error rolls back all state and leaves no fake success.
- The challenge / binding / audit / idempotency result are in the same DB transaction. This slice has no external side effects, so it needs no outbox job. Only the later market-creation intent will connect to the outbox.

## Invitation and external client flow

First run the existing `pnpm db:migrate` with the migration identity. It creates 0001/0002 and the NOLOGIN group roles. The deployment admin creates a separate LOGIN and grants it the group. The API login must not also belong to `blink_identity_admin`. Do not give the migration/admin connection string to the API.

The admin injects a dedicated connection through `IDENTITY_ADMIN_DATABASE_URL` in a private terminal:

```sh
pnpm identity:admin invite --operator-name 'Research team' --agent-name 'Agent A' --scopes 'candidate:write,trade:quote' --reason 'Approved invitation'
pnpm identity:admin issue --agent-id '<agent UUID>' --scopes 'trade:quote' --days 7 --reason 'Key rotation'
pnpm identity:admin revoke --key-id '<key UUID>' --reason 'Retired credential'
```

The stdout of invite/issue **contains a secret that is shown only once**. Do not run it in a shared CI log, and do not commit the response to Git. Hand it to the invitee over a secure channel. Key rotation means issuing first and then having the admin revoke the old key. The program does not extend or replace the old key by itself.

An external user needs only the invited key and their own wallet:

1. Call `POST /v1/auth/wallet-challenges` with the Bearer key and an Idempotency-Key. The body is `{ "address": "0x..." }`.
2. Check the origin, chain, address, purpose and validity period in the response message, and sign the **original message** with your own EOA wallet.
3. Call `POST /v1/auth/wallet-verifications` with the same API key and a new Idempotency-Key. The body is `{ "challengeId": "...", "signature": "0x..." }`.
4. Receiving wallet/verifiedAt completes the identity binding. This does not authorize or execute any trade, and does not mean the wallet is in the contract's taker allowlist.

HTTP body/header/schema errors return 400, an invalid key returns 401, a wrong scope returns 403, a challenge that is not the caller's returns 404, and an expired / used challenge, a binding conflict or an idempotency conflict returns 409. An unknown DB error does not return SQL or credentials.

## Deployment artifacts

```sh
pnpm build:services
pnpm test:service-build
docker build -f infra/Dockerfile.api -t blink-api:local .
```

The build produces `dist/services/{api,worker,indexer,signer}.mjs` and `dist/tools/{migrate,identity-admin}.mjs`, and the migration SQL is in `dist/migrations`. Each service can start on its own, with no runtime `tsx` and no workspace symlinks. `api-server.mjs` is for the bundle smoke test and is not an extra service.

The Docker build context must be the repo root. The API runtime image contains only the API bundle, runs as a non-root user, and contains no key-issuing/migration tools or private keys. The Docker healthcheck checks liveness only and does not pretend the trading platform is ready. When this slice was delivered, the Worker / Indexer / Signer output was still a disabled skeleton. Business wiring and [Local Alpha verification](M5_LOCAL_ALPHA.md) came later, and it is still not a finished private deployment topology. TLS, external ingress rate limiting, a secret manager, persistence, release / rollback and network ACLs are left to deployment acceptance.

## Tests and limits

Local verification on 2026-10-01: `pnpm check` passed (21 Node tests, TypeScript, dependency boundaries and contract compilation). `pnpm test:contracts` passed 24 items. `pnpm build:services` and the two standalone bundle smoke tests passed. The `pnpm build` Web build passed. The contracts themselves were not modified.

This slice adds PGlite + HTTP + local EOA signing tests: hash storage, DB roles, a correct binding, resend / changed payload, cross key / agent, wrong signer / origin, expiry, revocation, scope, the challenge quota, full rollback when audit fails, and client integration. The PGlite pool simulates single-connection queueing and does not claim to verify real concurrent locks.

`tests/postgres/identity.test.ts` is a separate real-PostgreSQL multi-connection test. Point `TEST_POSTGRES_ADMIN_URL` at a **dedicated test cluster**. It creates a random `blink_m2_*` DB and drops only that DB when it ends. It does create the group roles that the migration needs. It tests same-key concurrency, same-nonce concurrency, and two agents competing for the same wallet. CI is configured with a PostgreSQL service and runs `pnpm test:postgres`.

The local Docker daemon is currently unavailable, so the real PostgreSQL test and the Docker image build have not been verified locally. The newly added CI job must not be claimed as having passed on remote CI. The standalone bundle smoke test does not need Docker.

Next slice: evidence sources / access rights, candidate revisions, spec archiving, human approval, and the market-creation intent/outbox. The Indexer and RFQ / Signer come after that.
