import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { classifyRoute } from "@routenorth/shared";
import { AppModule } from "../app.module.js";
import { RESOURCES } from "../resources/defs.js";
import { AuthGuard } from "../auth/auth.guard.js";
import { PlatformGuard } from "./platform-auth.js";

/**
 * The guard refuses any signed-in route that no entitlement rule covers (so a new controller cannot leak into a section
 * a client does not have). This test turns that into a build failure instead of a surprise: add the path to API_ROUTE_RULES.
 */
const mod = AppModule.register({ pool: null as never, bus: null as never, jwtSecret: "x".repeat(32) });
const controllers = (mod.controllers ?? []) as (new (...a: never[]) => unknown)[];

function routes() {
  const out: { controller: string; method: number; path: string; guards: unknown[] }[] = [];
  for (const C of controllers) {
    const prefix: string = Reflect.getMetadata("path", C) ?? "";
    const classGuards: unknown[] = Reflect.getMetadata("__guards__", C) ?? [];
    for (const name of Object.getOwnPropertyNames(C.prototype)) {
      if (name === "constructor") continue;
      const fn = C.prototype[name as never] as unknown as object;
      const p = Reflect.getMetadata("path", fn);
      if (p === undefined) continue;
      out.push({
        controller: C.name, method: Reflect.getMetadata("method", fn),
        path: "/" + [prefix, p].join("/").replace(/\/+/g, "/").replace(/^\/|\/$/g, ""),
        guards: [...classGuards, ...(Reflect.getMetadata("__guards__", fn) ?? [])],
      });
    }
  }
  return out;
}

describe("every signed-in route belongs to a section or to the always-on core", () => {
  const all = routes();
  const signedIn = all.filter((r) => r.guards.includes(AuthGuard));

  it("finds the routes", () => {
    expect(all.length).toBeGreaterThan(400);
    expect(signedIn.length).toBeGreaterThan(300);
  });

  it("classifies all of them", () => {
    const missing = signedIn.filter((r) => !r.path.startsWith("/r/:") && classifyRoute(r.path) === null).map((r) => `${r.controller} ${r.path}`);
    expect(missing).toEqual([]);
  });

  it("classifies every generic resource (/r/<name>) one by one", () => {
    expect(RESOURCES.length).toBeGreaterThan(20);
    expect(RESOURCES.filter((r) => classifyRoute(`/r/${r.name}`) === null).map((r) => r.name)).toEqual([]);
    expect(["training-items", "work-orders", "shops", "report-defs"].filter((n) => classifyRoute(`/r/${n}`) === null)).toEqual([]);
  });

  it("keeps staff routes out of the client guard and the client guard out of the staff routes", () => {
    const staff = all.filter((r) => r.path.startsWith("/admin"));
    expect(staff.length).toBeGreaterThan(20);
    for (const r of staff) {
      expect(r.guards.includes(PlatformGuard), r.path).toBe(true);
      expect(r.guards.includes(AuthGuard), r.path).toBe(false);
    }
    expect(all.filter((r) => !r.path.startsWith("/admin") && r.guards.includes(PlatformGuard))).toEqual([]);
  });

  it("only routes with no guard are the public and sign-in ones", () => {
    // Open on purpose: sign-in and public pages, and the key-protected feeds (which check the company's status and sections themselves).
    const open = all.filter((r) => r.guards.length === 0).map((r) => r.path);
    for (const p of open) expect(/^\/(auth|public|feeds|inbound)(\/|$)/.test(p), p).toBe(true);
  });
});
