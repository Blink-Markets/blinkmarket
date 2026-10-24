import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  IndexedMarketRow,
  MarketListQuery,
  MarketReadStore,
} from "@blink/ports";
import { DeploymentId, Uint256 } from "@blink/schemas";
import { createUnitOfWork } from "./database.js";
import { identityTransaction } from "./identity-store.js";
import { transactionColumns } from "./tx-tracking-store.js";

// The one INDEXER_LAG age rule: the trading gate (RFQ, config, canTrade) judges staleness with it too.
export const indexerStaleSql = (cursor: string) =>
  `${cursor}.synced_at < blink.now()-interval '10 seconds'`;
const columns = `m.deployment_id AS "deploymentId", m.market_id::text AS "marketId", m.mode,
 '0x'||encode(m.spec_hash,'hex') AS "specHash", COALESCE(s.object_uri,m.spec_uri) AS "specUri",
 m.state AS "storedState", CASE WHEN m.state='OPEN' AND extract(epoch FROM blink.now()) >= m.close_at THEN 'CLOSED' ELSE m.state END AS "effectiveState",
 (m.paused OR COALESCE(ms.global_paused,false)) AS paused,
 m.created_block_number::text AS "createdBlockNumber",
 m.proposed_outcome AS "proposedOutcome",m.final_outcome AS "finalOutcome",
 '0x'||encode(m.proposal_evidence_hash,'hex') AS "proposalEvidenceHash",'0x'||encode(m.final_evidence_hash,'hex') AS "finalEvidenceHash",
 m.proposed_at::text AS "proposedAt",m.challenge_seconds AS "challengeSeconds",m.hard_deadline::text AS "hardDeadline",
 CASE WHEN c.deployment_id IS NULL THEN NULL ELSE json_build_object('blockNumber',c.block_number::text,'blockHash','0x'||encode(c.block_hash,'hex'),
 'finalizedNumber',c.finalized_number::text,'gateReason',c.gate_reason,'stale',${indexerStaleSql("c")}) END AS cursor`;
const joins = `FROM chain.markets m LEFT JOIN markets.specs s ON s.hash=m.spec_hash
 LEFT JOIN chain.cursors c ON c.deployment_id=m.deployment_id LEFT JOIN chain.maker_state ms ON ms.deployment_id=m.deployment_id`;
