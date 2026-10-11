"use client";

import { useEffect, useRef, useState } from "react";
import type { VisionEngineInfo } from "@pothole/shared-types";
import { createVisionEngine, type DescribedVisionEngine } from "@pothole/vision-web";
import type { AppConfig } from "@/lib/config";

/**
 * The detector, created once for the component that owns it and disposed with it.
 *
 * Selection is reported, never silent: `info` says which engine and model actually loaded,
 * and when no model is deployed the app falls back to the clearly labelled synthetic engine.
 */
export function useVisionEngine(config: AppConfig) {
  const engineRef = useRef<DescribedVisionEngine | null>(null);
  const [info, setInfo] = useState<VisionEngineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    createVisionEngine({
      mode: config.visionMode,
      config: config.vision,
      manifestUrl: config.modelManifestUrl,
      wasmPath: config.ortWasmPath,
      ortLogLevel: config.ortLogLevel,
      ...(config.serverVisionUrl ? { serverUrl: config.serverVisionUrl } : {}),
    })
      .then((engine) => {
        if (disposed) {
          void engine.dispose();
          return;
        }
        engineRef.current = engine;
        setInfo(engine.info);
      })
      .catch((cause: unknown) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      disposed = true;
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [config]);

  return { engineRef, info, error };
}
