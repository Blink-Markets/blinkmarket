import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  ChainBlock,
  ChainGateReason,
  ChainIndexStore,
  ChainLease,
  ChainProjection,
  ChainRangeCommit,
  ChainReorgCommit,
  DecodedEvent,
  DigestProjection,
  IndexCursor,
  MarketProjection,
  PositionProjection,
  ProjectionChanges,
} from "@blink/ports";
import { createUnitOfWork } from "./database.js";

type Db = Pick<PoolClient, "query">;
type Row = Record<string, unknown>;

const bare = (value: string) => value.slice(2);
const hx = (value: unknown) => "0x" + String(value);
const prefixed = (value: unknown) =>
  value === null ? null : "0x" + String(value);
const big = (value: unknown) => BigInt(value as string);
const bigOrNull = (value: unknown) => (value === null ? null : big(value));
const text = (value: bigint | number | null) =>
  value === null ? null : String(value);

const emptyProjection = (): ChainProjection => ({
  markets: new Map(),
  positions: new Map(),
  maker: { freeMicros: 0n, epoch: 0n, globalPaused: false },
  digests: new Map(),
  takers: new Map(),
});

const cursorColumns = `deployment_id, block_number::text AS block_number, encode(block_hash,'hex') AS block_hash,
  block_timestamp::text AS block_timestamp, head_number::text AS head_number,
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
    finalizedNumber: bigOrNull(row.finalized_number),
    syncedAt: new Date(row.synced_at as Date),
    gateReason: row.gate_reason as ChainGateReason | null,
    version: big(row.version),
  };
}

async function readEvents(
  db: Db,
  deploymentId: string,
): Promise<DecodedEvent[]> {
  const { rows } = await db.query<Row>(
    `SELECT e.block_number::text AS block_number, encode(e.block_hash,'hex') AS block_hash,
       b.timestamp::text AS block_timestamp, encode(e.tx_hash,'hex') AS tx_hash,
       e.tx_index, e.log_index, e.name, e.args
     FROM chain.events e
     JOIN chain.blocks b ON b.deployment_id=e.deployment_id AND b.hash=e.block_hash
     WHERE e.deployment_id=$1 AND e.canonical
     ORDER BY e.block_number, e.tx_index, e.log_index`,
    [deploymentId],
  );
  return rows.map((row) => ({
    name: row.name as DecodedEvent["name"],
    args: row.args as DecodedEvent["args"],
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
): Promise<ChainProjection> {
  const projection = emptyProjection();
  // One statement at a time: the caller may hold a single transaction connection.
  const markets = await db.query<Row>(
    `SELECT market_id::text AS market_id, encode(spec_hash,'hex') AS spec_hash, spec_uri, mode,
       close_at::text AS close_at, proposal_deadline::text AS proposal_deadline,
       hard_deadline::text AS hard_deadline, challenge_seconds,
       max_pairs::text AS max_pairs, max_taker_shares::text AS max_taker_shares, state, paused,
       proposed_outcome, proposed_at::text AS proposed_at,
       encode(proposal_evidence_hash,'hex') AS proposal_evidence_hash,
       encode(challenge_evidence_hash,'hex') AS challenge_evidence_hash,
       final_outcome, final_reason, encode(final_evidence_hash,'hex') AS final_evidence_hash,
       total_pairs::text AS total_pairs, escrow_micros::text AS escrow_micros,
       created_block_number::text AS created_block_number,
       encode(created_tx_hash,'hex') AS created_tx_hash
     FROM chain.markets WHERE deployment_id=$1`,
    [deploymentId],
  );
  const positions = await db.query<Row>(
    `SELECT market_id::text AS market_id, encode(account,'hex') AS account,
       yes_shares::text AS yes_shares, no_shares::text AS no_shares,
       taker_bought_shares::text AS taker_bought_shares,
       redeemed_payout_micros::text AS redeemed_payout_micros
     FROM chain.positions WHERE deployment_id=$1`,
    [deploymentId],
  );
  const maker = await db.query<Row>(
    `SELECT free_balance_micros::text AS free, epoch::text AS epoch, global_paused
     FROM chain.maker_state WHERE deployment_id=$1`,
    [deploymentId],
  );
  const digests = await db.query<Row>(
    `SELECT encode(digest,'hex') AS digest, state, market_id::text AS market_id,
       encode(taker,'hex') AS taker, side, quantity::text AS quantity, price_bps,
       taker_cost_micros::text AS taker_cost, maker_cost_micros::text AS maker_cost,
       block_number::text AS block_number, encode(block_hash,'hex') AS block_hash,
       encode(tx_hash,'hex') AS tx_hash
     FROM chain.quote_digests WHERE deployment_id=$1`,
    [deploymentId],
  );
  const takers = await db.query<Row>(
    `SELECT encode(account,'hex') AS account, allowed FROM chain.takers WHERE deployment_id=$1`,
    [deploymentId],
  );
  for (const r of markets.rows) {
    const market: MarketProjection = {
      marketId: String(r.market_id),
      specHash: hx(r.spec_hash),
      specUri: String(r.spec_uri),
      mode: r.mode as MarketProjection["mode"],
      closeAt: big(r.close_at),
      proposalDeadline: big(r.proposal_deadline),
      hardDeadline: big(r.hard_deadline),
      challengeSeconds: Number(r.challenge_seconds),
      maxPairs: big(r.max_pairs),
      maxTakerShares: big(r.max_taker_shares),
      state: r.state as MarketProjection["state"],
      paused: Boolean(r.paused),
      proposedOutcome:
        r.proposed_outcome as MarketProjection["proposedOutcome"],
      proposedAt: bigOrNull(r.proposed_at),
      proposalEvidenceHash: prefixed(r.proposal_evidence_hash),
      challengeEvidenceHash: prefixed(r.challenge_evidence_hash),
      finalOutcome: r.final_outcome as MarketProjection["finalOutcome"],
      finalReason: r.final_reason as MarketProjection["finalReason"],
      finalEvidenceHash: prefixed(r.final_evidence_hash),
      totalPairs: big(r.total_pairs),
      escrowMicros: big(r.escrow_micros),
      createdBlockNumber: big(r.created_block_number),
      createdTxHash: hx(r.created_tx_hash),
    };
    projection.markets.set(market.marketId, market);
  }
  for (const r of positions.rows) {
    const position: PositionProjection = {
      marketId: String(r.market_id),
      account: hx(r.account),
      yesShares: big(r.yes_shares),
      noShares: big(r.no_shares),
      takerBoughtShares: big(r.taker_bought_shares),
      redeemedPayoutMicros: big(r.redeemed_payout_micros),
    };
    projection.positions.set(
      `${position.marketId}:${position.account}`,
      position,
    );
  }
  const makerRow = maker.rows[0];
  if (makerRow)
    projection.maker = {
      freeMicros: big(makerRow.free),
      epoch: big(makerRow.epoch),
      globalPaused: Boolean(makerRow.global_paused),
    };
  for (const r of digests.rows) {
    const digest: DigestProjection = {
      digest: hx(r.digest),
      state: r.state as DigestProjection["state"],
      marketId: r.market_id === null ? null : String(r.market_id),
      taker: prefixed(r.taker),
      side: r.side as DigestProjection["side"],
      quantity: bigOrNull(r.quantity),
      priceBps: r.price_bps === null ? null : Number(r.price_bps),
      takerCostMicros: bigOrNull(r.taker_cost),
      makerCostMicros: bigOrNull(r.maker_cost),
      blockNumber: big(r.block_number),
      blockHash: hx(r.block_hash),
      txHash: hx(r.tx_hash),
    };
    projection.digests.set(digest.digest, digest);
  }
  for (const r of takers.rows)
    projection.takers.set(hx(r.account), Boolean(r.allowed));
  return projection;
}

// Which projection entries to write: null selects everything (after the caller cleared the tables).
type Selection = Pick<
  ProjectionChanges,
  "maker" | "markets" | "positions" | "digests" | "takers"
>;

async function writeProjection(
  db: Db,
  deploymentId: string,
  projection: ChainProjection,
  selection: Selection | null,
  asOfBlockHash: string,
) {
  const keys = <V>(map: Map<string, V>, chosen: string[] | undefined) =>
    (chosen ?? [...map.keys()]).map((key) => map.get(key)!);
  const asOf = bare(asOfBlockHash);
  const markets = keys(projection.markets, selection?.markets);
  if (markets.length)
    await db.query(
      `INSERT INTO chain.markets(deployment_id,market_id,spec_hash,spec_uri,mode,close_at,proposal_deadline,
         hard_deadline,challenge_seconds,max_pairs,max_taker_shares,state,paused,proposed_outcome,proposed_at,
         proposal_evidence_hash,challenge_evidence_hash,final_outcome,final_reason,final_evidence_hash,
         total_pairs,escrow_micros,created_block_number,created_tx_hash,as_of_block_hash)
       SELECT $1, x.market_id::numeric, decode(x.spec_hash,'hex'), x.spec_uri, x.mode, x.close_at::numeric,
         x.proposal_deadline::numeric, x.hard_deadline::numeric, x.challenge_seconds, x.max_pairs::numeric,
         x.max_taker_shares::numeric, x.state, x.paused, x.proposed_outcome, x.proposed_at::numeric,
         decode(x.proposal_evidence_hash,'hex'), decode(x.challenge_evidence_hash,'hex'), x.final_outcome,
         x.final_reason, decode(x.final_evidence_hash,'hex'), x.total_pairs::numeric, x.escrow_micros::numeric,
         x.created_block_number::numeric, decode(x.created_tx_hash,'hex'), decode($3,'hex')
       FROM jsonb_to_recordset($2::jsonb) AS x(market_id text, spec_hash text, spec_uri text, mode text,
         close_at text, proposal_deadline text, hard_deadline text, challenge_seconds integer, max_pairs text,
         max_taker_shares text, state text, paused boolean, proposed_outcome text, proposed_at text,
         proposal_evidence_hash text, challenge_evidence_hash text, final_outcome text, final_reason text,
         final_evidence_hash text, total_pairs text, escrow_micros text, created_block_number text,
         created_tx_hash text)
       ON CONFLICT (deployment_id, market_id) DO UPDATE SET
         state=EXCLUDED.state, paused=EXCLUDED.paused, proposed_outcome=EXCLUDED.proposed_outcome,
         proposed_at=EXCLUDED.proposed_at, proposal_evidence_hash=EXCLUDED.proposal_evidence_hash,
         challenge_evidence_hash=EXCLUDED.challenge_evidence_hash, final_outcome=EXCLUDED.final_outcome,
         final_reason=EXCLUDED.final_reason, final_evidence_hash=EXCLUDED.final_evidence_hash,
         total_pairs=EXCLUDED.total_pairs, escrow_micros=EXCLUDED.escrow_micros,
         as_of_block_hash=EXCLUDED.as_of_block_hash`,
      [
        deploymentId,
        JSON.stringify(
          markets.map((m) => ({
            market_id: m.marketId,
            spec_hash: bare(m.specHash),
            spec_uri: m.specUri,
            mode: m.mode,
            close_at: text(m.closeAt),
            proposal_deadline: text(m.proposalDeadline),
            hard_deadline: text(m.hardDeadline),
            challenge_seconds: m.challengeSeconds,
            max_pairs: text(m.maxPairs),
            max_taker_shares: text(m.maxTakerShares),
            state: m.state,
            paused: m.paused,
            proposed_outcome: m.proposedOutcome,
            proposed_at: text(m.proposedAt),
            proposal_evidence_hash:
              m.proposalEvidenceHash && bare(m.proposalEvidenceHash),
            challenge_evidence_hash:
              m.challengeEvidenceHash && bare(m.challengeEvidenceHash),
            final_outcome: m.finalOutcome,
            final_reason: m.finalReason,
            final_evidence_hash:
              m.finalEvidenceHash && bare(m.finalEvidenceHash),
            total_pairs: text(m.totalPairs),
            escrow_micros: text(m.escrowMicros),
            created_block_number: text(m.createdBlockNumber),
            created_tx_hash: bare(m.createdTxHash),
          })),
        ),
        asOf,
      ],
    );
  const positions = keys(projection.positions, selection?.positions);
  if (positions.length)
    await db.query(
      `INSERT INTO chain.positions(deployment_id,market_id,account,yes_shares,no_shares,taker_bought_shares,
         redeemed_payout_micros,as_of_block_hash)
       SELECT $1, x.market_id::numeric, decode(x.account,'hex'), x.yes_shares::numeric, x.no_shares::numeric,
         x.taker_bought_shares::numeric, x.redeemed_payout_micros::numeric, decode($3,'hex')
       FROM jsonb_to_recordset($2::jsonb) AS x(market_id text, account text, yes_shares text, no_shares text,
         taker_bought_shares text, redeemed_payout_micros text)
       ON CONFLICT (deployment_id, market_id, account) DO UPDATE SET
         yes_shares=EXCLUDED.yes_shares, no_shares=EXCLUDED.no_shares,
         taker_bought_shares=EXCLUDED.taker_bought_shares,
         redeemed_payout_micros=EXCLUDED.redeemed_payout_micros, as_of_block_hash=EXCLUDED.as_of_block_hash`,
      [
        deploymentId,
        JSON.stringify(
          positions.map((p) => ({
            market_id: p.marketId,
            account: bare(p.account),
            yes_shares: text(p.yesShares),
            no_shares: text(p.noShares),
            taker_bought_shares: text(p.takerBoughtShares),
            redeemed_payout_micros: text(p.redeemedPayoutMicros),
          })),
        ),
        asOf,
      ],
    );
  const digests = keys(projection.digests, selection?.digests);
  if (digests.length)
    await db.query(
      `INSERT INTO chain.quote_digests(deployment_id,digest,state,market_id,taker,side,quantity,price_bps,
         taker_cost_micros,maker_cost_micros,block_number,block_hash,tx_hash)
       SELECT $1, decode(x.digest,'hex'), x.state, x.market_id::numeric, decode(x.taker,'hex'), x.side,
         x.quantity::numeric, x.price_bps, x.taker_cost::numeric, x.maker_cost::numeric, x.block_number::numeric,
         decode(x.block_hash,'hex'), decode(x.tx_hash,'hex')
       FROM jsonb_to_recordset($2::jsonb) AS x(digest text, state text, market_id text, taker text, side text,
         quantity text, price_bps integer, taker_cost text, maker_cost text, block_number text, block_hash text,
         tx_hash text)
       ON CONFLICT (deployment_id, digest) DO UPDATE SET
         state=EXCLUDED.state, market_id=EXCLUDED.market_id, taker=EXCLUDED.taker, side=EXCLUDED.side,
         quantity=EXCLUDED.quantity, price_bps=EXCLUDED.price_bps,
         taker_cost_micros=EXCLUDED.taker_cost_micros, maker_cost_micros=EXCLUDED.maker_cost_micros,
         block_number=EXCLUDED.block_number, block_hash=EXCLUDED.block_hash, tx_hash=EXCLUDED.tx_hash`,
      [
        deploymentId,
        JSON.stringify(
          digests.map((d) => ({
            digest: bare(d.digest),
            state: d.state,
            market_id: d.marketId,
            taker: d.taker && bare(d.taker),
            side: d.side,
            quantity: text(d.quantity),
            price_bps: d.priceBps,
            taker_cost: text(d.takerCostMicros),
            maker_cost: text(d.makerCostMicros),
            block_number: text(d.blockNumber),
            block_hash: bare(d.blockHash),
            tx_hash: bare(d.txHash),
          })),
        ),
      ],
    );
  const takers = selection
    ? selection.takers.map(
        (account) => [account, projection.takers.get(account)!] as const,
      )
    : [...projection.takers];
  if (takers.length)
    await db.query(
      `INSERT INTO chain.takers(deployment_id,account,allowed,as_of_block_hash)
       SELECT $1, decode(x.account,'hex'), x.allowed, decode($3,'hex')
       FROM jsonb_to_recordset($2::jsonb) AS x(account text, allowed boolean)
       ON CONFLICT (deployment_id, account) DO UPDATE SET
         allowed=EXCLUDED.allowed, as_of_block_hash=EXCLUDED.as_of_block_hash`,
      [
        deploymentId,
        JSON.stringify(
          takers.map(([account, allowed]) => ({
            account: bare(account),
            allowed,
          })),
        ),
        asOf,
      ],
    );
  if (!selection || selection.maker)
    await db.query(
      `INSERT INTO chain.maker_state(deployment_id,free_balance_micros,epoch,global_paused,as_of_block_hash)
       VALUES ($1,$2,$3,$4,decode($5,'hex'))
       ON CONFLICT (deployment_id) DO UPDATE SET
         free_balance_micros=EXCLUDED.free_balance_micros, epoch=EXCLUDED.epoch,
         global_paused=EXCLUDED.global_paused, as_of_block_hash=EXCLUDED.as_of_block_hash`,
      [
        deploymentId,
        projection.maker.freeMicros.toString(),
        projection.maker.epoch.toString(),
        projection.maker.globalPaused,
        asOf,
      ],
    );
}

async function clearProjection(db: Db, deploymentId: string) {
  for (const table of [
    "markets",
    "positions",
    "quote_digests",
    "takers",
    "maker_state",
  ])
    await db.query(`DELETE FROM chain.${table} WHERE deployment_id=$1`, [
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
  events: readonly DecodedEvent[],
) {
  if (!events.length) return;
  await db.query(
    `INSERT INTO chain.events(deployment_id,block_hash,block_number,tx_hash,tx_index,log_index,name,args,canonical)
     SELECT $1, decode(x.block_hash,'hex'), x.block_number::numeric, decode(x.tx_hash,'hex'), x.tx_index,
       x.log_index, x.name, x.args, true
     FROM jsonb_to_recordset($2::jsonb) AS x(block_hash text, block_number text, tx_hash text, tx_index integer,
       log_index integer, name text, args jsonb)
     ON CONFLICT (deployment_id, block_hash, tx_hash, log_index) DO UPDATE SET canonical=true
       WHERE NOT chain.events.canonical`,
    [
      deploymentId,
      JSON.stringify(
        events.map((e) => ({
          block_hash: bare(e.blockHash),
          block_number: text(e.blockNumber),
          tx_hash: bare(e.txHash),
          tx_index: e.txIndex,
          log_index: e.logIndex,
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

export function postgresChainIndexStore(pool: Pool): ChainIndexStore {
  const uow = createUnitOfWork(pool);
  return {
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
        await db.query(
          `INSERT INTO chain.cursors(deployment_id,block_number,block_hash,block_timestamp,head_number,
             finalized_number,synced_at)
           VALUES ($1,$2,decode($3,'hex'),$4,$5,$6,to_timestamp(0)) ON CONFLICT (deployment_id) DO NOTHING`,
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
          ],
        );
        await db.query(
          `INSERT INTO chain.maker_state(deployment_id,as_of_block_hash)
           VALUES ($1,decode($2,'hex')) ON CONFLICT DO NOTHING`,
          [deploymentId, bare(baseline.hash)],
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
           finalized_number=$9, synced_at=blink.now(), gate_reason=$10`,
          [
            commit.block.number.toString(),
            bare(commit.block.hash),
            commit.block.timestamp.toString(),
            commit.headNumber.toString(),
            commit.finalizedNumber?.toString() ?? null,
            commit.gateReason,
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
              blockNumber: market.createdBlockNumber.toString(),
              txHash: market.createdTxHash,
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
          "head_number=$5, finalized_number=$6, gate_reason=$7, synced_at=blink.now()",
          [
            refresh.headNumber.toString(),
            refresh.finalizedNumber?.toString() ?? null,
            refresh.gateReason,
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
          "UPDATE chain.events SET canonical=false WHERE deployment_id=$1 AND canonical AND block_number>$2",
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

export async function loadChainDeployment(
  pool: Pool,
  deploymentId: string,
): Promise<{ marketAddress: string; deploymentBlock: bigint }> {
  const { rows } = await pool.query<Row>(
    `SELECT encode(market_address,'hex') AS address, manifest->>'deploymentBlock' AS block, enabled
     FROM markets.deployments WHERE id=$1`,
    [deploymentId],
  );
  const row = rows[0];
  if (!row) throw new Error("CHAIN_DEPLOYMENT_NOT_FOUND");
  if (!row.enabled) throw new Error("DEPLOYMENT_DISABLED");
  if (
    typeof row.block !== "string" ||
    !/^\d+$/.test(row.block) ||
    BigInt(row.block) < 1n
  )
    throw new Error("CHAIN_DEPLOYMENT_BLOCK_INVALID");
  return { marketAddress: hx(row.address), deploymentBlock: BigInt(row.block) };
}

export async function assertChainIndexInstalled(pool: Pool) {
  try {
    await pool.query("SELECT deployment_id FROM chain.cursors LIMIT 0");
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
