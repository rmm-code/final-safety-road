import { POTHOLE_CLASS_ALIASES, isPotholeClass, type RawOutputLayout } from "../postprocess/decode";

/**
 * Describes a deployed model. Served next to the weights as /models/model.json.
 *
 * The manifest, not the code, decides input size, class order, output layout and the
 * semantic version recorded on every detection event. A new model is a new manifest;
 * deployed versions are never overwritten.
 */
export type ModelManifest = {
  name: string;
  /** Semantic version, e.g. "0.1.0". Recorded as `${name}-${version}` on events. */
  version: string;
  /** URL of the .onnx file, absolute or relative to the manifest. */
  file: string;
  /** Longest input edge. Kept for compatibility; prefer the explicit pair below. */
  inputSize: number;
  /**
   * Exact network input width and height, taken from the exported graph.
   *
   * These are usually NOT equal: Ultralytics runs inference rectangularly (384x640 for
   * 16:9 footage), and letterboxing into a square instead wastes almost half the tensor
   * on padding, which measurably reduces what the model detects.
   */
  inputWidth?: number;
  inputHeight?: number;
  classNames: string[];
  /** "segment" models append mask coefficients to the detection head. */
  task?: "detect" | "segment";
  outputLayout?: RawOutputLayout;
  /**
   * Extra channels a segmentation head appends after the class scores (32 for the
   * Ultralytics `-seg` models). Required for segmentation models: `4 + nc + 32` cannot
   * be told apart from a 33-class detector by shape alone.
   */
  maskCoefficients?: number;
  /** Optional per-model overrides of the pipeline defaults. */
  confidenceThreshold?: number;
  nmsIouThreshold?: number;
};

const LAYOUTS: RawOutputLayout[] = ["auto", "channels-first", "channels-last", "end-to-end"];
const TASKS = ["detect", "segment"];

function fail(message: string): never {
  throw new Error(`Invalid model manifest: ${message}`);
}

/** Validate untrusted manifest JSON. A malformed manifest must never reach the engine. */
export function parseModelManifest(raw: unknown): ModelManifest {
  if (typeof raw !== "object" || raw === null) fail("expected a JSON object");
  const value = raw as Record<string, unknown>;

  const requireString = (key: string): string => {
    const item = value[key];
    if (typeof item !== "string" || item.trim() === "") fail(`"${key}" must be a non-empty string`);
    return item;
  };

  const inputSize = value.inputSize;
  if (typeof inputSize !== "number" || !Number.isFinite(inputSize) || inputSize <= 0) {
    fail('"inputSize" must be a positive number');
  }

  const positiveDimension = (key: string): number | undefined => {
    const item = value[key];
    if (item === undefined) return undefined;
    if (typeof item !== "number" || !Number.isInteger(item) || item <= 0) {
      fail(`"${key}" must be a positive integer`);
    }
    return item as number;
  };
  const inputWidth = positiveDimension("inputWidth");
  const inputHeight = positiveDimension("inputHeight");

  const classNames = value.classNames;
  if (
    !Array.isArray(classNames) ||
    classNames.length === 0 ||
    !classNames.every((c) => typeof c === "string" && c.trim() !== "")
  ) {
    fail('"classNames" must be a non-empty array of strings');
  }
  if (!(classNames as string[]).some((name) => isPotholeClass(name))) {
    fail(
      '"classNames" must contain a pothole class (one of: ' +
        [...POTHOLE_CLASS_ALIASES].join(", ") +
        "); the product has no other detection class",
    );
  }

  const outputLayout = value.outputLayout;
  if (outputLayout !== undefined && !LAYOUTS.includes(outputLayout as RawOutputLayout)) {
    fail(`"outputLayout" must be one of ${LAYOUTS.join(", ")}`);
  }

  const task = value.task;
  if (task !== undefined && !TASKS.includes(task as string)) {
    fail(`"task" must be one of ${TASKS.join(", ")}`);
  }

  const maskCoefficients = value.maskCoefficients;
  if (maskCoefficients !== undefined) {
    if (
      typeof maskCoefficients !== "number" ||
      !Number.isInteger(maskCoefficients) ||
      maskCoefficients < 0
    ) {
      fail('"maskCoefficients" must be a non-negative integer');
    }
  }
  if (task === "segment" && !maskCoefficients) {
    fail('a "segment" model must declare "maskCoefficients" (32 for Ultralytics -seg models)');
  }

  const optionalUnitInterval = (key: string): number | undefined => {
    const item = value[key];
    if (item === undefined) return undefined;
    if (typeof item !== "number" || !(item >= 0 && item <= 1)) fail(`"${key}" must be between 0 and 1`);
    return item;
  };

  return {
    name: requireString("name"),
    version: requireString("version"),
    file: requireString("file"),
    inputSize,
    ...(inputWidth !== undefined ? { inputWidth } : {}),
    ...(inputHeight !== undefined ? { inputHeight } : {}),
    classNames: classNames as string[],
    ...(task ? { task: task as "detect" | "segment" } : {}),
    ...(outputLayout ? { outputLayout: outputLayout as RawOutputLayout } : {}),
    ...(maskCoefficients ? { maskCoefficients: maskCoefficients as number } : {}),
    ...(optionalUnitInterval("confidenceThreshold") !== undefined
      ? { confidenceThreshold: optionalUnitInterval("confidenceThreshold") as number }
      : {}),
    ...(optionalUnitInterval("nmsIouThreshold") !== undefined
      ? { nmsIouThreshold: optionalUnitInterval("nmsIouThreshold") as number }
      : {}),
  };
}

/** Full model version string recorded on every detection produced by this model. */
export function modelVersionOf(manifest: ModelManifest): string {
  return `${manifest.name}-${manifest.version}`;
}

/** Resolve the weights URL relative to the manifest location. */
export function resolveModelFileUrl(manifestUrl: string, manifest: ModelManifest): string {
  if (/^https?:\/\//i.test(manifest.file) || manifest.file.startsWith("/")) return manifest.file;
  const base = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  return `${base}${manifest.file}`;
}

/** Network input dimensions, falling back to a square when the manifest predates the pair. */
export function modelInputSize(manifest: ModelManifest): { width: number; height: number } {
  return {
    width: manifest.inputWidth ?? manifest.inputSize,
    height: manifest.inputHeight ?? manifest.inputSize,
  };
}
