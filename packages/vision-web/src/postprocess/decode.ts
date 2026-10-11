import type { Detection } from "@pothole/shared-types";
import {
  inputBoxToNormalised,
  inputCornersToNormalised,
  type LetterboxTransform,
} from "./letterbox";
import { nonMaximumSuppression, type ScoredBox } from "./nms";
import { boxArea } from "./geometry";

/**
 * Supported raw output layouts.
 *
 * "channels-first": [1, 4 + numClasses, numAnchors] - the default Ultralytics
 *   YOLOv8/v11 ONNX export. Values are laid out channel by channel.
 * "channels-last": [1, numAnchors, 4 + numClasses] - produced by some export
 *   pipelines that transpose the head.
 * "end-to-end": [1, maxDetections, 6] - `x1, y1, x2, y2, confidence, classId`, with NMS
 *   already applied inside the graph. This is the YOLO26 default export and what any
 *   `nms=True` export produces.
 *
 * A segmentation head appends `maskCoefficients` extra channels after the class scores
 * (32 for the Ultralytics `-seg` models) and emits a second prototype output. The extra
 * channels are skipped here: the browser pipeline uses boxes, and prototype/coefficient
 * mask fusion is deferred. The Python pipeline reads real mask contours from Ultralytics
 * directly, so segmentation-quality areas are available there today.
 *
 * Box values are centre-form (cx, cy, w, h) in MODEL INPUT pixels. Class scores are
 * already sigmoid-activated and there is no separate objectness channel. A future
 * model with a different head declares its layout in model.json rather than forcing
 * changes here.
 */
/**
 * Class names that mean "pothole" across the public checkpoints worth deploying.
 *
 * "d40" is the RDD2022 label for a pothole. That dataset also carries D00/D10/D20 for
 * crack types and "Repair" for patched asphalt - none of which this product reports, so
 * they are dropped here rather than leaking outward as potholes.
 *
 * Kept in step with POTHOLE_CLASS_ALIASES in ai/inference/detector.py.
 */
export const POTHOLE_CLASS_ALIASES = new Set(["pothole", "potholes", "d40"]);

/** True when a model's class name denotes a pothole. */
export function isPotholeClass(name: string | undefined): boolean {
  return name !== undefined && POTHOLE_CLASS_ALIASES.has(name.trim().toLowerCase());
}

export type RawOutputLayout = "auto" | "channels-first" | "channels-last" | "end-to-end";

export type RawTensor = {
  data: Float32Array | Int8Array | Uint8Array | number[];
  dims: readonly number[];
};

export type DecodeOptions = {
  /** Class names in model output order, from model.json. */
  classNames: readonly string[];
  confidenceThreshold: number;
  nmsIouThreshold: number;
  maxDetections: number;
  transform: LetterboxTransform;
  layout?: RawOutputLayout;
  /**
   * Extra channels a segmentation head appends after the class scores. Declared in
   * model.json, because `4 + nc + 32` is indistinguishable from a 33-class detector.
   */
  maskCoefficients?: number;
  /**
   * Called for every detection at or above `confidenceThreshold` whose class is not a
   * pothole, with its confidence.
   *
   * A road model recognises more than we report - cracks, speed bumps, vehicles. Those
   * detections are still dropped, but counting them is how we learn what the detector
   * sees on our roads without inventing entities the data model has no place for.
   */
  onSkippedClass?: (className: string, confidence: number) => void;
};

type ResolvedLayout = {
  layout: "channels-first" | "channels-last" | "end-to-end";
  numAnchors: number;
  channels: number;
};

/** Channel count of an end-to-end row: x1, y1, x2, y2, confidence, classId. */
const END_TO_END_CHANNELS = 6;

/**
 * Work out which axis holds the 4 + numClasses channels.
 *
 * When both axes could match (a square output, e.g. 5 anchors with 1 class) the
 * Ultralytics default wins, because that is what our export pipeline produces.
 */
export function resolveLayout(
  dims: readonly number[],
  numClasses: number,
  requested: RawOutputLayout = "auto",
  maskCoefficients = 0,
): ResolvedLayout {
  if (dims.length !== 3 || dims[0] !== 1) {
    throw new Error(`Unsupported detector output shape [${dims.join(", ")}]; expected [1, a, b]`);
  }
  const axis1 = dims[1] as number;
  const axis2 = dims[2] as number;
  const expectedChannels = 4 + numClasses + maskCoefficients;

  if (requested === "end-to-end") {
    if (axis2 !== END_TO_END_CHANNELS) {
      throw new Error(
        `Output shape [${dims.join(", ")}] is not an end-to-end head; expected [1, n, 6]`,
      );
    }
    return { layout: "end-to-end", numAnchors: axis1, channels: axis2 };
  }
  if (requested === "channels-first") {
    if (axis1 !== expectedChannels) {
      throw new Error(
        `Output shape [${dims.join(", ")}] is not channels-first for ${numClasses} class(es)`,
      );
    }
    return { layout: "channels-first", numAnchors: axis2, channels: axis1 };
  }
  if (requested === "channels-last") {
    if (axis2 !== expectedChannels) {
      throw new Error(
        `Output shape [${dims.join(", ")}] is not channels-last for ${numClasses} class(es)`,
      );
    }
    return { layout: "channels-last", numAnchors: axis1, channels: axis2 };
  }

  if (axis1 === expectedChannels) {
    return { layout: "channels-first", numAnchors: axis2, channels: axis1 };
  }
  if (axis2 === expectedChannels) {
    return { layout: "channels-last", numAnchors: axis1, channels: axis2 };
  }
  if (axis2 === END_TO_END_CHANNELS) {
    return { layout: "end-to-end", numAnchors: axis1, channels: axis2 };
  }
  throw new Error(
    `Detector output [${dims.join(", ")}] has no axis of size ${expectedChannels} ` +
      `(4 box values + ${numClasses} class score(s)` +
      (maskCoefficients ? ` + ${maskCoefficients} mask coefficient(s)` : "") +
      `). Declare the layout in model.json.`,
  );
}

