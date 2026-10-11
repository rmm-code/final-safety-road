import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import type { VisionConfig } from "../config/vision-config";
import { clampBoxToFrame } from "../postprocess/geometry";
import { createPrng, randomBetween } from "../util/prng";
import { InferenceTimer, nowMs, type DescribedVisionEngine, type VisionEngineStats } from "./types";

/**
 * Deterministic synthetic detector.
 *
 * Its purpose is to keep the product, the tracker, the severity engine and the UI
 * developable while no trained weights exist in the repository. It does not look at
 * the pixels it is given and it is NOT a detector: every consumer must surface
 * `info.isSynthetic` so its output can never be mistaken for a model's.
 *
 * Output is reproducible. The sequence depends only on the seed and on how many times
 * `infer` has been called, never on wall-clock time or Math.random, so analysing the
 * same video twice produces the same report.
 *
 * The simulation uses a simple pinhole road model rather than an arbitrary animation,
 * because the pipeline's hardest case is geometric: a pothole near the horizon barely
 * moves between frames, then accelerates down the image and grows rapidly as the
 * vehicle closes in. That is what makes plain IoU association insufficient on its own
 * and what the tracker's motion prediction exists to handle.
 */
type VirtualPothole = {
  /** Remaining distance from the camera, in metres. */
  distanceM: number;
  /** Closing speed, in metres per second. */
  speedMps: number;
  /** Physical width, in metres. */
  widthM: number;
  /** Lateral offset from the camera axis, in metres. */
  offsetM: number;
  aspect: number;
  peakConfidence: number;
};

export const MOCK_MODEL_VERSION = "mock-synthetic-0.1.0";

export class MockVisionEngine implements DescribedVisionEngine {
  readonly info: VisionEngineInfo;

  private readonly config: VisionConfig;
  private readonly timer = new InferenceTimer();
  private rng: () => number;
  private frameIndex = -1;
  private nextSpawnFrame = 0;
  private active: VirtualPothole[] = [];
  private busy = false;
  private initialised = false;

  constructor(config: VisionConfig, options?: { seed?: number; selectionReason?: string }) {
    this.config = config;
    this.rng = createPrng(options?.seed ?? config.mock.seed);
    this.info = {
      kind: "mock",
      modelVersion: MOCK_MODEL_VERSION,
      backend: "synthetic",
      isSynthetic: true,
      selectionReason:
        options?.selectionReason ?? "Synthetic engine selected explicitly (no model required).",
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
    this.initialised = true;
  }

  /** Restart the sequence so a re-run of the same video reproduces the same result. */
  reset(seed?: number): void {
    this.rng = createPrng(seed ?? this.config.mock.seed);
    this.frameIndex = -1;
    this.nextSpawnFrame = 0;
    this.active = [];
  }

  async infer(_source: CanvasImageSource): Promise<Detection[]> {
    if (!this.initialised) throw new Error("MockVisionEngine.infer called before init()");
    const started = nowMs();
    this.busy = true;
    try {
      this.frameIndex += 1;
      return this.step();
    } finally {
      this.busy = false;
      this.timer.record(nowMs() - started);
    }
  }

  async dispose(): Promise<void> {
    this.active = [];
    this.initialised = false;
  }

  private step(): Detection[] {
    const mock = this.config.mock;

    if (this.frameIndex >= this.nextSpawnFrame) {
      this.active.push(this.spawn());
      const gapSeconds = randomBetween(this.rng, mock.minGapSeconds, mock.maxGapSeconds);
      this.nextSpawnFrame = this.frameIndex + Math.max(1, Math.round(gapSeconds * mock.virtualFps));
    }

    const detections: Detection[] = [];
    const survivors: VirtualPothole[] = [];

    for (const pothole of this.active) {
      if (pothole.distanceM <= mock.exitDistanceM) continue;
      survivors.push(pothole);

      const projected = this.project(pothole);
      pothole.distanceM -= pothole.speedMps / mock.virtualFps;

      // A frame the simulated detector misses, so the tracker has to bridge the gap.
      if (this.rng() < mock.dropoutProbability) continue;
      if (projected.confidence < 0.05) continue;

      detections.push({
        classId: 0,
        className: "pothole",
        confidence: projected.confidence,
        bbox: clampBoxToFrame(projected.bbox),
      });
    }

    this.active = survivors;

    if (this.rng() < mock.falsePositiveProbability) {
      // A one-frame low-confidence blob: a shadow or a wet patch. The confirmation
      // rules must throw it away.
      const width = randomBetween(this.rng, 0.03, 0.07);
      detections.push({
        classId: 0,
        className: "pothole",
        confidence: randomBetween(this.rng, 0.36, 0.52),
        bbox: clampBoxToFrame({
          x: randomBetween(this.rng, 0.05, 0.9),
          y: randomBetween(this.rng, 0.45, 0.85),
          width,
          height: width * 0.6,
        }),
      });
    }

    return detections;
  }

  /** Project a pothole on the road plane into normalised image coordinates. */
  private project(pothole: VirtualPothole): { bbox: Detection["bbox"]; confidence: number } {
    const mock = this.config.mock;
    const distance = pothole.distanceM;

    const centreY = mock.horizonY + mock.perspectiveK / distance;
    const width = pothole.widthM / (mock.lateralSpreadK * distance);
    const height = width * pothole.aspect;
    const centreX = 0.5 + pothole.offsetM / (mock.lateralSpreadK * distance);

    // A detector is less certain about a defect that covers only a few pixels.
    const visibility = Math.min(1, width / mock.confidenceWidthReference);
    const noise = (this.rng() - 0.5) * 0.05;
    const confidence = Math.min(
      0.99,
      Math.max(0, pothole.peakConfidence * (0.3 + 0.7 * visibility) + noise),
    );

    return {
      bbox: { x: centreX - width / 2, y: centreY - height / 2, width, height },
      confidence,
    };
  }

  private spawn(): VirtualPothole {
    const mock = this.config.mock;
    return {
      distanceM: mock.spawnDistanceM,
      speedMps: randomBetween(this.rng, mock.speedMpsMin, mock.speedMpsMax),
      widthM: randomBetween(this.rng, mock.potholeWidthMinM, mock.potholeWidthMaxM),
      // Roughly within one lane either side of the camera axis.
      offsetM: randomBetween(this.rng, -1.4, 1.4),
      aspect: randomBetween(this.rng, 0.45, 0.7),
      peakConfidence: randomBetween(this.rng, 0.74, 0.97),
    };
  }
}
