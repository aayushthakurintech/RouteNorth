"use client";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { STOP_COLORS, type RouteStop } from "@/lib/routes";

const TILE_URL = process.env.NEXT_PUBLIC_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const GLYPHS_URL = process.env.NEXT_PUBLIC_GLYPHS_URL ?? "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";

interface Props {
  stops: RouteStop[];
  /** Live position of the assigned vehicle, if known. */
  vehicle: { lat: number; lng: number } | null;
  /** When set, clicking the map reports the coordinates (used to place a new stop). */
  onPick: ((lat: number, lng: number) => void) | null;
  pin: { lat: number; lng: number } | null;
}

const colorExpr = [
  "match", ["get", "status"],
  "arrived", STOP_COLORS.arrived, "done", STOP_COLORS.done, "failed", STOP_COLORS.failed, "skipped", STOP_COLORS.skipped,
  STOP_COLORS.pending,
] as maplibregl.ExpressionSpecification;

export function RouteMap({ stops, vehicle, onPick, pin }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ stops, vehicle, onPick, pin });
  latest.current = { stops, vehicle, onPick, pin };
  const fitted = useRef(false);

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { stops: st, vehicle: v, pin: pn } = latest.current;
    (m.getSource("stops") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: st.map((s) => ({
        type: "Feature", properties: { status: s.status, label: String(s.sequence) },
        geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      })),
    });
    (m.getSource("path") as GeoJSONSource).setData({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: st.length > 1 ? st.map((s) => [s.lng, s.lat]) : [] },
    });
    (m.getSource("vehicle") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: v ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [v.lng, v.lat] } }] : [],
    });
    (m.getSource("pin") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: pn ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [pn.lng, pn.lat] } }] : [],
    });
    if (!fitted.current && st.length > 0) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      st.forEach((s) => b.extend([s.lng, s.lat]));
      m.fitBounds(b, { padding: 70, maxZoom: 14, duration: 0 });
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, center: [-79.38, 43.65], zoom: 9,
      style: {
        version: 8, glyphs: GLYPHS_URL,
        sources: { osm: { type: "raster", tiles: [TILE_URL], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] } as const;
      for (const id of ["stops", "path", "vehicle", "pin"]) m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({ id: "path", type: "line", source: "path", paint: { "line-color": "#64748b", "line-width": 2, "line-dasharray": [2, 2] } });
      m.addLayer({
        id: "stops", type: "circle", source: "stops",
        paint: { "circle-radius": 12, "circle-color": colorExpr, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });
      m.addLayer({
        id: "stop-labels", type: "symbol", source: "stops",
        layout: { "text-field": ["get", "label"], "text-size": 12, "text-font": ["Open Sans Regular"], "text-allow-overlap": true },
        paint: { "text-color": "#fff" },
      });
      m.addLayer({ id: "vehicle", type: "circle", source: "vehicle", paint: { "circle-radius": 8, "circle-color": "#2563eb", "circle-stroke-width": 3, "circle-stroke-color": "#fff" } });
      m.addLayer({ id: "pin", type: "circle", source: "pin", paint: { "circle-radius": 9, "circle-color": "#fff", "circle-stroke-width": 4, "circle-stroke-color": "#1e3a8a" } });
      m.on("click", (e) => latest.current.onPick?.(e.lngLat.lat, e.lngLat.lng));
      ready.current = true;
      push();
    });
    return () => { ready.current = false; fitted.current = false; m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (map.current) map.current.getCanvas().style.cursor = onPick ? "crosshair" : ""; }, [onPick]);
  useEffect(push, [stops, vehicle, pin]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" data-testid="route-map" />;
}
