import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, pg, withOrg } from "@routenorth/db";
import { storeFix } from "./store.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

const fix = (time: string, lat = 43.65) => ({
  externalId: "IMEI-1", time, lat, lng: -79.38, speed: 60, heading: 90,
  ignition: true, odometer: null, attributes: {},
});

suite("storeFix", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let orgId = "";

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
        CREATE ROLE routenorth_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
      END IF; END $$;`);
    await migrate(ADMIN_URL!);
    await admin.query("GRANT USAGE ON SCHEMA public TO routenorth_app");
    await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO routenorth_app");
    const u = new URL(ADMIN_URL!);
    u.username = "routenorth_app";
    u.password = "app";
    app = new pg.Pool({ connectionString: u.toString() });

    orgId = (await admin.query("INSERT INTO organizations (name) VALUES ('Acme') RETURNING id")).rows[0].id;
    await withOrg(app, orgId, (c) =>
      c.query("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'traccar','IMEI-1')", [orgId]),
    );
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("stores a fix for a registered device", async () => {
    const stored = await storeFix(app, "traccar", fix("2026-11-02T12:00:00Z"));
    expect(stored?.orgId).toBe(orgId);
    const rows = await withOrg(app, orgId, (c) => c.query("SELECT 1 FROM positions"));
    expect(rows.rowCount).toBe(1);
  });

  it("drops fixes from unregistered devices", async () => {
    const stored = await storeFix(app, "traccar", { ...fix("2026-11-02T12:00:05Z"), externalId: "UNKNOWN" });
    expect(stored).toBeNull();
  });

  it("ignores duplicates and never rewinds the latest position", async () => {
    await storeFix(app, "traccar", fix("2026-11-02T12:10:00Z", 44.0));
    const older = await storeFix(app, "traccar", fix("2026-11-02T12:05:00Z", 43.0));
    expect(older).toBeNull();
    const latest = await withOrg(app, orgId, (c) => c.query("SELECT lat FROM latest_positions"));
    expect(latest.rows[0].lat).toBe(44);
    const dup = await storeFix(app, "traccar", fix("2026-11-02T12:10:00Z", 44.0));
    expect(dup).toBeNull();
  });
});
