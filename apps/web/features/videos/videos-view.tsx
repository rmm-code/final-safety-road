"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import type { SeverityLevel } from "@pothole/shared-types";
import { Badge, Panel } from "@/components/ui";
import { SAMPLES, SAMPLE_SETUP, sampleOf } from "./lib/samples";
import { SEVERITY_LABEL, SEVERITY_ORDER, formatClock } from "@/features/video-dashboard/lib/dashboard-data";
import { listVideoAnalyses, type VideoAnalysisSummary } from "./lib/video-api";

const SEVERITY_VAR: Record<SeverityLevel, string> = {
  large: "var(--color-severity-large)",
  medium: "var(--color-severity-medium)",
  small: "var(--color-severity-small)",
  unknown: "var(--color-severity-unknown)",
};

function Meter({ counts }: { counts: Record<SeverityLevel, number> }) {
  const total = SEVERITY_ORDER.reduce((sum, level) => sum + counts[level], 0);
  return (
    <div className="flex h-2 gap-[2px]" aria-hidden>
      {total === 0 ? (
        <i className="flex-1 rounded-[2px] bg-fill" />
      ) : (
        SEVERITY_ORDER.filter((level) => counts[level] > 0).map((level) => (
          <i key={level} className="rounded-[2px]" style={{ flexGrow: counts[level], backgroundColor: SEVERITY_VAR[level] }} />
        ))
      )}
    </div>
  );
}

/** Each sample's saved analysis, preferring the published setup over any other. */
function analysesBySample(items: VideoAnalysisSummary[]): Map<string, VideoAnalysisSummary> {
  const bySample = new Map<string, VideoAnalysisSummary>();
  for (const item of items) {
    const sample = item.source === "demo" ? sampleOf(item.posterUrl) : undefined;
    if (!sample) continue;
    if (!bySample.has(sample.id) || item.modelVersion === SAMPLE_SETUP.modelVersion) bySample.set(sample.id, item);
  }
  return bySample;
}

/**
 * Pitstop's "Samples & insights": the four test videos, every video anyone has analysed on
 * the site, and the numbers across all of them.
 */
export function VideosView() {
  const analyses = useQuery({ queryKey: ["video-analyses"], queryFn: listVideoAnalyses, refetchInterval: 20_000 });
  const items = analyses.data ?? [];
  const uploads = items.filter((item) => item.source === "upload");
  const savedDemo = analysesBySample(items);

  const totals: Record<SeverityLevel, number> = { large: 0, medium: 0, small: 0, unknown: 0 };
  for (const item of items) for (const level of SEVERITY_ORDER) totals[level] += item.severityCounts[level];
  const totalPotholes = SEVERITY_ORDER.reduce((sum, level) => sum + totals[level], 0);
  const maxPerVideo = Math.max(1, ...items.map((item) => item.potholeCount));

  return (
    <div className="space-y-2.5">
      <Panel icon="samples" title="Sample videos" subtitle="Our test videos, already analysed. Open one to see its dashboard." bodyClassName="p-3">
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {SAMPLES.map((demo) => {
            const summary = savedDemo.get(demo.id);
            return (
              <Link
                key={demo.id}
                href={`/?video=${demo.id}`}
                className="group overflow-hidden rounded-lg border border-[#ebebeb] bg-white transition-shadow duration-150 hover:shadow-pop"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a static poster */}
                <img src={demo.poster} alt="" className="aspect-video w-full object-cover" />
                <div className="space-y-2 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-medium text-primary">{demo.title}</span>
                    <span className="tabular rounded-[5px] border border-[#e6e6e6] bg-[#f9f9f9] px-1 py-0.5 text-[10.5px] text-[#666]">
                      {demo.durationLabel}
                    </span>
                  </div>
                  <p className="truncate text-[12.5px] text-muted">{demo.description}</p>
                  {summary ? (
                    <>
                      <Meter counts={summary.severityCounts} />
                      <p className="tabular text-[12px] text-[#6a6a6a]">
                        {summary.potholeCount} {summary.potholeCount === 1 ? "pothole" : "potholes"}
                        {summary.location ? " · on the map" : ""}
                      </p>
                    </>
                  ) : (
                    <p className="text-[12px] text-[#8a8a8a]">Not analysed yet: open it to analyse</p>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
      </Panel>

      <div className="grid gap-2.5 lg:grid-cols-[1.6fr_1fr]">
        <Panel
          icon="upload"
          title="Analysed uploads"
          subtitle="Videos visitors analysed on the site, newest first"
          bodyClassName="p-3"
          footer={{ label: "Analyse your own video", href: "/analyze" }}
        >
          {analyses.isError ? (
            <p className="px-1 py-6 text-center text-[13px] text-muted">The server did not answer, so saved videos cannot be listed.</p>
          ) : uploads.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-muted">
              {analyses.isLoading ? "Loading…" : "No uploads yet. Analyse a video in the live demo and it appears here for everyone."}
            </p>
          ) : (
            <ul className="divide-y divide-[#f0f0f0]">
              {uploads.map((item) => (
                <li key={item.id}>
                  <Link href={`/videos/${item.id}`} className="flex items-center gap-3 rounded-md px-1.5 py-2.5 hover:bg-[#f7f7f7]">
                    {item.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a stored poster frame
                      <img src={item.posterUrl} alt="" crossOrigin="anonymous" className="h-12 w-20 shrink-0 rounded-md bg-[#2c2c2c] object-cover" />
                    ) : (
                      <span className="grid h-12 w-20 shrink-0 place-items-center rounded-md bg-[#2c2c2c] text-[11px] text-[#bbb]">Video</span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-primary">{item.title}</span>
                      <span className="tabular block text-[12px] text-muted">
                        {formatClock(item.durationSeconds)} · {new Date(item.createdAt).toLocaleString()}
                      </span>
                    </span>
                    <span className="tabular text-[13px] text-[#555]">{item.potholeCount}</span>
                    {item.location && <Badge icon="map">On the map</Badge>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel icon="dashboard" title="Insights" subtitle="Across every analysed video" bodyClassName="px-4 pb-4 pt-3">
          <div className="mb-4 flex items-baseline justify-between">
            <span className="text-[13px] text-[#737373]">Potholes found</span>
            <strong className="tabular text-[26px] font-semibold tracking-[-0.8px] text-primary">{totalPotholes}</strong>
          </div>
          <Meter counts={totals} />
          <ul className="mt-3 space-y-1.5">
            {SEVERITY_ORDER.map((level) => (
              <li key={level} className="flex items-center justify-between text-[12.5px] text-[#727272]">
                <span className="flex items-center gap-[7px]">
                  <i aria-hidden className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: SEVERITY_VAR[level] }} />
                  {SEVERITY_LABEL[level]}
                </span>
                <b className="tabular font-medium text-[#747474]">{totals[level]}</b>
              </li>
            ))}
          </ul>
          {items.length > 0 && (
            <div className="mt-5 space-y-2">
              <div className="text-[12px] text-[#8a8a8a]">Potholes per video</div>
              {items.slice(0, 8).map((item) => (
                <div key={item.id} className="grid grid-cols-[96px_1fr_28px] items-center gap-2 text-[12px]">
                  <span className="truncate text-[#555]">{item.title}</span>
                  <span className="h-2 overflow-hidden rounded-[2px] bg-fill">
                    <i className="block h-full rounded-[2px] bg-[#6ba8ed]" style={{ width: `${(item.potholeCount / maxPerVideo) * 100}%` }} />
                  </span>
                  <span className="tabular text-right text-[#555]">{item.potholeCount}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}
