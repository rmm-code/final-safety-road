"use client";

import * as maplibregl from "maplibre-gl";

/**
 * Point MapLibre at a worker it can actually load.
 *
 * MapLibre runs every GeoJSON operation - parsing, tiling, clustering - in a web worker
 * it starts from a bundler-resolved URL. Next.js does not emit a chunk for that URL, so
 * the request returns the 404 page and the browser rejects it as a non-JavaScript MIME
 * type. The worker never starts, no GeoJSON source ever finishes loading, and every
 * marker silently disappears.
 *
 * It is worth being precise about how this fails, because the symptom points away from
 * the cause: raster tiles keep rendering, since those load on the main thread. The map
 * looks healthy. The API returns rows, the counts update, and the map is simply empty.
 *
 * `npm run sync:maplibre-worker` copies the worker into public/maplibre; this points
 * MapLibre at it.
 */

let applied = false;

export function configureMapLibreWorker(workerUrl: string): void {
  // MapLibre reads this when it starts its worker pool, which happens on the first map.
  // Setting it twice is harmless, but there is no reason to.
  if (applied || !workerUrl) return;
  applied = true;
  maplibregl.setWorkerUrl(workerUrl);
}
