import { describe, expect, it } from "vitest";
import { frameAllowed } from "./widget";

describe("frameAllowed", () => {
  it("allows every site when no list is set", () => { expect(frameAllowed("https://x.com", "")).toBe(true); expect(frameAllowed(null, "  ")).toBe(true); });
  it("allows listed origins, ignoring case and trailing slashes", () => {
    expect(frameAllowed("https://shop.example.com", "https://Shop.example.com/, https://other.ca")).toBe(true);
    expect(frameAllowed("https://other.ca", "https://shop.example.com https://other.ca")).toBe(true);
  });
  it("blocks others and unknown parents once a list is set", () => {
    expect(frameAllowed("https://evil.com", "https://shop.example.com")).toBe(false);
    expect(frameAllowed("https://shop.example.com.evil.com", "https://shop.example.com")).toBe(false);
    expect(frameAllowed(null, "https://shop.example.com")).toBe(false);
  });
  it("supports a wildcard subdomain", () => {
    expect(frameAllowed("https://a.example.com", "https://*.example.com")).toBe(true);
    expect(frameAllowed("https://evilexample.com", "https://*.example.com")).toBe(false);
  });
});
