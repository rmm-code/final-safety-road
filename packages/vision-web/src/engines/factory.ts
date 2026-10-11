import { DEFAULT_VISION_CONFIG, type VisionConfig } from "../config/vision-config";
import { MockVisionEngine } from "./mock-vision-engine";
import { OnnxVisionEngine, type OrtLogLevel } from "./onnx-vision-engine";
import { ServerVisionEngine } from "./server-vision-engine";
import { parseModelManifest, resolveModelFileUrl, type ModelManifest } from "./model-manifest";
import type { DescribedVisionEngine } from "./types";

export type VisionEngineMode = "auto" | "onnx" | "server" | "mock";

export type CreateVisionEngineOptions = {
  /** Defaults to "auto". */
  mode?: VisionEngineMode;
  config?: VisionConfig;
  /** Where the model manifest is served from, e.g. "/models/model.json". */
  manifestUrl?: string;
  /** Inference service endpoint used by the server fallback. */
  serverUrl?: string;
  /** Directory serving the onnxruntime-web .wasm binaries. */
  wasmPath?: string;
  /**
   * ONNX Runtime log severity. Defaults to "error" inside the engine, because ORT routes
   * its warnings to `console.error` and a benign one then reads as a page error.
   */
  ortLogLevel?: OrtLogLevel;
  /**
   * ONNX Runtime execution providers to try, in order. Defaults to WebGPU then WASM.
   * Forcing one is for diagnosis - for example proving that a model which returns nothing
   * on WebGPU works on WASM, which is what a phone without WebGPU would run.
   */
  executionProviders?: string[];
  /**
   * ONNX only: also return potholes down to this confidence, for a caller that filters at
   * its own threshold (the /analyze slider). Mock and server output is not thresholded.
   */
  confidenceFloor?: number;
  /** Overrides the synthetic engine seed. Only affects the mock. */
  seed?: number;
  fetchImpl?: typeof fetch;
};

/** Fetch and validate a model manifest. Returns null when none is deployed. */
export async function loadModelManifest(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelManifest | null> {
  let response: Response;
  try {
    response = await fetchImpl(url, { cache: "no-cache" });
  } catch (error) {
    throw new Error(
      `Could not reach the model manifest at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Model manifest at ${url} responded ${response.status} ${response.statusText}`);
  }

  const raw: unknown = await response.json();
  return parseModelManifest(raw);
}

/**
 * Resolve an INITIALISED vision engine.
 *
 * Selection order in "auto" mode follows the product principle "browser inference
 * first, server fallback must exist":
 *
 *   1. ONNX in the browser, when a valid model manifest is deployed.
 *   2. The server inference adapter, when an endpoint is configured.
 *   3. The synthetic engine, which is always available and always labelled synthetic.
 *
 * Selection is never silent: the chosen engine carries a `selectionReason` that the UI
 * displays, so a fallback to synthetic output can never be mistaken for real detection.
 */
export async function createVisionEngine(
  options: CreateVisionEngineOptions = {},
): Promise<DescribedVisionEngine> {
  const config = options.config ?? DEFAULT_VISION_CONFIG;
  const mode = options.mode ?? "auto";
  const fetchImpl = options.fetchImpl ?? (typeof fetch !== "undefined" ? fetch : undefined);

  const makeMock = (selectionReason: string): DescribedVisionEngine =>
    new MockVisionEngine(config, {
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      selectionReason,
    });

  const buildOnnx = async (selectionReason: string): Promise<DescribedVisionEngine> => {
    const manifestUrl = options.manifestUrl;
    if (!manifestUrl) throw new Error("ONNX engine requires a model manifest URL");
    if (!fetchImpl) throw new Error("ONNX engine requires fetch to load the model manifest");

    const manifest = await loadModelManifest(manifestUrl, fetchImpl);
    if (!manifest) throw new Error(`No model manifest deployed at ${manifestUrl}`);

    return new OnnxVisionEngine(config, {
      modelUrl: resolveModelFileUrl(manifestUrl, manifest),
      manifest,
      ...(options.wasmPath ? { wasmPath: options.wasmPath } : {}),
      ...(options.ortLogLevel ? { logLevel: options.ortLogLevel } : {}),
      ...(options.executionProviders ? { executionProviders: options.executionProviders } : {}),
      ...(options.confidenceFloor !== undefined ? { confidenceFloor: options.confidenceFloor } : {}),
      selectionReason,
    });
  };

  const buildServer = (selectionReason: string): DescribedVisionEngine => {
    if (!options.serverUrl) throw new Error("Server engine requires an endpoint URL");
    return new ServerVisionEngine(config, {
      endpoint: options.serverUrl,
      ...(fetchImpl ? { fetchImpl } : {}),
      selectionReason,
    });
  };

  let engine: DescribedVisionEngine;

  switch (mode) {
    case "mock":
      engine = makeMock("Synthetic engine forced by configuration.");
      break;

    case "onnx":
      engine = await buildOnnx("ONNX engine forced by configuration.");
      break;

    case "server":
      engine = buildServer("Server inference forced by configuration.");
      break;

    case "auto": {
      const reasons: string[] = [];
      try {
        engine = await buildOnnx("Deployed ONNX model detected; running inference in the browser.");
        await engine.init();
        return engine;
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }

      if (options.serverUrl) {
        try {
          engine = buildServer(
            `Browser inference unavailable (${reasons.join("; ")}); using the server inference endpoint.`,
          );
          await engine.init();
          return engine;
        } catch (error) {
          reasons.push(error instanceof Error ? error.message : String(error));
        }
      }

      engine = makeMock(
        `No usable detector: ${reasons.join("; ")}. Detections below are SYNTHETIC, not model output.`,
      );
      break;
    }

    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown vision engine mode: ${String(exhaustive)}`);
    }
  }

  await engine.init();
  return engine;
}
