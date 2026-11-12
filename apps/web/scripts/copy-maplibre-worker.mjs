// MapLibre 6 runs its map worker from a separate file next to its own module, which the Next.js bundle does not emit.
// Copy the worker into public/, where src/lib/maplibre.ts points it.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(dirname(require.resolve("maplibre-gl/package.json")), "dist");
const out = join(here, "..", "public", "maplibre");
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs"]) copyFileSync(join(dist, f), join(out, f));
