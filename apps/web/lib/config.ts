import { DEFAULT_VISION_CONFIG, resolveVisionConfig, type VisionConfig } from "@pothole/vision-web";
import type { OrtLogLevel, VisionEngineMode } from "@pothole/vision-web";

/**
 * Runtime configuration, read once from the environment.
 *
 * Thresholds live in the vision package (mirroring ai/configs/vision.yaml); this module
 * only carries deployment-level settings. Nothing here may be hard-coded in a component.
 */

function readMode(raw: string | undefined): VisionEngineMode {
  const allowed: VisionEngineMode[] = ["auto", "onnx", "server", "mock"];
  if (raw && (allowed as string[]).includes(raw)) return raw as VisionEngineMode;
  return "auto";
}

/**
 * ONNX Runtime log severity.
 *
 * "error" by default: ORT writes warnings to stderr, Emscripten pipes stderr to
 * `console.error`, and the Next.js dev overlay reports every `console.error` as a page
 * error. Set NEXT_PUBLIC_ORT_LOG_LEVEL=warning when debugging the runtime itself.
 */
function readOrtLogLevel(raw: string | undefined): OrtLogLevel {
  const allowed: OrtLogLevel[] = ["verbose", "info", "warning", "error", "fatal"];
  if (raw && (allowed as string[]).includes(raw)) return raw as OrtLogLevel;
  return "error";
}

function readPositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export type AppConfig = {
  apiBaseUrl: string;
  mapStyleUrl: string;
  visionMode: VisionEngineMode;
  modelManifestUrl: string;
  ortWasmPath: string;
  ortLogLevel: OrtLogLevel;
  /** Where MapLibre's worker is served from. Populate with sync:maplibre-worker. */
  mapWorkerUrl: string;
  serverVisionUrl: string;
  /** Frames per second sampled from an uploaded video during analysis. */
  analyzeSampleFps: number;
  vision: VisionConfig;
};

export function getAppConfig(): AppConfig {
  const analyzeSampleFps = readPositiveNumber(
    process.env.NEXT_PUBLIC_ANALYZE_SAMPLE_FPS,
    DEFAULT_VISION_CONFIG.analysis.sampleFps,
  );

  return {
    // Empty means this origin: next.config.ts forwards /api/v1 to the API, so a phone
    // that can open the page can reach the API. Set it only to call an API elsewhere.
    apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL || "",
    // A raster style from OpenStreetMap tiles. Our pothole data never leaves our own
    // database; only the basemap comes from outside.
    mapStyleUrl: process.env.NEXT_PUBLIC_MAP_STYLE_URL || "",
    visionMode: readMode(process.env.NEXT_PUBLIC_VISION_ENGINE),
    modelManifestUrl: process.env.NEXT_PUBLIC_MODEL_MANIFEST_URL || "/models/model.json",
    ortWasmPath: process.env.NEXT_PUBLIC_ORT_WASM_PATH || "/ort/",
    ortLogLevel: readOrtLogLevel(process.env.NEXT_PUBLIC_ORT_LOG_LEVEL),
    mapWorkerUrl:
      process.env.NEXT_PUBLIC_MAPLIBRE_WORKER_URL || "/maplibre/maplibre-gl-worker.js",
    serverVisionUrl: process.env.NEXT_PUBLIC_SERVER_VISION_URL || "",
    analyzeSampleFps,
    vision: resolveVisionConfig({ analysis: { sampleFps: analyzeSampleFps } }),
  };
}
