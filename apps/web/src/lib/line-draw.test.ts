import { describe, expect, it } from "vitest";
import { partialLine } from "./line-draw";

const line: [number, number][] = [[0, 0], [2, 0], [2, 2]];

describe("partialLine", () => {
  it("returns the whole line at 1 and only the start at 0", () => {
    expect(partialLine(line, 1)).toEqual(line);
    expect(partialLine(line, 0)).toEqual([[0, 0]]);
  });
  it("cuts inside a segment", () => {
    expect(partialLine(line, 0.25)).toEqual([[0, 0], [1, 0]]);
    expect(partialLine(line, 0.75)).toEqual([[0, 0], [2, 0], [2, 1]]);
  });
  it("keeps a corner when the cut lands exactly on it", () => {
    expect(partialLine(line, 0.5)).toEqual([[0, 0], [2, 0], [2, 0]]);
  });
  it("leaves short or flat lines alone", () => {
    expect(partialLine([[1, 1]], 0.5)).toEqual([[1, 1]]);
    expect(partialLine([[1, 1], [1, 1]], 0.5)).toEqual([[1, 1], [1, 1]]);
  });
});
