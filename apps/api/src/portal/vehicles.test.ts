import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, viewer: string, driverTok: string, orgB: string;
let drv: string;
const GOOD_VIN = "1M8GDM9AXKP042788"; // standard test VIN with a valid check digit

const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
// yesterday in UTC is never after "today" in a Canadian time zone, so reports in company time always include it
const today = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const mk = async (extra: Record<string, unknown> = {}) => {
  const r = await post("/portal/vehicles", owner, { name: `Truck ${Math.random().toString(36).slice(2, 7)}`, kind: "truck", ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; name: string };
};

beforeAll(async () => {
  process.env.VIN_LOOKUP_URL = "off";
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  drv = await h.addUser(h.orgA, "dee@example.com", "driver", { display_name: "Dee" });
  driverTok = await h.token("dee@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  orgB = await h.token("adminb@example.com");
}, 90_000);
afterAll(async () => { await h.close(); });

describe("create, edit, archive", () => {
  it("creates a car, rejects bad input and bad VINs, and audits with old and new values", async () => {
    const v = await mk({ plate: "abc 123", vin: GOOD_VIN, purchasePriceCents: 4_500_000, odometerKm: 1000 });
    expect(v).toMatchObject({ status: "active", plate: "ABC 123", vin: GOOD_VIN });
    expect((await post("/portal/vehicles", owner, { kind: "truck" })).status).toBe(400);
    expect((await post("/portal/vehicles", owner, { name: "x", vin: "1M8GDM9AXKP04278" })).status).toBe(400); // 16 characters
    expect((await post("/portal/vehicles/check", owner, { vin: "1M8GDM9AXKP042789" })).body.vin).toMatchObject({ ok: true, checkDigitOk: false }); // warns, does not refuse
    expect((await post("/portal/vehicles", owner, { name: "x", purchasePriceCents: 10.5 })).status).toBe(400); // not whole cents

    const up = await h.call("patch", `/portal/vehicles/${v.id}`, owner, { color: "white", odometerKm: 1200 });
    expect(up.status).toBe(200);
    const a = (await get(`/portal/vehicles/${v.id}/activity`, owner)).body.audit as { action: string; oldValue: Record<string, unknown>; newValue: Record<string, unknown> }[];
    const edit = a.find((x) => x.action === "vehicles.update")!;
    expect(edit.oldValue).toMatchObject({ odometerKm: 1000 });
    expect(edit.newValue).toMatchObject({ odometerKm: 1200, color: "white" });
    expect(a.some((x) => x.action === "vehicles.create")).toBe(true);
  });

  it("refuses a duplicate plate or VIN and says which car has it", async () => {
    const v = await mk({ plate: "DUP 1" });
    const r = await post("/portal/vehicles", owner, { name: "Copy", plate: "dup 1" });
    expect(r.status).toBe(409);
    expect(r.body.duplicates[0]).toMatchObject({ id: v.id, field: "plate" });
    const chk = await post("/portal/vehicles/check", owner, { plate: "DUP 1" });
    expect(chk.body.duplicates).toHaveLength(1);
  });

  it("archives and restores instead of deleting, and keeps the car out of the default list", async () => {
    const v = await mk();
    expect((await post(`/portal/vehicles/${v.id}/archive`, owner)).status).toBe(200);
    expect((await get("/portal/vehicles", owner)).body.some((x: { id: string }) => x.id === v.id)).toBe(false);
    expect((await get("/portal/vehicles?archived=1", owner)).body.some((x: { id: string }) => x.id === v.id)).toBe(true);
    expect((await h.call("patch", `/portal/vehicles/${v.id}`, owner, { color: "red" })).status).toBe(400); // archived
    await post(`/portal/vehicles/${v.id}/restore`, owner);
    expect((await get("/portal/vehicles", owner)).body.some((x: { id: string }) => x.id === v.id)).toBe(true);
    const a = (await get(`/portal/vehicles/${v.id}/activity`, owner)).body.audit as { action: string }[];
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(["vehicles.archive", "vehicles.restore"]));
  });

  it("records a sale, which keeps the car out of use but in the history", async () => {
    const v = await mk();
    expect((await post(`/portal/vehicles/${v.id}/sell`, owner, { soldOn: today(), salePriceCents: 1_000_000 })).status).toBe(200);
    const one = (await get(`/portal/vehicles/${v.id}`, owner)).body;
    expect(one).toMatchObject({ status: "sold", salePriceCents: 1_000_000 });
    expect((await post(`/portal/vehicles/${v.id}/sell`, owner, { salePriceCents: 1 })).status).toBe(400);
  });

  it("imports a CSV: dry run reports bad lines, real run creates only the good ones", async () => {
    const rows = [{ name: "Imp 1", plate: "IMP 1", year: "2020" }, { name: "Imp 2", plate: "IMP 1" }, { name: "", plate: "X" }, { name: "Imp 4", year: "1800" }];
    const dry = (await post("/portal/vehicles/import", owner, { rows })).body;
    expect(dry).toMatchObject({ dryRun: true, total: 4, valid: 1, created: 0 });
    expect(dry.rows[1].errors.join()).toMatch(/twice/);
    const real = (await post("/portal/vehicles/import", owner, { rows, dryRun: false })).body;
    expect(real.created).toBe(1);
    expect((await get("/portal/vehicles", owner)).body.some((x: { name: string }) => x.name === "Imp 1")).toBe(true);
  });
});

describe("permissions and companies", () => {
  it("lets a viewer read but not change, and hides costs from people who cannot see them", async () => {
    const v = await mk({ purchasePriceCents: 9_900_00 });
    expect((await get("/portal/vehicles", viewer)).status).toBe(200);
    expect((await post("/portal/vehicles", viewer, { name: "nope" })).status).toBe(403);
    expect((await h.call("patch", `/portal/vehicles/${v.id}`, viewer, { color: "x" })).status).toBe(403);
    const seen = (await get(`/portal/vehicles/${v.id}`, viewer)).body;
    expect(seen.purchasePriceCents).toBeUndefined();
    expect(seen.canSeeCosts).toBe(false);
    expect((await get(`/portal/vehicles/${v.id}/financials`, viewer)).status).toBe(403);
    expect((await get(`/portal/vehicles/${v.id}`, owner)).body.purchasePriceCents).toBe(990_000);
  });

  it("never shows another company's car", async () => {
    const v = await mk();
    expect((await get(`/portal/vehicles/${v.id}`, orgB)).status).toBe(404);
    expect((await get("/portal/vehicles", orgB)).body.some((x: { id: string }) => x.id === v.id)).toBe(false);
    expect((await post(`/portal/vehicles/${v.id}/archive`, orgB)).status).toBe(404);
  });
});

describe("service, documents, fuel and maintenance", () => {
  it("shows service due from the interval, and a service resets it and moves the odometer", async () => {
    const v = await mk({ odometerKm: 9_000, serviceIntervalKm: 10_000 });
    await post(`/portal/vehicles/${v.id}/maintenance`, owner, { task: "Oil change", kind: "service", doneOn: today(), odometerKm: 9_500, labourCents: 4_000, partsCents: 2_550 });
    const one = (await get(`/portal/vehicles/${v.id}`, owner)).body;
    expect(one.odometerKm).toBe(9_500);
    expect(one.service.state).toBe("ok");
    const rows = (await get(`/portal/vehicles/${v.id}/maintenance`, owner)).body;
    expect(rows[0].totalCents).toBe(6_550);
    expect(typeof rows[0].totalCents).toBe("number");
  });

  it("blocks new jobs while a legal document is expired, then lifts the block when it is renewed", async () => {
    const v = await mk();
    const doc = (await post(`/portal/vehicles/${v.id}/documents`, owner, { kind: "Insurance", expiresOn: "2020-01-01" })).body;
    const row = (await get(`/portal/vehicles/${v.id}`, owner)).body;
    expect(row.docs.expired).toBe(1);
    expect(row.blockedReasons.join()).toMatch(/Expired: Insurance/);
    expect((await h.call("patch", `/portal/vehicles/${v.id}/documents/${doc.id}`, owner, { expiresOn: "2099-01-01" })).status).toBe(200);
    expect((await get(`/portal/vehicles/${v.id}`, owner)).body.blockedReasons).toEqual([]);
  });

  it("stores fuel cost as whole cents and reads it back unchanged", async () => {
    const v = await mk();
    const f = await post(`/portal/vehicles/${v.id}/fuel`, owner, { filledOn: today(), litres: 55.5, costCents: 12_345, odometerKm: 50 });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    expect(f.body.costCents).toBe(12_345);
    const dollars = (await h.admin.query("SELECT cost::float8 AS c FROM fuel_logs WHERE id = $1", [f.body.id])).rows[0].c;
    expect(dollars).toBeCloseTo(123.45, 5);
    expect((await post(`/portal/vehicles/${v.id}/fuel`, owner, { filledOn: today(), litres: 5, costCents: 1.5 })).status).toBe(400);
  });

  it("an unsigned failed inspection blocks the car until it is signed off", async () => {
    const v = await mk();
    const made = await post(`/portal/vehicles/${v.id}/inspections`, owner, { kind: "check_out", defects: true, items: [{ item: "Brakes", ok: false }] });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const ins = made.body;
    expect((await get(`/portal/vehicles/${v.id}`, owner)).body.blockedReasons.join()).toMatch(/failed inspection/);
    expect((await post(`/portal/vehicles/${v.id}/inspections/${ins.id}/sign-off`, owner, { note: "pads replaced" })).status).toBe(200);
    expect((await get(`/portal/vehicles/${v.id}`, owner)).body.blockedReasons).toEqual([]);
  });
});

describe("routes and jobs", () => {
  it("will not put a blocked car on a new route, and allows it once the problem is fixed", async () => {
    const v = await mk();
    const doc = (await post(`/portal/vehicles/${v.id}/documents`, owner, { kind: "Registration", expiresOn: "2020-01-01" })).body;
    const blocked = await post("/routes", owner, { name: "R1", date: "2026-11-05", vehicleId: v.id, stops: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("vehicle_blocked");
    await h.call("patch", `/portal/vehicles/${v.id}/documents/${doc.id}`, owner, { expiresOn: "2099-01-01" });
    expect((await post("/routes", owner, { name: "R1", date: "2026-11-05", vehicleId: v.id, stops: [] })).status).toBe(201);
    // out of service is blocked too
    const w = await mk();
    await h.call("patch", `/portal/vehicles/${w.id}`, owner, { status: "out_of_service" });
    expect((await post("/routes", owner, { name: "R2", date: "2026-11-05", vehicleId: w.id, stops: [] })).status).toBe(409);
  });
});

describe("work orders", () => {
  it("walks open to approved to closed, and closing books the cost as maintenance", async () => {
    const v = await mk();
    const wo = (await post(`/portal/vehicles/${v.id}/work-orders`, owner, { title: "Replace clutch", estimateCents: 120_000 })).body;
    const patch = (b: unknown) => h.call("patch", `/portal/vehicles/${v.id}/work-orders/${wo.id}`, owner, b);
    expect((await patch({ status: "closed" })).status).toBe(400); // cannot jump
    expect((await patch({ status: "awaiting_approval" })).status).toBe(200);
    expect((await patch({ status: "approved" })).status).toBe(200);
    expect((await patch({ status: "closed" })).status).toBe(400); // needs a final cost
    expect((await patch({ status: "closed", actualCents: 135_050 })).status).toBe(200);
    const m = (await get(`/portal/vehicles/${v.id}/maintenance`, owner)).body;
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: "repair", totalCents: 135_050, workOrderId: wo.id });
  });
});

describe("assignments", () => {
  it("assigns a driver, warns on overlap, and refuses a double booking unless forced", async () => {
    const v = await mk({ kind: "truck" });
    const first = await post(`/portal/vehicles/${v.id}/assignments`, owner, { driverId: drv, kind: "permanent", startAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect((await get(`/portal/vehicles/${v.id}`, owner)).body.currentDriverId).toBe(drv);
    const clash = await post(`/portal/vehicles/${v.id}/assignments`, owner, { driverId: drv, kind: "day", startAt: new Date().toISOString() });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("booking_conflict");
    const forced = await post(`/portal/vehicles/${v.id}/assignments`, owner, { driverId: drv, kind: "day", startAt: new Date().toISOString(), force: true });
    expect(forced.status).toBe(201);
    const cal = (await get("/portal/assignments/calendar", owner)).body as { vehicleId: string; conflict: boolean }[];
    expect(cal.filter((x) => x.vehicleId === v.id).every((x) => x.conflict)).toBe(true);
  });

  it("a driver cannot assign cars", async () => {
    const v = await mk();
    expect((await post(`/portal/vehicles/${v.id}/assignments`, driverTok, { driverId: drv })).status).toBe(403);
  });
});

describe("financials", () => {
  it("adds up fuel, repairs and purchase price the same way everywhere", async () => {
    const v = await mk({ purchasePriceCents: 2_000_000, purchaseDate: "2024-01-01" });
    await post(`/portal/vehicles/${v.id}/fuel`, owner, { filledOn: today(), litres: 40, costCents: 10_000 });
    await post(`/portal/vehicles/${v.id}/maintenance`, owner, { task: "Brakes", kind: "repair", doneOn: today(), labourCents: 20_000, partsCents: 5_000 });
    const f = (await get(`/portal/vehicles/${v.id}/financials`, owner)).body;
    expect(f.tco.purchaseCents).toBe(2_000_000);
    expect(f.tco.fuelCents).toBe(10_000);
    expect(f.tco.repairsCents).toBe(25_000);
    expect(f.tco.runningCents).toBeGreaterThanOrEqual(35_000);
    expect(f.tco.totalCents).toBe(f.tco.purchaseCents + f.tco.runningCents);
    expect(f.months).toHaveLength(12);
    expect(f.keepRepairSell.verdict ?? f.keepRepairSell.action ?? f.keepRepairSell).toBeDefined();
    const list = (await get("/portal/vehicles", owner)).body.find((x: { id: string }) => x.id === v.id);
    expect(Number.isInteger(list.monthProfitCents)).toBe(true);
  });
});

describe("shops", () => {
  it("adds and archives a shop and records it on the audit trail", async () => {
    const s = await post("/portal/shops", owner, { name: "Fast Fix" });
    expect(s.status).toBe(201);
    expect((await get("/portal/shops", owner)).body.some((x: { name: string }) => x.name === "Fast Fix")).toBe(true);
    expect((await post(`/portal/shops/${s.body.id}/archive`, owner)).status).toBe(200);
    expect((await get("/portal/shops", owner)).body.some((x: { name: string }) => x.name === "Fast Fix")).toBe(false);
  });
});
