"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SeverityLevel } from "@pothole/shared-types";
import { Badge, Button, IconTile } from "@/components/ui";
import { Icon } from "@/components/icons";
import { useBreadcrumb } from "@/components/shell-context";
import type { AppConfig } from "@/lib/config";
import type { AnalysedPothole, VideoAnalysisResult } from "@/features/analyze/lib/analyse-video";
import { VideoStage } from "@/features/analyze/components/video-stage";
import { LocationPicker } from "@/features/analyze/components/location-picker";
import type { AnalysisSettings } from "@/features/videos/lib/analysis-id";
import { confidenceSeries } from "./lib/dashboard-data";
import { AnalysisNote } from "@/features/videos/components/analysis-note";
import {
  ActivityCard,
  ConfidenceCard,
  LocationCard,
  OverviewCard,
  PhotosCard,
  TimelineCard,
} from "./components/cards";

/** "saved": on the server for everyone; "local": analysed in this browser only. */
export type SaveState = "saved" | "local" | null;
export type Place = { label: string | null; latitude: number; longitude: number; accuracyM: number };

const SAVE_BADGE = {
  saved: { tone: "ok", icon: "check", label: "Saved for everyone" },
  local: { tone: "neutral", icon: undefined, label: "Analysed in your browser" },
} as const;

