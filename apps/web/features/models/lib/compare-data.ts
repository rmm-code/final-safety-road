/**
 * Shapes of the files `ai/evaluation/build_model_compare.py` writes under
 * public/model-compare/. Generated offline, so the page only reads them.
 */

export type WebStatus = "live" | "ready" | "exportable" | "work";

export type CompareModel = {
  id: string;
  label: string;
  arch: string;
  params: string;
  trainedOn: string;
  license: string;
  source: string;
  inputSize: number;
  /** The figure the model's authors publish, on their own test set. */
  benchmark?: string;
  web: {
    status: WebStatus;
    onnxMB: number;
    layout: string;
    /** Present only for models exported into public/models and runnable on this page. */
    manifestUrl?: string;
    note: string;
  };
};

export type SetSummary = {
  boxesAt035: number;
  framesWithPotholeAt035: number;
  frames: number;
  topScore: number;
  meanMs: number | null;
};

export type PipelineResult = {
  potholes: number;
  rawDetections: number;
  topConfidence: number;
};

export type CompareSet = {
  id: string;
  title: string;
  description: string;
  source: string;
  frames: { file: string; width: number; height: number }[];
  summaries: Record<string, SetSummary>;
  pipeline: Record<string, PipelineResult>;
  metrics: Record<string, { ap50?: number; precision?: number; recall?: number }>;
  notes: string[];
};

/** One way of running detection: a model, or a merge of models, at a confidence threshold. */
export type ScorecardSetup = {
  id: string;
  label: string;
  detail: string;
  /** The model the frame viewer shows for this setup. */
  modelId: string;
  threshold: number;
};

/** What a setup reported on one video, after two blind reviewers judged every report. */
export type JudgedReports = {
  reported: number;
  real: number;
  falseAlarms: number;
  /** The two reviewers disagreed. */
  unsure: number;
};

export type Scorecard = {
  /** The setup the comparison recommends. */
  recommended: string;
  setups: ScorecardSetup[];
  /** Set ids, in the order they are shown. */
  videos: string[];
  reports: Record<string, Record<string, JudgedReports>>;
  /** Every box on every reviewed frame of all the videos, scored against the judged reference. */
  frames: Record<string, { precision: number; recall: number }>;
  /** How the labels were made, in one sentence. */
  method: string;
};

/** A candidate tested and dropped, with the reason in one line. */
export type AlsoTested = { label: string; reason: string };

export type CompareIndex = {
  generatedAt: string;
  /** Short conclusions, one per paragraph, written by whoever ran the comparison. */
  verdict: string[];
  models: CompareModel[];
  sets: CompareSet[];
  scorecard?: Scorecard;
  alsoTested?: AlsoTested[];
};

/** One frame's pothole boxes: [x1, y1, x2, y2, score], normalised 0..1. */
export type FrameBoxes = [number, number, number, number, number][];

export const COMPARE_ROOT = "/model-compare";

export async function loadIndex(): Promise<CompareIndex> {
  const response = await fetch(`${COMPARE_ROOT}/index.json`, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "No comparison data. Generate it with: python -m ai.evaluation.build_model_compare"
        : `Comparison data failed to load (${response.status})`,
    );
  }
  return (await response.json()) as CompareIndex;
}

export async function loadBoxes(setId: string, modelId: string): Promise<FrameBoxes[]> {
  const response = await fetch(`${COMPARE_ROOT}/${setId}/${modelId}.json`);
  if (!response.ok) throw new Error(`No predictions for ${modelId} on ${setId}`);
  return (await response.json()) as FrameBoxes[];
}

export const WEB_STATUS: Record<WebStatus, { label: string; tone: "ok" | "info" | "neutral" | "warn" }> = {
  live: { label: "In use", tone: "ok" },
  ready: { label: "Runs in our app", tone: "info" },
  exportable: { label: "Exportable", tone: "neutral" },
  work: { label: "Needs engineering", tone: "warn" },
};

/** Two colours for two models. Neither is a severity colour, which mean damage levels. */
export const MODEL_A_COLOUR = "#2563EB";
export const MODEL_B_COLOUR = "#F7A23B";
