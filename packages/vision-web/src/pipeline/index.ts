export { TrackManager, type TrackUpdateContext, type TrackUpdateResult } from "./track-manager";
export { VisualSeverityEngine, type SeverityEngine } from "./severity-engine";
export { BestFrameSelector, type FrameCandidateInput } from "./best-frame-selector";
export { isInTriggerRegion, triggerRegionCoverage } from "./trigger-region";
export { laplacianVariance, sharpnessScore, type GrayscaleSource } from "./frame-quality";
export { areaScore, centralityScore, clamp01 } from "./scores";
export { LocationBuffer } from "./location-buffer";
export {
  EventBuilder,
  type EventBuildResult,
  type EventRejectionReason,
  type BuildEventInput,
} from "./event-builder";