export function DashboardLayout({
  config,
  videoRef,
  fileName,
  title,
  description,
  videoUrl,
  result,
  settings,
  durationSeconds,
  pending,
  saved,
  place,
  onPlace,
  notice,
}: {
  config: AppConfig;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  fileName: string;
  title: string;
  description: string;
  videoUrl: string | null;
  result: VideoAnalysisResult | null;
  settings: AnalysisSettings | null;
  durationSeconds: number;
  pending: string;
  saved: SaveState;
  place: Place | null;
  /** Offered when nobody has placed the video yet. */
  onPlace?: (point: { latitude: number; longitude: number }) => Promise<void>;
  /** Shown above the cards, e.g. when a sample has no published analysis. */
  notice?: React.ReactNode;
}) {
  useBreadcrumb(fileName);
  const [currentSeconds, setCurrentSeconds] = useState(0);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [videoOpen, setVideoOpen] = useState(true);
  const [pin, setPin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [placing, setPlacing] = useState(false);
  const visionConfig = config.vision;
  const sampleFps = settings?.sampleFps ?? visionConfig.analysis.sampleFps;
  const threshold = settings?.confidenceThreshold ?? visionConfig.detection.confidenceThreshold;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentSeconds(video.currentTime);
    video.addEventListener("timeupdate", onTime);
    return () => video.removeEventListener("timeupdate", onTime);
  }, [videoRef, videoUrl]);

  const severityByTrack = useMemo(() => {
    const map = new Map<string, SeverityLevel>();
    result?.potholes.forEach((pothole) => map.set(pothole.trackId, pothole.severity.level));
    return map;
  }, [result]);
  const series = useMemo(() => (result ? confidenceSeries(result.frames) : null), [result]);

  const jumpTo = useCallback(
    (pothole: AnalysedPothole) => {
      setVideoOpen(true);
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = pothole.bestFrameSeconds ?? pothole.firstSeenSeconds;
      video.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    [videoRef],
  );

  const badge = saved ? SAVE_BADGE[saved] : null;

  return (
    <div className="space-y-2.5">
      {notice}
      <div className="grid gap-2.5 lg:grid-cols-2">
        <OverviewCard potholes={result?.potholes ?? null} pending={pending} />
        <ActivityCard
          frames={result?.frames ?? null}
          potholes={result?.potholes ?? null}
          durationSeconds={durationSeconds}
          rawDetections={result?.rawDetections ?? null}
          pending={pending}
        />
      </div>

      <section className="overflow-hidden rounded-[10px] border border-[#ebebeb] bg-white shadow-card">
        <header className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <IconTile name="video" />
            <div className="min-w-0">
              <h2 className="text-[16px] font-medium leading-5 text-[#2a2a2a]">Video & detections</h2>
              <p className="mt-1 truncate text-[13px] leading-[18px] text-muted">
                {fileName} · playback with the detector&apos;s boxes
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {badge && (
              <Badge tone={badge.tone} icon={badge.icon}>
                {badge.label}
              </Badge>
            )}
            <Link
              href="/analyze"
              className="hidden h-[34px] items-center gap-1.5 rounded-[7px] border border-[#e4e4e4] bg-white px-3 text-[13px] font-medium text-[#313131] shadow-[0_1px_2px_#25252505] transition-colors hover:bg-[#f6f6f6] sm:inline-flex"
            >
              <Icon name="upload" size={15} />
              Analyze your own video
            </Link>
            <button
              type="button"
              onClick={() => setVideoOpen((open) => !open)}
              aria-expanded={videoOpen}
              aria-label={videoOpen ? "Hide the video" : "Show the video"}
              className="grid h-8 w-8 place-items-center rounded-md text-[#666] hover:bg-[#f3f3f3]"
            >
              <Icon name="chevron" size={18} className={videoOpen ? "-rotate-90" : "rotate-90"} />
            </button>
          </div>
        </header>
        <div className={videoOpen ? "grid gap-2.5 px-3 pb-3 lg:grid-cols-[1.6fr_1fr]" : "hidden"}>
          <div className="overflow-hidden rounded-[10px] border border-[#ebebeb] bg-white">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <IconTile name="video" />
                <div className="min-w-0">
                  <div className="text-[15px] font-medium text-[#2a2a2a]">{title}</div>
                  <div className="truncate text-[12.5px] text-muted">{description}</div>
                </div>
              </div>
              <Badge icon="analyze">YOLO annotations</Badge>
            </div>
            <div className="relative mx-3 mb-3">
              {videoUrl ? (
                <>
                  <VideoStage
                    videoRef={videoRef}
                    videoUrl={videoUrl}
                    frames={result?.frames ?? []}
                    severityByTrack={severityByTrack}
                    toleranceSeconds={1 / sampleFps}
                    triggerRegionTopY={visionConfig.triggerRegion.topY}
                    aspectRatio={aspectRatio}
                    controls={result !== null}
                    onLoadedMetadata={() => {
                      const video = videoRef.current;
                      if (video && video.videoHeight > 0) setAspectRatio(video.videoWidth / video.videoHeight);
                    }}
                  />
                  <div className="pointer-events-none absolute inset-x-2.5 top-2.5 flex justify-between">
                    <span className="inline-flex items-center gap-1.5 rounded border border-white/15 bg-[#292929] px-[7px] py-1.5 text-[11px] font-medium tracking-[1px] text-[#f2f2f2]">
                      <Icon name="video" size={13} />
                      {result ? "ANNOTATED" : "NOT ANALYSED"}
                    </span>
                    <span className="rounded border border-white/15 bg-[#292929] px-[7px] py-1.5 text-[10px] font-medium tracking-[0.8px] text-[#f2f2f2]">
                      PITSTOP ANALYSIS
                    </span>
                  </div>
                </>
              ) : (
                <div className="grid aspect-video place-items-center rounded-md bg-[#2c2c2c] px-6 text-center text-[13px] text-[#cfcfcf]">
                  The video file was not stored, so only its results and photos are shown.
                </div>
              )}
            </div>
          </div>
          <ConfidenceCard
            series={series}
            threshold={threshold}
            durationSeconds={durationSeconds}
            currentSeconds={currentSeconds}
            pending={pending}
          />
        </div>
      </section>

      <TimelineCard potholes={result?.potholes ?? null} durationSeconds={durationSeconds} onSelect={jumpTo} pending={pending} />

      <div className="grid gap-2.5 lg:grid-cols-[1.6fr_1fr]">
        <PhotosCard potholes={result?.potholes ?? null} onSelect={jumpTo} pending={pending} />
        <LocationCard
          label={place?.label ?? null}
          latitude={place?.latitude ?? null}
          longitude={place?.longitude ?? null}
          accuracyM={place?.accuracyM ?? null}
        >
          {place ? (
            <LocationPicker value={place} onChange={() => {}} mapStyleUrl={config.mapStyleUrl} mapWorkerUrl={config.mapWorkerUrl} disabled />
          ) : onPlace ? (
            <div className="space-y-2">
              <p className="text-[13px] leading-5 text-[#6a6a6a]">Click where it was filmed, then put it on the map.</p>
              <LocationPicker value={pin} onChange={setPin} mapStyleUrl={config.mapStyleUrl} mapWorkerUrl={config.mapWorkerUrl} disabled={placing} />
              <Button
                variant="primary"
                className="w-full"
                disabled={!pin || placing}
                onClick={() => {
                  if (!pin) return;
                  setPlacing(true);
                  void onPlace(pin).finally(() => setPlacing(false));
                }}
              >
                <Icon name="map" />
                {placing ? "Placing…" : "Put it on the map"}
              </Button>
            </div>
          ) : null}
        </LocationCard>
      </div>

      {result && settings && !result.engine.isSynthetic && <AnalysisNote settings={settings} />}
      {result?.engine.isSynthetic && (
        <p role="alert" className="rounded-lg bg-red-soft px-3 py-2 text-[13px] text-red-ink">
          The real detector did not load, so these results come from the synthetic engine and are not real.
        </p>
      )}
      <div className="flex justify-end sm:hidden">
        <Link
          href="/analyze"
          className="inline-flex h-[37px] items-center gap-[7px] rounded-[7px] border border-[#202020] bg-accent px-3 text-[13px] font-medium text-white"
        >
          <Icon name="upload" />
          Analyze your own video
        </Link>
      </div>
    </div>
  );
}
