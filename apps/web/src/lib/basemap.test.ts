import { describe, expect, it } from "vitest";
import { baseStyle, configureBasemap } from "./basemap";

const street = () => (baseStyle().sources.street as { tiles: string[] }).tiles[0];

describe("map provider", () => {
  it("uses the default tiles until a provider with a key is chosen", () => {
    configureBasemap("osm", "", "");
    expect(street()).toContain("basemaps.cartocdn.com");
    configureBasemap("maptiler", "", "");
    expect(street()).toContain("basemaps.cartocdn.com");
  });
  it("switches to the chosen provider and back", () => {
    configureBasemap("mapbox", "tok", "");
    expect(street()).toContain("api.mapbox.com");
    configureBasemap("here", "k", "");
    expect(street()).toContain("hereapi.com");
    configureBasemap("osm", "", "");
    expect(street()).toContain("basemaps.cartocdn.com");
  });
  it("a custom https tile address wins; others are ignored", () => {
    configureBasemap("osm", "", "https://tiles.example.com/{z}/{x}/{y}.png");
    expect(street()).toBe("https://tiles.example.com/{z}/{x}/{y}.png");
    configureBasemap("osm", "", "http://insecure/{z}/{x}/{y}.png");
    expect(street()).toContain("basemaps.cartocdn.com");
  });
});