const order = `m.created_block_number DESC,m.deployment_id COLLATE "C",m.market_id DESC`;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Anchor = { b: string; d: string; m: string; f: string };
function decodeCursor(cursor: string | undefined, f: string): Anchor | null {
  if (cursor === undefined) return null;
  try {
    const a = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as Anchor;
    if (
      Object.keys(a).sort().join(",") !== "b,d,f,m" ||
      a.f !== f ||
      !Uint256.safeParse(a.b).success ||
      !Uint256.safeParse(a.m).success ||
      a.m === "0" ||
      !DeploymentId.safeParse(a.d).success ||
      Buffer.from(JSON.stringify(a)).toString("base64url") !== cursor
    )
      throw new Error();
    return a;
  } catch {
    throw new Error("INVALID_CURSOR");
  }
}
export function postgresMarketReadStore(pool: Pool): MarketReadStore {
  const uow = createUnitOfWork(pool);
  async function page(query: MarketListQuery, wallet?: string) {
    const filters = {
      deploymentId: query.deploymentId ?? null,
      mode: query.mode ?? null,
      status: query.status ?? null,
      ...(wallet ? { wallet } : {}),
    };
    const f = digest(filters),
      a = decodeCursor(query.cursor, f);
    const params: unknown[] = [];
    const bind = (v: unknown) => {
      params.push(v);
      return "$" + params.length;
    };
    const where: string[] = [];
    if (query.deploymentId !== undefined)
      where.push(`m.deployment_id=${bind(query.deploymentId)}`);
    if (query.mode !== undefined) where.push(`m.mode=${bind(query.mode)}`);
    if (query.status !== undefined)
      where.push(
        `(CASE WHEN m.state='OPEN' AND extract(epoch FROM blink.now())>=m.close_at THEN 'CLOSED' ELSE m.state END)=${bind(query.status)}`,
      );
    const positionJoin = wallet
      ? ` JOIN chain.positions p ON p.deployment_id=m.deployment_id AND p.market_id=m.market_id AND p.account=decode(${bind(wallet.slice(2))},'hex')`
      : "";
    if (wallet) where.push("(p.yes_shares+p.no_shares > 0)");
    const filtered = where.length ? where.join(" AND ") : "true";
    if (a) {
      // The anchor must exist inside the same filter set; this rejects edited cursors.
      const base = params.length;
      const anchor = await pool.query(
        `SELECT 1 ${joins}${positionJoin} WHERE ${filtered} AND m.created_block_number=${bind(a.b)} AND m.deployment_id=${bind(a.d)} AND m.market_id=${bind(a.m)}`,
        params,
      );
      if (!anchor.rows.length) throw new Error("INVALID_CURSOR");
      params.length = base;
      const b = bind(a.b),
        d = bind(a.d),
        m = bind(a.m);
      where.push(
        `(m.created_block_number<${b} OR (m.created_block_number=${b} AND (m.deployment_id COLLATE "C">${d} OR (m.deployment_id=${d} AND m.market_id<${m}))))`,
      );
    }
    const limit = query.limit ?? 20;
    const extra = wallet
      ? `,p.yes_shares::text AS "yesShares",p.no_shares::text AS "noShares", ARRAY(SELECT t.id::text FROM chain.transactions t WHERE t.deployment_id=m.deployment_id AND t.market_id=m.market_id AND t.wallet=p.account AND t.status='UNKNOWN' ORDER BY t.id) AS "pendingIntentIds"`
      : "";
    const result = await pool.query<
      IndexedMarketRow & {
        yesShares: string;
        noShares: string;
        pendingIntentIds: string[];
      }
    >(
      `SELECT ${columns}${extra} ${joins}${positionJoin} WHERE ${where.length ? where.join(" AND ") : "true"} ORDER BY ${order} LIMIT ${bind(limit + 1)}`,
      params,
    );
    const items = result.rows.slice(0, limit),
      last = items.at(-1);
    const nextCursor =
      result.rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              b: last.createdBlockNumber,
              d: last.deploymentId,
              m: last.marketId,
              f,
            }),
          ).toString("base64url")
        : null;
    return { items, nextCursor };
  }
  return {
    list: (query) => page(query),
    async market(deployment, id) {
      return (
        (
          await pool.query<IndexedMarketRow>(
            `SELECT ${columns} ${joins} WHERE m.deployment_id=$1 AND m.market_id=$2`,
            [deployment, id],
          )
        ).rows[0] ?? null
      );
    },
    async positions(deployment, wallet, query) {
      const p = await page({ ...query, deploymentId: deployment }, wallet);
      return {
        nextCursor: p.nextCursor,
        items: p.items.map((m) => ({
          market: m,
          yesShares: m.yesShares,
          noShares: m.noShares,
          pendingIntentIds: m.pendingIntentIds,
        })),
      };
    },
    async integrityFailure(m, requestId) {
      await pool.query(
        `INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES ($1,'public-read','spec.integrity_failed',$2,'Archived spec unavailable or failed integrity validation',$3)`,
        [randomUUID(), m.deploymentId + ":" + m.marketId, requestId],
      );
    },
    async hint(principal, body, key) {
      return uow.run(async (context) => {
        const db = uow.client(context),
          tx = identityTransaction(db);
        const current = await tx.key(principal.keyId);
        if (
          !current ||
          current.revokedAt ||
          current.expiresAt <= (await tx.now())
        )
          throw new Error("UNAUTHORIZED");
        const scope = "POST /v1/transactions";
        const claim = await tx.claimRequest(
          principal.operatorId,
          scope,
          key,
          digest({ keyId: principal.keyId, body }),
        );
        if (claim.state === "DONE") return claim.result;
        if (claim.state === "CONFLICT") throw new Error("IDEMPOTENCY_CONFLICT");
        if (claim.state === "BUSY") throw new Error("REQUEST_IN_PROGRESS");
        const wallet = await tx.wallet(principal.agentId);
        let result;
        if (!wallet)
          result = {
            status: 403,
            body: {
              code: "WALLET_NOT_VERIFIED",
              message: "WALLET_NOT_VERIFIED",
              retryable: false,
              details: {},
            },
          };
        else if (
          !(
            await db.query("SELECT id FROM markets.deployments WHERE id=$1", [
              body.deploymentId,
            ])
          ).rows.length
        )
          result = {
            status: 404,
            body: {
              code: "NOT_FOUND",
              message: "NOT_FOUND",
              retryable: false,
              details: {},
            },
          };
        else {
          await db.query(
            `INSERT INTO chain.transactions(id,deployment_id,tx_hash,agent_id,wallet,action,quote_id) VALUES ($1,$2,decode($3,'hex'),$4,decode($5,'hex'),$6,decode($7,'hex')) ON CONFLICT (deployment_id,tx_hash) DO NOTHING`,
            [
              randomUUID(),
              body.deploymentId,
              body.txHash.slice(2),
              principal.agentId,
              wallet.slice(2),
              body.action,
              body.quoteId?.slice(2) ?? null,
            ],
          );
          const row = (
            await db.query<{ id: string; agent_id: string }>(
              "SELECT id,agent_id FROM chain.transactions WHERE deployment_id=$1 AND tx_hash=decode($2,'hex')",
              [body.deploymentId, body.txHash.slice(2)],
            )
          ).rows[0]!;
          result =
            row.agent_id === principal.agentId
              ? { status: 202, body: { trackingId: row.id, status: "UNKNOWN" } }
              : {
                  status: 409,
                  body: {
                    code: "TX_ALREADY_TRACKED",
                    message: "TX_ALREADY_TRACKED",
                    retryable: false,
                    details: {},
                  },
                };
        }
        await tx.finishRequest(principal.operatorId, scope, key, result);
        return result;
      });
    },
    async transaction(deployment, hash) {
      const row = (
        await pool.query(
          `SELECT ${transactionColumns},c.finalized_number::text AS finalized FROM chain.transactions t LEFT JOIN chain.cursors c ON c.deployment_id=t.deployment_id WHERE t.deployment_id=$1 AND t.tx_hash=decode($2,'hex')`,
          [deployment, hash.slice(2)],
        )
      ).rows[0];
      if (!row) return null;
      return {
        ...row,
        chainCursor: row.receiptBlockHash
          ? {
              blockNumber: row.receiptBlockNumber,
              blockHash: row.receiptBlockHash,
              finality:
                row.status === "REORGED"
                  ? "UNKNOWN"
                  : row.status === "FINALIZED"
                    ? "FINALIZED"
                    : row.finalized === null
                      ? "UNKNOWN"
                      : "INCLUDED",
            }
          : null,
      } as Awaited<ReturnType<MarketReadStore["transaction"]>>;
    },
  };
}
