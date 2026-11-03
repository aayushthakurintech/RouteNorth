import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { migrate, pg, withOrg } from "@routenorth/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure.js";
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
    await admin.query("ALTER ROLE routenorth_app PASSWORD 'app'"); // `pnpm seed` may have set another password
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
    configureApp(nest);
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

    it("reports planned vs actual per stop", async () => {
      const route = (await call("post", "/routes", planner, {
        name: "Report", date: "2026-11-09",
        stops: [
          stop("On time", 43.65, -79.38, { windowStart: "2026-11-09T14:00:00Z", windowEnd: "2026-11-09T15:00:00Z" }),
          stop("Late", 43.66, -79.38, { windowStart: "2026-11-09T14:00:00Z", windowEnd: "2026-11-09T15:00:00Z" }),
          stop("No window", 43.67, -79.38),
          stop("Failed", 43.68, -79.38),
          stop("Pending", 43.69, -79.38),
        ],
      })).body;
      const set = (i: number, status: string, arrived: string | null, departed: string | null) =>
        admin.query("UPDATE stops SET status=$2, arrived_at=$3, departed_at=$4 WHERE id=$1", [route.stops[i].id, status, arrived, departed]);
      await set(0, "done", "2026-11-09T14:30:00Z", "2026-11-09T14:40:00Z");
      await set(1, "done", "2026-11-09T15:20:00Z", "2026-11-09T15:25:00Z");
      await set(2, "done", "2026-11-09T16:00:00Z", "2026-11-09T16:03:00Z");
      await set(3, "failed", null, null);

      const res = await call("get", `/routes/${route.id}/report`, planner);
      expect(res.status).toBe(200);
      expect(res.body.stops.map((s: { outcome: string }) => s.outcome)).toEqual(["on_time", "late", "no_window", "missed", "pending"]);
      expect(res.body.stops[0].dwellS).toBe(600);
      expect(res.body.stops[1].lateByS).toBe(1200);
      expect(res.body.summary).toMatchObject({ total: 5, done: 3, failed: 1, pending: 1, onTime: 1, late: 1, noWindow: 1, onTimePct: 50 });
    });

    it("does not show another organization's report", async () => {
      const route = (await call("post", "/routes", planner, { name: "R", date: "2026-11-10", stops: [] })).body;
      const other = await as("dispatch-b@example.com");
      expect((await call("get", `/routes/${route.id}/report`, other)).status).toBe(404);
    });

    it("cannot be pointed at another organization even by the database", async () => {
      const bVehicle = (await admin.query("SELECT id FROM vehicles WHERE org_id = $1", [orgB])).rows[0].id;
      await expect(
        admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id) VALUES ($1,'x','2026-11-08',$2)", [orgA, bVehicle]),
      ).rejects.toThrow(/foreign key/);
    });
  });

  describe("users and driver actions", () => {
    let owner = "";
    let driver = "";
    let otherDriver = "";
    let driverId = "";
    let routeId = "";
    let stopIds: string[] = [];
    const call = async (method: "get" | "post" | "put" | "patch" | "delete", path: string, token: string, body?: object) => {
      const r = request(nest.getHttpServer())[method](path).set("Authorization", `Bearer ${token}`);
      return body ? r.send(body) : r;
    };
    const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
    const jpeg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 1)]);
    const put = (path: string, token: string, body: Buffer, type = "image/jpeg") =>
      request(nest.getHttpServer()).put(path).set("Authorization", `Bearer ${token}`).set("Content-Type", type).send(body);
    const U = (id: string) => crypto.randomUUID();

    beforeAll(async () => {
      owner = (await login("a@example.com")).body.token;
      const made = await call("post", "/users", owner, { email: "driver1@example.com", password: "pw-correct-horse", role: "driver", locale: "fr" });
      expect(made.status).toBe(201);
      driverId = made.body.id;
      await call("post", "/users", owner, { email: "driver2@example.com", password: "pw-correct-horse", role: "driver" });
      driver = (await login("driver1@example.com")).body.token;
      otherDriver = (await login("driver2@example.com")).body.token;
      const route = (await call("post", "/routes", owner, {
        name: "Driver run", date: today(), driverId,
        stops: [{ name: "S1", lat: 43.65, lng: -79.38 }, { name: "S2", lat: 43.66, lng: -79.39 }],
      })).body;
      routeId = route.id;
      stopIds = route.stops.map((s: { id: string }) => s.id);
    });

    it("lets owners create users and rejects bad input", async () => {
      expect((await call("post", "/users", owner, { email: "bad", password: "pw-correct-horse", role: "driver" })).status).toBe(400);
      expect((await call("post", "/users", owner, { email: "x@example.com", password: "short", role: "driver" })).status).toBe(400);
      expect((await call("post", "/users", owner, { email: "x@example.com", password: "pw-correct-horse", role: "owner" })).status).toBe(400);
      expect((await call("post", "/users", owner, { email: "DRIVER1@example.com", password: "pw-correct-horse", role: "driver" })).status).toBe(409);
      expect((await call("post", "/users", driver, { email: "y@example.com", password: "pw-correct-horse", role: "driver" })).status).toBe(403);
      const drivers = await call("get", "/users?role=driver", owner);
      expect(drivers.body.map((u: { email: string }) => u.email)).toEqual(["driver1@example.com", "driver2@example.com"]);
      expect((await call("get", "/users", driver)).status).toBe(403);
    });

    it("shows a driver only their own routes for today", async () => {
      const mine = await call("get", "/driver/routes", driver);
      expect(mine.status).toBe(200);
      expect(mine.body).toHaveLength(1);
      expect(mine.body[0].stops.map((s: { name: string }) => s.name)).toEqual(["S1", "S2"]);
      expect(mine.body[0].stops[0].proofCount).toBe(0);
      expect((await call("get", "/driver/routes", otherDriver)).body).toEqual([]);
    });

    it("records arrival and completion, stamps times once, and updates the route", async () => {
      const t1 = new Date(Date.now() - 600_000).toISOString();
      const arrived = await call("post", `/driver/stops/${stopIds[0]}/status`, driver, { status: "arrived", occurredAt: t1 });
      expect(arrived.status).toBe(201);
      expect(arrived.body.stop.arrivedAt).toBe(t1);
      expect(arrived.body.routeStatus).toBe("in_progress");

      const done = await call("post", `/driver/stops/${stopIds[0]}/status`, driver, {
        status: "done", occurredAt: new Date(Date.now() - 300_000).toISOString(), notes: "Left at door", recipientName: "J. Smith",
      });
      expect(done.body.stop).toMatchObject({ status: "done", arrivedAt: t1, driverNotes: "Left at door", recipientName: "J. Smith" });

      // A late replay of "arrived" must not undo the finished stop or change its time.
      const replay = await call("post", `/driver/stops/${stopIds[0]}/status`, driver, { status: "arrived", occurredAt: new Date().toISOString() });
      expect(replay.body.stop.status).toBe("done");
      expect(replay.body.stop.arrivedAt).toBe(t1);

      const failed = await call("post", `/driver/stops/${stopIds[1]}/status`, driver, { status: "failed", reason: "Nobody home" });
      expect(failed.body.stop).toMatchObject({ status: "failed", failureReason: "Nobody home" });
      expect(failed.body.routeStatus).toBe("completed");

      // Undo puts the route back in progress.
      const undo = await call("post", `/driver/stops/${stopIds[1]}/status`, driver, { status: "pending" });
      expect(undo.body.stop).toMatchObject({ status: "pending", failureReason: null, arrivedAt: null });
      expect(undo.body.routeStatus).toBe("in_progress");
    });

    it("rejects other drivers, bad statuses and implausible times", async () => {
      expect((await call("post", `/driver/stops/${stopIds[0]}/status`, otherDriver, { status: "done" })).status).toBe(404);
      expect((await call("post", `/driver/stops/${stopIds[0]}/status`, driver, { status: "teleported" })).status).toBe(400);
      expect((await call("post", `/driver/stops/${stopIds[0]}/status`, driver, { status: "done", occurredAt: new Date(Date.now() + 3_600_000).toISOString() })).status).toBe(400);
      expect((await call("post", `/driver/stops/${stopIds[0]}/status`, driver, { status: "done", occurredAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
      expect((await call("post", `/driver/stops/${stopIds[0]}/status`, owner, { status: "done" })).status).toBe(404); // not the route's driver
    });

    it("stores proofs idempotently and serves them only to the right people", async () => {
      const cid = U("a");
      const up = await put(`/driver/stops/${stopIds[0]}/proofs/${cid}?kind=photo&lat=43.65&lng=-79.38`, driver, jpeg());
      expect(up.status).toBe(200);
      expect(up.body).toMatchObject({ kind: "photo", duplicate: false });
      const again = await put(`/driver/stops/${stopIds[0]}/proofs/${cid}?kind=photo`, driver, jpeg());
      expect(again.body).toMatchObject({ id: up.body.id, duplicate: true });
      const sig = await put(`/driver/stops/${stopIds[0]}/proofs/${U("b")}?kind=signature`, driver, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]), "image/png");
      expect(sig.status).toBe(200);

      const list = await call("get", `/stops/${stopIds[0]}/proofs`, owner);
      expect(list.body.map((p: { kind: string }) => p.kind).sort()).toEqual(["photo", "signature"]);
      const file = await request(nest.getHttpServer()).get(`/proofs/${up.body.id}`).set("Authorization", `Bearer ${owner}`).buffer(true).parse((res, cb) => {
        const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
      expect(file.status).toBe(200);
      expect(file.headers["content-type"]).toContain("image/jpeg");
      expect(file.headers["x-content-type-options"]).toBe("nosniff");
      expect((file.body as Buffer).length).toBe(204);

      expect((await call("get", `/proofs/${up.body.id}`, driver)).status).toBe(200);
      expect((await call("get", `/proofs/${up.body.id}`, otherDriver)).status).toBe(404);
      const outsider = (await login("dispatch-b@example.com")).body.token;
      expect((await call("get", `/proofs/${up.body.id}`, outsider)).status).toBe(404);
      expect((await call("get", `/stops/${stopIds[0]}/proofs`, outsider)).status).toBe(404);
    });

    it("validates proof uploads", async () => {
      const base = `/driver/stops/${stopIds[0]}/proofs`;
      expect((await put(`${base}/${U("c")}?kind=photo`, driver, jpeg(), "text/plain")).status).toBe(415);
      expect((await put(`${base}/${U("d")}?kind=photo`, driver, Buffer.from("not an image at all"))).status).toBe(400);
      expect((await put(`${base}/${U("e")}?kind=selfie`, driver, jpeg())).status).toBe(400);
      expect((await put(`${base}/${U("f")}?kind=photo`, driver, jpeg(7 * 1024 * 1024))).status).toBe(413);
      expect((await put(`${base}/not-a-uuid?kind=photo`, driver, jpeg())).status).toBe(400);
      expect((await put(`${base}/${U("g")}?kind=photo`, otherDriver, jpeg())).status).toBe(404);
    });
  });
});
