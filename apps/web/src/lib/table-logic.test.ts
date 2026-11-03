import { describe, expect, it } from "vitest";
import { filterRows, groupRows, sortRows, toCsv, windowRange, type Cell } from "./table-logic";

type R = { name: string; km: number | null; team: string };
const rows: R[] = [
  { name: "Truck 12", km: 40, team: "East" }, { name: "Truck 7", km: null, team: "West" },
  { name: "Bus 3", km: 120, team: "East" }, { name: "truck 2", km: 5, team: "" },
];
const get = (r: R, k: string) => (r as unknown as Record<string, Cell>)[k];

describe("table logic", () => {
  it("sorts numbers numerically and names naturally, blanks last in both directions", () => {
    expect(sortRows(rows, get, { key: "km", dir: "asc" }).map((r) => r.km)).toEqual([5, 40, 120, null]);
    expect(sortRows(rows, get, { key: "km", dir: "desc" }).map((r) => r.km)).toEqual([120, 40, 5, null]);
    expect(sortRows(rows, get, { key: "name", dir: "asc" }).map((r) => r.name)).toEqual(["Bus 3", "truck 2", "Truck 7", "Truck 12"]);
    expect(sortRows(rows, get, null)).toEqual(rows);
  });
  it("filters globally and per column", () => {
    expect(filterRows(rows, get, ["name", "team"], "truck", {})).toHaveLength(3);
    expect(filterRows(rows, get, ["name", "team"], "truck", { team: "east" }).map((r) => r.name)).toEqual(["Truck 12"]);
    expect(filterRows(rows, get, ["name"], "", {})).toHaveLength(4);
  });
  it("groups with counts and puts the blank group last", () => {
    const items = groupRows(rows, get, "team");
    const labels = items.filter((i) => i.kind === "group").map((i) => (i.kind === "group" ? `${i.label}:${i.count}` : ""));
    expect(labels).toEqual(["East:2", "West:1", "—:1"]);
    expect(groupRows(rows, get, null).every((i) => i.kind === "row")).toBe(true);
  });
  it("windows long lists", () => {
    expect(windowRange(1000, 0, 400, 40, 2)).toEqual({ first: 0, last: 12, padTop: 0, padBottom: 988 * 40 });
    const w = windowRange(1000, 4000, 400, 40, 2);
    expect(w.first).toBe(98); expect(w.last).toBe(112);
    expect(windowRange(5, 0, 400, 40).last).toBe(5);
  });
  it("writes safe CSV", () => {
    expect(toCsv(["a", "b"], [["x,y", '=SUM(1)'], [null, 'say "hi"']])).toBe('a,b\n"x,y",\'=SUM(1)\n,"say ""hi"""');
  });
});
