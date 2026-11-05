"use client";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import { STATUS_COLORS, type Fleet } from "@/lib/fleet";

import { zoneFeature, type ZoneShape } from "@/components/GeofenceMap";
import { applyBasemap, baseStyle, streetViewUrl, type Basemap } from "@/lib/basemap";
import { glideFrame, type Pt } from "@/lib/glide";
import { useI18n } from "@/lib/i18n-context";
import { useTheme } from "@/lib/theme-context";
// Public tile servers and demo glyphs are for development only; production will self-host them (see lib/basemap.ts).
const GLIDE_MS = 900;
const MAX_GLIDING = 300;

interface Props {
  fleet: Fleet;
  selectedId: string | null;
  follow: boolean;
  onSelect: (deviceId: string | null) => void;
  /** Zones to outline on the map. */
  zones?: ZoneShape[];
  /** Heat-map cells: weight says how strong each is. */
  heat?: { lat: number; lng: number; weight: number }[];
}

const STATUSES = ["moving", "idle", "stopped", "offline"] as const;

/**
 * Marker pictures drawn at runtime: a navigation arrow for a vehicle that is driving (it points where the vehicle heads)
 * and a round badge for one that is not, both with a white ring so they stay readable on any basemap, light or satellite.
 * Drawn at 2x for sharp edges on high-density screens.
 */
export function markerImage(kind: "arrow" | "dot", color: string): { width: number; height: number; data: Uint8ClampedArray } {
  const size = 64, c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.translate(size / 2, size / 2);
  g.lineJoin = "round";
  g.shadowColor = "rgba(8,16,32,.35)"; g.shadowBlur = 6; g.shadowOffsetY = 2;
  if (kind === "arrow") {
    g.beginPath();
    g.moveTo(0, -22); g.lineTo(16, 18); g.lineTo(0, 9); g.lineTo(-16, 18); g.closePath();
  } else {
    g.beginPath(); g.arc(0, 0, 15, 0, Math.PI * 2);
  }
  g.fillStyle = color; g.strokeStyle = "#ffffff"; g.lineWidth = 5;
  g.stroke(); g.shadowColor = "transparent"; g.fill();
  if (kind === "dot") { g.beginPath(); g.arc(0, 0, 5, 0, Math.PI * 2); g.fillStyle = "#ffffff"; g.fill(); }
  const img = g.getImageData(0, 0, size, size);
  return { width: size, height: size, data: img.data };
}

const colorExpr = [
  "match", ["get", "status"],
  "moving", STATUS_COLORS.moving,
  "idle", STATUS_COLORS.idle,
  "stopped", STATUS_COLORS.stopped,
  STATUS_COLORS.offline,
] as maplibregl.ExpressionSpecification;

