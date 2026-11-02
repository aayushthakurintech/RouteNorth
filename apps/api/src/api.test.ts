import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { Test } from "@nestjs/testing";
import { migrate, pg, withOrg } from "@routenorth/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AppModule } from "./app.module.js";
import { MemoryPositionBus } from "./live/position-bus.js";
import { hashPassword } from "./passwords.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const SECRET = "test-secret-test-secret-test-secret-123";

suite("API", () => {
  let admin: pg.Pool;
  let app: pg.Pool;
  let nest: INestApplication;
  let bus: MemoryPositionBus;
  let port = 0;
  let orgA = "";
  let orgB = "";
  const devices: Record<string, string> = {};

  const login = async (email: string, password = "pw-correct-horse") =>
    request(nest.getHttpServer()).post("/auth/login").send({ email, password });

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

    orgA = (await admin.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await admin.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
    const hash = await hashPassword("pw-correct-horse");
    await admin.query(
      "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'a@example.com',$3,'owner'),($2,'b@example.com',$3,'viewer')",
      [orgA, orgB, hash],
    );
    for (const [org, name, ext] of [[orgA, "Truck A1", "dev-a"], [orgB, "Bus B1", "dev-b"]] as const) {
      await withOrg(app, org, async (c) => {
        const v = (await c.query("INSERT INTO vehicles (org_id, name, kind) VALUES ($1,$2,'truck') RETURNING id", [org, name])).rows[0].id;
        const d = (await c.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator',$3) RETURNING id", [org, v, ext])).rows[0].id;
        devices[ext] = d;
        await c.query(
          "INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2,now(),43.65,-79.38,50,90,true)",
          [d, org],
        );
      });
    }

    // History for org A's device: 10 min driving east at 60 km/h, 20 min idling, 5 min driving, then parked.
    {
      let ms = Date.parse("2026-10-15T12:00:00Z");
      let lng = -79.5;
      const rows: unknown[][] = [];
      const add = (speed: number, ign: boolean) => rows.push([new Date(ms).toISOString(), orgA, devices["dev-a"], 43.65, lng, speed, ign]);
      const drive = (min: number) => { for (let s = 0; s < min * 60; s += 10) { lng += (60 / 3.6) * 10 / 80_500; ms += 10_000; add(60, true); } };
      const park = (min: number, ign: boolean) => { for (let s = 0; s < min * 60; s += 10) { ms += 10_000; add(0, ign); } };
      drive(10); park(20, true); drive(5); park(15, false);
      await withOrg(app, orgA, async (c) => {
        for (const r of rows) {
          await c.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES ($1,$2,$3,$4,$5,$6,$7)", r);
        }
      });
    }

    bus = new MemoryPositionBus();
    const mod = await Test.createTestingModule({
      imports: [AppModule.register({ pool: app, bus, jwtSecret: SECRET })],
    }).compile();
    nest = mod.createNestApplication();
    nest.useWebSocketAdapter(new WsAdapter(nest));
    await nest.listen(0);
    port = (nest.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    await nest?.close();
    await app?.end();
    await admin?.end();
  });

  it("logs in with correct credentials", async () => {
    const res = await login("a@example.com");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.orgId).toBe(orgA);
    expect(res.body.user.role).toBe("owner");
  });

  it("rejects wrong passwords and unknown users the same way", async () => {
    const wrong = await login("a@example.com", "nope");
    const unknown = await login("nobody@example.com");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("requires a token for live vehicles", async () => {
    expect((await request(nest.getHttpServer()).get("/vehicles/live")).status).toBe(401);
    const bad = await request(nest.getHttpServer()).get("/vehicles/live").set("Authorization", "Bearer garbage");
    expect(bad.status).toBe(401);
  });

  it("returns only the caller's organization's vehicles", async () => {
    const { token } = (await login("a@example.com")).body;
    const res = await request(nest.getHttpServer()).get("/vehicles/live").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.map((v: { name: string }) => v.name)).toEqual(["Truck A1"]);
    expect(res.body[0].status).toBe("moving");

    const other = (await login("b@example.com")).body.token;
    const resB = await request(nest.getHttpServer()).get("/vehicles/live").set("Authorization", `Bearer ${other}`);
    expect(resB.body.map((v: { name: string }) => v.name)).toEqual(["Bus B1"]);
  });

  const connect = (token: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/live?token=${token}`);
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
    });

  it("streams only the caller's organization's positions over WebSocket", async () => {
    const tokenA = (await login("a@example.com")).body.token;
    const tokenB = (await login("b@example.com")).body.token;
    const wsA = await connect(tokenA);
    const wsB = await connect(tokenB);
    const gotA: string[] = [];
    const gotB: string[] = [];
    wsA.on("message", (m) => gotA.push(m.toString()));
    wsB.on("message", (m) => gotB.push(m.toString()));
    await new Promise((r) => setTimeout(r, 100)); // let subscriptions register

    await bus.publish(orgA, JSON.stringify({ deviceId: "x", lat: 1 }));
    await new Promise((r) => setTimeout(r, 100));
    expect(gotA).toHaveLength(1);
    expect(gotB).toHaveLength(0);
    wsA.close();
    wsB.close();
  });

  it("closes WebSocket connections without a valid token", async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://localhost:${port}/live?token=bad`);
      ws.on("close", (c) => resolve(c));
    });
    expect(code).toBe(4401);
  });

  describe("history and reports", () => {
    const Q = "from=2026-10-15T00:00:00Z&to=2026-10-16T00:00:00Z";
    const get = async (path: string, email = "a@example.com") => {
      const { token } = (await login(email)).body;
      return request(nest.getHttpServer()).get(path).set("Authorization", `Bearer ${token}`);
    };

    it("detects two trips and two stops", async () => {
      const res = await get(`/vehicles/${devices["dev-a"]}/trips?${Q}`);
      expect(res.status).toBe(200);
      expect(res.body.trips).toHaveLength(2);
      expect(res.body.trips[0].distanceM).toBeGreaterThan(9_800);
      expect(res.body.trips[0].distanceM).toBeLessThan(10_200);
      expect(res.body.stops.map((s: { idling: boolean }) => s.idling)).toEqual([true, false]);
    });

    it("returns the replay track in time order", async () => {
      const res = await get(`/vehicles/${devices["dev-a"]}/track?${Q}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(300);
      const times = res.body.map((p: { time: string }) => p.time);
      expect([...times].sort()).toEqual(times);
    });

    it("reports daily distance and idle time", async () => {
      const res = await get(`/reports/daily?${Q}&tz=America/Toronto`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("Truck A1");
      expect(res.body[0].date).toBe("2026-10-15");
      expect(res.body[0].distanceM).toBeGreaterThan(14_500);
      expect(res.body[0].idleS).toBeGreaterThan(19 * 60);
    });

    it("reports idle stops", async () => {
      const res = await get(`/reports/idle?${Q}`);
      expect(res.body[0].name).toBe("Truck A1");
      expect(res.body[0].idleStops).toHaveLength(1);
      expect(res.body[0].idleStops[0].durationS).toBeGreaterThan(19 * 60);
    });

    it("does not leak another organization's history", async () => {
      // Org B asks for org A's device: it does not exist from B's point of view.
      expect((await get(`/vehicles/${devices["dev-a"]}/trips?${Q}`, "b@example.com")).status).toBe(404);
      expect((await get(`/vehicles/${devices["dev-a"]}/track?${Q}`, "b@example.com")).status).toBe(404);
      const report = await get(`/reports/daily?${Q}`, "b@example.com");
      expect(report.body).toEqual([]);
    });

    it("validates inputs", async () => {
      expect((await get(`/vehicles/not-a-uuid/trips?${Q}`)).status).toBe(400);
      expect((await get(`/vehicles/${devices["dev-a"]}/trips?from=nope`)).status).toBe(400);
      expect((await get(`/vehicles/${devices["dev-a"]}/trips?from=2026-10-16T00:00:00Z&to=2026-10-15T00:00:00Z`)).status).toBe(400);
      expect((await get(`/reports/daily?from=2026-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`)).status).toBe(400);
      expect((await get(`/reports/daily?${Q}&tz=Mars/Base`)).status).toBe(400);
    });

    it("requires login", async () => {
      expect((await request(nest.getHttpServer()).get(`/reports/idle?${Q}`)).status).toBe(401);
    });
  });

  describe("routes and stops", () => {
    let planner = "";
    const as = async (email: string) => (await login(email)).body.token as string;
    const call = async (method: "get" | "post" | "put" | "patch" | "delete", path: string, token: string, body?: object) => {
      const r = request(nest.getHttpServer())[method](path).set("Authorization", `Bearer ${token}`);
      return body ? r.send(body) : r;
    };
    const stop = (name: string, lat = 43.65, lng = -79.38, extra: object = {}) => ({ name, lat, lng, ...extra });

    beforeAll(async () => {
      planner = await as("a@example.com");
      await admin.query(
        "INSERT INTO users (org_id, email, password_hash, role) VALUES ($1,'dispatch-b@example.com',(SELECT password_hash FROM users WHERE email='a@example.com'),'dispatcher')",
        [orgB],
      );
    });

    it("creates a route with ordered stops and lists it", async () => {
      const res = await call("post", "/routes", planner, {
        name: "Morning run", date: "2026-11-03", vehicleId: undefined,
        stops: [stop("A", 43.65, -79.38, { packages: 3 }), stop("B", 43.66, -79.39), stop("C", 43.67, -79.4, { radiusM: 120 })],
      });
      expect(res.status).toBe(201);
      expect(res.body.stops.map((s: { name: string; sequence: number }) => [s.name, s.sequence])).toEqual([["A", 1], ["B", 2], ["C", 3]]);
      expect(res.body.stops[0].status).toBe("pending");
      expect(res.body.stops[2].radiusM).toBe(120);
      expect(res.body.stops[1].radiusM).toBe(75);

      const list = await call("get", "/routes?date=2026-11-03", planner);
      expect(list.body).toEqual([expect.objectContaining({ name: "Morning run", stopCount: 3, finishedCount: 0 })]);
    });

    it("assigns a vehicle and driver", async () => {
      const veh = (await call("get", "/vehicles/live", planner)).body[0].vehicleId;
      const driver = (await admin.query("SELECT id FROM users WHERE email='a@example.com'")).rows[0].id;
      const res = await call("post", "/routes", planner, { name: "Assigned", date: "2026-11-04", vehicleId: veh, driverId: driver, stops: [] });
      expect(res.status).toBe(201);
      expect(res.body.vehicleId).toBe(veh);
      expect(res.body.driverId).toBe(driver);
    });

    it("imports stops from CSV, including quoted commas", async () => {
      const route = (await call("post", "/routes", planner, { name: "Import", date: "2026-11-05", stops: [] })).body;
      const csv = 'name,address,lat,lng,window_start,window_end,packages\n"Smith, J.","1 Main St, Toronto",43.7,-79.4,2026-11-05T14:00:00Z,2026-11-05T15:00:00Z,4\nWarehouse,,43.6,-79.5,,,0\n';
      const res = await call("post", `/routes/${route.id}/stops/import`, planner, { csv });
      expect(res.status).toBe(201);
      expect(res.body.stops).toHaveLength(2);
      expect(res.body.stops[0]).toMatchObject({ name: "Smith, J.", address: "1 Main St, Toronto", packages: 4, sequence: 1 });
      expect(res.body.stops[0].windowEnd).toBe("2026-11-05T15:00:00.000Z");
    });

    it("reports which CSV row is wrong", async () => {
      const route = (await call("post", "/routes", planner, { name: "Bad import", date: "2026-11-05", stops: [] })).body;
      const res = await call("post", `/routes/${route.id}/stops/import`, planner, { csv: "name,lat,lng\nOK,43,-79\nBad,99,-79\n" });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("row 3");
    });

    it("reorders stops, edits a stop, and resequences after a delete", async () => {
      const route = (await call("post", "/routes", planner, { name: "Reorder", date: "2026-11-06", stops: [stop("A"), stop("B"), stop("C")] })).body;
      const [a, b, c] = route.stops.map((s: { id: string }) => s.id);
      const re = await call("put", `/routes/${route.id}/stops/order`, planner, { stopIds: [c, a, b] });
      expect(re.body.stops.map((s: { name: string }) => s.name)).toEqual(["C", "A", "B"]);

      const edited = await call("patch", `/routes/${route.id}/stops/${a}`, planner, { name: "A2", status: "done" });
      expect(edited.body.stops.find((s: { id: string }) => s.id === a)).toMatchObject({ name: "A2", status: "done" });

      const del = await call("delete", `/routes/${route.id}/stops/${c}`, planner);
      expect(del.body.stops.map((s: { name: string; sequence: number }) => [s.name, s.sequence])).toEqual([["A2", 1], ["B", 2]]);

      const bad = await call("put", `/routes/${route.id}/stops/order`, planner, { stopIds: [a] });
      expect(bad.status).toBe(400);
    });

    it("validates input", async () => {
      expect((await call("post", "/routes", planner, { name: "", date: "2026-11-03", stops: [] })).status).toBe(400);
      expect((await call("post", "/routes", planner, { name: "x", date: "11/03/2026", stops: [] })).status).toBe(400);
      expect((await call("post", "/routes", planner, { name: "x", date: "2026-11-03", stops: [stop("A", 120, 0)] })).status).toBe(400);
      const win = stop("W", 43, -79, { windowStart: "2026-11-03T15:00:00Z", windowEnd: "2026-11-03T14:00:00Z" });
      expect((await call("post", "/routes", planner, { name: "x", date: "2026-11-03", stops: [win] })).status).toBe(400);
      expect((await call("post", "/routes", planner, { name: "x", date: "2026-11-03", stops: [stop("R", 43, -79, { radiusM: 5 })] })).status).toBe(400);
    });

    it("only planners can change routes", async () => {
      const viewer = await as("b@example.com");
      expect((await call("post", "/routes", viewer, { name: "x", date: "2026-11-03", stops: [] })).status).toBe(403);
      // Viewers can still read their own organization's routes.
      expect((await call("get", "/routes?date=2026-11-03", viewer)).status).toBe(200);
    });

    it("keeps organizations apart", async () => {
      const route = (await call("post", "/routes", planner, { name: "Secret", date: "2026-11-07", stops: [stop("S")] })).body;
      const otherPlanner = await as("dispatch-b@example.com");
      expect((await call("get", `/routes/${route.id}`, otherPlanner)).status).toBe(404);
      expect((await call("get", "/routes?date=2026-11-07", otherPlanner)).body).toEqual([]);
      expect((await call("patch", `/routes/${route.id}`, otherPlanner, { name: "hijack" })).status).toBe(404);
      expect((await call("post", `/routes/${route.id}/stops`, otherPlanner, { stops: [stop("X")] })).status).toBe(404);
      expect((await call("delete", `/routes/${route.id}`, otherPlanner)).status).toBe(404);
      // And cannot assign org A's vehicle to its own route.
      const aVehicle = (await call("get", "/vehicles/live", planner)).body[0].vehicleId;
      expect((await call("post", "/routes", otherPlanner, { name: "x", date: "2026-11-07", vehicleId: aVehicle, stops: [] })).status).toBe(400);
      // The route is untouched.
      expect((await call("get", `/routes/${route.id}`, planner)).body.name).toBe("Secret");
    });

    it("cannot be pointed at another organization even by the database", async () => {
      const bVehicle = (await admin.query("SELECT id FROM vehicles WHERE org_id = $1", [orgB])).rows[0].id;
      await expect(
        admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id) VALUES ($1,'x','2026-11-08',$2)", [orgA, bVehicle]),
      ).rejects.toThrow(/foreign key/);
    });
  });
});
