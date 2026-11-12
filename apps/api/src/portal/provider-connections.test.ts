import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret } from "@routenorth/db";
import type { FetchLike } from "@routenorth/shared";
import { SECRET, startHarness, type Harness } from "../test-harness.js";
import { PortalProviderConnectionsController } from "./provider-connections.controller.js";

let h: Harness, owner: string, driver: string, orgB: string;
const calls: string[] = [];
/** A fake Samsara: token "good" is accepted, anything else refused. */
const fakeFetch: FetchLike = async (url, init) => {
  calls.push(url);
  const ok = init.headers.authorization === "Bearer good";
  return { ok, status: ok ? 200 : 401, json: async () => ({ data: [] }) };
};

beforeAll(async () => {
  PortalProviderConnectionsController.fetchFn = fakeFetch;
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "drv@example.com", "driver"); driver = await h.token("drv@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
});
afterAll(async () => { await h.close(); });

describe("provider connections", () => {
  let id = "";

  it("checks the token with the provider and refuses a bad one", async () => {
    const bad = await h.call("post", "/portal/provider-connections", owner, { provider: "samsara", settings: { region: "us" }, secret: "nope" });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/refused the API token/);
    expect(calls.at(-1)).toBe("https://api.samsara.com/fleet/vehicles?limit=1");
  });

  it("saves a good one encrypted and never returns it", async () => {
    const r = await h.call("post", "/portal/provider-connections", owner, { provider: "samsara", name: "Samsara main", settings: { region: "us" }, secret: "good" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ provider: "samsara", name: "Samsara main", status: "pending", settings: { region: "us" } });
    id = r.body.id;
    const list = await h.call("get", "/portal/provider-connections", owner);
    expect(list.body.connections).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("good");
    expect(JSON.stringify(list.body)).not.toContain("secret");
    const stored = (await h.admin.query("SELECT secret_enc FROM provider_connections WHERE id = $1", [id])).rows[0].secret_enc;
    expect(stored).not.toContain("good");
    expect(decryptSecret(SECRET, stored)).toBe("good");
  });

  it("refuses Geotab servers outside geotab.com before calling anything", async () => {
    const n = calls.length;
    const r = await h.call("post", "/portal/provider-connections", owner, { provider: "geotab", settings: { server: "169.254.169.254", database: "d", userName: "u" }, secret: "p" });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/geotab\.com/);
    expect(calls.length).toBe(n);
  });

  it("pauses, resumes and removes; other companies and drivers cannot", async () => {
    expect((await h.call("post", `/portal/provider-connections/${id}/pause`, orgB)).status).toBe(404);
    expect((await h.call("get", "/portal/provider-connections", orgB)).body.connections).toEqual([]);
    expect((await h.call("get", "/portal/provider-connections", driver)).status).toBe(403);
    expect((await h.call("post", `/portal/provider-connections/${id}/pause`, owner)).status).toBe(200);
    expect((await h.admin.query("SELECT status FROM provider_connections WHERE id = $1", [id])).rows[0].status).toBe("paused");
    await h.admin.query("UPDATE provider_connections SET failures = 4 WHERE id = $1", [id]);
    expect((await h.call("post", `/portal/provider-connections/${id}/resume`, owner)).status).toBe(200);
    expect((await h.admin.query("SELECT status, failures FROM provider_connections WHERE id = $1", [id])).rows[0]).toEqual({ status: "pending", failures: 0 });
    expect((await h.call("delete", `/portal/provider-connections/${id}`, owner)).status).toBe(200);
    expect((await h.call("get", "/portal/provider-connections", owner)).body.connections).toEqual([]);
  });
});
