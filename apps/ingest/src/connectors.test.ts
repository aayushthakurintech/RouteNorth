import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret, migrate, pg, withOrg } from "@routenorth/db";
import { clearConnectorSessions, type FetchLike } from "@routenorth/shared";
import { pullDueConnections } from "./connectors.js";
import { clearDeviceCache, ingestReading } from "./store.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const KEY = "connector-test-secret-connector-test";
const NOW = new Date("2026-11-12T15:10:00Z");

/** A fake Samsara: one page with two GPS points for one vehicle. */
function samsara(status = 200): { fetchFn: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchFn: FetchLike = async (url) => {
    urls.push(url);
    return { ok: status < 400, status, json: async () => ({
      data: [{ id: "v1", gps: [
        { time: "2026-11-12T15:00:00Z", latitude: 43.65, longitude: -79.38, headingDegrees: 90, speedMilesPerHour: 20 },
        { time: "2026-11-12T15:05:00Z", latitude: 43.66, longitude: -79.37, headingDegrees: 90, speedMilesPerHour: 25 },
      ], engineStates: [{ time: "2026-11-12T14:00:00Z", value: "On" }] }],
      pagination: { endCursor: "cur-2", hasNextPage: false },
    }) };
  };
  return { fetchFn, urls };
}

suite("provider pull connectors", () => {
  let admin: pg.Pool, app: pg.Pool, orgA = "", orgB = "", connA = "", connB = "";

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: ADMIN_URL });
    await admin.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'routenorth_app') THEN CREATE ROLE routenorth_app LOGIN PASSWORD 'app' NOSUPERUSER NOBYPASSRLS; END IF; END $$;`);
    await migrate(ADMIN_URL!);
    await admin.query("GRANT USAGE ON SCHEMA public TO routenorth_app");
    await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO routenorth_app");
    await admin.query("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO routenorth_app");
    const u = new URL(ADMIN_URL!); u.username = "routenorth_app"; u.password = "app";
    app = new pg.Pool({ connectionString: u.toString() });
    orgA = (await admin.query("INSERT INTO organizations (name) VALUES ('A') RETURNING id")).rows[0].id;
    orgB = (await admin.query("INSERT INTO organizations (name) VALUES ('B') RETURNING id")).rows[0].id;
    const add = (org: string, secret: string) => admin.query(
      "INSERT INTO provider_connections (org_id, provider, name, settings, secret_enc, cursor, next_run_at) VALUES ($1,'samsara','Samsara','{\"region\":\"us\"}',$2,'cur-1',$3) RETURNING id",
      [org, secret, new Date(NOW.getTime() - 1000)]);
    connA = (await add(orgA, encryptSecret(KEY, "token-a"))).rows[0].id;
    connB = (await add(orgB, "v1.garbage.garbage.garbage")).rows[0].id;
    clearDeviceCache(); clearConnectorSessions();
  });
  afterAll(async () => { await app?.end(); await admin?.end(); });

  const deps = (fetchFn: FetchLike) => ({ fetchFn, secretKey: KEY, now: () => NOW, ingest: (orgId: string, r: any) => ingestReading(app, "feed", r, NOW, orgId) });

  it("pulls due connections into the right company and moves the cursor", async () => {
    const { fetchFn, urls } = samsara();
    const res = await pullDueConnections(app, deps(fetchFn));
    expect(res.find((r) => r.id === connA)).toEqual({ id: connA, stored: 2 });
    expect(urls[0]).toContain("after=cur-1");
    const devices = await withOrg(app, orgA, async (c) => (await c.query("SELECT external_id FROM devices WHERE source = 'feed'")).rows);
    expect(devices).toEqual([{ external_id: "samsara:v1" }]);
    const none = await withOrg(app, orgB, async (c) => (await c.query("SELECT count(*)::int AS n FROM devices")).rows[0].n);
    expect(none).toBe(0);
    const row = (await admin.query("SELECT status, cursor, failures, last_error, last_data_at, next_run_at FROM provider_connections WHERE id = $1", [connA])).rows[0];
    expect(row).toMatchObject({ status: "ok", cursor: "cur-2", failures: 0, last_error: null });
    expect(new Date(row.last_data_at).toISOString()).toBe("2026-11-12T15:05:00.000Z");
    expect(new Date(row.next_run_at).getTime()).toBe(NOW.getTime() + 60_000);
  });

  it("marks a connection whose saved login cannot be decrypted, without calling the provider", async () => {
    const row = (await admin.query("SELECT status, failures, last_error FROM provider_connections WHERE id = $1", [connB])).rows[0];
    expect(row.status).toBe("error");
    expect(row.failures).toBe(1);
    expect(row.last_error).toMatch(/Enter it again/);
  });

  it("backs off after a refused token and skips paused connections", async () => {
    await admin.query("UPDATE provider_connections SET next_run_at = $2 WHERE id = $1", [connA, new Date(NOW.getTime() - 1)]);
    await admin.query("UPDATE provider_connections SET status = 'paused' WHERE id = $1", [connB]);
    const { fetchFn } = samsara(401);
    const res = await pullDueConnections(app, deps(fetchFn));
    expect(res.map((r) => r.id)).toEqual([connA]);
    const row = (await admin.query("SELECT status, cursor, failures, last_error, next_run_at FROM provider_connections WHERE id = $1", [connA])).rows[0];
    expect(row).toMatchObject({ status: "error", cursor: "cur-2", failures: 1 });
    expect(row.last_error).toMatch(/refused the API token/);
    expect(new Date(row.next_run_at).getTime()).toBe(NOW.getTime() + 3_600_000);
  });

  it("the app role cannot read another company's connections", async () => {
    const seen = await withOrg(app, orgB, async (c) => (await c.query("SELECT id FROM provider_connections")).rows.map((r) => r.id));
    expect(seen).toEqual([connB]);
  });
});
