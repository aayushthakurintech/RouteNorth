import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { migrate, pg } from "@routenorth/db";
import request from "supertest";
import { AppModule } from "./app.module.js";
import { configureApp } from "./configure.js";
import { MemoryPositionBus } from "./live/position-bus.js";
import type { Geocoder } from "./dispatch/geocoder.js";
import type { WeatherProvider } from "./weather/provider.js";
import type { RoutingProvider } from "./plan/providers.js";
import { hashPassword } from "./passwords.js";

export const ADMIN_URL = process.env.DATABASE_URL;
export const SECRET = "test-secret-test-secret-test-secret-123";
export const PASSWORD = "pw-correct-horse";

export interface Harness {
  admin: pg.Pool;
  app: pg.Pool;
  nest: INestApplication;
  bus: MemoryPositionBus;
  orgA: string;
  orgB: string;
  /** Log in as a seeded user and get the bearer token. */
  token(email: string): Promise<string>;
  /** Make a request as a seeded user. */
  call(method: "get" | "post" | "put" | "patch" | "delete", path: string, token?: string, body?: unknown): request.Test;
  /** Insert a user straight into the database (as superuser) and return its id. */
  addUser(org: string, email: string, role: string, extra?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/**
 * Starts the API against a throwaway database (the `public` schema is reset!) with two organizations:
 * A (owner a@example.com) and B (viewer b@example.com). Used by the tests of each feature area.
 */
export async function startHarness(opts: { routing?: RoutingProvider | null; geocoder?: Geocoder | null; weather?: WeatherProvider | null } = {}): Promise<Harness> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN
      CREATE ROLE routenorth_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS;
    END IF; END $$;`);
  await migrate(ADMIN_URL!);
  await admin.query("ALTER ROLE routenorth_app PASSWORD 'app'");
  await admin.query("GRANT USAGE ON SCHEMA public TO routenorth_app");
  await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO routenorth_app");
  await admin.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO routenorth_app");
  const u = new URL(ADMIN_URL!);
  u.username = "routenorth_app";
  u.password = "app";
  const app = new pg.Pool({ connectionString: u.toString() });

  const orgA = (await admin.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id as string;
  const orgB = (await admin.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id as string;
  const hash = await hashPassword(PASSWORD);
  const addUser = async (org: string, email: string, role: string, extra: Record<string, unknown> = {}) => {
    const cols = ["org_id", "email", "password_hash", "role", ...Object.keys(extra)];
    const vals = [org, email, hash, role, ...Object.values(extra)];
    const r = await admin.query(`INSERT INTO users (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals);
    return r.rows[0].id as string;
  };
  await addUser(orgA, "a@example.com", "owner");
  await addUser(orgB, "b@example.com", "viewer");

  const bus = new MemoryPositionBus();
  const mod = await Test.createTestingModule({ imports: [AppModule.register({ pool: app, bus, jwtSecret: SECRET, routing: opts.routing, geocoder: opts.geocoder, weather: opts.weather })] }).compile();
  const nest = mod.createNestApplication();
  configureApp(nest);
  await nest.listen(0);

  const token = async (email: string) => {
    const res = await request(nest.getHttpServer()).post("/auth/login").send({ email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
    return res.body.token as string;
  };
  const call: Harness["call"] = (method, path, tok, body) => {
    let r = request(nest.getHttpServer())[method](path);
    if (tok) r = r.set("Authorization", `Bearer ${tok}`);
    return body === undefined ? r : r.send(body as object);
  };
  return {
    admin, app, nest, bus, orgA, orgB, token, call, addUser,
    close: async () => { await nest.close(); await app.end(); await admin.end(); },
  };
}
