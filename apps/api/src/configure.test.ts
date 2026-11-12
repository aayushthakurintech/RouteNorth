import { describe, expect, it } from "vitest";
import { trustProxySetting } from "./configure.js";

describe("TRUST_PROXY", () => {
  it("reads a hop count or a list, and refuses to trust everyone", () => {
    expect(trustProxySetting(undefined)).toBeUndefined();
    expect(trustProxySetting("0")).toBeUndefined();
    expect(trustProxySetting("1")).toBe(1);
    expect(trustProxySetting("10.0.0.0/8, loopback")).toEqual(["10.0.0.0/8", "loopback"]);
    expect(() => trustProxySetting("true")).toThrow(/forge/);
  });
});
