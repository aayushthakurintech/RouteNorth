"use client";
import maplibregl from "@/lib/maplibre";
import { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { applyBasemap, baseStyle } from "@/lib/basemap";
import { useTheme } from "@/lib/theme-context";

export interface Feat { type: "Feature"; properties: Record<string, unknown>; geometry: { type: "Polygon"; coordinates: number[][][] } | { type: "Point"; coordinates: number[] } | { type: "LineString"; coordinates: number[][] } }

export interface ZoneShape {
  id?: string; name?: string; shape: "circle" | "polygon"; lat?: number | null; lng?: number | null; radiusM?: number | null; polygon?: [number, number][] | null; active?: boolean;
}

/** Approximate a circle with 48 corners, as [lng, lat] ring for GeoJSON. */
export function circleRing(lat: number, lng: number, radiusM: number): [number, number][] {
  const out: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  for (let i = 0; i <= 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    out.push([lng + Math.cos(a) * dLng, lat + Math.sin(a) * dLat]);
  }
  return out;
}

export function zoneFeature(z: ZoneShape, extra: Record<string, unknown>): Feat | null {
  if (z.shape === "circle" && z.lat != null && z.lng != null && z.radiusM) {
    return { type: "Feature", properties: { ...extra, name: z.name ?? "" }, geometry: { type: "Polygon", coordinates: [circleRing(z.lat, z.lng, z.radiusM)] } };
  }
  if (z.shape === "polygon" && z.polygon && z.polygon.length >= 3) {
    const ring = z.polygon.map(([la, ln]) => [ln, la] as [number, number]);
    return { type: "Feature", properties: { ...extra, name: z.name ?? "" }, geometry: { type: "Polygon", coordinates: [[...ring, ring[0]!]] } };
  }
  return null;
}

/** Map for viewing every zone and drawing a new one: click to place the centre or add polygon corners. */
export function GeofenceMap({ zones, draft, onPick }: { zones: ZoneShape[]; draft: ZoneShape | null; onPick: ((lat: number, lng: number) => void) | null }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);
  const { resolved } = useTheme();
  const latest = useRef({ zones, draft, onPick });
  latest.current = { zones, draft, onPick };

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { zones: zs, draft: d } = latest.current;
    const feats = zs.map((z) => zoneFeature(z, { active: z.active !== false })).filter((f): f is Feat => !!f);
    (m.getSource("zones") as GeoJSONSource).setData({ type: "FeatureCollection", features: feats });
    const dr: Feat[] = [];
    const pts: Feat[] = [];
    if (d) {
      const f = zoneFeature(d, {});
      if (f) dr.push(f);
      if (d.shape === "polygon" && d.polygon) {
        d.polygon.forEach(([la, ln]) => pts.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [ln, la] } }));
        if (d.polygon.length >= 2 && d.polygon.length < 3) dr.push({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: d.polygon.map(([la, ln]) => [ln, la]) } });
      } else if (d.lat != null && d.lng != null) pts.push({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [d.lng, d.lat] } });
    }
    (m.getSource("draft") as GeoJSONSource).setData({ type: "FeatureCollection", features: dr });
    (m.getSource("draft-pts") as GeoJSONSource).setData({ type: "FeatureCollection", features: pts });
    if (!fitted.current && feats.length > 0) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      for (const f of feats) for (const c of (f.geometry as { coordinates: number[][][] }).coordinates[0]!) b.extend(c as [number, number]);
      m.fitBounds(b, { padding: 60, maxZoom: 14, duration: 0 });
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, center: [-79.38, 43.65], zoom: 9, style: baseStyle() });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] } as const;
      for (const id of ["zones", "draft", "draft-pts"]) m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": "#2563eb", "fill-opacity": ["case", ["get", "active"], 0.16, 0.05] } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": "#2563eb", "line-width": 2 } });
      m.addLayer({ id: "zones-name", type: "symbol", source: "zones", layout: { "text-field": ["get", "name"], "text-size": 12, "text-font": ["Open Sans Regular"] }, paint: { "text-color": "#1e3a8a", "text-halo-color": "#fff", "text-halo-width": 1.5 } });
      m.addLayer({ id: "draft-fill", type: "fill", source: "draft", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#f97316", "fill-opacity": 0.25 } });
      m.addLayer({ id: "draft-line", type: "line", source: "draft", paint: { "line-color": "#ea580c", "line-width": 2, "line-dasharray": [2, 1] } });
      m.addLayer({ id: "draft-pts", type: "circle", source: "draft-pts", paint: { "circle-radius": 6, "circle-color": "#ea580c", "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      ready.current = true;
      push();
    });
    m.on("click", (e) => latest.current.onPick?.(e.lngLat.lat, e.lngLat.lng));
    return () => { m.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { push(); });
  useEffect(() => { const m = map.current; if (m && ready.current) applyBasemap(m, "street", resolved); }, [resolved]);
  useEffect(() => { const m = map.current; if (m) m.getCanvas().style.cursor = onPick ? "crosshair" : ""; }, [onPick]);

  return <div ref={el} className="map" data-testid="geofence-map" />;
}
