"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LocationBuffer } from "@pothole/vision-web";
import type { LocationSample } from "@pothole/shared-types";

export type LocationStatus = "idle" | "requesting" | "tracking" | "denied" | "unavailable" | "error";

export type LocationState = {
  status: LocationStatus;
  error: string | null;
  latest: LocationSample | null;
  samples: number;
};

/**
 * Continuous position tracking into a timestamped buffer.
 *
 * `watchPosition` rather than repeated `getCurrentPosition`: the browser keeps the GPS
 * warm, delivers fixes as they arrive, and a moving vehicle needs the trail, not a single
 * reading. Every fix keeps its reported accuracy, which travels all the way onto the
 * uploaded event - a phone coordinate is never treated as exact.
 */
export function useLocation() {
  // A stable instance for the lifetime of the component. Held in state rather than a
  // ref because it is read during render to be handed to the recorder.
  const [buffer] = useState(() => new LocationBuffer());
  const watchIdRef = useRef<number | null>(null);
  const [state, setState] = useState<LocationState>({
    status: "idle",
    error: null,
    latest: null,
    samples: 0,
  });

  const stop = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== "undefined") {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    setState((current) => ({ ...current, status: "idle" }));
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setState({
        status: "unavailable",
        error: "This browser does not provide location access.",
        latest: null,
        samples: 0,
      });
      return;
    }

    buffer.clear();
    setState({ status: "requesting", error: null, latest: null, samples: 0 });

    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const sample: LocationSample = {
          timestamp: position.timestamp,
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          speedMps: position.coords.speed,
          headingDeg: position.coords.heading,
        };
        buffer.add(sample);
        setState({
          status: "tracking",
          error: null,
          latest: sample,
          samples: buffer.size,
        });
      },
      (error) => {
        setState({
          status: error.code === error.PERMISSION_DENIED ? "denied" : "error",
          error: locationMessage(error),
          latest: null,
          samples: buffer.size,
        });
      },
      // High accuracy is the point of the product; a stale cached fix would place
      // potholes on the wrong street.
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15_000 },
    );
  }, [buffer]);

  useEffect(
    () => () => {
      if (watchIdRef.current !== null && typeof navigator !== "undefined") {
        navigator.geolocation.clearWatch(watchIdRef.current);
      }
    },
    [],
  );

  return { ...state, buffer, start, stop };
}

export function locationMessage(error: GeolocationPositionError): string {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      return "Location access was refused. Potholes cannot be placed on the map without it.";
    case error.POSITION_UNAVAILABLE:
      return "No position fix is available. Move somewhere with a clearer view of the sky.";
    case error.TIMEOUT:
      return "The device took too long to produce a position fix.";
    default:
      return error.message || "Location tracking failed.";
  }
}
