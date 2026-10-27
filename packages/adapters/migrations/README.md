# SQL migrations

Migrations 0001–0034 exist (there is no 0021; the runner does not require contiguous numbers). 0001–0024 are the v0.1 history. P2 added 0025–0034, and they are the current shape of the database:

| Migration | Change |
| --- | --- |
| 0025 retire_platform_execution | Dead-letters queued execution and quote-reconciliation jobs (`RETIRED_P2`, leases cleared and fenced); removes the retired storage and roles |
| 0026 retire_platform_research | Marks retired job types `DEAD`; drops research, budget, candidate and creation tables child before parent; recreates `analytics.final_forecasts` |
| 0027 protocol_deployments | `markets.protocol_deployments`, an immutable record of a verified manifest v2 |
| 0028 self_serve_identity | `identity.issue_self_serve_key` and `identity.revoke_self_serve_key` (`SECURITY DEFINER`), challenge columns, revokes every invite key, drops `blink_identity_admin` |
| 0029 protocol_index | Protocol event and projection tables; keeps the cursor, block history, lease tokens and reorg tombstones |
| 0030 content_and_suggestions | `content` and `suggestions` schemas; drops `markets.specs` and `blink_evidence_admin` |
| 0031 protocol_resolution | Proposal, dispute, round, vote, juror, reward-pool and fee projections |
| 0032 rfq_relay | `rfq.requests` and `rfq.quotes`, immutable |
| 0033 signed_forecasts | Signed submissions, window roots, `analytics.closed_forecasts`; drops `blink_forecast_admin` and the `evidence` schema |
| 0034 fees_undistributed_alert | Widens the alert family list |

Every DROP names its objects, and nothing uses CASCADE. No production database exists, so retired tables were dropped, not archived. The table inventory is in [Data model](../../../docs/DATA_MODEL.md).

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

There is no default connection. Use a migration account that can create schemas and roles. Runtime users need their login credentials set separately and must be granted the matching NOLOGIN group role; they do not share the migration account. The runner holds a session advisory lock on a single connection, runs each file in order inside BEGIN/COMMIT, and records its SHA-256; it rejects any change to the checksum of an applied file. A failure rolls back that batch, and nothing is ever dropped automatically.

Migrations are forward-only. An applied SQL file must not be modified; add a new version to fix it. The NUMERIC domains check explicitly for integers, to avoid the automatic rounding of a column's precision and scale. The audit runtime role has INSERT/SELECT only, and a trigger also rejects UPDATE/DELETE/TRUNCATE.

pnpm test uses the PGlite engine to verify DDL, grants, checksums, precision and the SQL functions. pnpm test:postgres needs a dedicated PostgreSQL (the CI image is `postgres:17.6`), runs serially because historical migrations create cluster-wide roles that 0025 drops, and tests lock contention across real multiple connections (key issue, RFQ quotes, forecast admission); a single-session test must not be taken as distributed concurrency acceptance. The backup and restore drill is `pnpm drill:restore`.
