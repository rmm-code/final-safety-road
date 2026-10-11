import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { clampBoxToFrame } from "../postprocess/geometry";
import { getSourceSize } from "./source-size";
import {
  InferenceTimer,
  nowMs,
  type DescribedVisionEngine,
  type VisionEngineStats,
} from "./types";

export type ServerEngineOptions = {
  /** Absolute or relative URL of the inference endpoint. */
  endpoint: string;
  /** Model version reported by the service, until it is returned in the response. */
  modelVersion?: string;
  /** Longest edge of the frame sent to the server, in pixels. */
  maxEdge?: number;
  /** JPEG/WebP quality for the uploaded frame. */
  quality?: number;
  selectionReason?: string;
  fetchImpl?: typeof fetch;
};

type ServerResponse = {
  modelVersion?: unknown;
  detections?: unknown;
};

/**
 * Server inference fallback.
 *
 * Required by the architecture for devices where WebGPU is unavailable or browser
 * inference is too slow, and for validating a model before it is exported to ONNX.
 * It is not wired up by default: the inference service arrives with the backend
 * milestone, and continuous 30 FPS streaming to a server is explicitly not the
 * intended mode of operation.
 *
 * The response is validated and normalised here so a server change can never leak an
 * unexpected shape into the pipeline.
 */
export class ServerVisionEngine implements DescribedVisionEngine {
  readonly info: VisionEngineInfo;

  private readonly config: VisionConfig;
  private readonly options: ServerEngineOptions;
  private readonly timer = new InferenceTimer();
  private busy = false;
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;

  constructor(config: VisionConfig, options: ServerEngineOptions) {
    if (!options.endpoint) throw new Error("ServerVisionEngine requires an endpoint");
    this.config = config;
    this.options = options;
    this.info = {
      kind: "server",
      modelVersion: options.modelVersion ?? "server-unknown",
      backend: "http",
      isSynthetic: false,
      selectionReason: options.selectionReason ?? "Server inference endpoint configured.",
    };
  }

  get stats(): VisionEngineStats {
    return this.timer.snapshot;
  }

  /** Single-class by construction, so there is never anything else to report. */
  get otherClassCounts(): Readonly<Record<string, number>> {
    return {};
  }

  isBusy(): boolean {
    return this.busy;
  }

  async init(): Promise<void> {
    // Nothing to load: the model lives on the server. Connectivity is proven by the
    // first inference, which reports its own error rather than failing at startup.
  }

  async infer(source: CanvasImageSource): Promise<Detection[]> {
    const started = nowMs();
    this.busy = true;
    try {
      const blob = await this.encodeFrame(source);
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": blob.type || "image/jpeg" },
        body: blob,
      });
      if (!response.ok) {
        throw new Error(`Inference server responded ${response.status} ${response.statusText}`);
      }
      const payload = (await response.json()) as ServerResponse;
      if (typeof payload.modelVersion === "string" && payload.modelVersion.trim() !== "") {
        this.info.modelVersion = payload.modelVersion;
      }
      return this.normalise(payload.detections);
    } finally {
      this.busy = false;
      this.timer.record(nowMs() - started);
    }
  }

  async dispose(): Promise<void> {
    this.canvas = null;
  }

  private async encodeFrame(source: CanvasImageSource): Promise<Blob> {
    const { width, height } = getSourceSize(source);
    const maxEdge = this.options.maxEdge ?? this.config.model.inputSize;
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const quality = this.options.quality ?? 0.8;

    if (typeof OffscreenCanvas !== "undefined") {
      if (!this.canvas || this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
        this.canvas = new OffscreenCanvas(targetWidth, targetHeight);
      }
      const canvas = this.canvas as OffscreenCanvas;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("OffscreenCanvas 2D context unavailable");
      context.drawImage(source, 0, 0, targetWidth, targetHeight);
      return canvas.convertToBlob({ type: "image/jpeg", quality });
    }

    if (typeof document === "undefined") {
      throw new Error("ServerVisionEngine requires a browser environment to encode frames");
    }
    if (!this.canvas || this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      const element = document.createElement("canvas");
      element.width = targetWidth;
      element.height = targetHeight;
      this.canvas = element;
    }
    const canvas = this.canvas as HTMLCanvasElement;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D context unavailable");
    context.drawImage(source, 0, 0, targetWidth, targetHeight);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("Frame encoding failed"))),
        "image/jpeg",
        quality,
      );
    });
  }

  /** Accept only well-formed, normalised detections. Anything else is discarded. */
  private normalise(raw: unknown): Detection[] {
    if (!Array.isArray(raw)) return [];
    const detections: Detection[] = [];

    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const confidence = record.confidence;
      const bbox = record.bbox as Record<string, unknown> | undefined;
      if (typeof confidence !== "number" || !Number.isFinite(confidence)) continue;
      if (!bbox) continue;

      const numbers = ["x", "y", "width", "height"].map((key) => bbox[key]);
      if (!numbers.every((value) => typeof value === "number" && Number.isFinite(value))) continue;
      const [x, y, width, height] = numbers as number[];
      if ((width as number) <= 0 || (height as number) <= 0) continue;

      const className = record.className;
      if (className !== undefined && className !== "pothole") continue;

      detections.push({
        classId: typeof record.classId === "number" ? record.classId : 0,
        className: "pothole",
        confidence: Math.min(1, Math.max(0, confidence)),
        bbox: clampBoxToFrame({
          x: x as number,
          y: y as number,
          width: width as number,
          height: height as number,
        }),
      });
    }

    return detections.slice(0, this.config.detection.maxDetections);
  }
}