export function FleetMap({ fleet, selectedId, follow, onSelect, zones, heat }: Props) {
  const { t } = useI18n();
  const { resolved } = useTheme();
  const [basemap, setBasemap] = useState<Basemap>("street");
  const shown = useRef<Record<string, Pt>>({});
  const raf = useRef(0);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ fleet, selectedId, follow, zones, heat });
  latest.current = { fleet, selectedId, follow, zones, heat };
  const fitted = useRef(false);
  const basemapRef = useRef(basemap);
  const themeRef = useRef(resolved);
  basemapRef.current = basemap;
  themeRef.current = resolved;

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { fleet: f, selectedId: sel } = latest.current;
    const vehicles = Object.values(f);
    const target: Record<string, Pt> = {};
    for (const v of vehicles) target[v.deviceId] = [v.lng, v.lat];
    const draw = (pos: Record<string, Pt>) =>
      (m.getSource("vehicles") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: vehicles.map((v) => ({
          type: "Feature",
          geometry: { type: "Point", coordinates: pos[v.deviceId] ?? [v.lng, v.lat] },
          properties: { id: v.deviceId, name: v.name, status: v.status, selected: v.deviceId === sel, heading: v.heading, moving: v.status === "moving" },
        })),
      });
    cancelAnimationFrame(raf.current);
    const reduced = document.documentElement.dataset.motion === "reduce" || (document.documentElement.dataset.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced || vehicles.length > MAX_GLIDING || Object.keys(shown.current).length === 0) {
      shown.current = target;
      draw(target);
    } else {
      const from = { ...shown.current };
      const start = performance.now();
      const step = (now: number) => {
        const k = (now - start) / GLIDE_MS;
        shown.current = glideFrame(from, target, k);
        draw(shown.current);
        if (k < 1) raf.current = requestAnimationFrame(step);
      };
      raf.current = requestAnimationFrame(step);
    }
    const trail = sel ? f[sel]?.trail ?? [] : [];
    (m.getSource("trail") as GeoJSONSource).setData({
      type: "Feature", properties: {},
      geometry: { type: "LineString", coordinates: trail.length > 1 ? trail : [] },
    });
    if (!fitted.current && vehicles.length > 0) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      vehicles.forEach((v) => b.extend([v.lng, v.lat]));
      m.fitBounds(b, { padding: 80, maxZoom: 13, duration: 0 });
    }
    const followed = latest.current.follow && sel ? f[sel] : null;
    if (followed) m.easeTo({ center: [followed.lng, followed.lat], duration: 500 });
  };

  const pushOverlays = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { zones: zs, heat: h } = latest.current;
    const feats = (zs ?? []).map((z) => zoneFeature(z, { active: z.active !== false })).filter((f) => !!f);
    (m.getSource("zones") as GeoJSONSource).setData({ type: "FeatureCollection", features: feats } as never);
    const max = Math.max(1, ...(h ?? []).map((c) => c.weight));
    (m.getSource("heat") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (h ?? []).map((c) => ({ type: "Feature", properties: { w: c.weight / max }, geometry: { type: "Point", coordinates: [c.lng, c.lat] } })),
    });
  };

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      center: [-79.38, 43.65],
      zoom: 9,
      style: baseStyle(),
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("heat", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({
        id: "heat", type: "heatmap", source: "heat",
        paint: {
          "heatmap-weight": ["get", "w"], "heatmap-radius": 28, "heatmap-opacity": 0.7,
          "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "#fde68a", 0.5, "#f97316", 1, "#b91c1c"],
        },
      });
      m.addSource("zones", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "zones-fill", type: "fill", source: "zones", paint: { "fill-color": "#2563eb", "fill-opacity": 0.12 } });
      m.addLayer({ id: "zones-line", type: "line", source: "zones", paint: { "line-color": "#2563eb", "line-width": 1.5, "line-dasharray": [3, 2] } });
      m.addSource("trail", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "trail-casing", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": 6, "line-opacity": 0.9 } });
      m.addLayer({ id: "trail", type: "line", source: "trail", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#2a78d6", "line-width": 3.5 } });
      m.addSource("vehicles", {
        type: "geojson", data: { type: "FeatureCollection", features: [] },
        cluster: true, clusterRadius: 40, clusterMaxZoom: 13,
      });
      m.addLayer({
        id: "clusters", type: "circle", source: "vehicles", filter: ["has", "point_count"],
        paint: { "circle-color": "#184f95", "circle-radius": 18, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });
      m.addLayer({
        id: "cluster-count", type: "symbol", source: "vehicles", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 13, "text-font": ["Open Sans Regular"] },
        paint: { "text-color": "#fff" },
      });
      for (const st of STATUSES) {
        m.addImage(`arrow-${st}`, markerImage("arrow", STATUS_COLORS[st]), { pixelRatio: 2 });
        m.addImage(`dot-${st}`, markerImage("dot", STATUS_COLORS[st]), { pixelRatio: 2 });
      }
      // A soft halo under the selected vehicle
      m.addLayer({
        id: "vehicle-halo", type: "circle", source: "vehicles", filter: ["all", ["!", ["has", "point_count"]], ["==", ["get", "selected"], true]],
        paint: { "circle-radius": 24, "circle-color": "#2a78d6", "circle-opacity": 0.18, "circle-stroke-width": 1.5, "circle-stroke-color": "#2a78d6", "circle-stroke-opacity": 0.6 },
      });
      m.addLayer({
        id: "vehicle", type: "symbol", source: "vehicles", filter: ["!", ["has", "point_count"]],
        layout: {
          "icon-image": ["concat", ["case", ["get", "moving"], "arrow-", "dot-"], ["get", "status"]],
          "icon-rotate": ["case", ["get", "moving"], ["get", "heading"], 0],
          "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true,
          "icon-size": ["case", ["get", "selected"], 0.95, 0.7],
          "text-field": ["get", "name"], "text-font": ["Open Sans Regular"], "text-size": 12, "text-offset": [0, 1.7], "text-anchor": "top", "text-optional": true,
        },
        paint: { "text-color": "#0e1726", "text-halo-color": "#ffffff", "text-halo-width": 2, "text-halo-blur": 0.5 },
      });
      m.on("click", "vehicle", (e) => onSelect(String(e.features?.[0]?.properties?.id ?? "")));
      m.on("click", "clusters", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = m.getSource("vehicles") as GeoJSONSource;
        src.getClusterExpansionZoom(f.properties.cluster_id).then((zoom) =>
          m.easeTo({ center: (f.geometry as unknown as { coordinates: [number, number] }).coordinates, zoom }),
        );
      });
      m.on("click", (e) => {
        if (!m.queryRenderedFeatures(e.point, { layers: ["vehicle", "clusters"] }).length) onSelect(null);
      });
      for (const layer of ["vehicle", "clusters"]) {
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
      ready.current = true;
      applyBasemap(m, basemapRef.current, themeRef.current);
      push();
      pushOverlays();
    });
    return () => { cancelAnimationFrame(raf.current); ready.current = false; fitted.current = false; m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(push, [fleet, selectedId, follow]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(pushOverlays, [zones, heat]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready.current && map.current) applyBasemap(map.current, basemap, resolved); }, [basemap, resolved]);

  const sel = selectedId ? fleet[selectedId] : undefined;
  return (
    <>
      <div ref={el} className="map" data-testid="map" />
      <div className="map-tools">
        <div className="seg" role="group" aria-label={t("mapLayers")}>
          <button type="button" aria-pressed={basemap === "street"} onClick={() => setBasemap("street")}>{t("mapStreet")}</button>
          <button type="button" aria-pressed={basemap === "satellite"} onClick={() => setBasemap("satellite")}>{t("mapSatellite")}</button>
        </div>
        {sel && <a className="btn alt sm" href={streetViewUrl(sel.lat, sel.lng)} target="_blank" rel="noreferrer">{t("streetView")}</a>}
      </div>
    </>
  );
}
