import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RouteNorthClient, RouteNorthError, verifyWebhook } from "./index.js";

const calls: { url: string; init: RequestInit }[] = [];
const fake = (status = 200, body: unknown = [{ id: "1" }]) => (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
const key = "rn_api_" + "k".repeat(32);

describe("client", () => {
  it("sends the key and builds the URL", async () => {
    calls.length = 0;
    const c = new RouteNorthClient({ baseUrl: "https://api.example.com/", apiKey: key, fetch: fake() });
    await c.jobs.list({ q: "a b", status: "" });
    expect(calls[0]!.url).toBe("https://api.example.com/r/jobs?q=a%20b");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
  });
  it("posts JSON bodies", async () => {
    calls.length = 0;
    const c = new RouteNorthClient({ baseUrl: "https://x.test", apiKey: key, fetch: fake(201, { id: "9" }) });
    expect(await c.jobs.create({ title: "T", address: "1 Main" })).toEqual({ id: "9" });
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ title: "T", address: "1 Main" });
  });
  it("encodes ids and resource names", async () => {
    calls.length = 0;
    const c = new RouteNorthClient({ baseUrl: "https://x.test", apiKey: key, fetch: fake() });
    await c.jobs.get("a/b");
    expect(calls[0]!.url).toBe("https://x.test/r/jobs/a%2Fb");
  });
  it("turns failures into errors carrying the server's message", async () => {
    const c = new RouteNorthClient({ baseUrl: "https://x.test", apiKey: key, fetch: fake(400, { message: "title is required" }) });
    await expect(c.jobs.create({ title: "" })).rejects.toMatchObject({ status: 400, message: "title is required" });
    await expect(c.jobs.create({ title: "" })).rejects.toBeInstanceOf(RouteNorthError);
  });
  it("refuses a bad base URL or key", () => {
    expect(() => new RouteNorthClient({ baseUrl: "ftp://x", apiKey: key })).toThrow();
    expect(() => new RouteNorthClient({ baseUrl: "https://x.test", apiKey: "nope" })).toThrow();
  });
  it("reaches assign, status, vehicles and routes", async () => {
    calls.length = 0;
    const c = new RouteNorthClient({ baseUrl: "https://x.test", apiKey: key, fetch: fake(200, {}) });
    await c.jobs.assign("j1", "d1"); await c.jobs.setStatus("j1", "done"); await c.vehicles.live(); await c.routes("2026-03-10");
    expect(calls.map((x) => x.url)).toEqual(["https://x.test/jobs/j1/assign", "https://x.test/jobs/j1/status", "https://x.test/vehicles/live", "https://x.test/routes?date=2026-03-10"]);
  });
});

describe("verifyWebhook", () => {
  const sign = (secret: string, t: number, body: string) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const now = 1_800_000_000_000;
  it("accepts a good signature", () => { expect(verifyWebhook("s3", sign("s3", now / 1000, "{}"), "{}", { now })).toBe(true); });
  it("rejects a wrong secret, a changed body and a malformed header", () => {
    expect(verifyWebhook("other", sign("s3", now / 1000, "{}"), "{}", { now })).toBe(false);
    expect(verifyWebhook("s3", sign("s3", now / 1000, "{}"), "{ }", { now })).toBe(false);
    expect(verifyWebhook("s3", "garbage", "{}", { now })).toBe(false);
  });
  it("rejects an old delivery", () => { expect(verifyWebhook("s3", sign("s3", now / 1000 - 3600, "{}"), "{}", { now })).toBe(false); });
});
