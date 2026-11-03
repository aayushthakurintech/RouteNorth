"use client";
import { animateLine } from "@/lib/line-draw";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";

const TILE_URL = process.env.NEXT_PUBLIC_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

export interface TrackPoint { time: string; lat: number; lng: number; speed: number }
export interface StopMarker { lat: number; lng: number; idling: boolean }

interface Props { track: TrackPoint[]; stops: StopMarker[]; index: number }

export function ReplayMap({ track, stops, index }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ track, stops, index });
  latest.current = { track, stops, index };
  const fitted = useRef<TrackPoint[] | null>(null);
  const drawnFor = useRef<TrackPoint[] | null>(null);
  const cancelDraw = useRef<() => void>(() => {});

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { track: tr, stops: st, index: i } = latest.current;
    const routeSrc = m.getSource("route") as GeoJSONSource;
    const line = (c: [number, number][]) => routeSrc.setData({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: c } });
    const coords: [number, number][] = tr.length > 1 ? tr.map((p) => [p.lng, p.lat]) : [];
    // The trail draws itself when a new day's track arrives; moving the replay slider only moves the dot.
    if (drawnFor.current !== tr) {
      cancelDraw.current();
      drawnFor.current = tr;
      cancelDraw.current = animateLine(line, coords);
    }
    (m.getSource("stops") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: st.map((s) => ({
        type: "Feature", properties: { idling: s.idling }, geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      })),
    });
    const cur = tr[Math.min(i, tr.length - 1)];
    (m.getSource("current") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: cur ? [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [cur.lng, cur.lat] } }] : [],
    });
    if (tr.length > 0 && fitted.current !== tr) {
      fitted.current = tr;
      const b = new maplibregl.LngLatBounds();
      tr.forEach((p) => b.extend([p.lng, p.lat]));
      m.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
    }
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current, center: [-79.38, 43.65], zoom: 9,
      style: {
        version: 8,
        sources: { osm: { type: "raster", tiles: [TILE_URL], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      const empty = { type: "FeatureCollection", features: [] } as const;
      m.addSource("route", { type: "geojson", data: empty });
      m.addSource("stops", { type: "geojson", data: empty });
      m.addSource("current", { type: "geojson", data: empty });
      m.addLayer({ id: "route", type: "line", source: "route", paint: { "line-color": "#2563eb", "line-width": 4, "line-opacity": 0.8 } });
      m.addLayer({
        id: "stops", type: "circle", source: "stops",
        paint: {
          "circle-radius": 7, "circle-stroke-width": 2, "circle-stroke-color": "#fff",
          "circle-color": ["case", ["get", "idling"], "#f2a900", "#6b7280"],
        },
      });
      m.addLayer({
        id: "current", type: "circle", source: "current",
        paint: { "circle-radius": 9, "circle-color": "#1a9850", "circle-stroke-width": 3, "circle-stroke-color": "#fff" },
      });
      ready.current = true;
      push();
    });
    return () => { cancelDraw.current(); ready.current = false; fitted.current = null; drawnFor.current = null; m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(push, [track, stops, index]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" data-testid="replay-map" />;
}
