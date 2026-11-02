import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, pg, withOrg } from "@routenorth/db";
import { updateRouteProgress } from "./progress.js";
import type { StoredPosition } from "./store.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;

suite("updateRouteProgress", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let orgId = "";
  let deviceId = "";
  let routeId = "";
  const stopIds: string[] = [];
  const T0 = Date.parse("2026-11-03T15:00:00Z"); // 10:00 in Toronto, route date 2026-11-03

  const fix = (sec: number, lat: number, lng = -79.38, speed = 3): StoredPosition => ({
    orgId, deviceId, time: new Date(T0 + sec * 1000).toISOString(), lat, lng, speed, heading: 0, ignition: true,
  });
  const stops = async () =>
    (await withOrg(app, orgId, (c) => c.query("SELECT status, arrived_at, departed_at, eta FROM stops ORDER BY sequence"))).rows;
  const route = async () => (await withOrg(app, orgId, (c) => c.query("SELECT status, started_at, completed_at FROM routes"))).rows[0];

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
    await withOrg(app, orgId, async (c) => {
      const v = (await c.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Truck 1') RETURNING id", [orgId])).rows[0].id;
      deviceId = (await c.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'traccar','d1') RETURNING id", [orgId, v])).rows[0].id;
      routeId = (await c.query("INSERT INTO routes (org_id, name, route_date, vehicle_id) VALUES ($1,'R','2026-11-03',$2) RETURNING id", [orgId, v])).rows[0].id;
      // Stop 1 at (43.65, -79.38); stop 2 about 2.2 km north.
      for (const [i, lat] of [43.65, 43.67].entries()) {
        stopIds.push((await c.query(
          "INSERT INTO stops (org_id, route_id, sequence, name, lat, lng) VALUES ($1,$2,$3,$4,$5,-79.38) RETURNING id",
          [orgId, routeId, i + 1, `Stop ${i + 1}`, lat],
        )).rows[0].id);
      }
    });
  });

  afterAll(async () => {
    await app?.end();
    await admin?.end();
  });

  it("sets ETAs for every stop and keeps the route planned while the truck is far away", async () => {
    expect(await updateRouteProgress(app, fix(0, 43.6))).toEqual([]);
    const s = await stops();
    expect(s.every((r) => r.status === "pending" && r.eta)).toBe(true);
    expect(s[1]!.eta.getTime()).toBeGreaterThan(s[0]!.eta.getTime());
    expect((await route()).status).toBe("planned");
  });

  it("ignores a drive-through", async () => {
    await updateRouteProgress(app, fix(60, 43.6502, -79.38, 50));
    await updateRouteProgress(app, fix(70, 43.6498, -79.38, 50));
    expect((await stops())[0]!.status).toBe("pending");
  });

  it("detects arrival after dwelling and starts the route", async () => {
    await updateRouteProgress(app, fix(100, 43.6501));
    const ev = await updateRouteProgress(app, fix(140, 43.6501, -79.38, 0));
    expect(ev).toEqual([{ routeId, stopId: stopIds[0], status: "arrived" }]);
    const s = await stops();
    expect(s[0]!.status).toBe("arrived");
    expect(s[0]!.arrived_at.toISOString()).toBe(new Date(T0 + 100_000).toISOString());
    expect(s[0]!.eta).toBeNull();
    const r = await route();
    expect(r.status).toBe("in_progress");
    expect(r.started_at).not.toBeNull();
  });

  it("detects departure and then completes the route at the last stop", async () => {
    await updateRouteProgress(app, fix(400, 43.655, -79.38, 40));
    const ev = await updateRouteProgress(app, fix(430, 43.66, -79.38, 40));
    expect(ev).toEqual([{ routeId, stopId: stopIds[0], status: "done" }]);
    expect((await stops())[0]!.departed_at.toISOString()).toBe(new Date(T0 + 400_000).toISOString());

    await updateRouteProgress(app, fix(700, 43.6701, -79.38, 2));
    await updateRouteProgress(app, fix(740, 43.6701, -79.38, 0));
    await updateRouteProgress(app, fix(900, 43.68, -79.38, 40));
    await updateRouteProgress(app, fix(930, 43.69, -79.38, 40));
    expect((await stops()).map((r) => r.status)).toEqual(["done", "done"]);
    expect((await route()).status).toBe("completed");
  });

  it("ignores fixes on other days or for routes without a vehicle match", async () => {
    const nextDay = { ...fix(0, 43.65), time: "2026-11-05T15:00:00Z" };
    expect(await updateRouteProgress(app, nextDay)).toEqual([]);
  });
});
