import { migratePostgres } from "../packages/adapters/src/migrations.js";
const url = process.env["DATABASE_URL"];
if (!url)
  throw new Error(
    "Set DATABASE_URL to an explicitly selected development database; no default target.",
  );
console.log(await migratePostgres(url));
