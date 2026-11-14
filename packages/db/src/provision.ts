import { ensureAppRole } from "./app-role.js";
import { migrate, pg } from "./index.js";

/**
 * Sets up an empty database for a real deployment: applies the migrations and creates the `routenorth_app` role the
 * services connect as. Adds no demo data (use `pnpm seed` for that). Safe to run again, and run it again after each
 * upgrade so new tables and functions are granted.
 *
 *   DATABASE_URL       owner/admin URL of the database (required)
 *   APP_DB_PASSWORD    password for routenorth_app     (required: there is no default here)
 */
const url = process.env.DATABASE_URL;
const appPassword = process.env.APP_DB_PASSWORD;
if (!url || !appPassword) {
  console.error("Set DATABASE_URL (admin URL of the database) and APP_DB_PASSWORD (the password to give routenorth_app).");
  process.exit(1);
}
await migrate(url);
const pool = new pg.Pool({ connectionString: url });
await ensureAppRole(pool, appPassword);
await pool.end();
console.log("database ready: migrations applied, routenorth_app role granted. Point the API and ingest at it with APP_DATABASE_URL.");
