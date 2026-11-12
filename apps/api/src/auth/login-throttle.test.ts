import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle.js";

describe("sign-in throttle", () => {
  it("blocks an email after 5 failures until the window ends; success clears it", () => {
    let t = 0;
    const th = new LoginThrottle(5, 30, 60_000, () => t);
    for (let i = 0; i < 4; i++) th.fail("a@x.ca", "1.1.1.1");
    expect(th.blockedFor("a@x.ca", "1.1.1.1")).toBe(0);
    th.fail("a@x.ca", "1.1.1.1");
    expect(th.blockedFor("a@x.ca", "2.2.2.2")).toBe(60);
    expect(th.blockedFor("b@x.ca", "1.1.1.1")).toBe(0);
    t = 60_000;
    expect(th.blockedFor("a@x.ca", "1.1.1.1")).toBe(0);
    for (let i = 0; i < 4; i++) th.fail("a@x.ca", "1.1.1.1");
    th.succeed("a@x.ca");
    th.fail("a@x.ca", "1.1.1.1");
    expect(th.blockedFor("a@x.ca", "1.1.1.1")).toBe(0);
  });
  it("blocks one address trying many emails", () => {
    const th = new LoginThrottle(5, 30, 60_000, () => 0);
    for (let i = 0; i < 30; i++) th.fail(`u${i}@x.ca`, "9.9.9.9");
    expect(th.blockedFor("new@x.ca", "9.9.9.9")).toBeGreaterThan(0);
    expect(th.blockedFor("new@x.ca", "8.8.8.8")).toBe(0);
  });
});
