import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createUnitOfWork } from "./database.js";

export const quoteGateReasons = [
  "OUTCOME_KNOWN",
  "ANNOUNCEMENT_EARLY",
  "OPERATOR_PAUSE",
  "SPEC_INTEGRITY",
] as const;
export type QuoteGateReason = (typeof quoteGateReasons)[number];
export interface QuoteGateInput {
  deploymentId: string;
  marketId: string;
  reason: QuoteGateReason;
  note: string;
}

export async function assertTradingAdminRole(pool: Pool) {
  const result =
    await pool.query(`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
  AND pg_has_role(current_user,'blink_trading_admin','USAGE') AS allowed FROM pg_roles WHERE rolname=current_user`);
  if (result.rows[0]?.allowed !== true)
    throw new Error("UNSAFE_TRADING_ADMIN_DATABASE_ROLE");
}

function valid(input: QuoteGateInput) {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(input.deploymentId) ||
    !/^[1-9][0-9]{0,77}$/.test(input.marketId) ||
    !(quoteGateReasons as readonly string[]).includes(input.reason) ||
    input.note.trim().length === 0 ||
    input.note.length > 4000
  )
    throw new Error("INVALID_QUOTE_GATE");
}

/** Operators close and reopen a market's quoting by hand; every change is audited. */
export function tradingAdmin(pool: Pool) {
  const uow = createUnitOfWork(pool);
  const audit = (
    db: ReturnType<typeof uow.client>,
    action: string,
    input: QuoteGateInput,
  ) =>
    db.query(
      "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,current_user,$2,$3,$4,$5)",
      [
        randomUUID(),
        action,
        `${input.deploymentId}:${input.marketId}:${input.reason}`,
        input.note,
        randomUUID(),
      ],
    );
  return {
    /** Fails when this reason is already closed for the market. */
    async closeGate(input: QuoteGateInput) {
      valid(input);
      return uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const gateId = randomUUID();
        await db.query(
          `INSERT INTO trading.quote_gates(id,deployment_id,market_id,reason,actor,note)
          VALUES($1,$2,$3,$4,current_user,$5)`,
          [
            gateId,
            input.deploymentId,
            input.marketId,
            input.reason,
            input.note,
          ],
        );
        await audit(db, "trading.gate_closed", input);
        return { gateId };
      });
    },
    /** Fails when no such gate is closed. */
    async reopenGate(input: QuoteGateInput) {
      valid(input);
      return uow.run(async (ctx) => {
        const db = uow.client(ctx);
        const { rows } = await db.query(
          `UPDATE trading.quote_gates SET reopened_at=blink.now(), reopened_by=current_user
          WHERE deployment_id=$1 AND market_id=$2 AND reason=$3 AND reopened_at IS NULL RETURNING id`,
          [input.deploymentId, input.marketId, input.reason],
        );
        if (!rows[0]) throw new Error("QUOTE_GATE_NOT_CLOSED");
        await audit(db, "trading.gate_reopened", input);
        return { gateId: String(rows[0].id) };
      });
    },
  };
}
