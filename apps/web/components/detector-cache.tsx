"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that keeps the model on the device (public/sw.js).
 *
 * Only from the pages that run the detector, so a visit to the map never installs
 * anything. Failure is silent on purpose: without it the detector still loads, it just
 * downloads again next time.
 */
export function DetectorCache() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
