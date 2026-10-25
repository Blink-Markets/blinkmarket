import type {
  ProtocolAccount,
  ProtocolMarket,
  MakerState,
  DigestStatus,
  Anchor,
} from "@blink/schemas";
import {
  hasRole as registryHasRole,
  creditAt as decayCredit,
} from "@blink/ports";
import { loadProtocolDeployment } from "./deployment-registry.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ChainBlock,
  ChainGateReason,
  ChainIndexStore,
  ChainLease,
  ProtocolProjection,
  ChainRangeCommit,
  ChainReorgCommit,
  ProtocolEvent,
  IndexCursor,
  ProjectionChanges,
  ProtocolReader,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type Db = Pick<PoolClient, "query">;
type Row = Record<string, unknown>;

const bare = (value: string) => value.slice(2);
const hx = (value: unknown) => "0x" + String(value);
const big = (value: unknown) => BigInt(value as string);
const bigOrNull = (value: unknown) => (value === null ? null : big(value));
const text = (value: bigint | number | null) =>
  value === null ? null : String(value);

const emptyProjection = (): ProtocolProjection => ({
  accounts: new Map(),
  templates: new Map(),
  markets: new Map(),
  positions: new Map(),
  makers: new Map(),
  digests: new Map(),
  fills: new Map(),
  anchors: new Map(),
  successors: new Map(),
});
const tables = {
  accounts: "accounts",
  templates: "templates",
  markets: "markets",
  positions: "positions",
  makers: "makers",
  digests: "quote_digests",
  fills: "fills",
  anchors: "anchors",
  successors: "successors",
} as const;

const cursorColumns = `deployment_id, block_number::text AS block_number, encode(block_hash,'hex') AS block_hash,
  block_timestamp::text AS block_timestamp, head_number::text AS head_number, head_timestamp::text AS head_timestamp,
  finalized_number::text AS finalized_number, synced_at, gate_reason, version::text AS version`;

