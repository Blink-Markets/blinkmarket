import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { createUnitOfWork } from "./database.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: string) => value.trim().length > 0 && value.length <= 4000;
export async function assertForecastAdminRole(pool: Pool) {
  const result =
    await pool.query(`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
  AND pg_has_role(current_user,'blink_forecast_admin','USAGE') AS allowed FROM pg_roles WHERE rolname=current_user`);
  if (result.rows[0]?.allowed !== true)
    throw new Error("UNSAFE_FORECAST_ADMIN_DATABASE_ROLE");
}
export function forecastAdmin(pool: Pool) {
  const uow = createUnitOfWork(pool);
  return {
    async annotate(input: {
      submissionId: string;
      kind: "WITHDRAWN" | "OUTCOME_ALREADY_PUBLIC" | "WINDOW_CONTAMINATED";
      reason: string;
    }) {
      if (
        !uuid.test(input.submissionId) ||
        ![
          "WITHDRAWN",
          "OUTCOME_ALREADY_PUBLIC",
          "WINDOW_CONTAMINATED",
        ].includes(input.kind) ||
        !text(input.reason)
      )
        throw new Error("INVALID_FORECAST_ANNOTATION");
      return uow.run(async (ctx) => {
        const db = uow.client(ctx),
          annotationId = randomUUID();
        await db.query(
          "INSERT INTO forecasts.annotations(id,submission_id,kind,reason,actor) VALUES($1,$2,$3,$4,current_user)",
          [annotationId, input.submissionId, input.kind, input.reason],
        );
        await db.query(
          "INSERT INTO operations.audit_log(id,actor,action,resource,reason,request_id) VALUES($1,current_user,'forecast.annotated',$2,$3,$4)",
          [randomUUID(), input.submissionId, input.reason, randomUUID()],
        );
        return { annotationId };
      });
    },
  };
}
