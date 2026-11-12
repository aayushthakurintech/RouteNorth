import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Providers } from "../notify/notifier.js";
import { resetLimits } from "../customer/public.controller.js";
import { PASSWORD, startHarness, type Harness } from "../test-harness.js";

let h: Harness;
const sent: { url: string; body: string }[] = [];
const stub: Providers = { fetch: (async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: String(init.body) }); return new Response("{}"); }) as typeof fetch, email: { apiKey: "k", from: "noreply@example.com", url: "https://email.test/send" }, sms: null };
const linkIn = (body: string) => /\/reset\/([A-Za-z0-9_-]+)/.exec(body.replace(/\\n/g, " "))?.[1] ?? "";
const good = { company: "Northwind Trucking", name: "Priya Shah", email: "priya@northwind.example", password: "lakeshore diesel morning", acceptTerms: true };

beforeAll(async () => { h = await startHarness({ notify: stub }); }, 90_000);
afterAll(async () => { await h.close(); });

describe("sign-up", () => {
  it("creates a company with its owner, signs them in and records what they agreed to", async () => {
    resetLimits();
    const r = await h.call("post", "/auth/signup", undefined, { ...good, marketing: false, locale: "fr" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.user).toMatchObject({ role: "owner", locale: "fr" });
    const me = await h.call("get", "/me", r.body.token);
    expect(me.status).toBe(200);
    const org = (await h.admin.query("SELECT name, plan, slug FROM organizations WHERE id = $1", [r.body.user.orgId])).rows[0];
    expect(org).toMatchObject({ name: "Northwind Trucking", plan: "trial" });
    expect(org.slug).toMatch(/^[a-z0-9-]+$/);
    const consent = (await h.admin.query("SELECT terms_version, marketing_email FROM signup_consents WHERE user_id = $1", [r.body.user.id])).rows[0];
    expect(consent).toEqual({ terms_version: "2026-11", marketing_email: false });
    expect((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'auth.signup' AND org_id = $1", [r.body.user.orgId])).rowCount).toBe(1);
  });
  it("lets the new owner sign in again with the same password", async () => {
    expect((await h.call("post", "/auth/login", undefined, { email: good.email, password: good.password })).status).toBe(200);
  });
  it("keeps marketing email consent separate and off unless ticked", async () => {
    resetLimits();
    const r = await h.call("post", "/auth/signup", undefined, { ...good, email: "second@northwind.example", marketing: true });
    expect(r.status).toBe(201);
    expect((await h.admin.query("SELECT marketing_email FROM signup_consents WHERE user_id = $1", [r.body.user.id])).rows[0].marketing_email).toBe(true);
  });
  it("refuses a taken email, a weak or personal password, missing consent and bad input", async () => {
    resetLimits();
    expect((await h.call("post", "/auth/signup", undefined, good)).status).toBe(409);
    expect((await h.call("post", "/auth/signup", undefined, { ...good, email: "x1@example.com", password: "password123" })).status).toBe(400);
    expect((await h.call("post", "/auth/signup", undefined, { ...good, email: "x2@example.com", password: "northwind-trucking-1" })).status).toBe(400);
    expect((await h.call("post", "/auth/signup", undefined, { ...good, email: "x3@example.com", acceptTerms: false })).status).toBe(400);
    expect((await h.call("post", "/auth/signup", undefined, { ...good, email: "not-an-email" })).status).toBe(400);
    expect((await h.call("post", "/auth/signup", undefined, { ...good, email: "x4@example.com", company: "" })).status).toBe(400);
  });
  it("keeps one company's data away from another", async () => {
    resetLimits();
    const a = await h.call("post", "/auth/signup", undefined, { ...good, email: "iso1@example.com" });
    const b = await h.call("post", "/auth/signup", undefined, { ...good, email: "iso2@example.com", company: "Lakeshore Buses" });
    await h.call("post", "/vehicles", a.body.token, { name: "Only A", kind: "truck" });
    const list = await h.call("get", "/vehicles", b.body.token);
    expect(JSON.stringify(list.body)).not.toContain("Only A");
  });
  it("is limited per address", async () => {
    resetLimits();
    let last = 0;
    for (let i = 0; i < 8; i++) last = (await h.call("post", "/auth/signup", undefined, { ...good, email: `rl${i}@example.com` })).status;
    expect(last).toBe(429);
  });
});

describe("password reset", () => {
  it("answers the same for a known and an unknown email, and emails only the known one", async () => {
    resetLimits(); sent.length = 0;
    const known = await h.call("post", "/auth/forgot", undefined, { email: good.email });
    const unknown = await h.call("post", "/auth/forgot", undefined, { email: "nobody@example.com" });
    expect(known.status).toBe(202); expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toContain(good.email);
    expect(sent[0]!.body).toContain("/reset/");
  });
  it("changes the password once, ends old sessions and the link stops working", async () => {
    resetLimits(); sent.length = 0;
    const before = (await h.call("post", "/auth/login", undefined, { email: good.email, password: good.password })).body.token as string;
    await h.call("post", "/auth/forgot", undefined, { email: good.email });
    const token = linkIn(sent[0]!.body);
    expect(token.length).toBeGreaterThan(20);
    expect((await h.call("post", "/auth/reset", undefined, { token, password: "password123" })).status).toBe(400); // too common; the link is not used up by a refused password
    const next = "harbour lights at dawn";
    expect((await h.call("post", "/auth/reset", undefined, { token, password: next })).status).toBe(200);
    expect((await h.call("post", "/auth/reset", undefined, { token, password: "another long passphrase" })).status).toBe(400); // used
    expect((await h.call("post", "/auth/login", undefined, { email: good.email, password: good.password })).status).toBe(401);
    expect((await h.call("post", "/auth/login", undefined, { email: good.email, password: next })).status).toBe(200);
    expect((await h.call("get", "/me", before)).status).toBe(401); // the session from before the reset is gone
    expect((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'auth.password.reset'")).rowCount).toBeGreaterThan(0);
  });
  it("only the newest link works, and expired or made-up links are refused", async () => {
    resetLimits(); sent.length = 0;
    await h.call("post", "/auth/forgot", undefined, { email: good.email });
    const first = linkIn(sent[0]!.body);
    resetLimits();
    await h.call("post", "/auth/forgot", undefined, { email: good.email });
    const second = linkIn(sent[1]!.body);
    expect((await h.call("post", "/auth/reset", undefined, { token: first, password: "first attempt passphrase" })).status).toBe(400);
    await h.admin.query("UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL");
    expect((await h.call("post", "/auth/reset", undefined, { token: second, password: "second attempt passphrase" })).status).toBe(400);
    expect((await h.call("post", "/auth/reset", undefined, { token: "x".repeat(43), password: "third attempt passphrase" })).status).toBe(400);
    expect((await h.call("post", "/auth/reset", undefined, { token: "short", password: "third attempt passphrase" })).status).toBe(400);
  });
  it("does not email a disabled account, and limits repeat requests", async () => {
    resetLimits(); sent.length = 0;
    await h.admin.query("UPDATE users SET disabled_at = now() WHERE email = 'second@northwind.example'");
    expect((await h.call("post", "/auth/forgot", undefined, { email: "second@northwind.example" })).status).toBe(202);
    expect(sent).toHaveLength(0);
    resetLimits();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await h.call("post", "/auth/forgot", undefined, { email: good.email })).status);
    expect(codes[3]).toBe(429);
    expect((await h.call("post", "/auth/forgot", undefined, { email: "bad" })).status).toBe(400);
  });
  it("the app role cannot read the reset links directly", async () => {
    const r = await h.app.query("SELECT count(*)::int AS n FROM password_resets");
    expect(r.rows[0].n).toBe(0);
  });
});
void PASSWORD;
