import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { computeLetterbox, type LetterboxTransform } from "../postprocess/letterbox";
import { decodeDetections, type RawTensor } from "../postprocess/decode";
import { getSourceSize } from "./source-size";
import {
  InferenceTimer,
  nowMs,
  type DescribedVisionEngine,
  type VisionEngineStats,
} from "./types";
import { modelInputSize, modelVersionOf, type ModelManifest } from "./model-manifest";

/** Padding colour used by the standard YOLO letterbox. */
const LETTERBOX_FILL = "rgb(114,114,114)";

/** Mirrors onnxruntime-web's `Env["logLevel"]`. Declared here so the runtime stays a dynamic import. */
export type OrtLogLevel = "verbose" | "info" | "warning" | "error" | "fatal";

/** ORT's numeric severity scale, which the per-session option uses instead of the names. */
const LOG_SEVERITY: Record<OrtLogLevel, 0 | 1 | 2 | 3 | 4> = {
  verbose: 0,
  info: 1,
  warning: 2,
  error: 3,
  fatal: 4,
};

/**
 * Warnings are off by default.
 *
 * ORT's native logger writes to stderr; Emscripten pipes stderr to `console.error`; the
 * Next.js dev overlay promotes every `console.error` to a red "Console Error". At ORT's
 * own default of "warning" that turns one benign, unactionable line into what looks like
 * a failed session:
 *
 *   VerifyEachNodeIsAssignedToAnEp - Some nodes were not assigned to the preferred
 *   execution providers ... ORT explicitly assigns shape related ops to CPU
 *
 * ORT does that on purpose, so there is nothing to act on. A provider that genuinely
 * cannot start throws, and `init` catches that and falls through to the next one - no
 * diagnostic is lost by silencing warnings.
 */
const DEFAULT_LOG_LEVEL: OrtLogLevel = "error";

export type OnnxEngineOptions = {
  /** URL of the .onnx weights. */
  modelUrl: string;
  manifest: ModelManifest;
  /** Directory serving the onnxruntime-web .wasm binaries. */
  wasmPath?: string;
  /**
   * Execution providers to try, in order. WebGPU first because it is dramatically
   * faster on phones; WASM is the compatibility fallback required by the spec.
   */
  executionProviders?: string[];
  /** ONNX Runtime log severity. Defaults to "error"; raise it to debug the runtime. */
  logLevel?: OrtLogLevel;
  /**
   * Also return potholes down to this confidence, below the configured threshold, for a
   * caller that applies its own threshold afterwards. Other classes are still counted
   * only at the configured threshold.
   */
  confidenceFloor?: number;
  selectionReason?: string;
};

type Canvas2D = {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
};

function createCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("OffscreenCanvas 2D context unavailable");
    return { canvas, context };
  }
  if (typeof document === "undefined") {
    throw new Error("OnnxVisionEngine requires a browser environment");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas 2D context unavailable");
  return { canvas, context };
}

/**
 * Browser inference with ONNX Runtime Web.
 *
 * onnxruntime-web is imported dynamically so that the runtime is only downloaded when
 * a model is actually deployed: with no weights present the app must still load fast
 * and fall back to the synthetic engine.
 *
 * Output layout comes from the manifest, which `python -m ai.export.to_onnx` writes from
 * the shapes it observes in the exported graph rather than assuming: Ultralytics changes
 * its default between versions, and a segmentation head appends mask coefficients.
 * Supported heads are the raw YOLOv8/v11 detection output, its transpose, and the
 * end-to-end `[1, n, 6]` head that YOLO26 exports by default.
 *
 * For a segmentation model only the detection output is read; prototype/coefficient mask
 * fusion is deferred, so boxes are used in the browser. The Python pipeline reads real
 * mask contours from Ultralytics, so mask-quality areas are available there today.
 */
export class OnnxVisionEngine implements DescribedVisionEngine {
  readonly info: VisionEngineInfo;

  private readonly config: VisionConfig;
  private readonly options: OnnxEngineOptions;
  private readonly timer = new InferenceTimer();
  private session: { run: (feeds: Record<string, unknown>) => Promise<Record<string, RawTensor>>; inputNames: readonly string[]; outputNames: readonly string[]; release?: () => Promise<void> } | null = null;
  private tensorFactory: ((type: "float32", data: Float32Array, dims: number[]) => unknown) | null = null;
  private scratch: Canvas2D | null = null;
  private busy = false;
  private readonly otherClasses: Record<string, number> = {};

  constructor(config: VisionConfig, options: OnnxEngineOptions) {
    this.config = config;
    this.options = options;
    this.info = {
      kind: "onnx",
      modelVersion: modelVersionOf(options.manifest),
      backend: "pending",
      isSynthetic: false,
      selectionReason: options.selectionReason ?? "ONNX model manifest resolved.",
    };
  }

  get stats(): VisionEngineStats {
    return this.timer.snapshot;
  }

