import type { pg } from "./index.js";

/**
 * Creates the low-privilege `routenorth_app` role the services connect as (so Row-Level Security applies) and gives it
 * what it needs. Run it after the migrations, as the database owner. Safe to run again.
 *
 * Why the grants are here and not only in the migrations: a migration can grant to the role only if the role already
 * exists, and on a new database it does not yet. So the functions that sign-up, invites, password reset, API keys and
 * GPS feed keys depend on were left without a grant, and those endpoints answered 500 on a database set up with
 * `pnpm seed`. Granting on every function in the schema closes that for functions added later too.
 */
export async function ensureAppRole(pool: pg.Pool, password: string): Promise<void> {
  const q = (text: string) => pool.query(text);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
      CREATE ROLE routenorth_app LOGIN;
    END IF;
  END $$`);
  await q(`ALTER ROLE routenorth_app PASSWORD '${password.replace(/'/g, "''")}'`);
  await q("GRANT USAGE ON SCHEMA public TO routenorth_app");
  await q("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO routenorth_app");
  await q("GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO routenorth_app");
  await q("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO routenorth_app");
}
