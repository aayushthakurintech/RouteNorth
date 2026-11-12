import { describe, expect, it } from "vitest";
import { pullDistance, PULL_THRESHOLD } from "./pull-refresh";

describe("pullDistance", () => {
  it("ignores upward movement", () => { expect(pullDistance(-40)).toBe(0); expect(pullDistance(0)).toBe(0); });
  it("resists and then stops", () => {
    expect(pullDistance(60)).toBe(30);
    expect(pullDistance(1000)).toBe(110);
  });
  it("needs a deliberate pull to refresh", () => { expect(pullDistance(PULL_THRESHOLD)).toBeLessThan(PULL_THRESHOLD); });
});
