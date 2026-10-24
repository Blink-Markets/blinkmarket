import type { PoolClient } from "pg";

// Validate the authenticated login, including indirect membership and SET ROLE impersonation.
export async function assertRuntimeRole(
  client: Pick<PoolClient, "query">,
  role: "blink_api" | "blink_worker" | "blink_indexer",
  errorCode: string,
) {
  const { rows } = await client.query<{ allowed: boolean }>(
    `SELECT
    session_user = current_user AND s.rolcanlogin
    AND NOT s.rolsuper AND NOT s.rolcreaterole AND NOT s.rolcreatedb AND NOT s.rolbypassrls
    AND pg_has_role(session_user, $1, 'USAGE')
    AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.oid <> s.oid AND r.rolname <> $1
      AND pg_has_role(session_user, r.oid, 'MEMBER'))
    AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = current_database() AND datdba = s.oid)
    AND NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN
      ('blink','operations','identity','evidence','discovery','markets','chain',
       'budgets','forecasts','resolution','analytics')
      AND has_schema_privilege(session_user, oid, 'CREATE')) AS allowed
    FROM pg_roles s WHERE s.rolname = session_user`,
    [role],
  );
  if (rows[0]?.allowed !== true) throw new Error(errorCode);
}
