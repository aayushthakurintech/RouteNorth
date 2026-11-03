"use client";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { baseStyle } from "@/lib/basemap";

export interface TrackData {
  vehicle: { lat: number; lng: number } | null;
  trail: { lat: number; lng: number }[];
  stops: { lat: number; lng: number; sequence: number; status: string }[];
}

/** Map for the public tracking page: the vehicle, its recent trail and the stops still to come. */
export function TrackMap({ data, brand }: { data: TrackData; brand: string }) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);
  const latest = useRef({ data, brand });
  latest.current = { data, brand };

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { data: d } = latest.current;
    (m.getSource("trail") as GeoJSONSource).setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: d.trail.length > 1 ? d.trail.map((p) => [p.lng, p.lat]) : [] } });
    (m.getSource("stops") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: d.stops.map((s) => ({ type: "Feature", properties: { label: String(s.sequence), done: s.status === "done" }, geometry: { type: "Point", coordinates: [s.lng, s.lat] } })),
    });
    (m.getSource("vehicle") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: d.vehicle ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [d.vehicle.lng, d.vehicle.lat] } }] : [],
    });
    if (!fitted.current && (d.vehicle || d.stops.length)) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      if (d.vehicle) b.extend([d.vehicle.lng, d.vehicle.lat]);
      d.stops.forEach((s) => b.extend([s.lng, s.lat]));
      m.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
    } else if (d.vehicle && fitted.current && !d.stops.length) {
      m.easeTo({ center: [d.vehicle.lng, d.vehicle.lat], duration: 600 });
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({ container: el.current, center: [-79.38, 43.65], zoom: 9, style: baseStyle(), attributionControl: { compact: true } });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] } as const;
      for (const id of ["trail", "stops", "vehicle"]) m.addSource(id, { type: "geojson", data: empty });
      m.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": latest.current.brand, "line-width": 4, "line-opacity": 0.7 } });
      m.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-radius": 9, "circle-color": ["case", ["get", "done"], "#16a34a", "#64748b"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
      m.addLayer({ id: "stops-n", type: "symbol", source: "stops", layout: { "text-field": ["get", "label"], "text-size": 11, "text-font": ["Open Sans Regular"] }, paint: { "text-color": "#fff" } });
      m.addLayer({ id: "vehicle", type: "circle", source: "vehicle", paint: { "circle-radius": 11, "circle-color": latest.current.brand, "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
      ready.current = true;
      push();
    });
    return () => { m.remove(); map.current = null; ready.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(push, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" data-testid="track-map" role="img" aria-label="Map" />;
}
