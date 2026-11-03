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
          properties: { id: v.deviceId, name: v.name, status: v.status, selected: v.deviceId === sel },
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
      m.addLayer({ id: "trail", type: "line", source: "trail", paint: { "line-color": "#2563eb", "line-width": 3, "line-opacity": 0.8 } });
      m.addSource("vehicles", {
        type: "geojson", data: { type: "FeatureCollection", features: [] },
        cluster: true, clusterRadius: 40, clusterMaxZoom: 13,
      });
      m.addLayer({
        id: "clusters", type: "circle", source: "vehicles", filter: ["has", "point_count"],
        paint: { "circle-color": "#1e3a8a", "circle-radius": 18, "circle-stroke-width": 2, "circle-stroke-color": "#fff" },
      });
      m.addLayer({
        id: "cluster-count", type: "symbol", source: "vehicles", filter: ["has", "point_count"],
        layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 13, "text-font": ["Open Sans Regular"] },
        paint: { "text-color": "#fff" },
      });
      m.addLayer({
        id: "vehicle", type: "circle", source: "vehicles", filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": colorExpr,
          "circle-radius": ["case", ["get", "selected"], 11, 8],
          "circle-stroke-width": ["case", ["get", "selected"], 3, 2],
          "circle-stroke-color": "#fff",
        },
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
