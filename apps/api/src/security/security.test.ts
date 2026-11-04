import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PASSWORD, SECRET, startHarness, type Harness } from "../test-harness.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { base32, fromBase32, hotp, matchStep, newRecoveryCodes, hashRecovery, stepOf } from "./totp.js";
import { runRetention } from "../ops/retention.js";
import { usageName } from "../ops/ops.controller.js";

let h: Harness;
let owner: string, ownerB: string;
const ok = (r: { status: number; body: unknown }, code = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(code); return r.body as Record<string, any>; };
const login = (email: string, password = PASSWORD) => request(h.nest.getHttpServer()).post("/auth/login").send({ email, password });
/** The code an authenticator app would show, `drift` steps from now. */
const codeFor = (seed: string, drift = 0) => hotp(fromBase32(seed), stepOf() + drift);

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgB, "ownerb@example.com", "owner"); ownerB = await h.token("ownerb@example.com");
});
afterAll(async () => { await h.close(); });

describe("one-time codes and secrets (pure)", () => {
  it("matches the RFC 4226 and 6238 test values", () => {
    const key = Buffer.from("12345678901234567890");
    expect([0, 1, 2].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152"]);
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(base32(key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(fromBase32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").equals(key)).toBe(true);
  });
  it("accepts one step of clock drift and nothing else", () => {
    const seed = base32(Buffer.from("12345678901234567890"));
    const now = 1_700_000_000_000;
    const at = (d: number) => hotp(fromBase32(seed), stepOf(now) + d);
    expect(matchStep(seed, at(0), now)).toBe(stepOf(now));
    expect(matchStep(seed, at(-1), now)).toBe(stepOf(now) - 1);
    expect(matchStep(seed, at(1), now)).toBe(stepOf(now) + 1);
    expect(matchStep(seed, at(3), now)).toBeNull();
    expect(matchStep(seed, "12345", now)).toBeNull();
    expect(matchStep(seed, "abcdef", now)).toBeNull();
  });
  it("encrypts secrets so that only the same key can read them", () => {
    const packed = encryptSecret(SECRET, "JBSWY3DPEHPK3PXP");
    expect(packed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(SECRET, packed)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptSecret("another-secret-another-secret-12345", packed)).toBeNull();
    expect(decryptSecret(SECRET, packed.slice(0, -3) + "AAA")).toBeNull();
    expect(encryptSecret(SECRET, "x")).not.toBe(encryptSecret(SECRET, "x"));
  });
  it("makes distinct recovery codes and hashes them regardless of dashes or case", () => {
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    expect(hashRecovery(codes[0]!)).toBe(hashRecovery(codes[0]!.toUpperCase().replace(/-/g, " ")));
  });
  it("folds ids and numbers out of usage names", () => {
    expect(usageName("/jobs/3f2b1c9e-1111-4222-8333-444455556666/edit?x=1")).toBe("/jobs/:id/edit");
    expect(usageName("/routes/42")).toBe("/routes/:n");
  });
});

describe("two-factor sign-in", () => {
  let seed: string, recovery: string[];
  it("needs the right code before it turns on, stores the seed encrypted and hands out recovery codes once", async () => {
    const s = ok(await h.call("post", "/security/2fa/setup", owner));
    seed = s.secret;
    expect(s.otpauth).toContain("otpauth://totp/");
    expect((await h.call("post", "/security/2fa/enable", owner, { code: "000000" })).status).toBe(400);
    const e = ok(await h.call("post", "/security/2fa/enable", owner, { code: codeFor(seed) }));
    recovery = e.recoveryCodes;
    expect(recovery).toHaveLength(10);
    const stored = (await h.admin.query("SELECT totp_secret FROM user_security")).rows[0].totp_secret as string;
    expect(stored).not.toContain(seed);
    expect(decryptSecret(SECRET, stored)).toBe(seed);
    expect(ok(await h.call("get", "/security/2fa", owner))).toMatchObject({ enabled: true, recoveryLeft: 10 });
    expect((await h.call("post", "/security/2fa/setup", owner)).status).toBe(400);
  });
  it("asks for a second step at sign-in, and the pass it hands back is not a session", async () => {
    const r = await login("a@example.com");
    expect(r.status).toBe(200);
    expect(r.body.token).toBeUndefined();
    expect(r.body.mfaRequired).toBe(true);
    expect((await h.call("get", "/me", r.body.challenge)).status).toBe(401);
  });
  it("accepts a fresh code once, refuses a replay and a wrong code, and locks after five misses", async () => {
    const challenge = (await login("a@example.com")).body.challenge as string;
    const code = codeFor(seed, 1);
    const good = await request(h.nest.getHttpServer()).post("/auth/mfa").send({ challenge, code });
    expect(good.status).toBe(200);
    expect((await h.call("get", "/me", good.body.token)).status).toBe(200);
    expect((await request(h.nest.getHttpServer()).post("/auth/mfa").send({ challenge, code })).status).toBe(401); // same step again
    for (let i = 0; i < 4; i++) expect((await request(h.nest.getHttpServer()).post("/auth/mfa").send({ challenge, code: "111111" })).status).toBe(401);
    expect((await request(h.nest.getHttpServer()).post("/auth/mfa").send({ challenge, code: codeFor(seed, -1) })).status).toBe(429);
  });
  it("lets a recovery code in once", async () => {
    await h.addUser(h.orgA, "rec@example.com", "manager");
    const t = await h.token("rec@example.com");
    const e = ok(await h.call("post", "/security/2fa/enable", t, { code: codeFor(ok(await h.call("post", "/security/2fa/setup", t)).secret) }));
    const codes = e.recoveryCodes as string[];
    const via = async (code: string) => request(h.nest.getHttpServer()).post("/auth/mfa").send({ challenge: (await login("rec@example.com")).body.challenge, code });
    expect((await via(codes[0]!)).status).toBe(200);
    expect((await via(codes[0]!)).status).toBe(401);
    expect((await via(codes[1]!.toUpperCase())).status).toBe(200);
    expect(ok(await h.call("get", "/security/2fa", t)).recoveryLeft).toBe(8);
    const fresh = ok(await h.call("post", "/security/2fa/recovery", t, { password: PASSWORD }));
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect((await via(codes[2]!)).status).toBe(401); // the old set no longer works
  });
  it("only turns off with the password, and an admin can reset it for someone who lost their phone", async () => {
    expect((await h.call("post", "/security/2fa/disable", owner, { password: "nope" })).status).toBe(403);
    const uid = await h.addUser(h.orgA, "lost.phone@example.com", "dispatcher");
    const t = await h.token("lost.phone@example.com");
    const s = ok(await h.call("post", "/security/2fa/setup", t));
    ok(await h.call("post", "/security/2fa/enable", t, { code: codeFor(s.secret) }));
    expect((await login("lost.phone@example.com")).body.mfaRequired).toBe(true);
    ok(await h.call("post", `/security/users/${uid}/reset-2fa`, owner));
    expect((await login("lost.phone@example.com")).body.token).toBeTruthy();
    expect((await h.call("get", "/me", t)).status).toBe(401); // reset also signs them out
    const t2 = await h.token("lost.phone@example.com");
    expect((await h.call("post", "/security/users/" + uid + "/reset-2fa", t2)).status).toBe(403);
  });
  it("the second-factor code is not written to the audit log", async () => {
    const rows = (await h.admin.query("SELECT detail::text AS d FROM audit_log WHERE path = '/security/2fa/enable'")).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.d ?? "").not.toMatch(/\d{6}/);
  });
});

describe("signed-in devices", () => {
  it("lists sessions, signs one out, and signs out all the others", async () => {
    await h.addUser(h.orgA, "multi@example.com", "manager");
    const a = await h.token("multi@example.com"), b = await h.token("multi@example.com"), c = await h.token("multi@example.com");
    const list = ok(await h.call("get", "/security/sessions", a)) as unknown as { id: string; current: boolean }[];
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const other = list.find((s) => !s.current)!;
    ok(await h.call("delete", `/security/sessions/${other.id}`, a));
    const statuses = await Promise.all([b, c].map(async (t) => (await h.call("get", "/me", t)).status));
    expect(statuses.sort()).toEqual([200, 401]);
    const n = ok(await h.call("post", "/security/sessions/revoke-others", a));
    expect(n.revoked).toBeGreaterThanOrEqual(1);
    expect((await h.call("get", "/me", b)).status).toBe(401);
    expect((await h.call("get", "/me", c)).status).toBe(401);
    expect((await h.call("get", "/me", a)).status).toBe(200);
  });
  it("logging out ends the token everywhere", async () => {
    const t = await h.token("multi@example.com");
    ok(await h.call("post", "/auth/logout", t));
    expect((await h.call("get", "/me", t)).status).toBe(401);
  });
  it("a manager can sign someone out, and people only see their own sessions", async () => {
    const uid = await h.addUser(h.orgA, "victim@example.com", "viewer");
    const v = await h.token("victim@example.com");
    ok(await h.call("post", `/security/users/${uid}/sign-out`, owner));
    expect((await h.call("get", "/me", v)).status).toBe(401);
    const mine = ok(await h.call("get", "/security/sessions", owner)) as unknown as { id: string }[];
    expect((await h.call("delete", `/security/sessions/${mine[0]!.id}`, ownerB)).status).toBe(404);
  });
});

describe("requiring two-factor for the organization", () => {
  it("cannot be switched on by someone without it, and then blocks people who have not set it up", async () => {
    await h.addUser(h.orgB, "ownerb2@example.com", "owner");
    const o2 = await h.token("ownerb2@example.com");
    expect((await h.call("put", "/org", o2, { settings: { twoFactorRequired: true } })).status).toBe(400);
    const s = ok(await h.call("post", "/security/2fa/setup", o2));
    ok(await h.call("post", "/security/2fa/enable", o2, { code: codeFor(s.secret) }));
    ok(await h.call("put", "/org", o2, { settings: { twoFactorRequired: true } }));
    await h.addUser(h.orgB, "late@example.com", "dispatcher");
    const late = await h.token("late@example.com");
    const blocked = await h.call("get", "/vehicles", late);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("mfa_required");
    const me = ok(await h.call("get", "/me", late));
    expect(me.security).toEqual({ twoFactor: false, mustSetUpTwoFactor: true });
    ok(await h.call("post", "/security/2fa/setup", late));
    expect((await h.call("post", "/security/2fa/disable", o2, { password: PASSWORD })).status).toBe(400);
    // a driver is not held to it
    await h.addUser(h.orgB, "drv@example.com", "driver");
    expect((await h.call("get", "/driver/routes", await h.token("drv@example.com"))).status).toBe(200);
    ok(await h.call("put", "/org", o2, { settings: { twoFactorRequired: false } }));
  });
});

describe("your data", () => {
  it("exports the organization's records without secrets or other organizations' data", async () => {
    ok(await h.call("post", "/r/vehicles", owner, { name: "Export truck" }), 201);
    ok(await h.call("post", "/r/vehicles", ownerB, { name: "Other org truck" }), 201);
    const res = await h.call("get", "/security/export", owner);
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("routenorth-export-");
    const body = JSON.parse(res.text);
    expect(body.meta.organization.id).toBe(h.orgA);
    expect(body.data.vehicles.map((v: { name: string }) => v.name)).toEqual(["Export truck"]);
    expect(body.data.users[0]).not.toHaveProperty("password_hash");
    expect(body.data).not.toHaveProperty("user_security");
    expect(body.data).not.toHaveProperty("api_keys");
    expect(res.text).not.toContain("Other org truck");
    expect((await h.call("get", "/security/export?tables=vehicles", owner)).text).toContain('"tables":1');
    const viewerTok = (await h.addUser(h.orgA, "v2@example.com", "viewer"), await h.token("v2@example.com"));
    expect((await h.call("get", "/security/export", viewerTok)).status).toBe(403);
  });
  it("erases a person's details but keeps the records they touched", async () => {
    const uid = await h.addUser(h.orgA, "leaver@example.com", "driver", { display_name: "Lee Leaver" });
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, phone) VALUES ($1,$2,'555') ON CONFLICT (user_id) DO UPDATE SET phone = '555'", [uid, h.orgA]);
    expect((await h.call("post", `/security/users/${uid}/erase`, owner, { confirm: "wrong@example.com" })).status).toBe(400);
    ok(await h.call("post", `/security/users/${uid}/erase`, owner, { confirm: "Leaver@Example.com" }));
    const u = (await h.admin.query("SELECT email, display_name, disabled_at FROM users WHERE id = $1", [uid])).rows[0];
    expect(u.email).toBe(`erased-${uid}@erased.invalid`);
    expect(u.display_name).toBeNull();
    expect(u.disabled_at).not.toBeNull();
    expect((await h.admin.query("SELECT 1 FROM driver_profiles WHERE user_id = $1", [uid])).rowCount).toBe(0);
    expect((await login("leaver@example.com")).status).toBe(401);
    const me = ((await h.admin.query("SELECT id FROM users WHERE email = 'a@example.com'")).rows[0].id) as string;
    expect((await h.call("post", `/security/users/${me}/erase`, owner, { confirm: "a@example.com" })).status).toBe(400);
  });
  it("deletes a whole organization only for its owner, with the password and the exact name", async () => {
    const org = (await h.admin.query("INSERT INTO organizations (name) VALUES ('Doomed Ltd') RETURNING id")).rows[0].id as string;
    await h.addUser(org, "boss@doomed.ca", "owner"); await h.addUser(org, "admin@doomed.ca", "admin");
    const boss = await h.token("boss@doomed.ca"), admin = await h.token("admin@doomed.ca");
    ok(await h.call("post", "/r/vehicles", boss, { name: "Doomed truck" }), 201);
    expect((await h.call("post", "/security/delete-organization", admin, { password: PASSWORD, confirm: "Doomed Ltd" })).status).toBe(403);
    expect((await h.call("post", "/security/delete-organization", boss, { password: "nope", confirm: "Doomed Ltd" })).status).toBe(403);
    expect((await h.call("post", "/security/delete-organization", boss, { password: PASSWORD, confirm: "doomed" })).status).toBe(400);
    ok(await h.call("post", "/security/delete-organization", boss, { password: PASSWORD, confirm: "Doomed Ltd" }));
    for (const t of ["organizations", "users", "vehicles", "audit_log", "user_sessions"]) {
      const col = t === "organizations" ? "id" : "org_id";
      expect((await h.admin.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [org])).rowCount, t).toBe(0);
    }
    expect((await h.admin.query("SELECT 1 FROM organizations WHERE id = $1", [h.orgA])).rowCount).toBe(1);
    expect((await h.call("get", "/me", boss)).status).toBe(401);
    // the audit log of the others is still protected
    await expect(h.admin.query("DELETE FROM audit_log WHERE org_id = $1", [h.orgA])).rejects.toThrow(/cannot be changed or deleted/);
  });
  it("the app role can read the roadmap and incidents but not change them", async () => {
    await expect(h.app.query("INSERT INTO roadmap_items (id, status, title_en, title_fr) VALUES ('hack','planned','x','x')")).rejects.toThrow();
    await expect(h.app.query("INSERT INTO service_incidents (title) VALUES ('x')")).rejects.toThrow();
    expect((await h.app.query("SELECT 1 FROM roadmap_items")).rowCount).toBeGreaterThan(3);
  });
});

describe("compliance checklist", () => {
  it("shows what is done, what needs doing and what is up to the organization", async () => {
    const r = ok(await h.call("get", "/security/compliance", owner));
    const by = Object.fromEntries((r.controls as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(by.tenant).toBe("ok");
    expect(by.twoFactorRequired).toBe("todo");
    expect(by.backups).toBe("external");
    expect(by.sessionLength).toBe("ok");
    await h.admin.query("UPDATE organizations SET settings = settings || '{\"ipAllowList\":[\"10.0.0.0/8\"]}' WHERE id = $1", [h.orgA]);
    const again = ok(await h.call("get", "/security/compliance", owner));
    expect((again.controls as { id: string; status: string }[]).find((c) => c.id === "ipAllow")!.status).toBe("ok");
    await h.admin.query("UPDATE organizations SET settings = settings - 'ipAllowList' WHERE id = $1", [h.orgA]);
    expect((await h.call("get", "/security/compliance", await h.token("v2@example.com"))).status).toBe(403);
  });
});

describe("driver privacy: track only during shifts", () => {
  it("hides a driver's vehicle outside their shift and shows it during one", async () => {
    const drv = await h.addUser(h.orgA, "tracked@example.com", "driver");
    const veh = (await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Tracked van') RETURNING id", [h.orgA])).rows[0].id as string;
    const dev = (await h.admin.query("INSERT INTO devices (org_id, external_id, vehicle_id) VALUES ($1,'imei-1',$2) RETURNING id", [h.orgA, veh])).rows[0].id as string;
    const today = new Date().toISOString().slice(0, 10);
    await h.admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id) VALUES ($1,'R',$2,$3,$4)", [h.orgA, today, veh, drv]);
    await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES (now(), $1,$2,43.7,-79.4,0,false)", [h.orgA, dev]);
    await h.admin.query("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2,now(),43.7,-79.4,0,0,false)", [dev, h.orgA]);
    const names = async () => ((await h.call("get", "/vehicles/live", owner)).body as { name: string }[]).map((v) => v.name);
    expect(await names()).toContain("Tracked van");                      // the setting is off
    ok(await h.call("put", "/org", owner, { settings: { trackOnlyDuringShift: true } }));
    expect(await names()).not.toContain("Tracked van");                  // driver is not on shift
    const range = `from=${new Date(Date.now() - 3600_000).toISOString()}&to=${new Date(Date.now() + 3600_000).toISOString()}`;
    expect((await h.call("get", `/vehicles/${dev}/track?${range}`, owner)).body).toHaveLength(0);
    await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at) VALUES ($1,$2, now() - interval '30 minutes')", [h.orgA, drv]);
    expect(await names()).toContain("Tracked van");                      // shift open
    expect((await h.call("get", `/vehicles/${dev}/track?${range}`, owner)).body).toHaveLength(1);
    await h.admin.query("UPDATE shifts SET ended_at = now() - interval '10 minutes' WHERE driver_id = $1", [drv]);
    expect(await names()).not.toContain("Tracked van");                  // fix at 'now' is after the shift ended
    ok(await h.call("put", "/org", owner, { settings: { trackOnlyDuringShift: false } }));
  });
});

describe("data retention", () => {
  it("removes positions past the retention days and old messages when asked, and keeps the rest", async () => {
    const veh = (await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Old data van') RETURNING id", [h.orgA])).rows[0].id as string;
    const dev = (await h.admin.query("INSERT INTO devices (org_id, external_id, vehicle_id) VALUES ($1,'imei-old',$2) RETURNING id", [h.orgA, veh])).rows[0].id as string;
    await h.admin.query("UPDATE organizations SET retention_days = 30 WHERE id = $1", [h.orgA]);
    await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed) VALUES (now() - interval '40 days', $1,$2,43,-79,0), (now() - interval '5 days', $1,$2,43,-79,0)", [h.orgA, dev]);
    const driver = (await h.admin.query("SELECT id FROM users WHERE email = 'tracked@example.com'")).rows[0].id as string;
    await h.admin.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body, created_at) VALUES ($1,'driver',$2,'dispatch',$2,'old', now() - interval '100 days'), ($1,'driver',$2,'dispatch',$2,'new', now())", [h.orgA, driver]);
    const before = (await h.admin.query("SELECT count(*)::int AS n FROM positions WHERE device_id = $1", [dev])).rows[0].n;
    expect(before).toBe(2);
    await runRetention(h.app);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM positions WHERE device_id = $1", [dev])).rows[0].n).toBe(1);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM messages WHERE body = 'old'")).rows[0].n).toBe(1); // message retention is off by default
    ok(await h.call("put", "/org", owner, { settings: { privacy: { messageRetentionDays: 30 } } }));
    await runRetention(h.app);
    expect((await h.admin.query("SELECT body FROM messages WHERE org_id = $1", [h.orgA])).rows.map((r) => r.body)).toEqual(["new"]);
  });
});
