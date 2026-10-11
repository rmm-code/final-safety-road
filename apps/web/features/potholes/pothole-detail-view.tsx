"use client";

import { useCallback, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { EvidenceImage } from "@/components/evidence-image";
import { Icon } from "@/components/icons";
import { Button, PageHeader, Panel, SeverityBadge, StatusBadge } from "@/components/ui";
import {
  createApiClient,
  type PotholeDetail,
  type PotholeStatus,
} from "@/lib/api-client";
import type { AppConfig } from "@/lib/config";
import { ObservationLocation } from "./components/observation-location";

export function PotholeDetailView({ config, potholeId }: { config: AppConfig; potholeId: string }) {
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);
  const queryClient = useQueryClient();
  const query = useQuery<PotholeDetail>({
    queryKey: ["pothole", potholeId],
    queryFn: () => api.pothole(potholeId),
  });

  const mutation = useMutation({
    mutationFn: (status: PotholeStatus) => api.setPotholeStatus(potholeId, status),
    onSuccess: () => {
      // The map and lists show status too, so invalidate them together.
      void queryClient.invalidateQueries({ queryKey: ["pothole", potholeId] });
      void queryClient.invalidateQueries({ queryKey: ["potholes"] });
    },
  });

  const pothole = query.data ?? null;
  const busy = mutation.isPending;
  const failure = mutation.error ?? query.error;
  const error = failure ? (failure as Error).message : null;

  const setStatus = useCallback(
    async (status: PotholeStatus) => {
      await mutation.mutateAsync(status).catch(() => {});
    },
    [mutation],
  );

  if (error && !pothole) {
    return (
      <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
        <div className="font-semibold text-red-ink">Could not load this pothole</div>
        <p className="mt-1 text-secondary">{error}</p>
      </div>
    );
  }

  if (!pothole) return <p className="text-[13px] text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <Link
        href="/potholes"
        className="inline-flex items-center gap-1 text-[13px] font-medium text-secondary hover:text-primary"
      >
        <Icon name="chevron" size={14} className="rotate-180" />
        Back to potholes
      </Link>
      <PageHeader
        title={`Pothole ${pothole.id.slice(0, 8)}`}
        description="Every sighting that contributed to this record."
        actions={
          <>
            <StatusBadge status={pothole.status} />
            <SeverityBadge level={pothole.severity} />
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <Panel title="Evidence" subtitle="The clearest frame any sighting captured" icon="video">
            <EvidenceImage
              url={
                pothole.primary_image_url ??
                pothole.observations.find((observation) => observation.crop_image_url)?.crop_image_url
              }
              alt={`Evidence for pothole ${pothole.id.slice(0, 8)}`}
              className="max-h-[420px] min-h-40 w-full"
            />
          </Panel>

          <Panel
            title="Observation history"
            subtitle={`${pothole.observations.length} sightings, newest first`}
            icon="dashboard"
          >
            {pothole.observations.length === 0 ? (
              <p className="py-4 text-center text-[13px] text-muted">No sightings recorded.</p>
            ) : (
              <ul className="divide-y divide-border">
                {pothole.observations.map((observation) => (
                  <li
                    key={observation.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 text-[13px]"
                  >
                    <EvidenceThumb url={observation.crop_image_url} />
                    <span className="w-40 shrink-0 tabular-nums text-secondary">
                      {new Date(observation.detected_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    <SeverityBadge level={observation.severity} />
                    <span className="font-mono tabular-nums">
                      {Math.round(observation.confidence * 100)}%
                    </span>
                    <ObservationLocation observation={observation} />
                    <span className="truncate font-mono text-[11px] text-muted">
                      {observation.model_version}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-4">
          <Panel title="Record" icon="info">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <Detail label="Status">
                <StatusBadge status={pothole.status} />
              </Detail>
              <Detail label="Sightings">
                <span className="font-mono tabular-nums">{pothole.sighting_count}</span>
              </Detail>
              <Detail label="Severity score">
                <span className="font-mono tabular-nums">{pothole.severity_score.toFixed(2)}</span>
              </Detail>
              <Detail label="Accuracy">
                <span className="font-mono tabular-nums">
                  ±{Math.round(pothole.location_accuracy_m)} m
                </span>
              </Detail>
              <Detail label="First seen">
                <span className="tabular-nums">{new Date(pothole.first_seen_at).toLocaleDateString()}</span>
              </Detail>
              <Detail label="Last seen">
                <span className="tabular-nums">{new Date(pothole.last_seen_at).toLocaleDateString()}</span>
              </Detail>
              <Detail label="Review">
                <span>
                  {pothole.review_verdict === "correct"
                    ? "Confirmed"
                    : pothole.review_verdict === "false_positive"
                      ? "False positive"
                      : "Not reviewed"}
                </span>
              </Detail>
              <Detail label="Location">
                <span className="font-mono text-[11px]">
                  {pothole.latitude.toFixed(5)}, {pothole.longitude.toFixed(5)}
                </span>
              </Detail>
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted">
              Visual severity, derived from apparent size. No physical width, length or depth is
              claimed.
            </p>
          </Panel>

          <Panel title="Actions" subtitle="Changes are recorded in the history" icon="review">
            <div className="flex flex-col gap-2">
              <Button variant="primary" disabled={busy} onClick={() => void setStatus("repaired")}>
                Mark as repaired
              </Button>
              <Button disabled={busy} onClick={() => void setStatus("false_positive")}>
                Mark as false positive
              </Button>
              {pothole.status !== "active" && (
                <Button disabled={busy} onClick={() => void setStatus("active")}>
                  Reopen pothole
                </Button>
              )}
            </div>
            {error && <p className="mt-2 text-[12px] text-red-ink">{error}</p>}
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
      <dd className="mt-0.5 font-medium text-primary">{children}</dd>
    </div>
  );
}

/** A sighting's own crop, small enough to scan a long history at a glance. */
function EvidenceThumb({ url }: { url: string | null }) {
  if (!url) return <span aria-hidden className="h-10 w-14 shrink-0 rounded-md bg-subtle" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="shrink-0" title="Open the full crop">
      <EvidenceImage
        url={url}
        alt="Crop from this sighting"
        className="h-10 w-14 object-cover"
        fallbackLabel=""
      />
    </a>
  );
}
