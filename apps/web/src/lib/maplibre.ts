import * as maplibregl from "maplibre-gl";

// MapLibre 6 loads its worker from a file beside its own module, which the Next.js bundle does not ship.
// scripts/copy-maplibre-worker.mjs puts it in public/ before every build; the version keeps browsers from using an old copy.
if (typeof window !== "undefined") maplibregl.setWorkerUrl(`/maplibre/maplibre-gl-worker.mjs?v=${maplibregl.getVersion()}`);

export default maplibregl;
