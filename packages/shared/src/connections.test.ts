import { describe, expect, it } from "vitest";
import { connectionStatus, luhnValid, normalizeTrackerId, setupInstructions, sourceForMethod } from "./connections.js";

const now = new Date("2026-11-14T15:00:00Z");
const mins = (n: number) => new Date(now.getTime() - n * 60_000).toISOString();

describe("normalizeTrackerId", () => {
  it("accepts a real-looking IMEI and strips spaces and dashes", () => {
    expect(luhnValid("356307042441013")).toBe(true);
    const r = normalizeTrackerId("traccar", " 356 307-042441-013 ");
    expect(r).toEqual({ ok: true, id: "356307042441013", warnings: [], kind: "imei" });
  });
  it("refuses a 15-digit number whose check digit is wrong, in words an owner can use", () => {
    const r = normalizeTrackerId("traccar", "356307042441014");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/label on the tracker/);
  });
  it("warns, but accepts, a serial number or short id", () => {
    const r = normalizeTrackerId("traccar", "1234567890");
    expect(r.ok && r.warnings.length).toBe(1);
    const a = normalizeTrackerId("feed", "truck-12");
    expect(a).toEqual({ ok: true, id: "truck-12", warnings: [], kind: "provider" });
  });
  it("refuses empty input, words with spaces and odd characters", () => {
    expect(normalizeTrackerId("traccar", "").ok).toBe(false);
    expect(normalizeTrackerId("feed", "truck 12").ok).toBe(false);
    expect(normalizeTrackerId("feed", "tr/uck").ok).toBe(false);
    expect(normalizeTrackerId("feed", "ab").ok).toBe(false);
  });
  it("hints when a Geotab or Samsara id looks like a name", () => {
    const g = normalizeTrackerId("geotab", "Truck12");
    expect(g.ok && g.warnings.length).toBe(1);
    expect(normalizeTrackerId("geotab", "b1F")).toMatchObject({ ok: true, warnings: [] });
    const s = normalizeTrackerId("samsara", "Truck12");
    expect(s.ok && s.warnings.length).toBe(1);
    expect(normalizeTrackerId("samsara", "212014918086169")).toMatchObject({ ok: true, warnings: [] });
  });
  it("maps methods onto the device source", () => {
    expect(sourceForMethod("traccar")).toBe("traccar");
    expect(["feed", "geotab", "samsara"].map((m) => sourceForMethod(m as never))).toEqual(["feed", "feed", "feed"]);
  });
});

describe("connectionStatus", () => {
  const base = { method: "traccar" as const, hasDevice: true, registeredAt: mins(2), lastSeen: null, now };
  it("says nothing is connected when there is no tracker", () => {
    expect(connectionStatus({ ...base, hasDevice: false, method: null }).state).toBe("not_connected");
  });
  it("is patient in the first minutes, then shows the checklist", () => {
    const early = connectionStatus(base);
    expect(early.state).toBe("waiting_first_ping");
    expect(early.fixes).toEqual([]);
    const late = connectionStatus({ ...base, registeredAt: mins(40) });
    expect(late.state).toBe("waiting_first_ping");
    expect(late.fixes.length).toBeGreaterThan(2);
    expect(late.detail).toContain("40 minutes ago");
  });
  it("is connected with a recent position and quiet with an old one", () => {
    expect(connectionStatus({ ...base, lastSeen: mins(3) })).toMatchObject({ state: "connected", minutesSince: 3 });
    const q = connectionStatus({ ...base, lastSeen: mins(300) });
    expect(q.state).toBe("quiet");
    expect(q.detail).toContain("5 hours ago");
    expect(q.fixes.length).toBeGreaterThan(0);
  });
  it("reports a failing provider login before anything else", () => {
    const e = connectionStatus({ ...base, method: "geotab", lastSeen: mins(1), provider: { status: "error", lastError: "The password was refused.", lastSyncAt: mins(1) } });
    expect(e).toMatchObject({ state: "error", detail: "The password was refused." });
    const p = connectionStatus({ ...base, method: "samsara", provider: { status: "paused", lastError: null, lastSyncAt: null } });
    expect(p.state).toBe("quiet");
  });
});

describe("setupInstructions", () => {
  it("says what the operator must set, instead of showing a made-up address", () => {
    const none = setupInstructions("traccar", { ingestUrl: null, traccarHost: null, traccarPorts: [] });
    expect(none.ready).toBe(false);
    expect(none.missing[0]).toContain("TRACCAR_PUBLIC_HOST");
    const ok = setupInstructions("traccar", { ingestUrl: null, traccarHost: "track.example.ca", traccarPorts: [{ protocol: "Teltonika", port: 5027 }] });
    expect(ok.ready).toBe(true);
    expect(ok.steps.join(" ")).toContain("track.example.ca");
    expect(ok.steps.join(" ")).toContain("Teltonika on port 5027");
    expect(setupInstructions("feed", { ingestUrl: null, traccarHost: null, traccarPorts: [] }).missing[0]).toContain("INGEST_PUBLIC_URL");
    expect(setupInstructions("geotab", { ingestUrl: null, traccarHost: null, traccarPorts: [] }).ready).toBe(true);
  });
});

import { deviceExternalId, displayTrackerId } from "./connections.js";
describe("external ids", () => {
  it("tags pulled ids with the provider the way the connectors do, and strips the tag for display", () => {
    expect(deviceExternalId("geotab", "b1F")).toBe("geotab:b1F");
    expect(deviceExternalId("samsara", "123")).toBe("samsara:123");
    expect(deviceExternalId("traccar", "356307042441013")).toBe("356307042441013");
    expect(displayTrackerId("geotab:b1F")).toBe("b1F");
    expect(displayTrackerId("truck-12")).toBe("truck-12");
  });
});
