# SQL migrations

`0005_creation_tracking` adds the market-creation observation history and projection, written only by the indexer; the API can only query them. `0006_creation_tracking_schedule` creates a durable polling schedule for verified market-creation projections whose txHash is pinned, and provides lease/retry recovery; it does not include a full block/event indexer. Apply 0006 before enabling the creation poller.

0001_foundation creates the domains, runtime roles and base operations tables; 0002_identity creates invitations and wallet binding; 0003_preparation creates evidence and candidates; 0004_approval creates deployment verification, specs, approvals, creation_intents and active_slots, plus a separate deployment-registry role. Releasing a pending slot and on-chain confirmation are left to a later migration; do not delete rows by hand.

```sh
DATABASE_URL=postgresql://blink:local-only@127.0.0.1:5432/blink pnpm db:migrate
```

There is no default connection. Use a migration account that can create schemas and roles. Runtime users need their login credentials set separately and must be granted the matching NOLOGIN group role; they do not share the migration account. The runner holds a session advisory lock on a single connection, runs each file in order inside BEGIN/COMMIT, and records its SHA-256; it rejects any change to the checksum of an applied file. A failure rolls back that batch, and nothing is ever dropped automatically.

Migrations are forward-only. An applied SQL file must not be modified; add a new version to fix it. The NUMERIC domains check explicitly for integers, to avoid the automatic rounding of a column's precision and scale. The audit runtime role has INSERT/SELECT only, and a trigger also rejects UPDATE/DELETE/TRUNCATE.

pnpm test uses the PGlite engine to verify DDL, grants, checksums, precision and identity transactions. pnpm test:postgres also needs a dedicated PostgreSQL and tests identity lock contention across real multiple connections; a single-session test must not be taken as distributed concurrency acceptance. Backup/restore and outbox retry integration are left to later slices.
