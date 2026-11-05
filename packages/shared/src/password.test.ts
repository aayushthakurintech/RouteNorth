import { describe, expect, it } from "vitest";
import { passwordProblem, passwordStrength } from "./password.js";

describe("passwordProblem", () => {
  it("wants at least 10 characters", () => {
    expect(passwordProblem("short1!")).toBe("short");
    expect(passwordProblem("a".repeat(201))).toBe("long");
  });
  it("refuses the passwords everyone tries, with or without punctuation", () => {
    expect(passwordProblem("password123")).toBe("common");
    expect(passwordProblem("Pass-word-123")).toBe("common");
    expect(passwordProblem("1234567890")).toBe("common");
  });
  it("refuses repeats", () => {
    expect(passwordProblem("aaaaaaaaaaaa")).toBe("repeated");
    expect(passwordProblem("abcabcabcabc")).toBe("repeated");
  });
  it("refuses a password built from the email, name or company", () => {
    expect(passwordProblem("priya-sharma-2026", { email: "priya.sharma@acme.ca", name: "Priya Sharma" })).toBe("personal");
    expect(passwordProblem("northwind-trucking!", { company: "Northwind Trucking" })).toBe("personal");
  });
  it("accepts a long passphrase and does not demand symbols", () => {
    expect(passwordProblem("correct horse battery staple")).toBeNull();
    expect(passwordProblem("lakeshore diesel morning")).toBeNull();
  });
  it("ignores short name parts, so 'Jo' does not forbid every password containing jo", () => {
    expect(passwordProblem("joyful-river-stones", { name: "Jo" })).toBeNull();
  });
});

describe("passwordStrength", () => {
  it("is 0 for empty or too short, and low for refused ones", () => {
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("abc")).toBe(0);
    expect(passwordStrength("password123")).toBe(1);
  });
  it("rises with length and variety", () => {
    expect(passwordStrength("lakeshore")).toBe(0);
    expect(passwordStrength("lakeshoredi")).toBeGreaterThanOrEqual(2);
    expect(passwordStrength("correct horse battery staple")).toBe(4);
    expect(passwordStrength("lakeshore diesel")).toBeLessThanOrEqual(passwordStrength("lakeshore diesel morning 42!"));
  });
});