async function readCursor(
  db: Db,
  deploymentId: string,
): Promise<IndexCursor | null> {
  const { rows } = await db.query<Row>(
    `SELECT ${cursorColumns} FROM chain.cursors WHERE deployment_id=$1`,
    [deploymentId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    deploymentId: String(row.deployment_id),
    blockNumber: big(row.block_number),
    blockHash: hx(row.block_hash),
    blockTimestamp: big(row.block_timestamp),
    headNumber: big(row.head_number),
    ...(row.head_timestamp === null
      ? {}
      : { headTimestamp: big(row.head_timestamp) }),
    finalizedNumber: bigOrNull(row.finalized_number),
    syncedAt: new Date(row.synced_at as Date),
    gateReason: row.gate_reason as ChainGateReason | null,
    version: big(row.version),
  };
}

async function readEvents(
  db: Db,
  deploymentId: string,
): Promise<ProtocolEvent[]> {
  const { rows } = await db.query<Row>(
    `SELECT e.block_number::text AS block_number, encode(e.block_hash,'hex') AS block_hash,
       b.timestamp::text AS block_timestamp, encode(e.tx_hash,'hex') AS tx_hash,
       e.tx_index, e.log_index, e.contract, encode(e.emitter,'hex') AS emitter, e.name, e.args
     FROM protocol.events e
     JOIN chain.blocks b ON b.deployment_id=e.deployment_id AND b.hash=e.block_hash
     WHERE e.deployment_id=$1 AND e.canonical
     ORDER BY e.block_number, e.tx_index, e.log_index`,
    [deploymentId],
  );
  return rows.map((row) => ({
    contract: row.contract as ProtocolEvent["contract"],
    emitter: hx(row.emitter),
    name: row.name as ProtocolEvent["name"],
    args: row.args as ProtocolEvent["args"],
    blockNumber: big(row.block_number),
    blockHash: hx(row.block_hash),
    blockTimestamp: big(row.block_timestamp),
    txHash: hx(row.tx_hash),
    txIndex: Number(row.tx_index),
    logIndex: Number(row.log_index),
  }));
}

async function readProjection(
  db: Db,
  deploymentId: string,
): Promise<ProtocolProjection> {
  const projection = emptyProjection();
  for (const [kind, table] of Object.entries(tables)) {
    const { rows } = await db.query<{ key: string; data: unknown }>(
      `SELECT key,data FROM protocol.${table} WHERE deployment_id=$1`,
      [deploymentId],
    );
    const map = projection[kind as keyof ProtocolProjection] as Map<
      string,
      unknown
    >;
    for (const row of rows) map.set(row.key, row.data);
  }
  return projection;
}
async function writeProjection(
  db: Db,
  deploymentId: string,
  projection: ProtocolProjection,
  selection: ProjectionChanges | null,
  asOfBlockHash: string,
) {
  for (const [kind, table] of Object.entries(tables)) {
    const map = projection[kind as keyof ProtocolProjection] as Map<
      string,
      unknown
    >;
    const keys = selection
      ? selection[kind as keyof ProtocolProjection]
      : [...map.keys()];
    if (!keys.length) continue;
    await db.query(
      `INSERT INTO protocol.${table}(deployment_id,key,data,as_of_block_hash)
   SELECT $1,x.key,x.data,decode($3,'hex') FROM jsonb_to_recordset($2::jsonb) AS x(key text,data jsonb)
   ON CONFLICT(deployment_id,key) DO UPDATE SET data=EXCLUDED.data,as_of_block_hash=EXCLUDED.as_of_block_hash`,
      [
        deploymentId,
        JSON.stringify(keys.map((key) => ({ key, data: map.get(key) }))),
        bare(asOfBlockHash),
      ],
    );
  }
  // Role and credit rows are rebuilt together with their account; no independently mutable copy.
  const accounts = selection
    ? selection.accounts
    : [...projection.accounts.keys()];
  for (const address of accounts) {
    const a = projection.accounts.get(address)!;
    for (const [role, data] of Object.entries(a.roles))
      await db.query(
        `INSERT INTO protocol.account_roles(deployment_id,account,role,data) VALUES($1,decode($2,'hex'),$3,$4) ON CONFLICT(deployment_id,account,role) DO UPDATE SET data=EXCLUDED.data`,
        [deploymentId, bare(address), role, data],
      );
    for (const [role, data] of Object.entries(a.credit))
      await db.query(
        `INSERT INTO protocol.credit(deployment_id,account,role,data) VALUES($1,decode($2,'hex'),$3,$4) ON CONFLICT(deployment_id,account,role) DO UPDATE SET data=EXCLUDED.data`,
        [deploymentId, bare(address), role, data],
      );
  }
}
async function clearProjection(db: Db, deploymentId: string) {
  for (const table of ["account_roles", "credit", ...Object.values(tables)])
    await db.query(`DELETE FROM protocol.${table} WHERE deployment_id=$1`, [
      deploymentId,
    ]);
}

async function upsertBlocks(
  db: Db,
  deploymentId: string,
  blocks: readonly ChainBlock[],
) {
  if (!blocks.length) return;
  // A block that returns to the canonical chain is revived; one already canonical is untouched.
  await db.query(
    `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
     SELECT $1, x.number::numeric, decode(x.hash,'hex'), decode(x.parent_hash,'hex'), x.timestamp::numeric, true
     FROM jsonb_to_recordset($2::jsonb) AS x(number text, hash text, parent_hash text, timestamp text)
     ON CONFLICT (deployment_id, hash) DO UPDATE SET canonical=true WHERE NOT chain.blocks.canonical`,
    [
      deploymentId,
      JSON.stringify(
        blocks.map((b) => ({
          number: text(b.number),
          hash: bare(b.hash),
          parent_hash: bare(b.parentHash),
          timestamp: text(b.timestamp),
        })),
      ),
    ],
  );
}

async function upsertEvents(
  db: Db,
  deploymentId: string,
  events: readonly ProtocolEvent[],
) {
  if (!events.length) return;
  await db.query(
    `INSERT INTO protocol.events(deployment_id,block_hash,block_number,tx_hash,tx_index,log_index,emitter,contract,name,args,canonical)
     SELECT $1, decode(x.block_hash,'hex'), x.block_number::numeric, decode(x.tx_hash,'hex'), x.tx_index,
       x.log_index, decode(x.emitter,'hex'), x.contract, x.name, x.args, true
     FROM jsonb_to_recordset($2::jsonb) AS x(block_hash text, block_number text, tx_hash text, tx_index integer,
       log_index integer, emitter text, contract text, name text, args jsonb)
     ON CONFLICT (deployment_id, block_hash, log_index) DO UPDATE SET canonical=true
       WHERE NOT protocol.events.canonical`,
    [
      deploymentId,
      JSON.stringify(
        events.map((e) => ({
          block_hash: bare(e.blockHash),
          block_number: text(e.blockNumber),
          tx_hash: bare(e.txHash),
          tx_index: e.txIndex,
          log_index: e.logIndex,
          emitter: bare(e.emitter),
          contract: e.contract,
          name: e.name,
          args: e.args,
        })),
      ),
    ],
  );
}

async function outbox(
  db: Db,
  type: string,
  aggregateId: string,
  version: bigint,
  payload: Record<string, string>,
) {
  await db.query(
    "INSERT INTO operations.outbox(id,event_type,aggregate_id,event_version,payload) VALUES ($1,$2,$3,$4,$5::jsonb)",
    [
      randomUUID(),
      type,
      aggregateId,
      version.toString(),
      JSON.stringify(payload),
    ],
  );
}

// The fence: the lease token and the cursor version must both still be the caller's.
async function advance(
  db: Db,
  lease: ChainLease,
  expectedVersion: bigint,
  assignments: string | null,
  values: unknown[] = [],
): Promise<{ version: bigint; blockHash: string }> {
  const { rows } = await db.query<Row>(
    `UPDATE chain.cursors SET ${assignments ? assignments + "," : ""} version=version+1
     WHERE deployment_id=$1 AND lease_owner=$2 AND lease_token=$3 AND version=$4
     RETURNING version::text AS version, encode(block_hash,'hex') AS block_hash`,
    [
      lease.deploymentId,
      lease.workerId,
      lease.token.toString(),
      expectedVersion.toString(),
      ...values,
    ],
  );
  if (!rows[0]) {
    const current = await db.query<Row>(
      "SELECT lease_owner, lease_token::text AS lease_token FROM chain.cursors WHERE deployment_id=$1",
      [lease.deploymentId],
    );
    const held = current.rows[0];
    throw new Error(
      held &&
        held.lease_owner === lease.workerId &&
        held.lease_token === lease.token.toString()
        ? "CHAIN_VERSION_CONFLICT"
        : "CHAIN_LEASE_LOST",
    );
  }
  return { version: big(rows[0].version), blockHash: hx(rows[0].block_hash) };
}

export function postgresProtocolIndexStore(pool: Pool): ChainIndexStore {
  const uow = createUnitOfWork(pool);
  return {
    async creditHalfLife(deploymentId) {
      return (await loadProtocolDeployment(pool, deploymentId)).params
        .creditHalfLife;
    },
    async loadCursor(deploymentId) {
      return readCursor(pool, deploymentId);
    },
    async now() {
      const { rows } = await pool.query<Row>("SELECT blink.now() AS now");
      return new Date(rows[0]!.now as Date);
    },
    initializeCursor: ({
      deploymentId,
      baseline,
      headNumber,
      headTimestamp,
      finalizedNumber,
    }) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query(
          `INSERT INTO chain.blocks(deployment_id,number,hash,parent_hash,timestamp,canonical)
           VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),$5,true) ON CONFLICT DO NOTHING`,
          [
            deploymentId,
            baseline.number.toString(),
            bare(baseline.hash),
            bare(baseline.parentHash),
            baseline.timestamp.toString(),
          ],
        );
        // Stale until the first committed sync: nothing has been indexed yet.
        // A restore may lose chain tables while retaining outbox history. Continue its
        // version sequence so replay emits new notifications without unique-key collisions.
        await db.query(
          `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,
             finalized_number,synced_at,version,head_timestamp)
           SELECT $1,$2,decode($3,'hex'),$4,$5,$6,to_timestamp(0),COALESCE(max(event_version),0)
            , $7::numeric FROM operations.outbox WHERE aggregate_id=$1 AND event_type IN ('chain.synced','chain.reorged')
           ON CONFLICT (deployment_id) DO NOTHING`,
          [
            deploymentId,
            baseline.number.toString(),
            bare(baseline.hash),
            baseline.timestamp.toString(),
            (headNumber > baseline.number
              ? headNumber
              : baseline.number
            ).toString(),
            finalizedNumber?.toString() ?? null,
            headTimestamp?.toString() ?? null,
          ],
        );
      }),
    async claimLease(deploymentId, workerId, leaseMs) {
      if (!workerId || workerId.length > 128)
        throw new Error("INVALID_CHAIN_INDEX_WORKER_ID");
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
        throw new Error("INVALID_CHAIN_INDEX_LEASE_MS");
      const { rows } = await pool.query<Row>(
        `UPDATE chain.cursors
         SET lease_owner=$2, lease_until=blink.now()+$3::bigint*interval '1 millisecond', lease_token=lease_token+1
         WHERE deployment_id=$1 AND (lease_owner IS NULL OR lease_owner=$2 OR lease_until<=blink.now())
         RETURNING lease_token::text AS lease_token`,
        [deploymentId, workerId, leaseMs],
      );
      return rows[0]
        ? { deploymentId, workerId, token: big(rows[0].lease_token) }
        : null;
    },
    async releaseLease(lease) {
      await pool.query(
        `UPDATE chain.cursors SET lease_owner=NULL, lease_until=NULL
         WHERE deployment_id=$1 AND lease_owner=$2 AND lease_token=$3`,
        [lease.deploymentId, lease.workerId, lease.token.toString()],
      );
    },
    loadProjection: (deploymentId) => readProjection(pool, deploymentId),
    loadCanonicalEvents: (deploymentId) => readEvents(pool, deploymentId),
    loadSnapshot: (deploymentId) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        const cursor = await readCursor(db, deploymentId);
        if (!cursor) throw new Error("CHAIN_CURSOR_NOT_FOUND");
        return {
          cursor,
          events: await readEvents(db, deploymentId),
          projection: await readProjection(db, deploymentId),
        };
      }),
    async canonicalBlockAtOrBelow(deploymentId, number) {
      const { rows } = await pool.query<Row>(
        `SELECT b.number::text AS number, encode(b.hash,'hex') AS hash, encode(b.parent_hash,'hex') AS parent_hash,
           b.timestamp::text AS timestamp
         FROM chain.blocks b WHERE b.deployment_id=$1 AND b.canonical AND b.number<=$2
         ORDER BY b.number DESC LIMIT 1`,
        [deploymentId, number.toString()],
      );
      const row = rows[0];
      return row
        ? {
            number: big(row.number),
            hash: hx(row.hash),
            parentHash: hx(row.parent_hash),
            timestamp: big(row.timestamp),
          }
        : null;
    },
    commitRange: (lease, commit: ChainRangeCommit) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { deploymentId } = lease;
        const { version } = await advance(
          db,
          lease,
          commit.expectedVersion,
          `block_number=$5, block_hash=decode($6,'hex'), block_timestamp=$7, head_number=$8,
           finalized_number=$9, synced_at=$12, gate_reason=$10,head_timestamp=$11`,
          [
            commit.block.number.toString(),
            bare(commit.block.hash),
            commit.block.timestamp.toString(),
            commit.headNumber.toString(),
            commit.finalizedNumber?.toString() ?? null,
            commit.gateReason,
            commit.headTimestamp?.toString() ?? null,
            commit.headObservedAt,
          ],
        );
        await upsertBlocks(db, deploymentId, commit.blocks);
        await upsertEvents(db, deploymentId, commit.events);
        if (commit.changes === null) await clearProjection(db, deploymentId);
        await writeProjection(
          db,
          deploymentId,
          commit.projection,
          commit.changes,
          commit.block.hash,
        );
        for (const marketId of commit.newMarketIds) {
          const market = commit.projection.markets.get(marketId)!;
          await outbox(
            db,
            "market.indexed",
            `${deploymentId}:${marketId}`,
            version,
            {
              deploymentId,
              marketId,
              specHash: market.specHash,
              blockNumber: commit.events
                .find(
                  (e) =>
                    e.name === "MarketCreated" && e.args.marketId === marketId,
                )!
                .blockNumber.toString(),
              txHash: commit.events.find(
                (e) =>
                  e.name === "MarketCreated" && e.args.marketId === marketId,
              )!.txHash,
            },
          );
        }
        await outbox(db, "chain.synced", deploymentId, version, {
          deploymentId,
          blockNumber: commit.block.number.toString(),
          blockHash: commit.block.hash,
        });
        return version;
      }),
    refreshCursor: (lease, expectedVersion, refresh) =>
      uow.run(async (ctx) => {
        const { version } = await advance(
          uow.client(ctx),
          lease,
          expectedVersion,
          "head_number=$5, finalized_number=$6, gate_reason=$7, synced_at=$9,head_timestamp=$8",
          [
            refresh.headNumber.toString(),
            refresh.finalizedNumber?.toString() ?? null,
            refresh.gateReason,
            refresh.headTimestamp?.toString() ?? null,
            refresh.headObservedAt,
          ],
        );
        return version;
      }),
    setGate: (lease, expectedVersion, reason) =>
      uow.run(async (ctx) => {
        const { version } = await advance(
          uow.client(ctx),
          lease,
          expectedVersion,
          "gate_reason=$5",
          [reason],
        );
        return version;
      }),
    commitReorg: (lease, commit: ChainReorgCommit) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { deploymentId } = lease;
        const stored = await db.query(
          "SELECT 1 FROM chain.blocks WHERE deployment_id=$1 AND hash=decode($2,'hex') AND number=$3 AND canonical",
          [
            deploymentId,
            bare(commit.ancestor.hash),
            commit.ancestor.number.toString(),
          ],
        );
        if (stored.rows.length !== 1) throw new Error("CHAIN_ANCESTOR_UNKNOWN");
        const { version } = await advance(
          db,
          lease,
          commit.expectedVersion,
          `block_number=$5, block_hash=decode($6,'hex'), block_timestamp=$7,
           head_number=$8, finalized_number=$9,
           gate_reason='REORG_IN_PROGRESS'`,
          [
            commit.ancestor.number.toString(),
            bare(commit.ancestor.hash),
            commit.ancestor.timestamp.toString(),
            commit.headNumber.toString(),
            commit.finalizedNumber?.toString() ?? null,
          ],
        );
        // Tombstones: the rows stay, only their canonical flag drops.
        await db.query(
          "UPDATE protocol.events SET canonical=false WHERE deployment_id=$1 AND canonical AND block_number>$2",
          [deploymentId, commit.ancestor.number.toString()],
        );
        await db.query(
          "UPDATE chain.blocks SET canonical=false WHERE deployment_id=$1 AND canonical AND number>$2",
          [deploymentId, commit.ancestor.number.toString()],
        );
        await clearProjection(db, deploymentId);
        await writeProjection(
          db,
          deploymentId,
          commit.projection,
          null,
          commit.ancestor.hash,
        );
        await outbox(db, "chain.reorged", deploymentId, version, {
          deploymentId,
          ancestorNumber: commit.ancestor.number.toString(),
          ancestorHash: commit.ancestor.hash,
          orphanedFrom: (commit.ancestor.number + 1n).toString(),
        });
        return version;
      }),
    replaceProjection: (lease, expectedVersion, projection) =>
      uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { version, blockHash } = await advance(
          db,
          lease,
          expectedVersion,
          null,
        );
        await clearProjection(db, lease.deploymentId);
        await writeProjection(
          db,
          lease.deploymentId,
          projection,
          null,
          blockHash,
        );
        return version;
      }),
  };
}

