import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { migrate, pg, withOrg } from "@routenorth/db";
import type { Reading } from "@routenorth/shared";
import { authenticateFeedKey, clearKeyCache, hashKey, isGpsKey, keyFromRequest, withinRate } from "./feed.js";
import { clearDeviceCache, ingestReading } from "./store.js";

const ADMIN_URL = process.env.DATABASE_URL;
const suite = ADMIN_URL ? describe : describe.skip;
const NOW = new Date("2026-11-02T13:00:00Z");
const newKey = (kind = "gps") => `rn_${kind}_${randomBytes(24).toString("base64url")}`;
const fix = (id: string, time: string, lat = 43.65): Reading => ({
  externalId: id, time, lat, lng: -79.38, speed: 60, heading: 90, ignition: true, odometer: null, altitude: null, hdop: null, satellites: null,
  batteryPct: null, extVoltage: null, fuelLevelPct: null, rpm: null, engineHours: null, coolantC: null, signal: null, attributes: {},
});

describe("gps key helpers", () => {
  it("hashes the way the API does (sha256 hex) and only accepts gps-shaped keys", () => {
    expect(hashKey("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(isGpsKey(newKey())).toBe(true);
    expect(isGpsKey(newKey("api"))).toBe(false);
    expect(isGpsKey("rn_gps_short")).toBe(false);
  });
  it("reads the key from the header or the link, and nothing else", () => {
    const k = newKey();
    expect(keyFromRequest(`Bearer ${k}`, null)).toBe(k);
    expect(keyFromRequest(undefined, k)).toBe(k);
    expect(keyFromRequest("Bearer nope", "also-nope")).toBe("");
  });
  it("limits each key to a number of requests a minute", () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(withinRate("k1", 5, t)).toBe(true);
    expect(withinRate("k1", 5, t)).toBe(false);
    expect(withinRate("k1", 5, t + 61_000)).toBe(true);
    expect(withinRate("k2", 5, t)).toBe(true);
  });
});

suite("company GPS feed", () => {
  let admin: pg.Pool, app: pg.Pool, orgA = "", orgB = "";
  const keyA = newKey(), keyB = newKey(), apiKey = newKey("api");

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
    const add = (org: string, kind: string, key: string) => admin.query("INSERT INTO api_keys (org_id, name, kind, prefix, key_hash) VALUES ($1,'k',$2,$3,$4)", [org, kind, key.slice(0, 12), hashKey(key)]);
    await add(orgA, "gps", keyA); await add(orgB, "gps", keyB); await add(orgA, "api", apiKey);
  });
  afterAll(async () => { await app?.end(); await admin?.end(); });

  it("finds the company for a gps key, and refuses unknown, revoked and other-kind keys", async () => {
    clearKeyCache();
    expect((await authenticateFeedKey(app, keyA))?.orgId).toBe(orgA);
    expect((await authenticateFeedKey(app, keyB))?.orgId).toBe(orgB);
    expect(await authenticateFeedKey(app, newKey())).toBeNull();
    expect(await authenticateFeedKey(app, apiKey)).toBeNull(); // an API key cannot push positions
    await admin.query("UPDATE api_keys SET revoked_at = now() WHERE key_hash = $1", [hashKey(keyB)]);
    clearKeyCache();
    expect(await authenticateFeedKey(app, keyB)).toBeNull();
  });

  it("records when the key was last used", async () => {
    clearKeyCache();
    await authenticateFeedKey(app, keyA);
    await new Promise((r) => setTimeout(r, 200));
    expect((await admin.query("SELECT last_used_at FROM api_keys WHERE key_hash = $1", [hashKey(keyA)])).rows[0].last_used_at).toBeTruthy();
  });

  it("creates the device on first sight and stores positions for that company only", async () => {
    clearDeviceCache();
    const o = await ingestReading(app, "feed", fix("truck-12", "2026-11-02T12:00:00Z"), NOW, orgA);
    expect(o.kind).toBe("stored");
    const dev = await withOrg(app, orgA, (c) => c.query("SELECT source, external_id, vehicle_id FROM devices"));
    expect(dev.rows).toEqual([{ source: "feed", external_id: "truck-12", vehicle_id: null }]);
    expect((await withOrg(app, orgA, (c) => c.query("SELECT 1 FROM positions"))).rowCount).toBe(1);
    expect((await withOrg(app, orgB, (c) => c.query("SELECT 1 FROM positions"))).rowCount).toBe(0);
  });

  it("keeps the same device name in two companies apart", async () => {
    const a = await ingestReading(app, "feed", fix("truck-12", "2026-11-02T12:05:00Z", 43.7), NOW, orgA);
    const b = await ingestReading(app, "feed", fix("truck-12", "2026-11-02T12:05:00Z", 45.4), NOW, orgB);
    expect(a.kind).toBe("stored"); expect(b.kind).toBe("stored");
    const la = await withOrg(app, orgA, (c) => c.query("SELECT lat FROM latest_positions"));
    const lb = await withOrg(app, orgB, (c) => c.query("SELECT lat FROM latest_positions"));
    expect(la.rows.map((r) => r.lat)).toEqual([43.7]);
    expect(lb.rows.map((r) => r.lat)).toEqual([45.4]);
    expect((await withOrg(app, orgA, (c) => c.query("SELECT 1 FROM devices"))).rowCount).toBe(1);
  });

  it("does not let a feed take over a hardware tracker id that belongs to another company", async () => {
    await admin.query("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'traccar','867000000000001')", [orgB]);
    const o = await ingestReading(app, "feed", fix("867000000000001", "2026-11-02T12:10:00Z"), NOW, orgA);
    expect(o.kind).toBe("stored"); // a new feed device in A's own space
    const b = await withOrg(app, orgB, (c) => c.query("SELECT 1 FROM positions WHERE device_id = (SELECT id FROM devices WHERE source = 'traccar')"));
    expect(b.rowCount).toBe(0);
  });
});
