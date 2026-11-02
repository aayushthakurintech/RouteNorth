import { describe, expect, it } from "vitest";
import { localToIso, moveStop } from "./routes.js";

describe("moveStop", () => {
  it("swaps with the neighbour", () => {
    expect(moveStop(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveStop(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });
  it("refuses to move past the ends", () => {
    expect(moveStop(["a", "b"], 0, -1)).toBeNull();
    expect(moveStop(["a", "b"], 1, 1)).toBeNull();
    expect(moveStop(["a"], 5, 1)).toBeNull();
  });
});

describe("localToIso", () => {
  it("converts and rejects empties", () => {
    expect(localToIso("")).toBeUndefined();
    expect(localToIso("nonsense")).toBeUndefined();
    expect(localToIso("2026-11-02T10:00")).toMatch(/^2026-11-02T\d\d:00:00\.000Z$/);
  });
});
