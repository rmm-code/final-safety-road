"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import clsx from "clsx";
import type { SeverityLevel, VisionEngineInfo } from "@pothole/shared-types";
import {
  createVisionEngine,
  resolveVisionConfig,
  type DescribedVisionEngine,
} from "@pothole/vision-web";
import { Button, PageHeader, Panel, SeverityBadge } from "@/components/ui";
import { Icon } from "@/components/icons";
import { ThresholdControl } from "@/components/threshold-control";
import { formatDuration, formatPercent, formatTimecode } from "@/lib/format";
import type { AppConfig } from "@/lib/config";
import {
  AnalysisAbortedError,
  analyseVideo,
  type AnalysedPothole,
  type AnalysisProgress,
  type SampledFrame,
  type VideoAnalysisResult,
} from "./lib/analyse-video";
import { buildReport, reportFileName, summarise } from "./lib/report";
import { AnalysisSummaryGrid } from "./components/analysis-summary";
import { DetectionStrip, DetectionTimeline } from "./components/detection-timeline";
import { SyntheticEngineNotice } from "./components/engine-status";
import { VideoStage } from "./components/video-stage";
import { VideoPicker } from "./components/video-picker";
import type { Sample } from "@/features/videos/lib/samples";
import { analysisId, fileSource, type AnalysisSettings } from "@/features/videos/lib/analysis-id";
import { AnalysisNote } from "@/features/videos/components/analysis-note";
import { saveAnalysis } from "@/features/videos/lib/video-api";
import { SavePanel, type SaveState } from "./components/save-panel";

type Status = "idle" | "ready" | "analyzing" | "done" | "error";

const NO_FRAMES: SampledFrame[] = [];

