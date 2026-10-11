"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  attachBasemapFallback,
  basemapStyle,
  symbolFont,
} from "@/features/map/lib/map-style";
import {
  createPublicApiClient,
  type PublicCounts,
  type PublicPothole,
  type PublicState,
} from "@/lib/public-api";
import { configureMapLibreWorker } from "@/lib/maplibre-worker";
// Telegram Mini App parked - see the ReportButton import below.
// import { readyForTelegram, useIsTelegramMiniApp } from "@/lib/telegram-webapp";
import {
  STATE_COLOUR,
  STATE_COLOUR_EXPRESSION,
  STATE_LABEL,
  STATE_OPACITY_EXPRESSION,
  STATE_ORDER,
} from "./lib/state-style";
import { LegendCard } from "./components/legend-card";
import { SummaryCard } from "./components/summary-card";
import { PotholeSheet } from "./components/pothole-sheet";
// Telegram Mini App parked: its report button is off until the Mini App returns. Restore
// these lines (and the bridge below) and rename app/(public)/live/_report back to report.
// import { ReportButton } from "./components/report-button";

const SOURCE_ID = "potholes";
/** Tashkent, so a map with nothing in view still opens somewhere meaningful. */
const DEFAULT_CENTRE: [number, number] = [69.2797, 41.3112];
const DEFAULT_ZOOM = 12;

const EMPTY_COUNTS: PublicCounts = { unverified: 0, confirmed: 0, fixed: 0, total: 0 };

function toFeatureCollection(potholes: PublicPothole[]) {
  return {
    type: "FeatureCollection" as const,
    features: potholes.map((pothole) => ({
      type: "Feature" as const,
      id: pothole.id,
      geometry: { type: "Point" as const, coordinates: [pothole.longitude, pothole.latitude] },
      properties: {
        id: pothole.id,
        state: pothole.state,
        severity: pothole.severity,
        reported_count: pothole.reported_count,
      },
    })),
  };
}

