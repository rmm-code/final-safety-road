"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { configureMapLibreWorker } from "@/lib/maplibre-worker";
import { attachBasemapFallback, basemapStyle } from "@/features/map/lib/map-style";

type Point = { latitude: number; longitude: number };

// Tashkent, so the picker opens on the city the product serves.
const DEFAULT_CENTRE: [number, number] = [69.2797, 41.3112];
const PIN_COLOUR = "#292929";

/** A small map: click where the video was filmed. */
export function LocationPicker({
  value,
  onChange,
  mapStyleUrl,
  mapWorkerUrl,
  disabled = false,
}: {
  value: Point | null;
  onChange: (point: Point) => void;
  mapStyleUrl: string;
  mapWorkerUrl: string;
  disabled?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  // The click handler is registered once; these keep it reading the latest props.
  const onChangeRef = useRef(onChange);
  const disabledRef = useRef(disabled);
  useEffect(() => {
    onChangeRef.current = onChange;
    disabledRef.current = disabled;
  }, [onChange, disabled]);

  useEffect(() => {
    if (!containerRef.current) return;
    configureMapLibreWorker(mapWorkerUrl);
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: basemapStyle(mapStyleUrl) as never,
      center: DEFAULT_CENTRE,
      zoom: 12,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    const disarmBasemapFallback = attachBasemapFallback(map);
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("click", (event) => {
      // MapLibre swallows exceptions thrown in its handlers, which hides the cause.
      try {
        if (disabledRef.current) return;
        onChangeRef.current({ latitude: event.lngLat.lat, longitude: event.lngLat.lng });
      } catch (cause) {
        console.error("Location picker click failed", cause);
      }
    });
    return () => {
      disarmBasemapFallback();
      markerRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [mapStyleUrl, mapWorkerUrl]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!value) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    const at: [number, number] = [value.longitude, value.latitude];
    if (markerRef.current) markerRef.current.setLngLat(at);
    else markerRef.current = new maplibregl.Marker({ color: PIN_COLOUR }).setLngLat(at).addTo(map);
    map.easeTo({ center: at, zoom: Math.max(map.getZoom(), 16) });
  }, [value]);

  return (
    <div
      ref={containerRef}
      role="application"
      aria-label="Map. Click where the video was filmed."
      className="h-60 w-full overflow-hidden rounded-lg bg-subtle"
    />
  );
}
