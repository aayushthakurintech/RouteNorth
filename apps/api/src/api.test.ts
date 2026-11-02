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
        await c.query(
          "INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2,now(),43.65,-79.38,50,90,true)",
          [d, org],
        );
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
});
