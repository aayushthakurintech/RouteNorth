import { describe, expect, it } from "vitest";
import { parseCsvText } from "./csv-parse";

describe("parseCsvText", () => {
  it("reads headers and rows", () => { expect(parseCsvText("a,b\n1,2\n3,4\n")).toEqual({ headers: ["a", "b"], rows: [{ a: "1", b: "2" }, { a: "3", b: "4" }] }); });
  it("handles quotes, doubled quotes and commas inside values", () => {
    expect(parseCsvText('name,note\n"Smith, J","said ""hi"""\n').rows[0]).toEqual({ name: "Smith, J", note: 'said "hi"' });
  });
  it("handles newlines inside quotes and Windows line endings", () => {
    expect(parseCsvText('a,b\r\n"x\ny",2\r\n').rows[0]).toEqual({ a: "x\ny", b: "2" });
  });
  it("detects semicolons and tabs, and strips a byte order mark", () => {
    expect(parseCsvText("﻿a;b\n1;2").headers).toEqual(["a", "b"]);
    expect(parseCsvText("a\tb\n1\t2").rows[0]).toEqual({ a: "1", b: "2" });
  });
  it("skips blank lines and pads short rows", () => { expect(parseCsvText("a,b\n\n1\n").rows).toEqual([{ a: "1", b: "" }]); });
  it("copes with an empty file", () => { expect(parseCsvText("")).toEqual({ headers: [], rows: [] }); });
});
