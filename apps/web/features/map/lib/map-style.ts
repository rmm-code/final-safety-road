import type { SeverityLevel } from "@pothole/shared-types";
import type { ErrorEvent, Map as MapLibreMap } from "maplibre-gl";

/**
 * The default basemap: OpenFreeMap's "Liberty" vector style.
 *
 * The Mapbox look without Mapbox. Mapbox's own tiles need an account and an access token,
 * and this project creates neither - so this is the same kind of map (vector tiles, crisp
 * labels at every zoom, built from OpenStreetMap data) from a free host that needs no key
 * and no sign-up. MapLibre, which draws it, is the open-source fork of Mapbox GL JS.
 *
 * Override with NEXT_PUBLIC_MAP_STYLE_URL. Note that a Mapbox style URL is NOT a drop-in
 * value: its JSON refers to `mapbox://` sources that MapLibre cannot resolve on its own.
 */
export const DEFAULT_BASEMAP_URL = "https://tiles.openfreemap.org/styles/liberty";

/** How long a remote style may take before the inline raster style replaces it. */
const BASEMAP_TIMEOUT_MS = 8000;

/** The `style` to construct a map with: the configured URL, else the free vector style. */
export function basemapStyle(configuredUrl: string): string {
  return configuredUrl || DEFAULT_BASEMAP_URL;
}

/**
 * Swap to the inline raster style if the remote one cannot be loaded.
 *
 * A remote style is a third-party dependency between the page and OUR data: the pothole
 * layers are added when the style is parsed, so a style that never arrives means a map
 * with no potholes on it. That breaks a rule this project already learned the hard way -
 * our data must not be gated on someone else's server.
 *
 * Only a STYLE failure triggers the swap. MapLibre also reports a missing tile or glyph
 * range as an `error`, and treating those as fatal would throw away a working map, and
 * every layer on it, over one blank square. So the swap is disarmed for good the moment
 * the style loads, and ignores errors that name a source or a tile.
 *
 * Returns a function that disarms it, for the component's cleanup.
 */
export function attachBasemapFallback(map: MapLibreMap): () => void {
  let settled = false;

  const disarm = () => {
    settled = true;
    window.clearTimeout(timer);
    map.off("error", onError);
  };

  const fallBack = () => {
    if (settled) return;
    disarm();
    try {
      // `diff: false`: the two styles share nothing, and diffing them is wasted work.
      map.setStyle(osmRasterStyle() as never, { diff: false });
    } catch {
      // The map was torn down while waiting. Nothing to fall back on.
    }
  };

  const onError = (event: ErrorEvent & { sourceId?: string; tile?: unknown }) => {
    if (settled || event.sourceId || event.tile) return;
    fallBack();
  };

  const timer = window.setTimeout(fallBack, BASEMAP_TIMEOUT_MS);
  map.on("error", onError);
  map.once("style.load", disarm);

  return disarm;
}

/**
 * A font stack the current style can actually serve, for our own text layers.
 *
 * A symbol layer with no `text-font` asks for MapLibre's default stack, and a vector
 * style's glyph server only has the fonts that style uses - so the cluster counts would
 * request a font that 404s and render as bare circles. Borrowing a stack from the style's
 * own labels guarantees one that exists, bold preferred because these are numbers on a
 * marker.
 *
 * Returns undefined for a style with no labels (the raster fallback), where the right
 * thing is to set no font at all and let MapLibre draw the digits itself.
 */
export function symbolFont(map: MapLibreMap): string[] | undefined {
  const stacks: string[][] = [];
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type !== "symbol") continue;
    const font = (layer.layout as Record<string, unknown> | undefined)?.["text-font"];
    if (Array.isArray(font) && font.length > 0 && font.every((f) => typeof f === "string")) {
      stacks.push(font as string[]);
    }
  }
  return (
    stacks.find((stack) => stack.some((f) => /bold/i.test(f))) ??
    stacks.find((stack) => stack.some((f) => /regular/i.test(f))) ??
    stacks[0]
  );
}

/**
 * Inline raster style, the fallback when the vector style is unreachable.
 *
 * Built inline from OpenStreetMap raster tiles, so it needs no style request at all and
 * cannot fail to parse. Pothole data is never sent anywhere: it is drawn from our own API
 * on top of these tiles.
 */
export function osmRasterStyle(): object {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "&copy; OpenStreetMap contributors",
        maxzoom: 19,
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
  };
}

/** Severity colours, identical to the table, the badge and the video overlay. */
export const SEVERITY_COLOUR: Record<SeverityLevel, string> = {
  small: "#68BF9B",
  medium: "#EFB66C",
  large: "#DB7979",
  unknown: "#B5B5B5",
};

/** MapLibre data-driven colour expression for the severity property. */
export const SEVERITY_COLOUR_EXPRESSION = [
  "match",
  ["get", "severity"],
  "small",
  SEVERITY_COLOUR.small,
  "medium",
  SEVERITY_COLOUR.medium,
  "large",
  SEVERITY_COLOUR.large,
  SEVERITY_COLOUR.unknown,
];

export type MapPothole = {
  id: string;
  latitude: number;
  longitude: number;
  severity: SeverityLevel;
  status: string;
  sighting_count: number;
  last_seen_at: string;
};

/** Convert API rows into the GeoJSON MapLibre draws. */
export function toFeatureCollection(potholes: MapPothole[]) {
  return {
    type: "FeatureCollection" as const,
    features: potholes.map((pothole) => ({
      type: "Feature" as const,
      id: pothole.id,
      geometry: { type: "Point" as const, coordinates: [pothole.longitude, pothole.latitude] },
      properties: {
        id: pothole.id,
        severity: pothole.severity,
        status: pothole.status,
        sighting_count: pothole.sighting_count,
        last_seen_at: pothole.last_seen_at,
      },
    })),
  };
}
