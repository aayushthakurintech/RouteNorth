import { describe, expect, it } from "vitest";
import { glideFrame, interpolate } from "./glide";

describe("glide", () => {
  it("moves part of the way and lands exactly", () => {
    expect(interpolate([0, 0], [10, 20], 0.5)).toEqual([5, 10]);
    expect(glideFrame({ a: [0, 0] }, { a: [10, 10] }, 1).a).toEqual([10, 10]);
    expect(glideFrame({ a: [0, 0] }, { a: [10, 10] }, 0).a).toEqual([0, 0]);
    const mid = glideFrame({ a: [0, 0] }, { a: [10, 10] }, 0.5).a!;
    expect(mid[0]).toBeGreaterThan(5); // ease-out is ahead of linear at the halfway mark
  });
  it("shows new vehicles at once", () => {
    expect(glideFrame({}, { b: [3, 4] }, 0).b).toEqual([3, 4]);
  });
});
