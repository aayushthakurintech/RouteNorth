"use client";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef } from "react";
import { STATUS_COLORS, type Fleet } from "@/lib/fleet";

const TILE_URL = process.env.NEXT_PUBLIC_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const GLYPHS_URL = process.env.NEXT_PUBLIC_GLYPHS_URL ?? "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf";
// Public OSM tiles and demo glyphs are for development only; production will self-host both.

interface Props {
  fleet: Fleet;
  selectedId: string | null;
  follow: boolean;
  onSelect: (deviceId: string | null) => void;
}

const colorExpr = [
  "match", ["get", "status"],
  "moving", STATUS_COLORS.moving,
  "idle", STATUS_COLORS.idle,
  "stopped", STATUS_COLORS.stopped,
  STATUS_COLORS.offline,
] as maplibregl.ExpressionSpecification;

export function FleetMap({ fleet, selectedId, follow, onSelect }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const ready = useRef(false);
  const latest = useRef({ fleet, selectedId, follow });
  latest.current = { fleet, selectedId, follow };
  const fitted = useRef(false);

  const push = () => {
    const m = map.current;
    if (!m || !ready.current) return;
    const { fleet: f, selectedId: sel } = latest.current;
    const vehicles = Object.values(f);
    (m.getSource("vehicles") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: vehicles.map((v) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [v.lng, v.lat] },
        properties: { id: v.deviceId, name: v.name, status: v.status, selected: v.deviceId === sel },
      })),
    });
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

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      center: [-79.38, 43.65],
      zoom: 9,
      style: {
        version: 8,
        glyphs: GLYPHS_URL,
        sources: { osm: { type: "raster", tiles: [TILE_URL], tileSize: 256, attribution: "© OpenStreetMap contributors" } },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
    });
    map.current = m;
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
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
      push();
    });
    return () => { ready.current = false; fitted.current = false; m.remove(); map.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(push, [fleet, selectedId, follow]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={el} className="map" data-testid="map" />;
}
