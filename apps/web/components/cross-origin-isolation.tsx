"use client";

import { useEffect, useSyncExternalStore } from "react";
import { DetectorCache } from "./detector-cache";

const RELOADED_AT = "pothole.isolation-reload";
/** A reload this recent that still did not isolate means the browser cannot. */
const RELOAD_GRACE_MS = 10_000;

type Decision = "pending" | "ready" | "reload";

/** Read once per render; nothing about it changes without a page load. */
function decide(): Decision {
  if (window.crossOriginIsolated) return "ready";
  try {
    const last = Number(sessionStorage.getItem(RELOADED_AT) ?? 0);
    return Date.now() - last > RELOAD_GRACE_MS ? "reload" : "ready";
  } catch {
    // Storage unavailable: no way to remember a reload, so never risk a loop.
    return "ready";
  }
}

const noSubscription = () => () => {};

/**
 * Makes sure the detector pages run in a cross-origin isolated document.
 *
 * The server sends the isolation headers for these routes (next.config.ts), but they only
 * take effect when a document is LOADED. Arriving through a client-side link keeps the
 * previous, unisolated document - and with it a single-threaded WASM detector. So this
 * reloads once, before the detector starts, rather than loading a 50 MB model twice.
 *
 * A browser that cannot isolate at all would reload forever; the timestamp stops that, and
 * the page then runs as it did before, just without threads.
 */
export function CrossOriginIsolation({ children }: { children: React.ReactNode }) {
  const decision = useSyncExternalStore<Decision>(noSubscription, decide, () => "pending");

  useEffect(() => {
    if (decision !== "reload") return;
    try {
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
      window.location.reload();
    } catch {
      // Cannot remember the attempt, so do not make it.
    }
  }, [decision]);

  return decision === "ready" ? (
    <>
      <DetectorCache />
      {children}
    </>
  ) : null;
}
