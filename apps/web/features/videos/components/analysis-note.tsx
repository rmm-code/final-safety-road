import { Fragment } from "react";
import type { AnalysisSettings } from "@/features/videos/lib/analysis-id";
import { modelSources } from "@/features/videos/lib/models";

/** Which detectors produced an analysis, and at what settings. */
export function AnalysisNote({ settings }: { settings: AnalysisSettings }) {
  const sources = modelSources(settings.modelVersion);
  return (
    <p className="px-1 text-[12px] leading-[18px] text-muted">
      {sources.length > 1 ? `${sources.length} detectors, merged: ` : "Detector: "}
      {sources.map((source, index) => (
        <Fragment key={source.label}>
          {index > 0 && ", "}
          {source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              className="text-[#555] underline decoration-[#d0d0d0] underline-offset-2 hover:text-primary"
            >
              {source.label}
            </a>
          ) : (
            source.label
          )}
        </Fragment>
      ))}
      . Analysed at {settings.sampleFps} frames a second, confidence threshold {settings.confidenceThreshold}. Severity is
      visual only; no size or depth is measured.
    </p>
  );
}
