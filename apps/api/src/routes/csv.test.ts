import { describe, expect, it } from "vitest";
import { csvToObjects, parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("handles quotes, embedded commas, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
  it("handles newlines inside quotes and skips blank lines", () => {
    expect(parseCsv('a,b\n"line1\nline2",2\n\n')).toEqual([["a", "b"], ["line1\nline2", "2"]]);
  });
  it("strips a BOM (Excel exports)", () => {
    expect(parseCsv("﻿name\nA")[0]).toEqual(["name"]);
  });
});

describe("csvToObjects", () => {
  it("normalizes header names", () => {
    expect(csvToObjects("Name, Window Start ,lat\nA,2026-11-02T14:00:00Z,43.6")).toEqual([
      { name: "A", window_start: "2026-11-02T14:00:00Z", lat: "43.6" },
    ]);
  });
  it("returns nothing for empty input", () => expect(csvToObjects("")).toEqual([]));
});
