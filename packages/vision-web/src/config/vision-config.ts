/**
 * Browser-side mirror of ai/configs/vision.yaml.
 *
 * The YAML file is canonical. This module exists because the browser cannot read
 * YAML from the repository at runtime. `vision-config.test.ts` parses the YAML and
 * asserts deep equality with the object below, so the two cannot silently diverge.
 *
 * Thresholds must never be duplicated into components. Read them from here.
 */

export type SeverityConfidenceWeights = {
  base: number;
  detection: number;
  persistence: number;
  triggerRegion: number;
};

export type BestFrameWeights = {
  confidence: number;
  area: number;
  sharpness: number;
  centrality: number;
};

export type VisionConfig = {
  model: {
    inputSize: number;
    classNames: string[];
  };
  detection: {
    confidenceThreshold: number;
    nmsIouThreshold: number;
    maxDetections: number;
  };
  tracking: {
    iouMatchThreshold: number;
    maxMissedFrames: number;
    motionPrediction: boolean;
    centreDistanceGate: number;
    scaleRatioGate: number;
    minObservations: number;
    minMaxConfidence: number;
    minDurationMs: number;
  };
  triggerRegion: {
    topY: number;
  };
  severity: {
    areaScoreReference: number;
    smallMax: number;
    mediumMax: number;
    persistenceReferenceObservations: number;
    confidenceWeights: SeverityConfidenceWeights;
  };
  bestFrame: {
    edgeMargin: number;
    edgeClipPenalty: number;
    sharpnessHalfSaturation: number;
    weights: BestFrameWeights;
  };
  analysis: {
    /** Sample rate for video files. Offline, so it favours accuracy over speed. */
    sampleFps: number;
  };
  drive: {
    /** Sample rate for the live camera, bounded by what a phone can sustain. */
    targetFps: number;
  };
  mock: {
    seed: number;
    virtualFps: number;
    minGapSeconds: number;
    maxGapSeconds: number;
    spawnDistanceM: number;
    exitDistanceM: number;
    horizonY: number;
    perspectiveK: number;
    lateralSpreadK: number;
    speedMpsMin: number;
    speedMpsMax: number;
    potholeWidthMinM: number;
    potholeWidthMaxM: number;
    confidenceWidthReference: number;
    dropoutProbability: number;
    falsePositiveProbability: number;
  };
};

export const DEFAULT_VISION_CONFIG: VisionConfig = {
  model: {
    inputSize: 640,
    classNames: ["pothole"],
  },
  detection: {
    confidenceThreshold: 0.25,
    nmsIouThreshold: 0.45,
    maxDetections: 50,
  },
  tracking: {
    iouMatchThreshold: 0.2,
    maxMissedFrames: 3,
    motionPrediction: true,
    centreDistanceGate: 1.2,
    scaleRatioGate: 3.0,
    minObservations: 3,
    minMaxConfidence: 0.55,
    minDurationMs: 200,
  },
  triggerRegion: {
    topY: 0.72,
  },
  severity: {
    areaScoreReference: 0.04,
    smallMax: 0.3,
    mediumMax: 0.65,
    persistenceReferenceObservations: 8,
    confidenceWeights: {
      base: 0.3,
      detection: 0.3,
      persistence: 0.2,
      triggerRegion: 0.2,
    },
  },
  bestFrame: {
    edgeMargin: 0.02,
    edgeClipPenalty: 0.4,
    sharpnessHalfSaturation: 200.0,
    weights: {
      confidence: 1.0,
      area: 1.0,
      sharpness: 0.6,
      centrality: 0.8,
    },
  },
  analysis: {
    sampleFps: 12,
  },
  drive: {
    targetFps: 6,
  },
  mock: {
    seed: 20260816,
    virtualFps: 6,
    minGapSeconds: 2.0,
    maxGapSeconds: 5.5,
    spawnDistanceM: 40.0,
    exitDistanceM: 3.0,
    horizonY: 0.5,
    perspectiveK: 1.5,
    lateralSpreadK: 1.4,
    speedMpsMin: 8.0,
    speedMpsMax: 16.0,
    potholeWidthMinM: 0.25,
    potholeWidthMaxM: 1.3,
    confidenceWidthReference: 0.06,
    dropoutProbability: 0.12,
    falsePositiveProbability: 0.05,
  },
};

/** Recursively applied partial, for callers that want to override a single threshold. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Merge overrides onto the defaults without mutating either input. */
export function resolveVisionConfig(overrides?: DeepPartial<VisionConfig>): VisionConfig {
  if (!overrides) return DEFAULT_VISION_CONFIG;
  const merge = (base: unknown, patch: unknown): unknown => {
    if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      out[key] = merge(base[key], value);
    }
    return out;
  };
  return merge(DEFAULT_VISION_CONFIG, overrides) as VisionConfig;
}