/**
 * Turn a raw detector tensor into normalised detections in our own schema.
 * Nothing downstream ever sees the model's native layout.
 */
export function decodeDetections(tensor: RawTensor, options: DecodeOptions): Detection[] {
  const { classNames, confidenceThreshold, nmsIouThreshold, maxDetections, transform } = options;
  const numClasses = classNames.length;
  if (numClasses === 0) throw new Error("decodeDetections requires at least one class name");

  const maskCoefficients = options.maskCoefficients ?? 0;
  const { layout, numAnchors } = resolveLayout(
    tensor.dims,
    numClasses,
    options.layout ?? "auto",
    maskCoefficients,
  );
  const data = tensor.data;

  const kept =
    layout === "end-to-end"
      ? decodeEndToEnd(data, numAnchors, confidenceThreshold, maxDetections, transform)
      : decodeRawHead(
          data,
          layout,
          numAnchors,
          numClasses,
          maskCoefficients,
          confidenceThreshold,
          nmsIouThreshold,
          maxDetections,
          transform,
        );

  // Normalise into our schema. The MVP product only carries potholes; any other class
  // a multi-class model emits is dropped here rather than leaking outward.
  const detections: Detection[] = [];
  for (const item of kept) {
    const className = classNames[item.payload.classId];
    if (!isPotholeClass(className)) {
      if (className) options.onSkippedClass?.(className, item.score);
      continue;
    }
    detections.push({
      classId: item.payload.classId,
      className: "pothole",
      confidence: item.score,
      bbox: item.box,
    });
  }
  return detections;
}

/** Raw YOLO head: per-anchor class scores over centre-form boxes, needing NMS. */
function decodeRawHead(
  data: RawTensor["data"],
  layout: "channels-first" | "channels-last",
  numAnchors: number,
  numClasses: number,
  maskCoefficients: number,
  confidenceThreshold: number,
  nmsIouThreshold: number,
  maxDetections: number,
  transform: LetterboxTransform,
): ScoredBox<{ classId: number }>[] {
  const channels = 4 + numClasses + maskCoefficients;

  const at = (channel: number, anchor: number): number => {
    const index =
      layout === "channels-first" ? channel * numAnchors + anchor : anchor * channels + channel;
    return Number(data[index] ?? 0);
  };

  const candidates: ScoredBox<{ classId: number }>[] = [];

  for (let anchor = 0; anchor < numAnchors; anchor += 1) {
    let bestClass = -1;
    let bestScore = 0;
    // Only the class channels are read; any mask coefficients that follow are skipped.
    for (let c = 0; c < numClasses; c += 1) {
      const score = at(4 + c, anchor);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestClass < 0 || bestScore < confidenceThreshold) continue;

    const box = inputBoxToNormalised(
      at(0, anchor),
      at(1, anchor),
      at(2, anchor),
      at(3, anchor),
      transform,
    );
    if (boxArea(box) <= 0) continue;

    candidates.push({ box, score: bestScore, payload: { classId: bestClass } });
  }

  return nonMaximumSuppression(candidates, nmsIouThreshold, maxDetections);
}

/**
 * End-to-end head: NMS already ran inside the graph, so rows are final detections.
 * Padding rows are emitted with zero confidence and filtered by the threshold.
 */
function decodeEndToEnd(
  data: RawTensor["data"],
  numRows: number,
  confidenceThreshold: number,
  maxDetections: number,
  transform: LetterboxTransform,
): ScoredBox<{ classId: number }>[] {
  const kept: ScoredBox<{ classId: number }>[] = [];

  for (let row = 0; row < numRows && kept.length < maxDetections; row += 1) {
    const offset = row * END_TO_END_CHANNELS;
    const score = Number(data[offset + 4] ?? 0);
    if (score < confidenceThreshold) continue;

    const box = inputCornersToNormalised(
      Number(data[offset] ?? 0),
      Number(data[offset + 1] ?? 0),
      Number(data[offset + 2] ?? 0),
      Number(data[offset + 3] ?? 0),
      transform,
    );
    if (boxArea(box) <= 0) continue;

    kept.push({ box, score, payload: { classId: Math.round(Number(data[offset + 5] ?? 0)) } });
  }

  return kept;
}
