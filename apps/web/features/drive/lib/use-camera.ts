"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraStatus =
  | "idle"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable"
  | "insecure"
  | "error";

export type CameraState = {
  status: CameraStatus;
  error: string | null;
  stream: MediaStream | null;
};

/**
 * Rear camera lifecycle.
 *
 * `facingMode: environment` is a preference, not a guarantee: a laptop has only a front
 * camera and will happily return it. The resolution request is also ideal-only, because
 * demanding an exact size fails outright on devices that cannot provide it, and a smaller
 * frame is far better than no camera at all.
 */
export function useCamera() {
  const [state, setState] = useState<CameraState>({ status: "idle", error: null, stream: null });
  const streamRef = useRef<MediaStream | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setState({ status: "idle", error: null, stream: null });
  }, []);

  const start = useCallback(async (): Promise<MediaStream | null> => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      // getUserMedia only exists in a secure context, so this is almost always plain HTTP.
      const insecure = typeof window !== "undefined" && !window.isSecureContext;
      setState({
        status: insecure ? "insecure" : "unavailable",
        error: insecure
          ? "The camera needs HTTPS. Open this page over https, or via localhost during development."
          : "This browser does not provide camera access.",
        stream: null,
      });
      return null;
    }

    setState({ status: "requesting", error: null, stream: null });

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      streamRef.current = stream;
      setState({ status: "ready", error: null, stream });
      return stream;
    } catch (cause) {
      setState({ status: statusFor(cause), error: messageFor(cause), stream: null });
      return null;
    }
  }, []);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  return { ...state, start, stop };
}

function nameOf(cause: unknown): string {
  return cause instanceof Error ? cause.name : "";
}

export function statusFor(cause: unknown): CameraStatus {
  switch (nameOf(cause)) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "unavailable";
    default:
      return "error";
  }
}

export function messageFor(cause: unknown): string {
  switch (nameOf(cause)) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera access was refused. Allow it in the browser's site settings, then start the drive again.";
    case "NotFoundError":
      return "No camera was found on this device.";
    case "OverconstrainedError":
      return "No camera on this device can supply a usable rear-facing video stream.";
    case "NotReadableError":
      return "The camera is already in use by another application. Close it and try again.";
    default:
      return cause instanceof Error ? cause.message : "The camera could not be started.";
  }
}
