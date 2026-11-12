import { describe, expect, it } from "vitest";
import { HELP_ARTICLES, scoreArticle } from "./help.js";

describe("help search", () => {
  it("needs every word, ranks title hits first and ignores accents and case", () => {
    const a = { title: "Add a driver", body: "Invite the person and give them the Driver role" };
    const b = { title: "Reports", body: "Export a driver scorecard" };
    expect(scoreArticle(a, "DRIVER")).toBeGreaterThan(scoreArticle(b, "driver"));
    expect(scoreArticle(a, "driver scorecard")).toBe(0);
    expect(scoreArticle({ title: "Équipes", body: "régions" }, "equipes regions")).toBeGreaterThan(0);
    expect(scoreArticle(a, "   ")).toBe(1);
  });
  it("has unique article ids", () => { expect(new Set(HELP_ARTICLES.map((x) => x.id)).size).toBe(HELP_ARTICLES.length); });
});