export async function assertChainIndexInstalled(pool: Pool) {
  try {
    await pool.query("SELECT deployment_id FROM protocol.events LIMIT 0");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "42P01" || error.code === "3F000")
    )
      throw new Error("CHAIN_INDEX_MIGRATION_REQUIRED");
    throw error;
  }
}

export function postgresProtocolReader(
  db: Pick<Pool, "query">,
  deploymentId: string,
): ProtocolReader {
  const read = async <T>(table: string, key: string): Promise<T | null> => {
    const { rows } = await db.query<{ data: T }>(
      `SELECT data FROM protocol.${table} WHERE deployment_id=$1 AND key=$2`,
      [deploymentId, key.toLowerCase()],
    );
    return rows[0]?.data ?? null;
  };
  const params = async () =>
    (await loadProtocolDeployment(db, deploymentId)).params;
  const account = (address: string) =>
    read<ProtocolAccount>("accounts", address);
  return {
    async health() {
      const { rows } = await db.query(
        `SELECT c.block_number::text,c.head_number::text,c.gate_reason,
    GREATEST(0,COALESCE(c.head_timestamp,c.block_timestamp)-c.block_timestamp)::text AS lag,
    extract(epoch FROM blink.now()-c.synced_at)::text AS age
    FROM chain.cursors c WHERE c.deployment_id=$1`,
        [deploymentId],
      );
      const r = rows[0];
      return r
        ? {
            headBlock: Number(r.head_number),
            indexedBlock: Number(r.block_number),
            lagSeconds: Number(r.lag),
            stale: !!r.gate_reason || Number(r.lag) > 30 || Number(r.age) > 30,
          }
        : { headBlock: 0, indexedBlock: 0, lagSeconds: 0, stale: true };
    },
    account,
    async hasRole(address, role) {
      return registryHasRole(
        await account(address),
        role,
        (await params()).minRoleStake,
      );
    },
    async creditAt(address, role, at) {
      return decayCredit(
        (await account(address))?.credit[role],
        at,
        (await params()).creditHalfLife,
      );
    },
    market: (id) => read<ProtocolMarket>("markets", id),
    async marketBySpecHash(specHash) {
      const { rows } = await db.query<{ data: ProtocolMarket }>(
        "SELECT data FROM protocol.markets WHERE deployment_id=$1 AND data->>'specHash'=$2 ORDER BY (data->>'marketId')::numeric LIMIT 1",
        [deploymentId, specHash.toLowerCase()],
      );
      return rows[0]?.data ?? null;
    },
    async markets({ states, after, limit }) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        (after !== undefined && !/^\d+$/.test(after))
      )
        throw new Error("INVALID_MARKET_PAGE");
      const { rows } = await db.query<{ data: ProtocolMarket }>(
        `SELECT data FROM protocol.markets WHERE deployment_id=$1 AND ($2::text[] IS NULL OR data->>'state'=ANY($2)) AND ($3::numeric IS NULL OR (data->>'marketId')::numeric>$3) ORDER BY (data->>'marketId')::numeric LIMIT $4`,
        [deploymentId, states ?? null, after ?? null, limit + 1],
      );
      const items = rows.slice(0, limit).map((r) => r.data);
      return {
        items,
        next: rows.length > limit ? items.at(-1)!.marketId : null,
      };
    },
    async maker(address) {
      return (
        (await read<MakerState>("makers", address)) ?? {
          address: address.toLowerCase(),
          freeMicros: "0",
          epoch: "0",
        }
      );
    },
    async digest(digest) {
      return (await read<DigestStatus>("quote_digests", digest)) ?? "UNUSED";
    },
    anchor: (root) => read<Anchor>("anchors", root),
  };
}