export function AnalyzeView({
  config,
  variant = "page",
  samples = [],
}: {
  config: AppConfig;
  /** "home" when this is the first thing a visitor sees: it says what the product does. */
  variant?: "page" | "home";
  /** Videos a visitor can try in one click, without footage of their own. */
  samples?: Sample[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<DescribedVisionEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [threshold, setThreshold] = useState(config.vision.detection.confidenceThreshold);
  // One derived config drives inference, tracking and the exported report, so a run can
  // never be analysed at one threshold and reported at another.
  const visionConfig = useMemo(
    () => resolveVisionConfig({ detection: { confidenceThreshold: threshold } }),
    [threshold],
  );

  const [engineInfo, setEngineInfo] = useState<VisionEngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnalysisProgress | null>(null);
  const [result, setResult] = useState<VideoAnalysisResult | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  // The demo video being analysed, if any: it knows when and, sometimes, where it was filmed.
  const [sample, setSample] = useState<Sample | null>(null);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "idle" });
  // The settings the shown result was analysed with; the threshold may move afterwards.
  const [analysedWith, setAnalysedWith] = useState<AnalysisSettings | null>(null);

  // Resolve the detector once. Selection is reported, never silent: if no model is
  // deployed the app says so and falls back to the clearly-labelled synthetic engine.
  useEffect(() => {
    let disposed = false;

    createVisionEngine({
      mode: config.visionMode,
      config: config.vision,
      manifestUrl: config.modelManifestUrl,
      wasmPath: config.ortWasmPath,
      ortLogLevel: config.ortLogLevel,
      ...(config.serverVisionUrl ? { serverUrl: config.serverVisionUrl } : {}),
    })
      .then((engine) => {
        if (disposed) {
          void engine.dispose();
          return;
        }
        engineRef.current = engine;
        setEngineInfo(engine.info);
      })
      .catch((cause: unknown) => {
        if (disposed) return;
        setEngineError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      disposed = true;
      abortRef.current?.abort();
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    if (!videoUrl) return;
    return () => URL.revokeObjectURL(videoUrl);
  }, [videoUrl]);

  const frames = useMemo(() => result?.frames ?? NO_FRAMES, [result]);
  const severityByTrack = useMemo(() => {
    const map = new Map<string, SeverityLevel>();
    result?.potholes.forEach((pothole) => map.set(pothole.trackId, pothole.severity.level));
    return map;
  }, [result]);
  const summary = useMemo(() => summarise(result?.potholes ?? []), [result]);
  const selected = useMemo(
    () => result?.potholes.find((pothole) => pothole.trackId === selectedTrackId) ?? null,
    [result, selectedTrackId],
  );

  const handleSelectFile = useCallback((selectedFile: File, fromSample: Sample | null = null) => {
    setSample(fromSample);
    setFile(selectedFile);
    setVideoUrl(URL.createObjectURL(selectedFile));
    setResult(null);
    setProgress(null);
    setSelectedTrackId(null);
    setError(null);
    setAspectRatio(null);
    setStatus("ready");
  }, []);

  const handleSelectSample = useCallback(
    async (demo: Sample) => {
      setLoadingSample(demo.id);
      setError(null);
      try {
        const response = await fetch(demo.src);
        if (!response.ok) throw new Error(`Could not load ${demo.title} (${response.status})`);
        const blob = await response.blob();
        handleSelectFile(new File([blob], `${demo.id}.mp4`, { type: blob.type || "video/mp4" }), demo);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus("error");
      } finally {
        setLoadingSample(null);
      }
    },
    [handleSelectFile],
  );

  const handleAnalyze = useCallback(async () => {
    const video = videoRef.current;
    const engine = engineRef.current;
    if (!video || !engine || !file) return;

    const controller = new AbortController();
    abortRef.current = controller;
    video.pause();
    // Restart the synthetic sequence so re-analysing a file reproduces its report.
    engine.reset?.();

    setStatus("analyzing");
    setError(null);
    setResult(null);
    setSaveState({ kind: "idle" });
    setSelectedTrackId(null);
    setProgress(null);

    try {
      const analysis = await analyseVideo({
        video,
        engine,
        config: visionConfig,
        signal: controller.signal,
        onProgress: setProgress,
      });
      setResult(analysis);
      setAnalysedWith({
        modelVersion: analysis.engine.modelVersion,
        confidenceThreshold: visionConfig.detection.confidenceThreshold,
        sampleFps: visionConfig.analysis.sampleFps,
      });
      setStatus("done");
      video.currentTime = 0;
      if (sample) {
        // A sample already has its published analysis; a second copy would duplicate it.
        setSaveState({ kind: "sample", href: `/?video=${sample.id}` });
      } else if (!analysis.engine.isSynthetic) {
        // Saved for everyone: the record, the overlay and photos, then the video itself.
        setSaveState({ kind: "saving" });
        const settings = {
          confidenceThreshold: visionConfig.detection.confidenceThreshold,
          sampleFps: visionConfig.analysis.sampleFps,
        };
        void (async () => {
          try {
            const id = await analysisId(await fileSource(file), { modelVersion: analysis.engine.modelVersion, ...settings });
            await saveAnalysis({
              id,
              result: analysis,
              title: file.name,
              fileName: file.name,
              demo: null,
              file,
              recordedAt: null,
              settings,
            });
            setSaveState({ kind: "saved", href: `/videos/${id}` });
          } catch (cause) {
            setSaveState({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
          }
        })();
      }
    } catch (cause) {
      if (cause instanceof AnalysisAbortedError) {
        setStatus("ready");
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }, [file, sample, visionConfig]);

  const handleSelectPothole = useCallback((pothole: AnalysedPothole) => {
    setSelectedTrackId(pothole.trackId);
    const video = videoRef.current;
    if (video) video.currentTime = pothole.bestFrameSeconds ?? pothole.firstSeenSeconds;
  }, []);

  const handleDownload = useCallback(() => {
    if (!result || !file) return;
    const report = buildReport({ result, fileName: file.name, config: visionConfig });
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFileName(file.name);
    anchor.click();
    URL.revokeObjectURL(url);
  }, [file, result, visionConfig]);

  const analysing = status === "analyzing";

  return (
    <div className="space-y-4">
      <PageHeader
        title={variant === "home" ? "Find potholes in a road video" : "Analyze video"}
        description={
          variant === "home"
            ? "Upload a dashcam or phone video, or try one of ours. The detector runs in this browser and grades every pothole it finds; the finished analysis, with the video and its photos, is saved so anyone can open it."
            : "Detect, track and grade potholes in recorded footage, then place the video on the map to save what it found."
        }
        actions={
          <>
            {analysing ? (
              <Button variant="destructive" onClick={() => abortRef.current?.abort()}>
                <Icon name="stop" />
                Cancel
              </Button>
            ) : (
              <>
                {result && (
                  <Button onClick={handleDownload}>
                    <Icon name="download" />
                    Download JSON
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => void handleAnalyze()}
                  disabled={!file || !engineInfo}
                >
                  {result ? "Re-analyze video" : "Analyze video"}
                </Button>
              </>
            )}
          </>
        }
      />

      {engineError && (
        <div
          role="alert"
          className="flex gap-2.5 rounded-xl bg-red-soft px-4 py-3"
        >
          <Icon name="alert" className="mt-0.5 text-red-ink" />
          <div>
            <div className="text-[13px] font-semibold text-red-ink">Detector unavailable</div>
            <p className="mt-0.5 text-[13px] leading-5 text-secondary">{engineError}</p>
          </div>
        </div>
      )}
      {engineInfo && <SyntheticEngineNotice engine={engineInfo} />}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Panel title="Source video" subtitle="Recorded MP4, MOV or WebM road footage" icon="video">
          <VideoPicker
            file={file}
            disabled={analysing}
            onSelect={(selected) => handleSelectFile(selected)}
            onError={(message) => {
              setError(message);
              setStatus("error");
            }}
          />

          {samples.length > 0 && (
            <SamplePicker
              samples={samples}
              selectedId={sample?.id ?? null}
              loadingId={loadingSample}
              disabled={analysing}
              onSelect={(demo) => void handleSelectSample(demo)}
            />
          )}

          {error && (
            <p role="alert" className="mt-3 text-[13px] text-red-ink">
              {error}
            </p>
          )}

          {videoUrl ? (
            <div className="mt-3">
              <VideoStage
                videoRef={videoRef}
                videoUrl={videoUrl}
                frames={frames}
                severityByTrack={severityByTrack}
                toleranceSeconds={1 / visionConfig.analysis.sampleFps}
                triggerRegionTopY={visionConfig.triggerRegion.topY}
                aspectRatio={aspectRatio}
                controls={!analysing}
                onLoadedMetadata={() => {
                  const video = videoRef.current;
                  if (video && video.videoHeight > 0) {
                    setAspectRatio(video.videoWidth / video.videoHeight);
                  }
                }}
              />
            </div>
          ) : (
            <div className="mt-3 grid h-56 place-items-center rounded-lg bg-subtle text-[13px] text-muted">
              Choose a road video to begin
            </div>
          )}

          {analysing && progress && <AnalysisProgressBar progress={progress} />}
        </Panel>

        <div className="space-y-4">
          <Panel title="Run settings" subtitle="Defaults from ai/configs/vision.yaml" icon="models">
            <ThresholdControl
              value={threshold}
              defaultValue={config.vision.detection.confidenceThreshold}
              disabled={analysing}
              onChange={setThreshold}
              onReset={() => setThreshold(config.vision.detection.confidenceThreshold)}
            />

            <dl className="mt-3 space-y-2 border-t border-border pt-3 text-[13px]">
              <SettingRow label="Sampling">
                <span className="tabular font-mono">{visionConfig.analysis.sampleFps} FPS</span>
              </SettingRow>
              <SettingRow label="Confirmation">
                <span className="tabular font-mono">
                  {visionConfig.tracking.minObservations} sightings
                </span>
              </SettingRow>
            </dl>
          </Panel>

          {result && Object.keys(result.otherClasses).length > 0 && (
            <Panel title="Also recognised" subtitle="Seen by the model, not reported" icon="info">
              <dl className="space-y-2 text-[13px]">
                {Object.entries(result.otherClasses)
                  .sort(([, a], [, b]) => b - a)
                  .map(([name, count]) => (
                    <SettingRow key={name} label={name}>
                      <span className="tabular font-mono">{count}</span>
                    </SettingRow>
                  ))}
              </dl>
              <p className="mt-3 border-t border-border pt-3 text-[11px] leading-4 text-muted">
                This product reports potholes only. These are counted so it is visible what
                the detector found beyond them - the evidence for whether another defect
                type is worth modelling on these roads.
              </p>
            </Panel>
          )}

          <SavePanel state={saveState} />
        </div>
      </div>

      {result && (
        <Panel
          icon="dashboard"
          title="Analysis summary"
          subtitle={`${formatDuration(result.durationSeconds)} of footage, sampled at ${config.vision.analysis.sampleFps} FPS`}
        >
          <AnalysisSummaryGrid
            summary={summary}
            rejectedTracks={result.rejectedTracks}
            rawDetections={result.rawDetections}
            averageInferenceMs={result.averageInferenceMs}
          />
          <div className="mt-3 border-t border-border pt-3">
            {analysedWith && !result.engine.isSynthetic ? (
              <AnalysisNote settings={analysedWith} />
            ) : (
              <p className="text-[12px] leading-[18px] text-muted">
                Severity is visual only; no size or depth is measured.
              </p>
            )}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Panel
          icon="potholes"
          title="Detections"
          subtitle={
            result ? `${result.potholes.length} unique potholes` : "Runs after analysis"
          }
          bodyClassName="p-0"
        >
          {result ? (
            <>
              <DetectionStrip
                potholes={result.potholes}
                durationSeconds={result.durationSeconds}
                selectedTrackId={selectedTrackId}
                onSelect={handleSelectPothole}
              />
              <DetectionTimeline
                potholes={result.potholes}
                selectedTrackId={selectedTrackId}
                onSelect={handleSelectPothole}
              />
            </>
          ) : (
            <p className="px-4 py-8 text-center text-[13px] text-muted">
              Analyse a video to list unique potholes.
            </p>
          )}
        </Panel>

        {selected ? (
          <PotholeDetail pothole={selected} />
        ) : (
          <Panel title="Selected pothole" icon="potholes">
            <p className="text-[13px] leading-5 text-muted">
              Choose a row to seek the video to its evidence frame.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}

/** Our test videos, one click each, so the detector can be tried without footage. */
function SamplePicker({
  samples,
  selectedId,
  loadingId,
  disabled,
  onSelect,
}: {
  samples: Sample[];
  selectedId: string | null;
  loadingId: string | null;
  disabled: boolean;
  onSelect: (demo: Sample) => void;
}) {
  return (
    <div className="mt-4">
      <div className="text-[12.5px] font-medium text-secondary">Or try one of our videos</div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {samples.map((demo) => {
          const selected = demo.id === selectedId;
          return (
            <button
              key={demo.id}
              type="button"
              disabled={disabled || loadingId !== null}
              aria-pressed={selected}
              onClick={() => onSelect(demo)}
              className={clsx(
                "group overflow-hidden rounded-lg bg-fill text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60",
                selected ? "ring-2 ring-blue-strong" : "hover:bg-fill-strong",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a static poster, already small */}
              <img src={demo.poster} alt="" className="aspect-video w-full object-cover" />
              <span className="block px-2.5 py-2">
                <span className="block text-[13px] font-medium text-primary">
                  {loadingId === demo.id ? "Loading…" : demo.title}
                </span>
                <span className="block truncate text-[12px] text-muted">{demo.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Real progress, not a skeleton: frames processed is the number an operator watches. */
function AnalysisProgressBar({ progress }: { progress: AnalysisProgress }) {
  const percent = (progress.framesAnalysed / progress.totalFrames) * 100;

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-[13px]">
        <span>
          Analyzing video <span className="tabular font-mono">{Math.round(percent)}%</span>
        </span>
        <span className="tabular font-mono text-secondary">
          {progress.potholesFound} found
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-fill"
      >
        <div
          className="h-full rounded-full bg-blue-strong transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="tabular mt-1 text-[12px] leading-[18px] text-muted">
        {progress.framesAnalysed} / {progress.totalFrames} frames processed -{" "}
        {formatTimecode(progress.currentSeconds)} of {formatTimecode(progress.durationSeconds)}
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

function PotholeDetail({ pothole }: { pothole: AnalysedPothole }) {
  return (
    <Panel title="Selected pothole" subtitle={pothole.trackId} icon="potholes">
      {pothole.fullImage && (
        <Image
          src={pothole.fullImage}
          alt={`Best evidence frame for ${pothole.trackId}`}
          width={480}
          height={270}
          unoptimized
          className="mb-3 w-full rounded-lg object-cover"
        />
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <Detail label="Visual severity">
          <SeverityBadge level={pothole.severity.level} />
        </Detail>
        <Detail label="Severity score">
          <span className="tabular font-mono text-[13px]">{pothole.severity.score.toFixed(2)}</span>
        </Detail>
        <Detail label="Detector confidence">
          <span className="tabular font-mono text-[13px]">{formatPercent(pothole.confidence)}</span>
        </Detail>
        <Detail label="Severity confidence">
          <span className="tabular font-mono text-[13px]">
            {formatPercent(pothole.severity.confidence)}
          </span>
        </Detail>
        <Detail label="Sightings">
          <span className="tabular font-mono text-[13px]">{pothole.observationCount}</span>
        </Detail>
        <Detail label="Evidence frame">
          <span className="tabular font-mono text-[13px]">
            {pothole.bestFrameSeconds === null ? "-" : formatTimecode(pothole.bestFrameSeconds)}
          </span>
        </Detail>
      </dl>

      <p className="mt-3 border-t border-border pt-3 text-[12px] leading-[18px] text-muted">
        {pothole.severity.rationale}
      </p>
    </Panel>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] leading-[18px] text-secondary">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
