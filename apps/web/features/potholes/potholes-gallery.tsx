"use client";

import { useState } from "react";
import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Badge, Button, FilterTabs, Panel, SeverityBadge } from "@/components/ui";
import { formatPercent } from "@/lib/format";
import type { AppConfig } from "@/lib/config";
import { formatClock } from "@/features/video-dashboard/lib/dashboard-data";
import { listVideoPotholes } from "@/features/videos/lib/video-api";
import { PotholeListView } from "./pothole-list-view";

const PAGE = 60;

/**
 * Every pothole as its photo: those found in analysed videos, and those on the map with
 * their repair status (the operator's list, kept one tab away).
 */
export function PotholesGallery({ config }: { config: AppConfig }) {
  const [tab, setTab] = useState<"videos" | "mapped">("videos");
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FilterTabs
          label="Which potholes"
          options={[
            { value: "videos", label: "From videos" },
            { value: "mapped", label: "On the map" },
          ]}
          isActive={(value) => value === tab}
          onSelect={setTab}
        />
      </div>
      {tab === "videos" ? <VideoPotholes /> : <PotholeListView config={config} />}
    </div>
  );
}

function VideoPotholes() {
  const query = useInfiniteQuery({
    queryKey: ["video-potholes"],
    queryFn: ({ pageParam }) => listVideoPotholes(PAGE, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? 0;

  return (
    <Panel
      icon="images"
      title="Potholes from videos"
      subtitle={query.isSuccess ? `${total} ${total === 1 ? "pothole" : "potholes"} across every analysed video` : "Every pothole found in an analysed video"}
      bodyClassName="p-3"
    >
      {query.isError ? (
        <p className="py-10 text-center text-[13px] text-muted">The server did not answer, so the photos cannot be listed.</p>
      ) : query.isLoading ? (
        <p className="py-10 text-center text-[13px] text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-muted">
          No video has been analysed yet. Open a sample on the{" "}
          <Link href="/" className="font-medium text-primary underline underline-offset-2">
            dashboard
          </Link>{" "}
          or try the{" "}
          <Link href="/analyze" className="font-medium text-primary underline underline-offset-2">
            live demo
          </Link>
          .
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6">
            {items.map((pothole) => {
              const photo = pothole.cropUrl ?? pothole.fullUrl;
              const at = formatClock(pothole.bestFrameSeconds ?? pothole.firstSeenSeconds);
              return (
                <Link
                  key={pothole.id}
                  href={`/videos/${pothole.analysisId}`}
                  className="overflow-hidden rounded-lg border border-[#ebebeb] bg-white transition-shadow duration-150 hover:shadow-pop"
                >
                  {photo ? (
                    // eslint-disable-next-line @next/next/no-img-element -- a stored evidence crop
                    <img src={photo} alt={`Pothole in ${pothole.analysisTitle} at ${at}`} crossOrigin="anonymous" loading="lazy" className="aspect-[4/3] w-full bg-[#2c2c2c] object-cover" />
                  ) : (
                    <div className="grid aspect-[4/3] place-items-center bg-subtle text-[12px] text-muted">No photo</div>
                  )}
                  <div className="space-y-1.5 px-2.5 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <SeverityBadge level={pothole.severity} />
                      <span className="tabular text-[12px] text-[#737373]">{formatPercent(pothole.confidence)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-[12px] text-[#6a6a6a]">
                      <span className="truncate">
                        {pothole.analysisTitle} · {at}
                      </span>
                      {pothole.located && <Badge icon="map">Map</Badge>}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
          {query.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button onClick={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage}>
                {query.isFetchingNextPage ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
