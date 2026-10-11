// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEVERITY_COLOURS } from "@/features/analyze/lib/overlay";
import { STATE_COLOUR } from "@/features/live/lib/state-style";
import { SEVERITY_COLOUR, osmRasterStyle, toFeatureCollection } from "./map-style";

const rows = [
  {
    id: "a",
    latitude: 41.3112,
    longitude: 69.2797,
    severity: "large" as const,
    status: "active",
    sighting_count: 12,
    last_seen_at: "2026-08-16T18:00:00Z",
  },
];

describe("basemap style", () => {
  it("uses OpenStreetMap raster tiles with attribution", () => {
    const style = osmRasterStyle() as { sources: { osm: { attribution: string; tiles: string[] } } };
    expect(style.sources.osm.tiles[0]).toContain("tile.openstreetmap.org");
    expect(style.sources.osm.attribution).toContain("OpenStreetMap");
  });
});

describe("pothole features", () => {
  it("puts coordinates in GeoJSON order", () => {
    // GeoJSON is longitude first; reversing this drops every marker in the sea.
    expect(toFeatureCollection(rows).features[0]!.geometry.coordinates).toEqual([69.2797, 41.3112]);
  });

  it("carries the properties the map styling and popup need", () => {
    expect(toFeatureCollection(rows).features[0]!.properties).toMatchObject({
      id: "a",
      severity: "large",
      sighting_count: 12,
    });
  });

  it("handles an empty result without inventing features", () => {
    expect(toFeatureCollection([]).features).toEqual([]);
  });
});

/**
 * Canvas and MapLibre cannot read CSS variables, so their colours are copies. These tests
 * read the tokens from globals.css, so a palette change that misses a copy fails here
 * instead of showing an operator two different reds for one severity.
 */
const CSS = readFileSync(fileURLToPath(new URL("../../../app/globals.css", import.meta.url)), "utf8");

function token(name: string): string {
  const match = CSS.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match?.[1]) throw new Error(`--color-${name} is not defined in globals.css`);
  return match[1].toLowerCase();
}

describe("severity colours", () => {
  it("match the design tokens on the internal map", () => {
    for (const level of ["small", "medium", "large", "unknown"] as const) {
      expect(SEVERITY_COLOUR[level].toLowerCase()).toBe(token(`severity-${level}`));
    }
  });

  it("match the design tokens on the video overlay", () => {
    for (const level of ["small", "medium", "large", "unknown"] as const) {
      expect(SEVERITY_COLOURS[level].toLowerCase()).toBe(token(`severity-${level}`));
    }
  });
});

describe("public map state colours", () => {
  it("match the verification-state tokens", () => {
    expect(STATE_COLOUR.unverified.toLowerCase()).toBe(token("state-unverified"));
    expect(STATE_COLOUR.confirmed.toLowerCase()).toBe(token("state-confirmed"));
    expect(STATE_COLOUR.fixed.toLowerCase()).toBe(token("state-fixed"));
  });
});
