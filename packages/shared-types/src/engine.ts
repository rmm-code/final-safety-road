/**
 * Which implementation produced a set of detections.
 *
 * "ultralytics" is server-side only: the Python pipeline loads a `.pt` checkpoint
 * directly. The browser never sees it - it runs "onnx", "server" or "mock".
 */
export type VisionEngineKind = "onnx" | "server" | "mock" | "ultralytics";

export type VisionEngineInfo = {
  kind: VisionEngineKind;
  /**
   * Semantic version of the deployed model, recorded on every detection event.
   * Synthetic engines must use a version prefixed with "mock-" so fabricated output
   * can never be mistaken for model output.
   */
  modelVersion: string;
  /** Execution provider or transport actually in use, e.g. "webgpu", "wasm", "http". */
  backend: string;
  /**
   * True when detections are fabricated rather than produced by a model.
   * Every surface that displays or exports these detections must say so.
   */
  isSynthetic: boolean;
  /** Why this engine was selected. Shown in the UI so selection is never silent. */
  selectionReason: string;
};
