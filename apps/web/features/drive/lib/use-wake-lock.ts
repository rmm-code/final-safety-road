"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * Keeps the screen awake for the duration of a drive.
 *
 * A phone that sleeps mid-drive stops the camera and the whole session with it. The API
 * is not universally supported and the lock is dropped whenever the tab is backgrounded,
 * so it is re-acquired on visibility change. Failure is not worth surfacing: it degrades
 * to the device's normal timeout rather than breaking the drive.
 */
export function useWakeLock() {
  const lockRef = useRef<WakeLockSentinel | null>(null);
  const wantedRef = useRef(false);

  const acquire = useCallback(async () => {
    wantedRef.current = true;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    try {
      lockRef.current = await navigator.wakeLock.request("screen");
    } catch {
      // Denied or unsupported: the drive continues, the screen may just dim.
    }
  }, []);

  const release = useCallback(async () => {
    wantedRef.current = false;
    try {
      await lockRef.current?.release();
    } catch {
      // Already released.
    }
    lockRef.current = null;
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible" && wantedRef.current) void acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void lockRef.current?.release().catch(() => {});
    };
  }, [acquire]);

  return { acquire, release };
}
