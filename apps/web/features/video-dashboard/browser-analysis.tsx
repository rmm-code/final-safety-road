"use client";

import { useEffect } from "react";
import type { AppConfig } from "@/lib/config";
import {
  AnalysisAbortedError,
  analyseVideo,
  type AnalysisProgress,
  type VideoAnalysisResult,
} from "@/features/analyze/lib/analyse-video";
import { useVisionEngine } from "@/features/analyze/lib/use-vision-engine";
import type { AnalysisSettings } from "@/features/videos/lib/analysis-id";

/**
 * Analyses the dashboard's video in this browser with the deployed model. Mounted only on
 * request, so the model is downloaded only then. Renders nothing.
 */
export function BrowserAnalysis({
  config,
  videoRef,
  onProgress,
  onResult,
  onError,
}: {
  config: AppConfig;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onProgress: (progress: AnalysisProgress) => void;
  onResult: (result: VideoAnalysisResult, settings: AnalysisSettings) => void;
  onError: (message: string) => void;
}) {
  const { engineRef, info, error } = useVisionEngine(config);

  useEffect(() => {
    if (error) onError(`The detector could not start: ${error}`);
  }, [error, onError]);

  useEffect(() => {
    const video = videoRef.current;
    const engine = engineRef.current;
    if (!info || !engine || !video) return;
    const controller = new AbortController();
    const run = async () => {
      if (video.readyState < 1) {
        await new Promise((resolve) => video.addEventListener("loadedmetadata", resolve, { once: true }));
      }
      engine.reset?.();
      try {
        const result = await analyseVideo({ video, engine, config: config.vision, signal: controller.signal, onProgress });
        video.currentTime = 0;
        onResult(result, {
          modelVersion: result.engine.modelVersion,
          confidenceThreshold: config.vision.detection.confidenceThreshold,
          sampleFps: config.vision.analysis.sampleFps,
        });
      } catch (cause) {
        if (!(cause instanceof AnalysisAbortedError)) onError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void run();
    return () => controller.abort();
  }, [config, engineRef, info, onError, onProgress, onResult, videoRef]);

  return null;
}
