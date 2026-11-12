import { describe, expect, it } from "vitest";
import { flagEnabled, resolveFlags, rolloutBucket, type FlagDef } from "./flags.js";

const defs: FlagDef[] = [{ key: "a", default: false, rolloutPct: 0 }, { key: "b", default: true, rolloutPct: 100 }, { key: "c", default: false, rolloutPct: 30 }];

describe("feature flags", () => {
  it("is off when nothing turns it on and on when the default says so", () => {
    expect(flagEnabled("a", "org1", {}, defs)).toBe(false);
    expect(flagEnabled("b", "org1", {}, defs)).toBe(true);
    expect(flagEnabled("nope", "org1", {}, defs)).toBe(false);
  });
  it("lets an organization override in both directions", () => {
    expect(flagEnabled("a", "org1", { a: true }, defs)).toBe(true);
    expect(flagEnabled("b", "org1", { b: false }, defs)).toBe(false);
  });
  it("gives the same answer every time and only adds organizations as the percentage grows", () => {
    expect(rolloutBucket("org1", "c")).toBe(rolloutBucket("org1", "c"));
    const orgs = Array.from({ length: 400 }, (_, i) => `org-${i}`);
    const at = (pct: number) => orgs.filter((o) => flagEnabled("c", o, {}, [{ key: "c", default: false, rolloutPct: pct }]));
    const ten = at(10), fifty = at(50);
    expect(ten.every((o) => fifty.includes(o))).toBe(true);
    expect(fifty.length).toBeGreaterThan(140); expect(fifty.length).toBeLessThan(260);
    expect(at(0)).toHaveLength(0); expect(at(100)).toHaveLength(400);
  });
  it("resolves every flag at once", () => { expect(resolveFlags("org1", { a: true }, defs)).toMatchObject({ a: true, b: true }); });
});
