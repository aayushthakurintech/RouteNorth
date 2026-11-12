import { beforeEach, describe, expect, it } from "vitest";
import { backoffMs, checkProvider, clearConnectorSessions, ConnectorError, geotabReading, isGeotabServer, pullProvider, samsaraReadings, type FetchLike } from "./connectors.js";

/** A fake provider: records each request and answers from a queue. */
function fake(answers: { status?: number; body: unknown }[]) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    return { ok: (a.status ?? 200) < 400, status: a.status ?? 200, json: async () => a.body };
  };
  return { fetchFn, calls };
}

const geotab = { provider: "geotab" as const, settings: { server: "my.geotab.com", database: "acme", userName: "ops@acme.ca" }, secret: "pw" };
const auth = { body: { result: { credentials: { database: "acme", userName: "ops@acme.ca", sessionId: "s1" }, path: "my3.geotab.com" } } };

beforeEach(() => clearConnectorSessions());

describe("Geotab", () => {
  it("accepts only geotab.com servers", () => {
    expect(isGeotabServer("my.geotab.com")).toBe(true);
    expect(isGeotabServer("my3.geotab.com")).toBe(true);
    expect(isGeotabServer("evil.com")).toBe(false);
    expect(isGeotabServer("geotab.com.evil.com")).toBe(false);
    expect(isGeotabServer("169.254.169.254")).toBe(false);
  });

  it("maps a LogRecord and drops unusable ones", () => {
    const r = geotabReading({ dateTime: "2026-11-12T15:00:00.000Z", latitude: 45.5, longitude: -73.6, speed: 52, device: { id: "b12" } });
    expect(r).toMatchObject({ externalId: "geotab:b12", lat: 45.5, lng: -73.6, speed: 52, heading: 0, ignition: null });
    expect(geotabReading({ dateTime: "x", latitude: 1, longitude: 1, device: { id: "b1" } })).toBeNull();
    expect(geotabReading({ dateTime: "2026-11-12T15:00:00Z", latitude: 0, longitude: 0, device: { id: "b1" } })).toBeNull();
  });

  it("signs in, follows the server it names, and pulls from the saved version", async () => {
    const { fetchFn, calls } = fake([auth, { body: { result: { data: [
      { dateTime: "2026-11-12T15:01:00Z", latitude: 45.51, longitude: -73.6, speed: 10, device: { id: "b1" } },
      { dateTime: "2026-11-12T15:00:00Z", latitude: 45.5, longitude: -73.6, speed: 0, device: { id: "b1" } },
    ], toVersion: "000000000000a1" } } }]);
    const r = await pullProvider({ ...geotab, cursor: "0000000000009f" }, fetchFn);
    expect(calls[0]!.url).toBe("https://my.geotab.com/apiv1");
    expect(calls[0]!.body).toMatchObject({ method: "Authenticate", params: { database: "acme", userName: "ops@acme.ca", password: "pw" } });
    expect(calls[1]!.url).toBe("https://my3.geotab.com/apiv1");
    expect(calls[1]!.body.params).toMatchObject({ typeName: "LogRecord", fromVersion: "0000000000009f", credentials: { sessionId: "s1" } });
    expect(r.cursor).toBe("000000000000a1");
    expect(r.readings.map((x) => x.time)).toEqual(["2026-11-12T15:00:00.000Z", "2026-11-12T15:01:00.000Z"]);
    expect(r.more).toBe(false);
  });

  it("starts an hour back on the first pull", async () => {
    const { fetchFn, calls } = fake([auth, { body: { result: { data: [], toVersion: "v1" } } }]);
    await pullProvider({ ...geotab, cursor: null }, fetchFn, new Date("2026-11-12T16:00:00Z"));
    expect(calls[1]!.body.params.search).toEqual({ fromDate: "2026-11-12T15:00:00.000Z" });
    expect(calls[1]!.body.params.fromVersion).toBeUndefined();
  });

  it("signs in again once when the session has expired", async () => {
    const expired = { body: { error: { message: "Incorrect login", errors: [{ name: "InvalidUserException" }] } } };
    const { fetchFn, calls } = fake([auth, expired, auth, { body: { result: { data: [], toVersion: "v2" } } }]);
    const r = await pullProvider({ ...geotab, cursor: "v1" }, fetchFn);
    expect(calls.map((c) => c.body.method)).toEqual(["Authenticate", "GetFeed", "Authenticate", "GetFeed"]);
    expect(r.cursor).toBe("v2");
  });

  it("reports a wrong password as a login problem", async () => {
    const { fetchFn } = fake([{ body: { error: { message: "Incorrect login", errors: [{ name: "InvalidUserException" }] } } }]);
    const err = await checkProvider(geotab, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err.auth).toBe(true);
  });

  it("never calls a server outside geotab.com", async () => {
    const { fetchFn, calls } = fake([]);
    const err = await pullProvider({ ...geotab, settings: { ...geotab.settings, server: "internal.local" }, cursor: null }, fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(calls).toHaveLength(0);
  });
});

describe("Samsara", () => {
  const vehicle = {
    id: "281474976710655", name: "Truck 7",
    gps: [
      { time: "2026-11-12T15:00:00Z", latitude: 43.65, longitude: -79.38, headingDegrees: 90, speedMilesPerHour: 0 },
      { time: "2026-11-12T15:05:00Z", latitude: 43.66, longitude: -79.37, headingDegrees: 400, speedMilesPerHour: 31.07 },
    ],
    engineStates: [{ time: "2026-11-12T14:50:00Z", value: "Off" }, { time: "2026-11-12T15:02:00Z", value: "On" }],
  };

  it("maps GPS points with km/h speed and ignition from the engine state", () => {
    const r = samsaraReadings(vehicle);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ externalId: "samsara:281474976710655", speed: 0, heading: 90, ignition: false });
    expect(r[1]).toMatchObject({ speed: 50, heading: 40, ignition: true });
  });

  it("pages with the cursor and sends the token", async () => {
    const { fetchFn, calls } = fake([
      { body: { data: [vehicle], pagination: { endCursor: "c2", hasNextPage: true } } },
      { body: { data: [], pagination: { endCursor: "c3", hasNextPage: false } } },
    ]);
    const r = await pullProvider({ provider: "samsara", settings: { region: "us" }, secret: "tok", cursor: "c1" }, fetchFn);
    expect(calls[0]!.url).toBe("https://api.samsara.com/fleet/vehicles/stats/feed?types=gps,engineStates&after=c1");
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
    expect(calls[1]!.url).toContain("after=c2");
    expect(r).toMatchObject({ cursor: "c3", more: false });
    expect(r.readings).toHaveLength(2);
  });

  it("uses the EU host for EU accounts and treats 401 as a login problem", async () => {
    const { fetchFn, calls } = fake([{ status: 401, body: {} }]);
    const err = await pullProvider({ provider: "samsara", settings: { region: "eu" }, secret: "bad", cursor: null }, fetchFn).catch((e) => e);
    expect(calls[0]!.url.startsWith("https://api.eu.samsara.com/")).toBe(true);
    expect(err.auth).toBe(true);
  });

  it("stops early and asks for another pull when rate limited", async () => {
    const { fetchFn } = fake([{ status: 429, body: {} }]);
    const r = await pullProvider({ provider: "samsara", settings: { region: "us" }, secret: "t", cursor: "c1" }, fetchFn);
    expect(r).toMatchObject({ readings: [], cursor: "c1", more: true });
  });
});

describe("backoff", () => {
  it("doubles from a minute up to thirty, and waits an hour on a refused login", () => {
    expect(backoffMs(1, false)).toBe(60_000);
    expect(backoffMs(3, false)).toBe(240_000);
    expect(backoffMs(20, false)).toBe(1_800_000);
    expect(backoffMs(1, true)).toBe(3_600_000);
  });
});
