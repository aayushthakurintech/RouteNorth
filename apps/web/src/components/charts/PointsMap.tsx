"use client";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { baseStyle } from "@/lib/basemap";

export interface Pt { lat: number; lng: number; weight?: number; label?: string }

/** Points on a map as a heat layer (where things happened most) with the dots visible once you zoom in. */
export function PointsMap({ points, ariaLabel }: { points: Pt[]; ariaLabel: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef(points);
  latest.current = points;
  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const pts = latest.current.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    (m.getSource("pts") as GeoJSONSource).setData({ type: "FeatureCollection", features: pts.map((p) => ({ type: "Feature", properties: { w: p.weight ?? 1, label: p.label ?? "" }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } })) });
    if (pts.length) { const b = new maplibregl.LngLatBounds(); pts.forEach((p) => b.extend([p.lng, p.lat])); m.fitBounds(b, { padding: 40, maxZoom: 14, duration: 0 }); }
  };
  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, center: [-79.38, 43.65], zoom: 8, style: baseStyle(), attributionControl: { compact: true } });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("pts", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "pts-heat", type: "heatmap", source: "pts", paint: { "heatmap-weight": ["get", "w"], "heatmap-radius": 28, "heatmap-opacity": 0.75, "heatmap-intensity": 1 } });
      m.addLayer({ id: "pts-dot", type: "circle", source: "pts", minzoom: 11, paint: { "circle-radius": 5, "circle-color": "#0072b2", "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
      ready.current = true; push();
    });
    return () => { m.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(push, [points]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={el} className="map" style={{ height: 360, borderRadius: "var(--r)" }} role="img" aria-label={ariaLabel} />;
}
