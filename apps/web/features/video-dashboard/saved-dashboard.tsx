"use client";

import { useCallback, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppConfig } from "@/lib/config";
import { sampleOf } from "@/features/videos/lib/samples";
import { HAND_PLACED_ACCURACY_M, asResult, getVideoAnalysis, loadOverlay, placeVideo } from "@/features/videos/lib/video-api";
import { DashboardLayout, type Place } from "./dashboard-layout";

/** The dashboard for any analysis saved on the server: an upload or a sample. */
export function SavedDashboard({ config, id }: { config: AppConfig; id: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["video-analysis", id], queryFn: () => getVideoAnalysis(id) });
  const overlay = useQuery({
    queryKey: ["video-overlay", id, detail.data?.overlayUrl],
    queryFn: () => loadOverlay(detail.data?.overlayUrl ?? null),
    enabled: Boolean(detail.data),
    staleTime: Infinity,
  });
  const data = detail.data;
  const result = useMemo(() => (data && overlay.data ? asResult(data, overlay.data) : null), [data, overlay.data]);
  const place: Place | null = data?.location ? { ...data.location } : null;
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
      place={place}
      onPlace={data && !data.location ? onPlace : undefined}
    />
  );
}
