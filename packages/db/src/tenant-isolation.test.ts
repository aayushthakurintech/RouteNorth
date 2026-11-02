import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, pg, withOrg } from "./index.js";

// Needs a Postgres where DATABASE_URL points at a superuser/owner role.
// Skipped when unset so `pnpm test` still works without a database.
const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

suite("tenant isolation (Row-Level Security)", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let orgA = "";
  let orgB = "";
  let deviceA = "";

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await migrate(ADMIN_URL!);

    // The API connects as a plain role: not a superuser, so RLS cannot be bypassed.
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
        CREATE ROLE routenorth_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$;`);
    await admin.query("GRANT USAGE ON SCHEMA public TO routenorth_app");
    await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO routenorth_app");
    const u = new URL(ADMIN_URL!);
    u.username = "routenorth_app";
    u.password = "app";
    app = new pg.Pool({ connectionString: u.toString() });

    orgA = (await admin.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await admin.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;

    await withOrg(app, orgA, async (c) => {
      deviceA = (
        await c.query(
          "INSERT INTO devices (org_id, source, external_id) VALUES ($1,'simulator','sim-a') RETURNING id",
          [orgA],
        )
      ).rows[0].id;
      await c.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Truck A1')", [orgA]);
      await c.query(
        "INSERT INTO positions (time, org_id, device_id, lat, lng, speed) VALUES (now(), $1, $2, 43.65, -79.38, 50)",
        [orgA, deviceA],
      );
    });
    await withOrg(app, orgB, (c) =>
      c.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Bus B1')", [orgB]),
    );
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("org A only sees its own rows", async () => {
    const vehicles = await withOrg(app, orgA, (c) => c.query("SELECT name FROM vehicles"));
    expect(vehicles.rows.map((r) => r.name)).toEqual(["Truck A1"]);
    const positions = await withOrg(app, orgA, (c) => c.query("SELECT 1 FROM positions"));
    expect(positions.rowCount).toBe(1);
  });

  it("org B cannot read org A's positions or devices", async () => {
    const positions = await withOrg(app, orgB, (c) => c.query("SELECT 1 FROM positions"));
    expect(positions.rowCount).toBe(0);
    const devices = await withOrg(app, orgB, (c) => c.query("SELECT 1 FROM devices"));
    expect(devices.rowCount).toBe(0);
  });

  it("org B cannot insert rows for org A", async () => {
    await expect(
      withOrg(app, orgB, (c) =>
        c.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Hijack')", [orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("org B cannot update or delete org A's rows", async () => {
    const upd = await withOrg(app, orgB, (c) => c.query("UPDATE vehicles SET name = 'x' WHERE name = 'Truck A1'"));
    expect(upd.rowCount).toBe(0);
    const del = await withOrg(app, orgB, (c) => c.query("DELETE FROM positions"));
    expect(del.rowCount).toBe(0);
  });

  it("a connection with no org set sees nothing", async () => {
    const res = await app.query("SELECT 1 FROM vehicles");
    expect(res.rowCount).toBe(0);
  });
});
