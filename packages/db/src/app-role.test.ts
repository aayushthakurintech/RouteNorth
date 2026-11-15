import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAppRole } from "./app-role.js";
import { migrate, pg } from "./index.js";

// Needs a Postgres where DATABASE_URL points at a superuser/owner role. Skipped when unset.
const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

// Other suites (ingest, API) connect as routenorth_app with the password "app" and only create the role when it is missing,
// so this test must use the same password and leave it that way.
suite("app role on a new database", () => {
  let admin: pg.Pool;
  let app: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    // Start where a real deployment starts: migrations first, role second, and no role left from an earlier run.
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(ADMIN_URL!);
    // On a new server the role does not exist while the migrations run, so their "grant if the role exists" steps are
    // skipped. Take those grants away so this test starts from that state even when the role is left over from earlier.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN CREATE ROLE routenorth_app LOGIN; END IF;
    END $$`);
    await admin.query("REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM routenorth_app");
    await ensureAppRole(admin, "app");
    const u = new URL(ADMIN_URL!);
    u.username = "routenorth_app";
    u.password = "app";
    app = new pg.Pool({ connectionString: u.toString() });
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("can run every lookup function the sign-up, invite, reset and API-key endpoints call", async () => {
    const rows = (await admin.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef AND NOT has_function_privilege('routenorth_app', p.oid, 'EXECUTE')`)).rows;
    expect(rows).toEqual([]);
  });

  it("answers a GPS key lookup as the app role instead of failing with permission denied", async () => {
    const res = await app.query("SELECT * FROM find_api_key($1)", ["no-such-key-hash"]);
    expect(res.rowCount).toBe(0);
  });

  it("can be run twice", async () => {
    await expect(ensureAppRole(admin, "app")).resolves.toBeUndefined();
  });
});
