#!/usr/bin/env node
/**
 * Copy MapLibre's web worker into public/maplibre so the browser can fetch it from our
 * own origin.
 *
 * MapLibre does all GeoJSON work - parsing, tiling, clustering - in a worker it starts
 * with `new Worker(new URL(...))`. Next.js does not emit a chunk for that URL, so the
 * request 404s and the dev server answers with its HTML error page. The browser refuses
 * it ("non-JavaScript MIME type of text/html") and the worker never starts.
 *
 * The failure is silent in the worst way: raster tiles still render, because they load on
 * the main thread. Only the data disappears. A map full of basemap and no markers, with
 * no error anywhere, is what this script exists to prevent.
 *
 * TWO files, not one. MapLibre ships a split ESM build: the worker is a thin 18KB module
 * that imports "./maplibre-gl-shared.mjs" for the actual work - geojson-vt, supercluster,
 * tile parsing. Copying the worker alone moves the 404 rather than fixing it, and the
 * symptom is identical, so it looks like the fix did nothing.
 *
 * The shared chunk keeps its exact filename because the worker's import specifier names
 * it. The worker itself is renamed to .js, since that is the URL we hand to MapLibre and
 * .js is served as JavaScript by every static host.
 *
 * Exits 0 when MapLibre is absent: a missing optional asset must not fail a build.
 */
import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(webRoot, "public", "maplibre");

const candidates = [
  join(webRoot, "node_modules", "maplibre-gl", "dist"),
  join(webRoot, "..", "..", "node_modules", "maplibre-gl", "dist"),
];

const source = candidates.find((path) => existsSync(join(path, "maplibre-gl-worker.mjs")));
if (!source) {
  console.warn("[maplibre] maplibre-gl is not installed; skipping worker copy.");
  process.exit(0);
}

await mkdir(target, { recursive: true });
await cp(join(source, "maplibre-gl-worker.mjs"), join(target, "maplibre-gl-worker.js"));
await cp(join(source, "maplibre-gl-shared.mjs"), join(target, "maplibre-gl-shared.mjs"));

console.log("[maplibre] Copied the worker and its shared chunk to public/maplibre/");
