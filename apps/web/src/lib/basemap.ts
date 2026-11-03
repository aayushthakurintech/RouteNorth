import type { StyleSpecification } from "maplibre-gl";

/** Public development tile servers; self-host for production (NEXT_PUBLIC_TILE_URL / _DARK / _SATELLITE). */
export const TILES = {
  street: process.env.NEXT_PUBLIC_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  dark: process.env.NEXT_PUBLIC_TILE_URL_DARK ?? "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
  satellite: process.env.NEXT_PUBLIC_TILE_URL_SATELLITE ?? "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
};
export const GLYPHS_URL = process.env.NEXT_PUBLIC_GLYPHS_URL ?? "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

export type Basemap = "street" | "satellite";

/** One style with all three raster layers; `basemapLayer` says which one is visible. */
export function baseStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      street: { type: "raster", tiles: [TILES.street], tileSize: 256, attribution: "© OpenStreetMap contributors" },
      dark: { type: "raster", tiles: [TILES.dark], tileSize: 256, attribution: "© OpenStreetMap contributors © CARTO" },
      satellite: { type: "raster", tiles: [TILES.satellite], tileSize: 256, attribution: "Imagery © Esri" },
    },
    layers: [
      { id: "base-street", type: "raster", source: "street" },
      { id: "base-dark", type: "raster", source: "dark", layout: { visibility: "none" } },
      { id: "base-satellite", type: "raster", source: "satellite", layout: { visibility: "none" } },
    ],
  };
}

export function basemapLayer(basemap: Basemap, theme: "light" | "dark" | "contrast"): "base-street" | "base-dark" | "base-satellite" {
  if (basemap === "satellite") return "base-satellite";
  return theme === "dark" ? "base-dark" : "base-street";
}

export function applyBasemap(map: { setLayoutProperty: (id: string, k: string, v: string) => void }, basemap: Basemap, theme: "light" | "dark" | "contrast") {
  const show = basemapLayer(basemap, theme);
  for (const id of ["base-street", "base-dark", "base-satellite"]) map.setLayoutProperty(id, "visibility", id === show ? "visible" : "none");
}

/** Link that opens Google Street View at a position. */
export const streetViewUrl = (lat: number, lng: number) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lng}`;
