"use client";

import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@/lib/config";
import type { SampledFrame } from "@/features/analyze/lib/analyse-video";
import { sampleOf } from "@/features/videos/lib/samples";
import { HAND_PLACED_ACCURACY_M, asResult, getVideoAnalysis, loadOverlay, placeVideo } from "@/features/videos/lib/video-api";
import { DashboardLayout } from "./dashboard-layout";

/** One array, so a lost overlay does not hand the video stage a new one every render. */
const NO_FRAMES: SampledFrame[] = [];

/** The dashboard for any analysis saved on the server: an upload or a sample. */
export function SavedDashboard({ config, id }: { config: AppConfig; id: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["video-analysis", id], queryFn: () => getVideoAnalysis(id) });
  const data = detail.data;
  const overlayUrl = data?.overlayUrl ?? null;
  // Keyed on the analysis, not on its link: every detail refetch signs the link afresh,
  // but the overlay behind it is the same.
  const overlay = useQuery({
    queryKey: ["video-overlay", id, overlayUrl !== null],
    queryFn: () => loadOverlay(overlayUrl),
    enabled: Boolean(data),
    staleTime: Infinity,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[1] === id ? previous : undefined),
  });
  // Without its overlay the analysis still has its results; only the boxes are missing.
  const overlayLost = overlay.isError && !overlay.data;
  const frames = overlay.data ?? (overlayLost ? NO_FRAMES : null);
  const result = useMemo(() => (data && frames ? asResult(data, frames) : null), [data, frames]);
  const sample = sampleOf(data?.posterUrl ?? null);

  const onPlace = useCallback(
    async (point: { latitude: number; longitude: number }) => {
      await placeVideo(id, { ...point, accuracyM: HAND_PLACED_ACCURACY_M });
      await queryClient.invalidateQueries({ queryKey: ["video-analysis", id] });
    },
    [id, queryClient],
  );

  const pending = detail.isError
    ? "The server did not answer."
    : data === null
      ? "No saved analysis has this address."
      : "Loading…";

  return (
    <DashboardLayout
      config={config}
      videoRef={videoRef}
      fileName={data?.fileName ?? "VIDEO"}
      title={data?.title ?? "Saved video"}
      description={sample?.description ?? (data ? new Date(data.createdAt).toLocaleString() : "")}
      videoUrl={data?.videoUrl ?? null}
      result={result}
      settings={
        data
          ? { modelVersion: data.modelVersion, confidenceThreshold: data.confidenceThreshold, sampleFps: data.sampleFps }
          : null
      }
      durationSeconds={data?.durationSeconds ?? 0}
      pending={pending}
      saved={data ? "saved" : null}
      // Not a copy: a new object every render would ease the map back to the pin.
      place={data?.location ?? null}
      onPlace={data && !data.location ? onPlace : undefined}
      notice={
        overlayLost ? (
          <p role="status" className="rounded-[10px] border border-[#ebebeb] bg-white px-4 py-3 text-[13px] leading-5 text-[#555] shadow-card">
            The detector&apos;s boxes could not be loaded, so the video and charts show none.
          </p>
        ) : null
      }
    />
  );
}
