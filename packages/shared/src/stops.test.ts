import { describe, expect, it } from "vitest";
import { classifyStop, estimateEtas, evaluateStop, type StopState } from "./stops.js";

const stop = (over: Partial<StopState> = {}): StopState => ({
  id: "s1", lat: 43.65, lng: -79.38, radiusM: 75, status: "pending",
  insideSince: null, outsideSince: null, arrivedAt: null, departedAt: null, ...over,
});
// ~0.00045 degrees of latitude is about 50 m.
const at = (sec: number, dLat = 0, speed = 5) => ({
  time: new Date(Date.parse("2026-11-02T15:00:00Z") + sec * 1000).toISOString(),
  lat: 43.65 + dLat, lng: -79.38, speed,
});
const run = (s: StopState, fixes: ReturnType<typeof at>[]) => {
  let cur = s;
  for (const f of fixes) {
    const p = evaluateStop(cur, f);
    if (p) cur = { ...cur, ...p };
  }
  return cur;
};

describe("evaluateStop arrival", () => {
  it("arrives after dwelling, stamped with the first fix inside", () => {
    const s = run(stop(), [at(0, 0.002), at(10, 0.0003), at(20, 0.0002), at(30, 0.0001), at(45, 0.0001)]);
    expect(s.status).toBe("arrived");
    expect(s.arrivedAt).toBe(at(10).time);
  });

  it("ignores a drive-through at speed", () => {
    const s = run(stop(), [at(0, 0.0005, 50), at(10, 0.0002, 50), at(20, -0.0002, 50), at(30, -0.0006, 50)]);
    expect(s.status).toBe("pending");
    expect(s.insideSince).toBeNull();
  });

  it("ignores a brief GPS spike inside the radius", () => {
    const s = run(stop(), [at(0, 0.01), at(10, 0.0001), at(20, 0.01), at(30, 0.01)]);
    expect(s.status).toBe("pending");
  });

  it("does not arrive while outside the radius, however long", () => {
    const s = run(stop(), Array.from({ length: 20 }, (_, i) => at(i * 10, 0.002, 0)));
    expect(s.status).toBe("pending");
  });

  it("restarts the dwell clock after leaving and re-entering", () => {
    const s = run(stop(), [at(0, 0.0001), at(20, 0.002), at(40, 0.0001), at(60, 0.0001)]);
    expect(s.status).toBe("pending"); // only 20 s inside since re-entry
    expect(run(s, [at(80, 0.0001)]).arrivedAt).toBe(at(40).time);
  });
});

describe("evaluateStop departure", () => {
  const arrived = stop({ status: "arrived", arrivedAt: at(0).time });

  it("departs after staying outside the departure radius, stamped with the first exit fix", () => {
    const s = run(arrived, [at(100, 0.001), at(110, 0.0015), at(135, 0.002)]);
    expect(s.status).toBe("done");
    expect(s.departedAt).toBe(at(110).time);
  });

  it("does not depart on jitter between the radius and the departure radius", () => {
    // 0.00135 deg is about 150 m... use ~90 m: inside 1.5 x 75 m
    const s = run(arrived, [at(100, 0.0008), at(130, 0.0008), at(160, 0.0008)]);
    expect(s.status).toBe("arrived");
  });

  it("does not depart on a single outlying fix", () => {
    const s = run(arrived, [at(100, 0.003), at(110, 0.0001), at(120, 0.0001)]);
    expect(s.status).toBe("arrived");
    expect(s.outsideSince).toBeNull();
  });
});

describe("evaluateStop leaves finished stops alone", () => {
  for (const status of ["done", "failed", "skipped"] as const) {
    it(`never changes a ${status} stop`, () => {
      expect(evaluateStop(stop({ status }), at(0, 0))).toBeNull();
    });
  }
  it("returns null when nothing changed", () => {
    expect(evaluateStop(stop(), at(0, 0.01))).toBeNull();
  });
});

describe("estimateEtas", () => {
  it("chains stops in order, adding service time", () => {
    const from = { lat: 43.65, lng: -79.38, time: "2026-11-02T15:00:00Z" };
    // ~11.1 km north, then ~11.1 km further north
    const etas = estimateEtas([{ id: "a", lat: 43.75, lng: -79.38 }, { id: "b", lat: 43.85, lng: -79.38 }], from);
    const a = Date.parse(etas.get("a")!) - Date.parse(from.time);
    const b = Date.parse(etas.get("b")!) - Date.parse(etas.get("a")!);
    // 11.1 km * 1.3 at 40 km/h is about 21.7 minutes
    expect(a / 60_000).toBeGreaterThan(21);
    expect(a / 60_000).toBeLessThan(23);
    expect(b / 60_000).toBeGreaterThan(26); // 21.7 min + 5 min service
    expect(b / 60_000).toBeLessThan(28);
  });
  it("returns nothing for no stops", () => {
    expect(estimateEtas([], { lat: 0, lng: 0, time: "2026-11-02T15:00:00Z" }).size).toBe(0);
  });
});

describe("classifyStop", () => {
  const w = { windowStart: "2026-11-02T15:00:00Z", windowEnd: "2026-11-02T16:00:00Z" };
  it("classifies against the window", () => {
    expect(classifyStop({ status: "done", ...w, arrivedAt: "2026-11-02T15:30:00Z" })).toBe("on_time");
    expect(classifyStop({ status: "done", ...w, arrivedAt: "2026-11-02T16:05:00Z" })).toBe("late");
    expect(classifyStop({ status: "done", ...w, arrivedAt: "2026-11-02T14:40:00Z" })).toBe("early");
  });
  it("handles no window, missed and pending", () => {
    expect(classifyStop({ status: "done", windowStart: null, windowEnd: null, arrivedAt: "2026-11-02T15:30:00Z" })).toBe("no_window");
    expect(classifyStop({ status: "failed", ...w, arrivedAt: null })).toBe("missed");
    expect(classifyStop({ status: "pending", ...w, arrivedAt: null })).toBe("pending");
  });
});
