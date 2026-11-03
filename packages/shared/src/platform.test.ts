import { describe, expect, it } from "vitest";
import { applyMapping, autoMap, buildIcs, checkCustomValues, INTEGRATIONS, invoiceCsv, parseEmailJob, rowsToCsv, tileChoice } from "./platform.js";

describe("tileChoice", () => {
  it("builds a provider URL only with a key", () => {
    expect(tileChoice("maptiler", "abc").url).toContain("key=abc");
    expect(tileChoice("mapbox", "tok").url).toContain("access_token=tok");
    expect(tileChoice("here", "k").url).toContain("apiKey=k");
    expect(tileChoice("maptiler", "").url).toBeNull();
  });
  it("lets a custom https URL win and ignores unsafe ones", () => {
    expect(tileChoice("osm", "", "https://tiles.example.com/{z}/{x}/{y}.png").url).toBe("https://tiles.example.com/{z}/{x}/{y}.png");
    expect(tileChoice("osm", "", "http://tiles.example.com/{z}/{x}/{y}.png").url).toBeNull();
    expect(tileChoice("osm", "", "javascript:alert(1)").url).toBeNull();
  });
  it("does not pretend Google tiles work", () => { expect(tileChoice("google", "k")).toMatchObject({ url: null, supported: false }); });
  it("encodes the key", () => { expect(tileChoice("maptiler", "a&b").url).toContain("key=a%26b"); });
});

describe("parseEmailJob", () => {
  const mail = { from: 'Pat Lee <pat@shop.ca>', subject: "Fwd: Delivery for tomorrow", text: "Hi,\nDeliver to: 22 Elm Ave, Ottawa ON\nCall 613-555-0199 on arrival.\n> quoted line 5 Old Rd\n-- \nPat" };
  it("finds the address, phone, name, email and date", () => {
    const j = parseEmailJob(mail, "2026-03-10");
    expect(j).toMatchObject({ title: "Delivery for tomorrow", customerName: "Pat Lee", customerEmail: "pat@shop.ca", customerPhone: "613-555-0199", address: "22 Elm Ave, Ottawa ON", scheduledDate: "2026-03-11", type: "delivery" });
  });
  it("ignores quoted lines and signatures", () => { expect(parseEmailJob(mail, "2026-03-10").address).not.toContain("Old Rd"); });
  it("finds an unlabelled street line and a pick-up", () => {
    const j = parseEmailJob({ subject: "Pickup please", text: "Please collect\n450 King Street West\nthanks" }, "2026-03-10");
    expect(j).toMatchObject({ address: "450 King Street West", type: "pickup", scheduledDate: null });
  });
  it("reads French labels and dates", () => {
    const j = parseEmailJob({ subject: "Livraison demain", text: "Adresse : 12 rue Saint-Denis, Montréal" }, "2026-03-10");
    expect(j).toMatchObject({ address: "12 rue Saint-Denis, Montréal", scheduledDate: "2026-03-11" });
  });
  it("copes with nothing useful", () => {
    const j = parseEmailJob({}, "2026-03-10");
    expect(j.title).toBe("Email job");
    expect(j.address).toBeNull();
  });
});

describe("buildIcs", () => {
  const ics = buildIcs("Route; north", [{ uid: "a@x", start: new Date("2026-03-10T14:00:00Z"), end: new Date("2026-03-10T15:30:00Z"), summary: "Stop, A", description: "line1\nline2", location: "1 Main" }], new Date("2026-03-01T00:00:00Z"));
  it("is a valid calendar with CRLF endings", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain("DTSTART:20260310T140000Z");
    expect(ics).toContain("SUMMARY:Stop\\, A");
    expect(ics).toContain("DESCRIPTION:line1\\nline2");
    expect(ics).toContain("X-WR-CALNAME:Route\\; north");
  });
  it("folds long lines at 75 bytes", () => {
    const long = buildIcs("x", [{ uid: "b", start: new Date(0), end: new Date(1000), summary: "é".repeat(100) }]);
    for (const l of long.split("\r\n")) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });
});

