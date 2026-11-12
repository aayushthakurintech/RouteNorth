import { describe, expect, it } from "vitest";
import { deliver, isPrivateIp, publicAddressProblem } from "./notifier.js";

describe("webhook address guard", () => {
  it("knows private and public addresses", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "142.250.72.14", "2606:4700:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it("refuses a public name that resolves to a private address", async () => {
    expect(await publicAddressProblem("https://hooks.example.com/x", async () => ["10.0.0.5"])).toMatch(/private/);
    expect(await publicAddressProblem("https://hooks.example.com/x", async () => ["93.184.216.34", "127.0.0.1"])).toMatch(/private/);
    expect(await publicAddressProblem("https://hooks.example.com/x", async () => ["93.184.216.34"])).toBeNull();
    expect(await publicAddressProblem("https://nowhere.example.com/x", async () => { throw new Error("ENOTFOUND"); })).toMatch(/could not be found/);
    expect(await publicAddressProblem("http://hooks.example.com/x", async () => ["93.184.216.34"])).toMatch(/https/);
  });
  it("does not call a webhook the guard refuses", async () => {
    let called = false;
    const r = await deliver({ id: "1", kind: "webhook", target: "https://hooks.example.com/x", label: "x" }, { subject: "s", text: "t" },
      { fetch: (async () => { called = true; return new Response(null); }) as typeof fetch, guard: async () => "the address points to a private network" });
    expect(r).toEqual({ ok: false, error: "the address points to a private network" });
    expect(called).toBe(false);
  });
});
