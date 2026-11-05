import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, pg, withOrg } from "@routenorth/db";
import type { Reading } from "@routenorth/shared";
import { clearDeviceCache, countOutcome, flushCounters, ingestReading, storeFix } from "./store.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

const fix = (time: string, lat = 43.65, over: Partial<Reading> = {}): Reading => ({
  externalId: "IMEI-1", time, lat, lng: -79.38, speed: 60, heading: 90,
  ignition: true, odometer: null, altitude: null, hdop: null, satellites: null, batteryPct: null, extVoltage: null,
  fuelLevelPct: null, rpm: null, engineHours: null, coolantC: null, signal: null, attributes: {}, ...over,
});
const NOW = new Date("2026-11-02T13:00:00Z");

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
    const stored = await storeFix(app, "traccar", fix("2026-11-02T12:00:00Z"), NOW);
    expect(stored?.orgId).toBe(orgId);
    const rows = await withOrg(app, orgId, (c) => c.query("SELECT 1 FROM positions"));
    expect(rows.rowCount).toBe(1);
  });

  it("drops fixes from unregistered devices", async () => {
    const stored = await storeFix(app, "traccar", { ...fix("2026-11-02T12:00:05Z"), externalId: "UNKNOWN" }, NOW);
    expect(stored).toBeNull();
  });

  it("ignores duplicates and never rewinds the latest position", async () => {
    await storeFix(app, "traccar", fix("2026-11-02T12:10:00Z", 44.0), NOW);
    const older = await storeFix(app, "traccar", fix("2026-11-02T12:05:00Z", 43.0), NOW);
    expect(older).toBeNull();
    const latest = await withOrg(app, orgId, (c) => c.query("SELECT lat FROM latest_positions"));
    expect(latest.rows[0].lat).toBe(44);
    const dup = await storeFix(app, "traccar", fix("2026-11-02T12:10:00Z", 44.0), NOW);
    expect(dup).toBeNull();
  });

  it("keeps a late fix in history without moving the marker, and reports it", async () => {
    const o = await ingestReading(app, "traccar", fix("2026-11-02T12:06:00Z", 43.9), NOW);
    expect(o.kind).toBe("history_only");
    const n = await withOrg(app, orgId, (c) => c.query("SELECT count(*)::int AS n FROM positions WHERE time = '2026-11-02T12:06:00Z'"));
    expect(n.rows[0].n).toBe(1);
  });

  it("refuses impossible positions and counts them by reason", async () => {
    const jump = await ingestReading(app, "traccar", fix("2026-11-02T12:10:10Z", 45.5), NOW);
    expect(jump).toMatchObject({ kind: "rejected", reason: "position_jump" });
    const island = await ingestReading(app, "traccar", fix("2026-11-02T12:10:20Z", 0, { lng: 0 }), NOW);
    expect(island).toMatchObject({ kind: "rejected", reason: "null_island" });
    countOutcome("traccar", jump); countOutcome("traccar", island);
    await flushCounters(app);
    const rows = await withOrg(app, orgId, (c) => c.query("SELECT outcome, n::int FROM ingest_counters ORDER BY outcome"));
    expect(rows.rows).toEqual([{ outcome: "rejected:null_island", n: 1 }, { outcome: "rejected:position_jump", n: 1 }]);
  });

  it("stores sensors and lifts device alarms into events", async () => {
    const o = await ingestReading(app, "traccar", fix("2026-11-02T12:11:00Z", 44.001, {
      satellites: 11, hdop: 0.9, batteryPct: 80, extVoltage: 13.9, fuelLevelPct: 61, rpm: 1500, engineHours: 120.5, signal: 4,
      attributes: { alarm: "hardBraking" },
    }), NOW);
    expect(o.kind).toBe("stored");
    const lp = (await withOrg(app, orgId, (c) => c.query("SELECT satellites, fuel_level_pct, ext_voltage, engine_hours FROM latest_positions"))).rows[0];
    expect(lp).toEqual({ satellites: 11, fuel_level_pct: 61, ext_voltage: 13.9, engine_hours: 120.5 });
    const ev = (await withOrg(app, orgId, (c) => c.query("SELECT kind, severity FROM device_events"))).rows;
    expect(ev).toEqual([{ kind: "harsh_brake", severity: 2 }]);
    // the same alarm delivered twice does not duplicate
    await ingestReading(app, "traccar", fix("2026-11-02T12:11:00Z", 44.001, { attributes: { alarm: "hardBraking" } }), NOW);
    expect((await withOrg(app, orgId, (c) => c.query("SELECT 1 FROM device_events"))).rowCount).toBe(1);
  });

  it("compresses a parked vehicle: no new history row, but last-seen moves", async () => {
    const park = (t: string) => fix(t, 44.001, { speed: 0, ignition: false });
    expect((await ingestReading(app, "traccar", park("2026-11-02T12:20:00Z"), NOW)).kind).toBe("stored");
    const before = (await withOrg(app, orgId, (c) => c.query("SELECT count(*)::int AS n FROM positions"))).rows[0].n;
    expect((await ingestReading(app, "traccar", park("2026-11-02T12:21:00Z"), NOW)).kind).toBe("latest_only");
    expect((await withOrg(app, orgId, (c) => c.query("SELECT count(*)::int AS n FROM positions"))).rows[0].n).toBe(before);
    const lp = (await withOrg(app, orgId, (c) => c.query("SELECT time FROM latest_positions"))).rows[0];
    expect(new Date(lp.time).toISOString()).toBe("2026-11-02T12:21:00.000Z");
  });

  it("caches device lookups but forgets on demand", async () => {
    clearDeviceCache();
    expect((await ingestReading(app, "traccar", fix("2026-11-02T12:30:00Z", 44.002), NOW)).kind).toBe("stored");
  });
});
