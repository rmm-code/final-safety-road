"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SeverityLevel } from "@pothole/shared-types";
import { EvidenceImage } from "@/components/evidence-image";
import { Button, PageHeader, Panel, SeverityBadge } from "@/components/ui";
import { createApiClient, type Pothole, type PotholeDetail, type ReviewVerdict } from "@/lib/api-client";
import type { AppConfig } from "@/lib/config";
import { CitizenReportQueue } from "./components/citizen-report-queue";

const CITY_BBOX = { minLng: 69.0, minLat: 41.15, maxLng: 69.55, maxLat: 41.45 };

/**
 * Human review of what the detector reported.
 *
 * Two jobs: keep the map honest by retiring false positives, and build the labelled set
 * that later fine-tuning needs. Negative examples - shadows, puddles, manholes, patched
 * asphalt - are as valuable here as the true detections, because they are what a detector
 * trained only on potholes gets wrong.
 */
export function ReviewView({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);
  const [index, setIndex] = useState(0);
  const [reviewed, setReviewed] = useState(0);
  const queryClient = useQueryClient();

  // Only what nobody has judged yet: a verdict is stored, so the queue shrinks for good
  // instead of offering the same pothole again on the next visit.
  const query = useQuery<Pothole[]>({
    queryKey: ["potholes", "review"],
    queryFn: () => api.potholes({ bbox: CITY_BBOX, status: ["active"], reviewed: false }),
  });

  // Least-confirmed first: a defect seen once is likeliest to be wrong, and is where a
  // reviewer's time is worth most.
  const queue = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => a.sighting_count - b.sighting_count),
    [query.data],
  );
  const current = queue[index];

  // The list carries keys, not images; the detail signs a fresh link for the evidence.
  const evidence = useQuery<PotholeDetail>({
    queryKey: ["pothole", current?.id],
    queryFn: () => api.pothole(current!.id),
    enabled: Boolean(current),
  });
  const imageUrl =
    evidence.data?.primary_image_url ??
    evidence.data?.observations.find((observation) => observation.crop_image_url)?.crop_image_url;

  const mutation = useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict: ReviewVerdict }) =>
      api.reviewPothole(id, verdict),
  });

  const busy = mutation.isPending;
  const failure = mutation.error ?? query.error;
  const error = failure ? (failure as Error).message : null;

  const decide = useCallback(
    async (verdict: ReviewVerdict) => {
      if (!current) return;
      try {
        await mutation.mutateAsync({ id: current.id, verdict });
      } catch {
        // Shown through `mutation.error`; stay on this pothole so the verdict is not lost.
        return;
      }
      setReviewed((count) => count + 1);
      setIndex((position) => position + 1);
    },
    [current, mutation],
  );

  // Refresh the map and lists when leaving, not after every verdict: refetching the queue
  // mid-review would reorder it under the reviewer's cursor.
  useEffect(
    () => () => void queryClient.invalidateQueries({ queryKey: ["potholes"] }),
    [queryClient],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Review"
        description="Confirm or reject what the detector reported. Reviewed examples become training data."
        actions={<span className="font-mono text-[13px] tabular-nums text-secondary">{reviewed} reviewed</span>}
      />

      {error && (
        <div role="alert" className="rounded-xl border border-red/30 bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Review unavailable</div>
          <p className="mt-1 text-secondary">{error}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel title="Candidate" subtitle={current ? `${queue.length - index} remaining` : undefined}>
          {!current ? (
            <p className="py-10 text-center text-[13px] text-muted">
              {queue.length === 0
                ? "Nothing waiting for review."
                : "Queue complete. Everything active has been looked at."}
            </p>
          ) : (
            <div className="space-y-3">
              {evidence.isPending ? (
                <div className="h-56 animate-pulse rounded-md bg-app" />
              ) : (
                <EvidenceImage
                  url={imageUrl}
                  alt="Best evidence frame for this pothole"
                  className={imageUrl ? "max-h-[360px] w-full" : "h-56"}
                />
              )}

              <dl className="grid grid-cols-3 gap-3 text-[13px]">
                <Detail label="Reported">
                  <SeverityBadge level={current.severity as SeverityLevel} />
                </Detail>
                <Detail label="Sightings">
                  <span className="font-mono tabular-nums">{current.sighting_count}</span>
                </Detail>
                <Detail label="Accuracy">
                  <span className="font-mono tabular-nums">
                    ±{Math.round(current.location_accuracy_m)} m
                  </span>
                </Detail>
              </dl>

              <div className="flex flex-wrap gap-2 border-t border-border pt-3">
                <Button variant="primary" disabled={busy} onClick={() => void decide("correct")}>
                  Correct
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => void decide("false_positive")}>
                  False positive
                </Button>
                <Button disabled={busy} onClick={() => setIndex((p) => p + 1)}>
                  Skip
                </Button>
              </div>
            </div>
          )}
        </Panel>

        <div className="space-y-4">
          {/* Two queues, deliberately side by side. The detector's mistakes and the
              public's reports are both work for the same person, and splitting them
              across two pages means one of them stops getting done. */}
          <CitizenReportQueue apiBaseUrl={config.apiBaseUrl} />

          <Panel title="What to look for">
            <p className="text-[13px] leading-relaxed text-secondary">
              These are the things a pothole detector most often gets wrong. Marking them here
              is what teaches the next model to ignore them:
            </p>
            <ul className="mt-2 space-y-1 text-[13px] text-secondary">
              {[
                "Shadows",
                "Puddles and wet patches",
                "Manhole covers",
                "Patched asphalt",
                "Oil stains",
                "Speed bumps",
                "Road markings",
                "Broken road edges",
                "Debris",
              ].map((item) => (
                <li key={item} className="flex items-center gap-2">
                  <span aria-hidden className="h-1 w-1 rounded-full bg-muted" />
                  {item}
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] leading-4 text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