  get otherClassCounts(): Readonly<Record<string, number>> {
    return this.otherClasses;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async init(): Promise<void> {
    if (this.session) return;

    const ort = await import("onnxruntime-web");
    if (this.options.wasmPath) {
      ort.env.wasm.wasmPaths = this.options.wasmPath;
    }

    // Two knobs, because they feed different loggers. `env.logLevel` covers messages the
    // runtime emits before any session exists, and is read once when the WASM module
    // first initialises. `logSeverityLevel` governs the session's own logger, which is
    // the one that reports execution-provider assignment - so it is the load-bearing half.
    const logLevel = this.options.logLevel ?? DEFAULT_LOG_LEVEL;
    ort.env.logLevel = logLevel;
    const logSeverityLevel = LOG_SEVERITY[logLevel];

    const providers = this.options.executionProviders ?? ["webgpu", "wasm"];
    const failures: string[] = [];

    for (const provider of providers) {
      try {
        const session = await ort.InferenceSession.create(this.options.modelUrl, {
          executionProviders: [provider],
          graphOptimizationLevel: "all",
          logSeverityLevel,
        });
        this.session = session as unknown as typeof this.session;
        this.tensorFactory = (type, data, dims) => new ort.Tensor(type, data, dims);
        this.info.backend = provider;
        return;
      } catch (error) {
        failures.push(`${provider}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(
      `No ONNX execution provider could be initialised (${failures.join("; ")}). ` +
        "WebGPU may be unavailable and the WASM binaries may be missing - run " +
        "`npm run sync:ort-runtime --workspace @pothole/web`.",
    );
  }

  async infer(source: CanvasImageSource): Promise<Detection[]> {
    const session = this.session;
    const makeTensor = this.tensorFactory;
    if (!session || !makeTensor) throw new Error("OnnxVisionEngine.infer called before init()");

    const started = nowMs();
    this.busy = true;
    try {
      const { width: sourceWidth, height: sourceHeight } = getSourceSize(source);
      const input = modelInputSize(this.options.manifest);
      const transform = computeLetterbox(sourceWidth, sourceHeight, input.width, input.height);

      const tensorData = this.preprocess(source, transform, input.width, input.height);
      const inputName = session.inputNames[0];
      if (!inputName) throw new Error("Model exposes no inputs");

      const feeds = {
        [inputName]: makeTensor("float32", tensorData, [1, 3, input.height, input.width]),
      };
      const outputs = await session.run(feeds);

      const outputName = session.outputNames[0];
      const raw = outputName ? outputs[outputName] : undefined;
      if (!raw) throw new Error("Model produced no detection output");

      const manifest = this.options.manifest;
      const threshold = manifest.confidenceThreshold ?? this.config.detection.confidenceThreshold;
      return decodeDetections(raw, {
        classNames: manifest.classNames,
        confidenceThreshold: Math.min(threshold, this.options.confidenceFloor ?? threshold),
        nmsIouThreshold: manifest.nmsIouThreshold ?? this.config.detection.nmsIouThreshold,
        maxDetections: this.config.detection.maxDetections,
        transform,
        ...(manifest.outputLayout ? { layout: manifest.outputLayout } : {}),
        ...(manifest.maskCoefficients ? { maskCoefficients: manifest.maskCoefficients } : {}),
        onSkippedClass: (className, confidence) => {
          if (confidence < threshold) return;
          this.otherClasses[className] = (this.otherClasses[className] ?? 0) + 1;
        },
      });
    } finally {
      this.busy = false;
      this.timer.record(nowMs() - started);
    }
  }

  async dispose(): Promise<void> {
    await this.session?.release?.();
    this.session = null;
    this.tensorFactory = null;
    this.scratch = null;
  }

  /** Letterbox onto the network's input rectangle, then convert RGBA to NCHW float32. */
  private preprocess(
    source: CanvasImageSource,
    transform: LetterboxTransform,
    inputWidth: number,
    inputHeight: number,
  ): Float32Array {
    if (!this.scratch) this.scratch = createCanvas(inputWidth, inputHeight);
    const { canvas, context } = this.scratch;
    if (canvas.width !== inputWidth || canvas.height !== inputHeight) {
      canvas.width = inputWidth;
      canvas.height = inputHeight;
    }

    const { width: sourceWidth, height: sourceHeight } = getSourceSize(source);
    context.fillStyle = LETTERBOX_FILL;
    context.fillRect(0, 0, inputWidth, inputHeight);
    context.drawImage(
      source,
      transform.padX,
      transform.padY,
      sourceWidth * transform.scale,
      sourceHeight * transform.scale,
    );

    const { data } = context.getImageData(0, 0, inputWidth, inputHeight);
    const pixels = inputWidth * inputHeight;
    const tensor = new Float32Array(pixels * 3);

    for (let i = 0; i < pixels; i += 1) {
      const offset = i * 4;
      tensor[i] = (data[offset] as number) / 255;
      tensor[pixels + i] = (data[offset + 1] as number) / 255;
      tensor[pixels * 2 + i] = (data[offset + 2] as number) / 255;
    }
    return tensor;
  }
}