export function LiveMapView({
  apiBaseUrl,
  mapStyleUrl,
  mapWorkerUrl,
}: {
  apiBaseUrl: string;
  mapStyleUrl: string;
  mapWorkerUrl: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const api = useMemo(() => createPublicApiClient(apiBaseUrl), [apiBaseUrl]);

  const [counts, setCounts] = useState<PublicCounts>(EMPTY_COUNTS);
  // Every row in the viewport, before the state filter. Held here rather than pushed
  // straight into the source because filtering has to re-run when a toggle changes, not
  // only when the map moves.
  const [rows, setRows] = useState<PublicPothole[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<PublicState>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  // Telegram Mini App parked.
  // const inTelegram = useIsTelegramMiniApp();
  // useEffect(readyForTelegram, []);

  const load = useCallback(
    async (map: MapLibreMap) => {
      setLoading(true);
      try {
        // Inside the try: reading bounds from a map that has been torn down throws, and
        // an escaped exception here leaves an empty map with nothing to explain it.
        const bounds = map.getBounds();
        const bbox = {
          minLng: bounds.getWest(),
          minLat: bounds.getSouth(),
          maxLng: bounds.getEast(),
          maxLat: bounds.getNorth(),
        };
        const [found, totals] = await Promise.all([api.potholes(bbox), api.counts(bbox)]);
        setRows(found);
        setCounts(totals);
        setError(null);
        setUpdatedAt(
          new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    // Before the map, not after: MapLibre spins its worker pool up with the first map.
    configureMapLibreWorker(mapWorkerUrl);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(mapStyleUrl) as never,
      center: DEFAULT_CENTRE,
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    const disarmBasemapFallback = attachBasemapFallback(map);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
    map.addControl(
      new maplibregl.GeolocateControl({ trackUserLocation: false }),
      "bottom-right",
    );

    /**
     * Set the layers up as soon as the STYLE is parsed.
     *
     * Not "load" or "idle": both wait for the first full render, which waits for basemap
     * tiles from a third party. Gating our own data on those means a blocked or slow
     * tile server produces an empty map - and our potholes are not the basemap's
     * dependants.
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
          cluster: true,
          clusterRadius: 44,
          clusterMaxZoom: 14,
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
        // A soft halo under each marker, so a purple dot stays findable against the
        // yellow-green of a city basemap without making the dot itself larger.
        map.addLayer({
          id: "pothole-halo",
          type: "circle",
          source: SOURCE_ID,
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": STATE_COLOUR_EXPRESSION as never,
            "circle-opacity": 0.18,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 9, 18, 22],
          },
        });
        map.addLayer({
          id: "pothole-points",
          type: "circle",
          source: SOURCE_ID,
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": STATE_COLOUR_EXPRESSION as never,
            "circle-opacity": STATE_OPACITY_EXPRESSION as never,
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 5, 18, 12],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#FFFFFF",
          },
        });

        map.on(
          "click",
          "pothole-points",
          (event: MapMouseEvent & { features?: { properties?: Record<string, unknown> }[] }) => {
            const id = event.features?.[0]?.properties?.id as string | undefined;
            if (id) setSelectedId(id);
          },
        );
        map.on("click", "clusters", (event: MapMouseEvent) => {
          map.easeTo({ center: event.lngLat, zoom: map.getZoom() + 2 });
        });
        map.on("mouseenter", "pothole-points", () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", "pothole-points", () => {
          map.getCanvas().style.cursor = "";
        });

        void load(map);
      } catch (cause) {
        // MapLibre swallows exceptions thrown inside its handlers, which would leave an
        // empty map and no explanation. Surface it.
        setError(
          `Слой карты не создан: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    });

    map.on("moveend", () => void load(map));

    /**
     * Keep the canvas the size of its box.
     *
     * This page sizes itself with a chain of percentage heights from the viewport, so the
     * container can still be zero when MapLibre measures it during construction - and a
     * map built against a zero-size container keeps a 400x300 canvas afterwards. The
     * symptom is the worst kind: the map "works", data loads, counts update, and the
     * canvas is simply blank. An observer fixes it whenever the box settles, rather than
     * relying on the size being right at one particular moment.
     */
    const observer = new ResizeObserver(() => {
      try {
        map.resize();
      } catch {
        // Fired after teardown; nothing to resize.
      }
    });
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      // Clear the ref BEFORE tearing down: `remove()` throws while the style is still
      // loading, and if the assignment below never runs, React's second development
      // mount sees a non-null ref and returns early - leaving a dead canvas with no map.
      disarmBasemapFallback();
      const instance = mapRef.current;
      mapRef.current = null;
      try {
        instance?.remove();
      } catch {
        // Already gone.
      }
    };
  }, [mapStyleUrl, mapWorkerUrl, load]);

  /**
   * Push the visible rows into the map.
   *
   * The filter is applied to the SOURCE, not to the layers. Filtering the layers would
   * hide individual markers while leaving the cluster bubbles counting everything - so
   * turning off "confirmed" would still show a cluster of 32, and the number would
   * contradict the map underneath it. Re-setting the data makes MapLibre recluster, and
   * it costs nothing: the rows are already in memory.
   */
  useEffect(() => {
    const map = mapRef.current;
    const source = map?.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    const visible = hidden.size === 0 ? rows : rows.filter((row) => !hidden.has(row.state));
    source.setData(toFeatureCollection(visible) as never);
  }, [rows, hidden]);

  const toggleState = useCallback((state: PublicState) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  }, []);

  return (
    <div className="relative h-full w-full bg-app">
      {/*
        Sized with h-full, NOT `absolute inset-0`. MapLibre's own stylesheet sets
        `.maplibregl-map { position: relative }`, which has the same specificity as
        Tailwind's `.absolute` and is loaded after it - so the utility loses on source
        order, the container falls back to static flow and collapses to zero height. The
        symptom is a blank map with no error: the canvas exists, the data loads, and
        nothing is drawn because there is nowhere to draw it.
      */}
      <div ref={containerRef} className="h-full w-full" />

      <SummaryCard
        counts={counts}
        loading={loading}
        updatedAt={updatedAt}
        hidden={hidden}
        onToggle={toggleState}
      />

      <LegendCard hidden={hidden} onToggle={toggleState} />

      {error && (
        <div
          role="alert"
          className="pointer-events-auto absolute left-1/2 top-3 z-20 w-[min(92vw,420px)] -translate-x-1/2 rounded-xl bg-red-soft px-4 py-3 text-[13px] shadow-sm"
        >
          <div className="font-semibold text-red-ink">Карта не загрузилась</div>
          <p className="mt-1 text-secondary">{error}</p>
        </div>
      )}

      {/* Telegram Mini App parked. */}
      {/* <ReportButton apiBaseUrl={apiBaseUrl} inTelegram={inTelegram} /> */}

      {selectedId && (
        <PotholeSheet
          apiBaseUrl={apiBaseUrl}
          potholeId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}

      {/* Colour is the only thing distinguishing the markers, so the legend is also
          stated in text for anyone who cannot rely on it. */}
      <p className="sr-only">
        {STATE_ORDER.map((state) => `${STATE_LABEL[state]}: ${counts[state]}`).join(". ")}
      </p>
      <span className="sr-only">
        {STATE_ORDER.map((state) => `${STATE_LABEL[state]} - ${STATE_COLOUR[state]}`).join(", ")}
      </span>
    </div>
  );
}