describe("invoiceCsv", () => {
  const inv = [{ number: "INV-1", customer: 'Acme, "Inc"', email: "a@acme.ca", issuedOn: "2026-03-01", dueOn: "2026-03-31", currency: "CAD", status: "sent", lines: [{ description: "Delivery", qty: 2, unitPrice: 50 }, { description: "Rush", qty: 1, unitPrice: 10, amount: 10 }], subtotal: 110, tax: 14.3, total: 124.3 }];
  it("writes one row per line for each program", () => {
    for (const f of ["quickbooks", "xero", "sage"] as const) {
      const rows = invoiceCsv(inv, f).trim().split("\r\n");
      expect(rows).toHaveLength(3);
    }
  });
  it("quotes values and keeps the amounts", () => {
    const qb = invoiceCsv(inv, "quickbooks");
    expect(qb).toContain('"Acme, ""Inc"""');
    expect(qb.split("\r\n")[1]).toContain(",100,");
  });
  it("uses a single line when the invoice has none", () => {
    expect(invoiceCsv([{ ...inv[0]!, lines: [] }], "xero").trim().split("\r\n")).toHaveLength(2);
  });
  it("puts the tax only on the first Sage line", () => {
    const s = invoiceCsv(inv, "sage").trim().split("\r\n");
    expect(s[1]).toContain("14.30"); expect(s[2]).toContain("0.00");
  });
});

describe("import wizard", () => {
  it("maps Onfleet-style headers", () => {
    const m = autoMap(["Recipient Name", "Recipient Phone", "Address", "Recipient Notes", "Complete After"], "onfleet");
    expect(m).toMatchObject({ customer_name: "Recipient Name", customer_phone: "Recipient Phone", address: "Address", notes: "Recipient Notes" });
  });
  it("uses each column once and leaves unknowns empty", () => {
    const m = autoMap(["Name", "Address", "Weight"], "generic");
    expect(m.title).toBe("Name"); expect(m.customer_name).toBe(""); expect(m.weight_kg).toBe("Weight");
  });
  it("applies the mapping and cleans dates, types and priorities", () => {
    const rows = applyMapping([{ N: "A", D: "12/31/2026", T: "Drop off", P: "Rush", X: "ignored" }], { title: "N", scheduled_date: "D", type: "T", priority: "P" });
    expect(rows[0]).toEqual({ title: "A", scheduled_date: "2026-12-31", type: "delivery", priority: "urgent" });
  });
  it("reads day-first dates when the first number cannot be a month", () => {
    expect(applyMapping([{ D: "25/12/2026" }], { scheduled_date: "D" })[0]!.scheduled_date).toBe("2026-12-25");
  });
  it("writes CSV for the importer with only the used columns", () => {
    const csv = rowsToCsv([{ title: 'A "x"', address: "1 Main, Ottawa" }]);
    expect(csv.split("\r\n")[0]).toBe("title,address");
    expect(csv).toContain('"A ""x"""');
  });
});

describe("checkCustomValues", () => {
  const defs = [{ key: "po", label: "PO", type: "text" as const, required: true }, { key: "pallets", label: "Pallets", type: "number" as const }, { key: "gate", label: "Gate", type: "select" as const, options: ["A", "B"] }, { key: "due", label: "Due", type: "date" as const }, { key: "old", label: "Old", type: "text" as const, active: false }];
  it("accepts good values and converts types", () => {
    expect(checkCustomValues(defs, { po: "123", pallets: "4", gate: "A", due: "2026-03-10" })).toEqual({ ok: true, values: { po: "123", pallets: 4, gate: "A", due: "2026-03-10" } });
  });
  it("rejects unknown, inactive, wrong or missing values", () => {
    expect(checkCustomValues(defs, { nope: 1 })).toMatchObject({ ok: false });
    expect(checkCustomValues(defs, { old: "x" })).toMatchObject({ ok: false });
    expect(checkCustomValues(defs, { pallets: "many" })).toMatchObject({ ok: false });
    expect(checkCustomValues(defs, { gate: "C" })).toMatchObject({ ok: false });
    expect(checkCustomValues(defs, { due: "tomorrow" })).toMatchObject({ ok: false });
    expect(checkCustomValues(defs, { po: "" })).toMatchObject({ ok: false });
  });
  it("lets a value be cleared", () => { expect(checkCustomValues(defs, { pallets: null })).toEqual({ ok: true, values: { pallets: null } }); });
});

describe("catalog", () => {
  it("points every entry at a playbook item", () => { for (const i of INTEGRATIONS) expect(i.item).toMatch(/^integ\.\d+$/); });
  it("has no duplicate ids", () => { expect(new Set(INTEGRATIONS.map((i) => i.id)).size).toBe(INTEGRATIONS.length); });
});
