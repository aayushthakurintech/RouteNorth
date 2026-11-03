import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, pg, withOrg } from "@routenorth/db";
import { updateGeofences } from "./geofence.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

suite("geofence detection", () => {
  let admin: pg.Pool, app: pg.Pool, orgId = "", deviceId = "";
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
      CREATE ROLE routenorth_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    await migrate(ADMIN_URL!);
    await admin.query("GRANT USAGE ON SCHEMA public TO routenorth_app");
    await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO routenorth_app");
    const u = new URL(ADMIN_URL!); u.username = "routenorth_app"; u.password = "app";
    app = new pg.Pool({ connectionString: u.toString() });
    orgId = (await admin.query("INSERT INTO organizations (name) VALUES ('Acme') RETURNING id")).rows[0].id;
    deviceId = (await admin.query("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'traccar','G1') RETURNING id", [orgId])).rows[0].id;
    await withOrg(app, orgId, async (c) => {
      await c.query("INSERT INTO geofences (org_id, name, shape, lat, lng, radius_m) VALUES ($1,'Depot','circle',43.65,-79.38,300)", [orgId]);
      await c.query("INSERT INTO geofences (org_id, name, shape, polygon, active) VALUES ($1,'Zone','polygon',$2,true)", [orgId, JSON.stringify([[43.7, -79.5], [43.7, -79.4], [43.8, -79.4], [43.8, -79.5]])]);
      await c.query("INSERT INTO geofences (org_id, name, shape, lat, lng, radius_m, active) VALUES ($1,'Off','circle',43.65,-79.38,300,false)", [orgId]);
    });
  });
  afterAll(async () => { await app?.end(); await admin?.end(); });

  const at = (m: number, lat: number, lng: number) => ({ orgId, deviceId, time: new Date(Date.UTC(2026, 6, 1, 12, m)).toISOString(), lat, lng, speed: 30, heading: 0, ignition: true });

  it("sets a starting state silently, then records enter and exit", async () => {
    expect(await updateGeofences(app, at(0, 43.65, -79.38))).toEqual([]); // parked in the depot at start of day
    expect(await updateGeofences(app, at(1, 43.651, -79.38))).toEqual([]); // still inside
    const out = await updateGeofences(app, at(2, 43.60, -79.38));
    expect(out.map((e) => [e.name, e.kind])).toEqual([["Depot", "exit"]]);
    const back = await updateGeofences(app, at(3, 43.65, -79.38));
    expect(back.map((e) => [e.name, e.kind])).toEqual([["Depot", "enter"]]);
    const zone = await updateGeofences(app, at(4, 43.75, -79.45));
    expect(zone.map((e) => `${e.name} ${e.kind}`).sort()).toEqual(["Depot exit", "Zone enter"]);
  });

  it("stores events for the alert engine and ignores inactive fences", async () => {
    const rows = (await withOrg(app, orgId, (c) => c.query("SELECT g.name, e.kind FROM geofence_events e JOIN geofences g ON g.id = e.geofence_id ORDER BY e.at, g.name"))).rows;
    expect(rows.length).toBe(4);
    expect(rows.some((r) => r.name === "Off")).toBe(false);
  });
});
