"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import type { AppConfig } from "@/lib/config";
import type { AnalysisProgress, VideoAnalysisResult } from "@/features/analyze/lib/analyse-video";
import { analysisId, type AnalysisSettings } from "@/features/videos/lib/analysis-id";
import { SAMPLE_SETUP, findSample, type Sample } from "@/features/videos/lib/samples";
import { asResult, getVideoAnalysis, loadOverlay } from "@/features/videos/lib/video-api";
import { BrowserAnalysis } from "./browser-analysis";
import { DashboardLayout } from "./dashboard-layout";

type Loaded = { result: VideoAnalysisResult; settings: AnalysisSettings; saved: boolean };

/** Loaded analyses, kept for the tab so switching samples is instant. */
const LOADED = new Map<string, Loaded>();

async function loadPublished(sample: Sample): Promise<Loaded | null> {
  const stored = await getVideoAnalysis(await analysisId(`demo:${sample.id}`, SAMPLE_SETUP));
  if (!stored) return null;
  const frames = await loadOverlay(stored.overlayUrl);
  return {
    result: asResult(stored, frames),
    settings: {
      modelVersion: stored.modelVersion,
      confidenceThreshold: stored.confidenceThreshold,
      sampleFps: stored.sampleFps,
    },
    saved: true,
  };
}

/** The dashboard for the sample chosen in the sidebar, opened from its published analysis. */
export function SampleDashboard({ config, sampleId }: { config: AppConfig; sampleId: string | null }) {
  const sample = findSample(sampleId);
  return <SampleView key={sample.id} config={config} sample={sample} />;
}

function SampleView({ config, sample }: { config: AppConfig; sample: Sample }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(() => LOADED.get(sample.id) ?? null);
  const [missing, setMissing] = useState<"absent" | "offline" | null>(null);
  const [analysing, setAnalysing] = useState(false);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    loadPublished(sample).then(
      (published) => {
        if (cancelled) return;
        if (!published) return setMissing("absent");
        LOADED.set(sample.id, published);
        setLoaded(published);
      },
      () => {
        if (!cancelled) setMissing("offline");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [loaded, sample]);

  const onResult = useCallback(
    (result: VideoAnalysisResult, settings: AnalysisSettings) => {
      const local = { result, settings, saved: false };
      LOADED.set(sample.id, local);
      setLoaded(local);
      setAnalysing(false);
    },
    [sample.id],
  );
  const onError = useCallback((message: string) => {
    setError(message);
    setAnalysing(false);
  }, []);

  const pending = error
    ? `The analysis failed: ${error}`
    : analysing && progress
      ? `Analysing ${sample.title} in your browser… ${Math.round((progress.framesAnalysed / progress.totalFrames) * 100)}%`
      : analysing
        ? "Loading the detector…"
        : missing
          ? "Not analysed yet."
          : "Loading…";

  return (
    <>
      {analysing && (
        <BrowserAnalysis config={config} videoRef={videoRef} onProgress={setProgress} onResult={onResult} onError={onError} />
      )}
      <DashboardLayout
        config={config}
        videoRef={videoRef}
        fileName={`${sample.id.toUpperCase()}.MP4`}
        title={sample.title}
        description={sample.description}
        videoUrl={sample.src}
        result={loaded?.result ?? null}
        settings={loaded?.settings ?? null}
        durationSeconds={loaded?.result.durationSeconds ?? progress?.durationSeconds ?? 0}
        pending={pending}
        saved={loaded ? (loaded.saved ? "saved" : "local") : null}
        place={sample.placement ? { ...sample.placement } : null}
        notice={
          missing && !loaded ? (
            <MissingNotice
              offline={missing === "offline"}
              busy={analysing}
              onAnalyse={() => {
                setError(null);
                setAnalysing(true);
              }}
            />
          ) : null
        }
      />
    </>
  );
}

function MissingNotice({ offline, busy, onAnalyse }: { offline: boolean; busy: boolean; onAnalyse: () => void }) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-[#ebebeb] bg-white px-4 py-3 shadow-card"
    >
      <p className="max-w-[70ch] text-[13px] leading-5 text-[#555]">
        {offline ? "The server did not answer, so the saved analysis cannot be shown." : "This sample has no saved analysis yet."}{" "}
        You can analyse it here with the in-browser model; that result is not saved.
      </p>
      <Button variant="primary" onClick={onAnalyse} disabled={busy}>
        <Icon name="analyze" />
        {busy ? "Analysing…" : "Analyse in your browser"}
      </Button>
    </div>
  );
}
