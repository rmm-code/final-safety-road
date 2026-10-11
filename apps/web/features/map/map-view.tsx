"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as maplibregl from "maplibre-gl";
import type { Map as MapLibreMap, MapMouseEvent, GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { SeverityLevel } from "@pothole/shared-types";
import { Badge, PageHeader, Panel, SeverityBadge, SeverityIcon, StatusBadge } from "@/components/ui";
import { createApiClient, failureHint, type Pothole } from "@/lib/api-client";
import { configureMapLibreWorker } from "@/lib/maplibre-worker";
import type { AppConfig } from "@/lib/config";
import {
  SEVERITY_COLOUR_EXPRESSION,
  attachBasemapFallback,
  basemapStyle,
  symbolFont,
  toFeatureCollection,
} from "./lib/map-style";
import { syncVideoMarkers } from "./video-markers";
import { listLocatedVideos } from "@/features/videos/lib/video-api";

const SOURCE_ID = "potholes";
// Tashkent, so an empty map still opens somewhere meaningful.
const DEFAULT_CENTRE: [number, number] = [69.2797, 41.3112];

export function MapView({ config }: { config: AppConfig }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const videoMarkersRef = useRef(new Map<string, maplibregl.Marker>());
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);

  const [potholes, setPotholes] = useState<Pothole[]>([]);
  // The map's click handler is registered once, so it records an id rather than closing
  // over a row list that would be stale by the next pan.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (map: MapLibreMap) => {
      setLoading(true);
      try {
        // Inside the try: reading bounds from a map that has been torn down throws, and
        // that exception used to escape into a floating promise, leaving an empty map
        // with no request made and nothing shown to explain it.
        const bounds = map.getBounds();
        const rows = await api.potholes({
          bbox: {
            minLng: bounds.getWest(),
            minLat: bounds.getSouth(),
            maxLng: bounds.getEast(),
            maxLat: bounds.getNorth(),
          },
        });
        setPotholes(rows);
        setError(null);
        setErrorHint(null);
        const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
        source?.setData(toFeatureCollection(rows) as never);
        // Placed videos are their own layer; a failure there must not hide the potholes.
        try {
          const bbox = [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()]
            .map((value) => value.toFixed(6))
            .join(",");
          syncVideoMarkers(map, await listLocatedVideos(bbox), videoMarkersRef.current);
        } catch {
          // The saved-videos API is optional for the map.
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setErrorHint(failureHint(cause));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Before the map: without a reachable worker, MapLibre renders the basemap and no
    // data at all, with nothing logged to say why.
    configureMapLibreWorker(config.mapWorkerUrl);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(config.mapStyleUrl) as never,
      center: DEFAULT_CENTRE,
      zoom: 13,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    const disarmBasemapFallback = attachBasemapFallback(map);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), "top-right");

    // React runs effects twice in development, so this component mounts, tears the map
    // down and mounts again. The second instance can finish loading its style before the
    // handler is attached, in which case "load" never fires and the map stays empty -
    // hence running the setup immediately when the style is already there.
    /**
     * Run the pothole-layer setup as soon as the STYLE is parsed.
     *
     * Deliberately not "load" or "idle": both of those wait for the first full render,
     * which waits for basemap tiles. Tiles come from a third party and can be slow,
     * blocked by a corporate proxy, or simply unreachable offline - and gating our own
     * data on them means an operator on a restricted network gets an empty map with
     * nothing to explain it. Our potholes are not the basemap's dependants.
     *
     * `styledata` fires when the style JSON is parsed, which for the inline style here is
     * almost immediate, and it still fires for a map created after its style resolved -
     * the case that arises on the second of React's two development mounts.
     */
    const onStyleReady = (setup: () => void) => {
      const run = () => {
        if (map.getLayer("pothole-points")) return;
        setup();
      };
      if (map.isStyleLoaded()) run();
      else map.once("styledata", run);
    };

    onStyleReady(() => {
      try {
        const clusterFont = symbolFont(map);
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: toFeatureCollection([]) as never,
        // Clustering keeps a city's worth of defects legible when zoomed out.
        cluster: true,
        clusterRadius: 48,
        clusterMaxZoom: 15,
      });

      map.addLayer({
        id: "clusters",
        type: "circle",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#FFFFFF",
          "circle-stroke-color": "#D9DDE4",
          "circle-stroke-width": 1,
          "circle-radius": ["step", ["get", "point_count"], 16, 10, 22, 50, 28],
        },
      });
      map.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
            "text-field": "{point_count_abbreviated}",
            "text-size": 12,
            // A font the basemap's glyph server actually has; see symbolFont().
            ...(clusterFont ? { "text-font": clusterFont } : {}),
          },
        paint: { "text-color": "#111827" },
      });
      map.addLayer({
        id: "pothole-points",
        type: "circle",
        source: SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": SEVERITY_COLOUR_EXPRESSION as never,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 5, 18, 11],
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#FFFFFF",
        },
      });

      map.on("click", "pothole-points", (event: MapMouseEvent & { features?: { properties?: Record<string, unknown> }[] }) => {
        const feature = event.features?.[0];
        const id = feature?.properties?.id as string | undefined;
        if (id) setSelectedId(id);
      });
      map.on("click", "clusters", (event: MapMouseEvent & { features?: unknown[] }) => {
        const feature = event.features?.[0];
        if (feature) map.easeTo({ center: event.lngLat, zoom: map.getZoom() + 2 });
      });
      map.on("mouseenter", "pothole-points", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "pothole-points", () => (map.getCanvas().style.cursor = ""));

        void load(map);
      } catch (cause) {
        // MapLibre swallows exceptions thrown inside its event handlers, which would
        // leave an empty map with no explanation. Surface it instead.
        setError(
          `Map layers could not be created: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });

    map.on("moveend", () => void load(map));

    return () => {
      // Clear the ref BEFORE tearing down. React runs effects twice in development, so
      // this cleanup is followed by a second mount that checks `mapRef.current` to avoid
      // creating two maps. If `remove()` throws - which it does when the style is still
      // loading - the assignment below it never runs, the guard stays set, and the second
      // mount returns early. The result is a dead canvas in the DOM with no live map
      // behind it: no tiles, no events, no data, and no error to explain any of it.
      disarmBasemapFallback();
      const instance = mapRef.current;
      mapRef.current = null;
      try {
        instance?.remove();
      } catch {
        // Already torn down, or torn down mid-load. Nothing left to release.
      }
    };
  }, [config.mapStyleUrl, config.mapWorkerUrl, load]);

  const selected = useMemo(
    () => potholes.find((pothole) => pothole.id === selectedId) ?? null,
    [potholes, selectedId],
  );

  const counts = useMemo(() => {
    const result: Record<SeverityLevel, number> = { small: 0, medium: 0, large: 0, unknown: 0 };
    potholes.forEach((pothole) => (result[pothole.severity] += 1));
    return result;
  }, [potholes]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Map"
        description="Physical potholes, deduplicated from every sighting."
        actions={
          loading ? <Badge tone="neutral">Loading</Badge> : <Badge tone="neutral">{potholes.length} in view</Badge>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Could not load potholes</div>
          <p className="mt-1 text-secondary">{error}</p>
          {errorHint && <p className="mt-1 text-muted">{errorHint}</p>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div
          ref={containerRef}
          className="h-[64vh] min-h-[440px] w-full overflow-hidden rounded-xl bg-surface shadow-card"
        />

        <div className="space-y-4">
          <Panel title="In this view" subtitle="Potholes inside the map area" icon="potholes">
            <dl className="space-y-2.5 text-[13px]">
              {(["large", "medium", "small"] as const).map((level) => (
                <div key={level} className="flex items-center justify-between">
                  <dt className="flex items-center gap-2">
                    <SeverityIcon level={level} />
                    <span className="capitalize text-secondary">{level}</span>
                  </dt>
                  <dd className="tabular font-medium text-primary">{counts[level]}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          {selected ? (
            <Panel title="Selected pothole" subtitle={`Pothole ${selected.id.slice(0, 8)}`} icon="map">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
                <Detail label="Visual severity">
                  <SeverityBadge level={selected.severity} />
                </Detail>
                <Detail label="Status">
                  <StatusBadge status={selected.status} />
                </Detail>
                <Detail label="Sightings">
                  <span className="font-mono tabular-nums">{selected.sighting_count}</span>
                </Detail>
                <Detail label="Accuracy">
                  <span className="font-mono tabular-nums">
                    ±{Math.round(selected.location_accuracy_m)} m
                  </span>
                </Detail>
                <Detail label="First seen">
                  <span className="tabular-nums">{formatDate(selected.first_seen_at)}</span>
                </Detail>
                <Detail label="Last seen">
                  <span className="tabular-nums">{formatDate(selected.last_seen_at)}</span>
                </Detail>
              </dl>
              <Link
                href={`/potholes/${selected.id}`}
                className="mt-4 inline-flex h-9 w-full items-center justify-center rounded-lg bg-fill text-[13.5px] font-medium text-primary transition-colors duration-150 hover:bg-fill-strong"
              >
                Open photos and history
              </Link>
            </Panel>
          ) : (
            <Panel title="Selected pothole" icon="map">
              <p className="py-4 text-center text-[13px] text-muted">
                Click a marker on the map to see its details here.
              </p>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] leading-4 text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium text-primary">{children}</dd>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}
