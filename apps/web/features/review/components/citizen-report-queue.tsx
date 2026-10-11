"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Panel } from "@/components/ui";
import { createApiClient, type CitizenReport } from "@/lib/api-client";
import { EvidenceImage } from "@/components/evidence-image";

/**
 * The moderation queue for reports from the public.
 *
 * Two decisions, and they are not the same decision the detector review makes. Accepting
 * says "this is a real pothole and this photo can be shown publicly"; rejecting withdraws
 * the report's vote, which can demote a pothole that was only verified by reports that
 * turned out to be junk.
 *
 * The photo is the reason this screen exists. A stranger uploaded it, nobody has seen it,
 * and it stays off the public map until somebody has.
 */
export function CitizenReportQueue({ apiBaseUrl }: { apiBaseUrl: string }) {
  const api = useMemo(() => createApiClient(apiBaseUrl), [apiBaseUrl]);
  const queryClient = useQueryClient();
  const [index, setIndex] = useState(0);

  const query = useQuery<CitizenReport[]>({
    queryKey: ["citizen-reports", "pending"],
    queryFn: () => api.citizenReports("pending"),
  });

  const review = useMutation({
    mutationFn: ({ id, state }: { id: string; state: "accepted" | "rejected" }) =>
      api.reviewCitizenReport(id, state),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["citizen-reports"] });
      void queryClient.invalidateQueries({ queryKey: ["potholes"] });
    },
  });

  const queue = query.data ?? [];
  const current = queue[index];
  const busy = review.isPending;

  const decide = async (state: "accepted" | "rejected") => {
    if (!current) return;
    await review.mutateAsync({ id: current.id, state }).catch(() => {});
    setIndex((position) => position + 1);
  };

  if (query.isLoading) {
    return (
      <Panel title="Reports from the public">
        <p className="text-[13px] text-muted">Loading…</p>
      </Panel>
    );
  }

  if (query.error) {
    return (
      <Panel title="Reports from the public">
        <p role="alert" className="text-[13px] text-red-ink">
          {(query.error as Error).message}
        </p>
      </Panel>
    );
  }

  if (!current) {
    return (
      <Panel
        title="Reports from the public"
        subtitle="Telegram reports awaiting a decision"
      >
        <p className="text-[13px] text-secondary">
          {queue.length === 0 && index === 0
            ? "Nothing waiting. Reports arrive from the Telegram bot and the Mini App."
            : `Queue cleared. ${index} report${index === 1 ? "" : "s"} reviewed.`}
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Reports from the public"
      subtitle={`${queue.length - index} awaiting review`}
      bodyClassName="space-y-3"
    >
      <EvidenceImage
        url={current.image_url}
        alt="Photo submitted with this report"
        className={current.image_url ? "max-h-[320px] w-full" : "h-32"}
      />

      {current.comment && (
        <p className="rounded-md border border-border bg-app px-3 py-2 text-[13px] leading-5 text-secondary">
          {current.comment}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        <Row label="Source">
          <Badge tone="neutral">
            {current.source === "telegram_bot" ? "Bot" : "Mini App"}
          </Badge>
        </Row>
        <Row label="Pothole status">
          {current.pothole_status === "reported" ? (
            <Badge tone="unverified">Unverified</Badge>
          ) : (
            <span className="capitalize">{current.pothole_status?.replace("_", " ") ?? "-"}</span>
          )}
        </Row>
        <Row label="Location">
          <span className="tabular font-mono text-[12px]">
            {current.latitude.toFixed(5)}, {current.longitude.toFixed(5)}
          </span>
        </Row>
        <Row label="Accuracy">
          <span className="tabular font-mono text-[12px]">
            ±{Math.round(current.location_accuracy_m)} m
          </span>
        </Row>
      </dl>

      <div className="flex gap-2 border-t border-border pt-3">
        <Button disabled={busy} onClick={() => void decide("accepted")}>
          Accept
        </Button>
        <Button variant="destructive" disabled={busy} onClick={() => void decide("rejected")}>
          Reject
        </Button>
      </div>

      <p className="text-[12px] leading-4 text-muted">
        Accepting publishes the photo on the public map and counts toward confirming the
        pothole. Rejecting withdraws it, and can return the pothole to unverified.
      </p>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}
