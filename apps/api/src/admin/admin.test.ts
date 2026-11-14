import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, SECRET, startHarness, type Harness } from "../test-harness.js";
import { hashPassword } from "../passwords.js";
import { encryptSecret } from "../security/secrets.js";
import { hashRecovery, hotp, fromBase32, newRecoveryCodes, newSecret, stepOf } from "../security/totp.js";

let h: Harness;
const SEED = newSecret();
const STAFF_PW = "staff-passphrase-long-enough-1";
const codeNow = () => hotp(fromBase32(SEED), stepOf());

async function addStaff(email: string, role: string, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = { email, display_name: email.split("@")[0], password_hash: await hashPassword(STAFF_PW), role, totp_secret: encryptSecret(SECRET, SEED), recovery_hashes: [] as string[], ...extra };
  const keys = Object.keys(cols);
  const r = await h.admin.query(`INSERT INTO platform_admins (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, Object.values(cols));
  return r.rows[0].id as string;
}

/** Password, then the authenticator code. Each code is single-use, so the stored "last step" is cleared first, as a new 30-second window would. */
async function staffToken(email: string): Promise<string> {
  const first = await h.call("post", "/auth/login", undefined, { email, password: STAFF_PW });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  expect(first.body.token).toBeUndefined();
  await h.admin.query("UPDATE platform_admins SET last_step = NULL WHERE lower(email) = lower($1)", [email]);
  const second = await h.call("post", "/auth/mfa", undefined, { challenge: first.body.challenge, code: codeNow() });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  return second.body.token as string;
}
async function stepUp(tok: string) {
  await h.admin.query("UPDATE platform_admins SET last_step = NULL");
  const r = await h.call("post", "/admin/stepup", tok, { code: codeNow() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

let superTok = "", managerTok = "", supportTok = "", auditorTok = "";

beforeAll(async () => {
  h = await startHarness();
  await addStaff("root@routenorth.example", "super_admin");
  await addStaff("manager@routenorth.example", "account_manager");
  await addStaff("support@routenorth.example", "support");
  await addStaff("auditor@routenorth.example", "auditor");
  superTok = await staffToken("root@routenorth.example");
  managerTok = await staffToken("manager@routenorth.example");
  supportTok = await staffToken("support@routenorth.example");
  auditorTok = await staffToken("auditor@routenorth.example");
}, 120_000);
afterAll(async () => { await h.close(); });
beforeEach(async () => { await h.admin.query("UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL WHERE email LIKE '%@routenorth.example'"); });

describe("staff sign-in", () => {
  it("uses the same login URL, needs a second factor, and a password alone never gives a token", async () => {
    const r = await h.call("post", "/auth/login", undefined, { email: "ROOT@routenorth.example", password: STAFF_PW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mfaRequired: true });
    expect(r.body.token).toBeUndefined();
  });

  it("answers the same way for a wrong password, an unknown email and a client's password", async () => {
    const wrong = await h.call("post", "/auth/login", undefined, { email: "root@routenorth.example", password: "nope-nope-nope" });
    const unknown = await h.call("post", "/auth/login", undefined, { email: "nobody@routenorth.example", password: "nope-nope-nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("a staff token is returned only after the code, and the answer sends staff to /admin", async () => {
    const first = await h.call("post", "/auth/login", undefined, { email: "root@routenorth.example", password: STAFF_PW });
    const bad = await h.call("post", "/auth/mfa", undefined, { challenge: first.body.challenge, code: "000000" });
    expect(bad.status).toBe(401);
    await h.admin.query("UPDATE platform_admins SET last_step = NULL");
    const ok = await h.call("post", "/auth/mfa", undefined, { challenge: first.body.challenge, code: codeNow() });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: "platform:super_admin", home: "/admin", platform: true });
    superTok = ok.body.token;
  });

  it("refuses to accept the same code twice", async () => {
    await h.admin.query("UPDATE platform_admins SET last_step = NULL");
    const a = await h.call("post", "/auth/login", undefined, { email: "root@routenorth.example", password: STAFF_PW });
    const b = await h.call("post", "/auth/login", undefined, { email: "root@routenorth.example", password: STAFF_PW });
    const code = codeNow();
    expect((await h.call("post", "/auth/mfa", undefined, { challenge: a.body.challenge, code })).status).toBe(200);
    expect((await h.call("post", "/auth/mfa", undefined, { challenge: b.body.challenge, code })).status).toBe(401);
    superTok = await staffToken("root@routenorth.example");
  });

  it("locks after five wrong passwords, and then even the right password looks wrong", async () => {
    const email = "lockme@routenorth.example";
    await addStaff(email, "auditor");
    for (let i = 0; i < 5; i++) expect((await h.call("post", "/auth/login", undefined, { email, password: "wrong-wrong-wrong" })).status).toBe(401);
    const right = await h.call("post", "/auth/login", undefined, { email, password: STAFF_PW });
    expect(right.status).toBe(401);
    expect(right.body.message).toBe("invalid credentials");
    expect((await h.admin.query("SELECT 1 FROM platform_audit WHERE action = 'login.locked' AND admin_email = $1", [email])).rowCount).toBe(1);
  });

  it("a disabled account cannot sign in and an existing session stops at once", async () => {
    const email = "gone@routenorth.example";
    const id = await addStaff(email, "auditor");
    const tok = await staffToken(email);
    expect((await h.call("get", "/admin/me", tok)).status).toBe(200);
    await h.admin.query("UPDATE platform_admins SET disabled_at = now() WHERE id = $1", [id]);
    expect((await h.call("get", "/admin/me", tok)).status).toBe(401);
    expect((await h.call("post", "/auth/login", undefined, { email, password: STAFF_PW })).status).toBe(401);
  });

  it("sessions end after 30 idle minutes and after 8 hours in total", async () => {
    const email = "idle@routenorth.example";
    await addStaff(email, "auditor");
    const tok = await staffToken(email);
    await h.admin.query("UPDATE platform_sessions SET last_seen_at = now() - interval '31 minutes' WHERE admin_id = (SELECT id FROM platform_admins WHERE email = $1)", [email]);
    expect((await h.call("get", "/admin/me", tok)).status).toBe(401);
    const tok2 = await staffToken(email);
    await h.admin.query("UPDATE platform_sessions SET created_at = now() - interval '9 hours' WHERE id = (SELECT id FROM platform_sessions WHERE revoked_at IS NULL AND admin_id = (SELECT id FROM platform_admins WHERE email = $1) LIMIT 1)", [email]);
    expect((await h.call("get", "/admin/me", tok2)).status).toBe(401);
  });

  it("signing in again ends the older session, and logout ends the current one", async () => {
    const email = "twice@routenorth.example";
    await addStaff(email, "auditor");
    const a = await staffToken(email);
    const b = await staffToken(email);
    expect((await h.call("get", "/admin/me", a)).status).toBe(401);
    expect((await h.call("get", "/admin/me", b)).status).toBe(200);
    await h.call("post", "/admin/logout", b);
    expect((await h.call("get", "/admin/me", b)).status).toBe(401);
  });

  it("can be limited to a network, for everyone or for one person", async () => {
    const email = "net@routenorth.example";
    await addStaff(email, "auditor", { ip_allow_list: ["203.0.113.0/24"] });
    // supertest connects from loopback, which is not in the person's list
    expect((await h.call("post", "/auth/login", undefined, { email, password: STAFF_PW })).status).toBe(401);
    process.env.PLATFORM_ADMIN_IP_ALLOWLIST = "203.0.113.9";
    try { expect((await h.call("post", "/auth/login", undefined, { email: "root@routenorth.example", password: STAFF_PW })).status).toBe(401); }
    finally { delete process.env.PLATFORM_ADMIN_IP_ALLOWLIST; }
  });
});

describe("staff and client tokens are different kinds of token", () => {
  it("a client token cannot open the console and a staff token cannot open the product", async () => {
    const owner = await h.token("a@example.com");
    expect((await h.call("get", "/admin/me", owner)).status).toBe(401);
    expect((await h.call("get", "/admin/clients", owner)).status).toBe(401);
    for (const path of ["/me", "/routes?date=2026-11-20", "/vehicles", "/users", "/org"]) expect((await h.call("get", path, superTok)).status, path).toBe(401);
  });
  it("no token at all is refused", async () => { expect((await h.call("get", "/admin/clients")).status).toBe(401); });
  it("a staff account and a client user cannot share an email", async () => {
    await expect(h.addUser(h.orgA, "root@routenorth.example", "viewer")).rejects.toThrow();
    const signup = await h.call("post", "/auth/signup", undefined, { company: "Sneaky Co", name: "Sneaky", email: "root@routenorth.example", password: "lakeshore diesel morning", acceptTerms: true });
    expect(signup.status).toBe(409);
  });
});

describe("what each staff role may do", () => {
  it("only a super admin sees or changes staff accounts", async () => {
    for (const tok of [managerTok, supportTok, auditorTok]) expect((await h.call("get", "/admin/admins", tok)).status).toBe(403);
    expect((await h.call("get", "/admin/admins", superTok)).status).toBe(200);
  });
  it("an auditor reads but cannot change anything", async () => {
    expect((await h.call("get", "/admin/clients", auditorTok)).status).toBe(200);
    expect((await h.call("get", "/admin/audit", auditorTok)).status).toBe(200);
    await stepUp(auditorTok);
    expect((await h.call("put", `/admin/clients/${h.orgA}/access`, auditorTok, { sections: ["tracking"] })).status).toBe(403);
    expect((await h.call("post", `/admin/clients/${h.orgA}/suspend`, auditorTok, { reason: "testing the role matrix" })).status).toBe(403);
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, auditorTok, { reason: "testing the role matrix" })).status).toBe(403);
  });
  it("support can look inside an account but cannot change access or suspend", async () => {
    await stepUp(supportTok);
    expect((await h.call("put", `/admin/clients/${h.orgA}/access`, supportTok, { sections: ["tracking"] })).status).toBe(403);
    expect((await h.call("post", `/admin/clients/${h.orgA}/suspend`, supportTok, { reason: "testing the role matrix" })).status).toBe(403);
    expect((await h.call("get", "/admin/audit", supportTok)).status).toBe(403);
  });
  it("an account manager can change access but cannot view as a client", async () => {
    await stepUp(managerTok);
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, managerTok, { reason: "testing the role matrix" })).status).toBe(403);
  });
});

describe("step-up", () => {
  it("sensitive changes need a recently entered code", async () => {
    const tok = await staffToken("manager@routenorth.example");
    const r = await h.call("put", `/admin/clients/${h.orgB}/access`, tok, { sections: [...["tracking"]] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("step_up_required");
    await stepUp(tok);
    expect((await h.call("put", `/admin/clients/${h.orgB}/access`, tok, { sections: ["tracking"], reason: "step up test" })).status).toBe(200);
    await h.call("put", `/admin/clients/${h.orgB}/access`, tok, { preset: "full" });
    // after ten minutes it is needed again
    await h.admin.query("UPDATE platform_sessions SET stepped_up_at = now() - interval '11 minutes'");
    expect((await h.call("put", `/admin/clients/${h.orgB}/access`, tok, { preset: "full" })).body.code).toBe("step_up_required");
    managerTok = tok;
  });
  it("five wrong step-up codes end the session", async () => {
    const email = "stepfail@routenorth.example";
    await addStaff(email, "account_manager");
    const tok = await staffToken(email);
    for (let i = 0; i < 5; i++) expect((await h.call("post", "/admin/stepup", tok, { code: "111111" })).status).toBe(403);
    expect((await h.call("get", "/admin/me", tok)).status).toBe(401);
  });
});

describe("a client limited to some sections (server-side)", () => {
  let owner = "";
  beforeAll(async () => {
    await stepUp(managerTok);
    const r = await h.call("put", `/admin/clients/${h.orgA}/access`, managerTok, { sections: ["tracking"], reason: "tracking-only plan" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.removed).toContain("dispatch");
    owner = await h.token("a@example.com");
  });

  it("can use tracking and the basics, and is refused everything else with 403 from the API itself", async () => {
    for (const path of ["/vehicles", "/devices", "/me", "/users", "/org", "/audit", "/billing/plan", "/r/vehicles", "/security/2fa", "/search?q=a", "/fleet/trip-log"]) {
      const r = await h.call("get", path, owner);
      expect(r.status, `${path} -> ${r.status} ${JSON.stringify(r.body)}`).toBeLessThan(400);
    }
    for (const path of ["/routes?date=2026-11-20", "/r/jobs", "/portal/finance/earnings", "/portal/finance/payouts", "/analytics/summary", "/alerts", "/platform/keys", "/portal/drivers", "/billing/quotes", "/invoices", "/r/fuel-logs", "/r/rate-cards", "/ai/briefing", "/automation/catalog", "/timesheets", "/portal/dashboard", "/driver/routes", "/fleet/fuel/summary", "/fleet/drivers"]) {
      const r = await h.call("get", path, owner);
      expect(r.status, `${path} -> ${r.status}`).toBe(403);
      expect(r.body.code).toBe("section_not_included");
    }
  });

  it("writes are refused too, not just reads", async () => {
    expect((await h.call("post", "/routes", owner, { name: "x", routeDate: "2026-11-20" })).status).toBe(403);
    expect((await h.call("post", "/r/rate-cards", owner, { name: "x" })).status).toBe(403);
  });

  it("an API key of that company is held to the same sections", async () => {
    const k = await h.call("post", "/platform/keys", owner, { name: "x" });
    expect(k.status).toBe(403);
    await h.admin.query("UPDATE org_entitlements SET sections = ARRAY['tracking','integrations'] WHERE org_id = $1", [h.orgA]);
    const made = await h.call("post", "/platform/keys", owner, { name: "ci", kind: "api", scope: "read" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect((await h.call("get", "/vehicles", made.body.key)).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-20", made.body.key)).status).toBe(403);
    await h.admin.query("UPDATE org_entitlements SET sections = ARRAY['tracking'] WHERE org_id = $1", [h.orgA]);
    expect((await h.call("get", "/vehicles", made.body.key)).status).toBe(200);
    await h.admin.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [h.orgA]);
    expect((await h.call("get", "/vehicles", made.body.key)).status).toBe(403);
    await h.admin.query("UPDATE organizations SET status = 'active' WHERE id = $1", [h.orgA]);
  });

  it("the other company is not affected", async () => {
    const b = await h.token("b@example.com");
    expect((await h.call("get", "/routes?date=2026-11-20", b)).status).toBe(200);
  });

  it("/me tells the web app what the company has and where to land", async () => {
    const me = await h.call("get", "/me", owner);
    expect(me.body.entitlements).toMatchObject({ restricted: true, sections: ["tracking"] });
    expect(me.body.home).toBe("/live");
    const login = await h.call("post", "/auth/login", undefined, { email: "a@example.com", password: PASSWORD });
    expect(login.body.user.home).toBe("/live");
  });

  it("search and the resource list only show what the company has", async () => {
    await h.admin.query("INSERT INTO routes (org_id, name, route_date) VALUES ($1,'Secret route','2026-11-20')", [h.orgA]);
    const s = await h.call("get", "/search?q=Secret", owner);
    expect(s.body).toEqual([]);
    const schema = await h.call("get", "/r/_schema", owner);
    const names = (schema.body as { name: string }[]).map((x) => x.name);
    expect(names).toContain("vehicles");
    expect(names).not.toContain("fuel-logs");
    expect(names).not.toContain("rate-cards");
  });

  it("takes effect on the very next request with the same token, both ways", async () => {
    expect((await h.call("get", "/routes?date=2026-11-20", owner)).status).toBe(403);
    await stepUp(managerTok);
    await h.call("put", `/admin/clients/${h.orgA}/access`, managerTok, { sections: ["tracking", "dispatch"] });
    expect((await h.call("get", "/routes?date=2026-11-20", owner)).status).toBe(200);
    await h.call("put", `/admin/clients/${h.orgA}/access`, managerTok, { sections: ["tracking"] });
    expect((await h.call("get", "/routes?date=2026-11-20", owner)).status).toBe(403);
  });

  it("is written to the client's own audit log and to the staff audit log with before and after", async () => {
    const mine = (await h.admin.query("SELECT actor_label, detail FROM audit_log WHERE org_id = $1 AND action = 'staff.access.changed' ORDER BY at DESC", [h.orgA])).rows;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].actor_label).toMatch(/RouteNorth staff/);
    const staff = (await h.admin.query("SELECT detail, reason FROM platform_audit WHERE action = 'client.access.changed' AND org_id = $1 ORDER BY id", [h.orgA])).rows;
    expect(staff[0].detail.removed).toContain("dispatch");
    expect(staff[0].reason).toBe("tracking-only plan");
  });

  it("an unknown section name is rejected and nothing changes", async () => {
    await stepUp(managerTok);
    const r = await h.call("put", `/admin/clients/${h.orgA}/access`, managerTok, { sections: ["tracking", "everything"] });
    expect(r.status).toBe(400);
    expect((await h.call("get", "/routes?date=2026-11-20", owner)).status).toBe(403);
  });
});

describe("suspension", () => {
  it("stops sign-in and every request at once, and reinstating restores it", async () => {
    const b = await h.token("b@example.com");
    expect((await h.call("get", "/routes?date=2026-11-20", b)).status).toBe(200);
    await stepUp(managerTok);
    expect((await h.call("post", `/admin/clients/${h.orgB}/suspend`, managerTok, { reason: "x" })).status).toBe(400);
    expect((await h.call("post", `/admin/clients/${h.orgB}/suspend`, managerTok, { reason: "unpaid invoice, third notice" })).status).toBe(200);
    const r = await h.call("get", "/routes?date=2026-11-20", b);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("account_suspended");
    const login = await h.call("post", "/auth/login", undefined, { email: "b@example.com", password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("account_suspended");
    expect((await h.call("post", `/admin/clients/${h.orgB}/suspend`, managerTok, { reason: "unpaid invoice, third notice" })).status).toBe(409);
    expect((await h.call("post", `/admin/clients/${h.orgB}/reinstate`, managerTok, { reason: "paid in full today" })).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-20", b)).status).toBe(200);
    const actions = (await h.admin.query("SELECT action FROM platform_audit WHERE org_id = $1 AND action IN ('client.suspended','client.reinstated') ORDER BY id", [h.orgB])).rows.map((x) => x.action);
    expect(actions).toEqual(["client.suspended", "client.reinstated"]);
  });
});

describe("key-protected feeds follow the same rules", () => {
  it("are closed when the company is suspended or does not have the integrations section", async () => {
    await h.admin.query("UPDATE organizations SET status = 'active' WHERE id = $1", [h.orgB]);
    await h.admin.query("UPDATE users SET role = 'owner' WHERE email = 'b@example.com'");
    await stepUp(managerTok);
    await h.call("put", `/admin/clients/${h.orgB}/access`, managerTok, { preset: "full" });
    const b = await h.token("b@example.com");
    const k = await h.call("post", "/platform/keys", b, { name: "sheet", kind: "feed" });
    expect(k.status, JSON.stringify(k.body)).toBe(201);
    expect((await h.call("get", `/feeds/datasets?key=${k.body.key}`)).status).toBe(200);
    await h.call("put", `/admin/clients/${h.orgB}/access`, managerTok, { sections: ["tracking"] });
    expect((await h.call("get", `/feeds/datasets?key=${k.body.key}`)).body.code).toBe("section_not_included");
    await h.call("put", `/admin/clients/${h.orgB}/access`, managerTok, { preset: "full" });
    await h.admin.query("UPDATE organizations SET status = 'suspended' WHERE id = $1", [h.orgB]);
    expect((await h.call("get", `/feeds/datasets?key=${k.body.key}`)).body.code).toBe("account_suspended");
    await h.admin.query("UPDATE organizations SET status = 'active' WHERE id = $1", [h.orgB]);
  });
});

describe("hard limits set by staff", () => {
  it("stop vehicles and users at the number staff typed", async () => {
    await stepUp(managerTok);
    await h.call("put", `/admin/clients/${h.orgB}/access`, managerTok, { preset: "full", limits: { vehicles: 1, users: 2 } });
    await h.admin.query("UPDATE users SET role = 'owner' WHERE email = 'b@example.com'");
    const b = await h.token("b@example.com");
    expect((await h.call("post", "/r/vehicles", b, { name: "Truck 1", kind: "truck" })).status).toBe(201);
    const second = await h.call("post", "/r/vehicles", b, { name: "Truck 2", kind: "truck" });
    expect(second.status).toBe(403);
    expect(second.body).toMatchObject({ code: "limit_reached", limit: 1 });
    expect((await h.call("post", "/users", b, { email: "two@example.com", password: "lakeshore diesel morning", role: "viewer" })).status).toBe(201);
    const third = await h.call("post", "/users", b, { email: "three@example.com", password: "lakeshore diesel morning", role: "viewer" });
    expect(third.status).toBe(403);
    expect(third.body.code).toBe("limit_reached");
    await h.call("put", `/admin/clients/${h.orgB}/access`, managerTok, { preset: "full" });
    expect((await h.call("post", "/r/vehicles", b, { name: "Truck 2", kind: "truck" })).status).toBe(201);
  });
});

describe("view as client", () => {
  let owner = "";
  beforeAll(async () => {
    await stepUp(managerTok);
    await h.call("put", `/admin/clients/${h.orgA}/access`, managerTok, { sections: ["tracking", "dispatch", "drivers"] });
    owner = await h.token("a@example.com");
  });

  it("needs a reason, a recent code and a role that allows it", async () => {
    await h.admin.query("UPDATE platform_sessions SET stepped_up_at = NULL");
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Customer asked us to look at their live map" })).body.code).toBe("step_up_required");
    await stepUp(supportTok);
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "short" })).status).toBe(400);
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, {})).status).toBe(400);
  });

  it("gives a short, read-only session that the client can see in its own audit log", async () => {
    await stepUp(supportTok);
    const r = await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Customer asked us to look at their live map", ticket: "T-1042" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const tok = r.body.token as string;
    const me = await h.call("get", "/me", tok);
    expect(me.status).toBe(200);
    expect(me.body.impersonation).toMatchObject({ reason: "Customer asked us to look at their live map" });
    expect(me.body.perms).not.toContain("drivers.sensitive");
    expect(me.body.perms).not.toContain("users.manage");
    expect((await h.call("get", "/routes?date=2026-11-20", tok)).status).toBe(200);
    expect((await h.call("get", "/vehicles", tok)).status).toBe(200);
    // never a write
    const w = await h.call("post", "/r/vehicles", tok, { name: "Staff truck", kind: "truck" });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe("read_only_view");
    expect((await h.call("put", "/org", tok, { name: "Hacked" })).status).toBe(403);
    expect((await h.call("patch", "/me", tok, { displayName: "x" })).status).toBe(403);
    // credentials and bulk exports stay closed even for reading
    expect((await h.call("get", "/security/2fa", tok)).body.code).toBe("blocked_in_staff_view");
    // the section limits still apply: staff see what the client sees
    expect((await h.call("get", "/portal/finance/earnings", tok)).body.code).toBe("section_not_included");
    // the client's log shows it
    const log = (await h.admin.query("SELECT actor_label, detail FROM audit_log WHERE org_id = $1 AND action = 'staff.access.started'", [h.orgA])).rows;
    expect(log.at(-1).detail).toMatchObject({ reason: "Customer asked us to look at their live map", readOnly: true });
    expect(log.at(-1).actor_label).toMatch(/RouteNorth staff/);
    // what was looked at is kept without ids
    await new Promise((res) => setTimeout(res, 100));
    const row = (await h.admin.query("SELECT requests, blocked_writes, paths FROM platform_impersonations WHERE id = $1", [r.body.impersonationId])).rows[0];
    expect(row.requests).toBeGreaterThanOrEqual(5);
    expect(row.blocked_writes).toBeGreaterThanOrEqual(3);
    expect(row.paths).toContain("/routes");
    // no database writes happened in the client's data
    expect((await h.admin.query("SELECT 1 FROM vehicles WHERE name = 'Staff truck'")).rowCount).toBe(0);
    // signing out of the view ends it for good
    expect((await h.call("post", "/auth/logout", tok)).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-20", tok)).status).toBe(401);
    expect((await h.admin.query("SELECT ended_at FROM platform_impersonations WHERE id = $1", [r.body.impersonationId])).rows[0].ended_at).not.toBeNull();
  });

  it("expires by itself, and staff can end it from the console", async () => {
    await stepUp(supportTok);
    const r = await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Checking the dashboard with the client on the phone" });
    expect((await h.call("get", "/routes?date=2026-11-20", r.body.token)).status).toBe(200);
    await h.admin.query("UPDATE platform_impersonations SET expires_at = now() - interval '1 minute' WHERE id = $1", [r.body.impersonationId]);
    expect((await h.call("get", "/routes?date=2026-11-20", r.body.token)).status).toBe(401);
    const r2 = await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Checking the dashboard with the client on the phone" });
    expect((await h.call("post", `/admin/view-as/${r2.body.impersonationId}/end`, supportTok)).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-20", r2.body.token)).status).toBe(401);
  });

  it("stops working if the staff member is disabled", async () => {
    const email = "temp-support@routenorth.example";
    const id = await addStaff(email, "support");
    const tok = await staffToken(email);
    await stepUp(tok);
    const r = await h.call("post", `/admin/clients/${h.orgA}/view-as`, tok, { reason: "Looking into a ticket from this customer" });
    expect((await h.call("get", "/routes?date=2026-11-20", r.body.token)).status).toBe(200);
    await h.admin.query("UPDATE platform_admins SET disabled_at = now() WHERE id = $1", [id]);
    expect((await h.call("get", "/routes?date=2026-11-20", r.body.token)).status).toBe(401);
  });

  it("is refused when the client turned staff access off, and that is logged", async () => {
    await h.admin.query("UPDATE organizations SET settings = jsonb_set(settings, '{privacy}', '{\"staffAccess\": false}') WHERE id = $1", [h.orgA]);
    await stepUp(supportTok);
    const r = await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Customer asked us to look at their live map" });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("staff_access_off");
    expect((await h.admin.query("SELECT 1 FROM platform_audit WHERE action = 'view_as.refused_by_client' AND org_id = $1", [h.orgA])).rowCount).toBe(1);
    await h.admin.query("UPDATE organizations SET settings = settings - 'privacy' WHERE id = $1", [h.orgA]);
  });

  it("the client can switch staff access off in its own settings", async () => {
    const r = await h.call("put", "/org", owner, { settings: { privacy: { staffAccess: false } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await stepUp(supportTok);
    expect((await h.call("post", `/admin/clients/${h.orgA}/view-as`, supportTok, { reason: "Customer asked us to look at their live map" })).body.code).toBe("staff_access_off");
    await h.call("put", "/org", owner, { settings: { privacy: { staffAccess: true } } });
  });
});

describe("creating a client", () => {
  it("makes the company, its owner invitation and its sections in one step, and the owner lands on a page they have", async () => {
    await stepUp(managerTok);
    const r = await h.call("post", "/admin/clients", managerTok, { name: "Peel Waste Haulers", ownerEmail: "boss@peelwaste.example", ownerName: "Dana Singh", plan: "starter", preset: "tracking_only", limits: { vehicles: 5 } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const token = /\/reset\/([A-Za-z0-9_-]+)/.exec(r.body.setupLink)![1];
    const set = await h.call("post", "/auth/reset", undefined, { token, password: "lakeshore diesel morning" });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const login = await h.call("post", "/auth/login", undefined, { email: "boss@peelwaste.example", password: "lakeshore diesel morning" });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ role: "owner", home: "/live" });
    expect((await h.call("get", "/routes?date=2026-11-20", login.body.token)).status).toBe(403);
    expect((await h.call("get", "/vehicles", login.body.token)).status).toBe(200);
    const row = (await h.admin.query("SELECT o.plan, o.slug, e.sections, e.limits FROM organizations o JOIN org_entitlements e ON e.org_id = o.id WHERE o.id = $1", [r.body.id])).rows[0];
    expect(row).toMatchObject({ plan: "starter", slug: "peel-waste-haulers", sections: ["tracking"], limits: { vehicles: 5 } });
    expect((await h.call("post", "/admin/clients", managerTok, { name: "Dup", ownerEmail: "boss@peelwaste.example", ownerName: "x" })).status).toBe(409);
  });

  it("lists clients with usage and health, and filters by name", async () => {
    const all = await h.call("get", "/admin/clients", auditorTok);
    expect(all.status).toBe(200);
    expect(all.body.length).toBeGreaterThanOrEqual(3);
    const one = (all.body as { name: string; usage: unknown; health: unknown; entitlements: unknown }[]).find((c) => c.name === "Peel Waste Haulers")!;
    expect(one).toBeTruthy();
    expect(one.usage).toBeTruthy();
    expect(one.health).toBeTruthy();
    expect((await h.call("get", "/admin/clients?q=peel", auditorTok)).body).toHaveLength(1);
    const detail = await h.call("get", `/admin/clients/${one && (all.body as { id: string; name: string }[]).find((c) => c.name === "Peel Waste Haulers")!.id}`, supportTok);
    expect(detail.status).toBe(200);
    expect(detail.body.users[0]).toMatchObject({ email: "boss@peelwaste.example", role: "owner" });
    // viewing a client's details is itself logged
    expect((await h.admin.query("SELECT 1 FROM platform_audit WHERE action = 'client.viewed' AND admin_email = 'support@routenorth.example'")).rowCount).toBeGreaterThan(0);
  });

  it("monitoring shows trackers that went quiet", async () => {
    const dev = (await h.admin.query("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'traccar','356938035643809') RETURNING id", [h.orgB])).rows[0].id;
    await h.admin.query("INSERT INTO latest_positions (device_id, org_id, time, lat, lng) VALUES ($1,$2, now() - interval '3 days', 43.7, -79.4)", [dev, h.orgB]);
    const o = await h.call("get", "/admin/overview", auditorTok);
    expect(o.status).toBe(200);
    expect(o.body.clients.total).toBeGreaterThanOrEqual(3);
    expect(o.body.attention.map((c: { id: string }) => c.id)).toContain(h.orgB);
    const b = (await h.call("get", "/admin/clients", auditorTok)).body.find((c: { id: string }) => c.id === h.orgB);
    expect(b.health.flags.map((f: { code: string }) => f.code)).toContain("no_data");
  });

  it("finds who holds a tracker ID, and logs the lookup", async () => {
    const hit = await h.call("get", "/admin/devices/lookup?source=traccar&id=356938035643809", supportTok);
    expect(hit.body).toMatchObject({ found: true, holder: { orgId: h.orgB } });
    expect((await h.call("get", "/admin/devices/lookup?source=traccar&id=000", supportTok)).body.found).toBe(false);
    expect((await h.admin.query("SELECT 1 FROM platform_audit WHERE action = 'device.lookup'")).rowCount).toBe(2);
  });
});

describe("managing staff", () => {
  it("makes a new account with a one-time setup, forces a password change first, and enforces the rules for the last super admin", async () => {
    const root = await staffToken("root@routenorth.example");
    await stepUp(root);
    const made = await h.call("post", "/admin/admins", root, { email: "new@routenorth.example", displayName: "New Person", role: "support" });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.setup.temporaryPassword).toBeTruthy();
    expect(made.body.setup.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(made.body.setup.recoveryCodes).toHaveLength(10);
    // password and secret are never listed afterwards
    const list = await h.call("get", "/admin/admins", root);
    expect(JSON.stringify(list.body)).not.toContain(made.body.setup.temporaryPassword);
    expect(JSON.stringify(list.body)).not.toContain(made.body.setup.totpSecret);
    // first sign-in with the temporary password and the new authenticator
    const login = await h.call("post", "/auth/login", undefined, { email: "new@routenorth.example", password: made.body.setup.temporaryPassword });
    const { fromBase32: fb, hotp: ht, stepOf: so } = await import("../security/totp.js");
    const code = ht(fb(made.body.setup.totpSecret), so());
    const ok = await h.call("post", "/auth/mfa", undefined, { challenge: login.body.challenge, code });
    expect(ok.status).toBe(200);
    expect(ok.body.user.mustChangePassword).toBe(true);
    const tok = ok.body.token as string;
    expect((await h.call("get", "/admin/clients", tok)).body.code).toBe("password_change_required");
    expect((await h.call("post", "/admin/me/password", tok, { current: made.body.setup.temporaryPassword, next: "short" })).status).toBe(400);
    expect((await h.call("post", "/admin/me/password", tok, { current: made.body.setup.temporaryPassword, next: "a-much-longer-passphrase-for-staff" })).status).toBe(200);
    expect((await h.call("get", "/admin/clients", tok)).status).toBe(200);
    // the only super admin cannot be demoted or disabled, and nobody changes their own role
    const admins = (await h.call("get", "/admin/admins", root)).body as { id: string; email: string }[];
    const rootId = admins.find((a) => a.email === "root@routenorth.example")!.id;
    expect((await h.call("patch", `/admin/admins/${rootId}`, root, { role: "support" })).status).toBe(403);
    expect((await h.call("patch", `/admin/admins/${rootId}`, root, { disabled: true })).status).toBe(403);
    // promoting a second one and then removing the first is fine; removing the last is not
    const newId = admins.find((a) => a.email === "new@routenorth.example")!.id;
    expect((await h.call("patch", `/admin/admins/${newId}`, root, { role: "super_admin" })).status).toBe(200);
    expect((await h.call("patch", `/admin/admins/${newId}`, root, { disabled: true })).status).toBe(200);
    expect((await h.call("patch", `/admin/admins/${newId}`, root, { role: "support" })).status).toBe(200);
    superTok = root;
  });

  it("a role change ends that person's sessions, and a credential reset replaces password and authenticator", async () => {
    const id = await addStaff("reset@routenorth.example", "support");
    const tok = await staffToken("reset@routenorth.example");
    const root = superTok;
    await stepUp(root);
    expect((await h.call("patch", `/admin/admins/${id}`, root, { role: "auditor" })).status).toBe(200);
    expect((await h.call("get", "/admin/me", tok)).status).toBe(401);
    const rs = await h.call("post", `/admin/admins/${id}/reset-credentials`, root);
    expect(rs.status).toBe(200);
    expect((await h.call("post", "/auth/login", undefined, { email: "reset@routenorth.example", password: STAFF_PW })).status).toBe(401);
    expect((await h.call("post", "/auth/login", undefined, { email: "reset@routenorth.example", password: rs.body.setup.temporaryPassword })).status).toBe(200);
  });
});

describe("the staff audit log", () => {
  it("records sign-ins, changes and refusals with who, what, which client and why", async () => {
    const r = await h.call("get", "/admin/audit?limit=200", auditorTok);
    expect(r.status).toBe(200);
    const actions = new Set((r.body.rows as { action: string }[]).map((x) => x.action));
    for (const a of ["login", "stepup", "client.access.changed", "client.suspended", "view_as.started", "client.created", "admin.created"]) expect(actions.has(a), a).toBe(true);
    const started = (r.body.rows as { action: string; reason: string; orgName: string; adminEmail: string }[]).find((x) => x.action === "view_as.started" && x.adminEmail === "support@routenorth.example")!;
    expect(started).toMatchObject({ adminEmail: "support@routenorth.example", orgName: "A" });
    expect(started.reason).toMatch(/.{10,}/);
    expect((await h.call("get", `/admin/audit?org=${h.orgA}&action=client.access`, auditorTok)).body.rows.length).toBeGreaterThan(0);
  });
  it("never keeps a password, code or secret", async () => {
    const dump = JSON.stringify((await h.admin.query("SELECT detail, reason, target FROM platform_audit")).rows);
    expect(dump).not.toContain(STAFF_PW);
    expect(dump).not.toContain(SEED);
  });
  it("cannot be edited or deleted, even by the database owner", async () => {
    await expect(h.admin.query("UPDATE platform_audit SET action = 'x'")).rejects.toThrow(/cannot be changed/);
    await expect(h.admin.query("DELETE FROM platform_audit")).rejects.toThrow(/cannot be changed/);
  });
});

describe("tenant isolation of the staff tables", () => {
  it("a client's database session cannot read or write any staff table, or call the staff functions", async () => {
    const { withOrg } = await import("@routenorth/db");
    await withOrg(h.app, h.orgA, async (c) => {
      for (const t of ["platform_admins", "platform_sessions", "platform_impersonations", "platform_audit"]) {
        expect((await c.query(`SELECT * FROM ${t}`)).rowCount, t).toBe(0);
      }
      expect((await c.query("SELECT * FROM platform_org_stats()")).rowCount).toBe(0);
      expect((await c.query("SELECT * FROM platform_find_device('traccar','356938035643809')")).rowCount).toBe(0);
      // it can read its own entitlements (the guard needs them) but not another company's
      expect((await c.query("SELECT org_id FROM org_entitlements")).rows.every((r) => r.org_id === h.orgA)).toBe(true);
    });
    await expect(withOrg(h.app, h.orgA, (c) => c.query("INSERT INTO platform_audit (action) VALUES ('forged')"))).rejects.toThrow();
    await expect(withOrg(h.app, h.orgA, (c) => c.query("INSERT INTO org_entitlements (org_id, sections) VALUES ($1, ARRAY['tracking'])", [h.orgB]))).rejects.toThrow();
    // an UPDATE of its own entitlements matches no rows: a client cannot give itself more
    const upd = await withOrg(h.app, h.orgA, (c) => c.query("UPDATE org_entitlements SET sections = ARRAY['tracking','finance']"));
    expect(upd.rowCount).toBe(0);
    expect((await withOrg(h.app, h.orgA, (c) => c.query("UPDATE organizations SET status = 'active', internal_notes = 'x'"))).rowCount).toBe(1);
  });
  it("a client cannot see or change another company's row even though staff can see all", async () => {
    const { withOrg } = await import("@routenorth/db");
    const seen = await withOrg(h.app, h.orgA, (c) => c.query("SELECT id FROM organizations"));
    expect(seen.rows.map((r) => r.id)).toEqual([h.orgA]);
  });
  it("internal notes are never sent to a client", async () => {
    await stepUp(managerTok);
    await h.call("patch", `/admin/clients/${h.orgA}`, managerTok, { internalNotes: "slow payer, handle with care" });
    const owner = await h.token("a@example.com");
    for (const p of ["/me", "/org"]) expect(JSON.stringify((await h.call("get", p, owner)).body)).not.toContain("slow payer");
  });
});

void newRecoveryCodes; void hashRecovery;
