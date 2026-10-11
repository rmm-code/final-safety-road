"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { IconTile, PageHeader, Panel, SegmentedBar, SeverityBadge, TABLE } from "@/components/ui";
import { createApiClient, type Pothole, type StatsOverview } from "@/lib/api-client";
import type { AppConfig } from "@/lib/config";

/** A generous box around Tashkent, so the dashboard shows recent work without a map. */
const CITY_BBOX = { minLng: 69.0, minLat: 41.15, maxLng: 69.55, maxLat: 41.45 };

const QUICK_ACTIONS: { href: string; icon: IconName; title: string; detail: string }[] = [
  { href: "/drive", icon: "drive", title: "Start a live drive", detail: "Phone camera and GPS" },
  { href: "/", icon: "analyze", title: "Analyze a video", detail: "Upload footage or try ours" },
  { href: "/map", icon: "map", title: "Open the map", detail: "Every physical pothole" },
];

function count(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

export function StatisticsView({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);
  const overview = useQuery<StatsOverview>({ queryKey: ["stats"], queryFn: () => api.stats() });
  const potholes = useQuery<Pothole[]>({
    queryKey: ["potholes", "recent"],
    queryFn: () => api.potholes({ bbox: CITY_BBOX }),
  });

  const stats = overview.data;
  const recent = useMemo(
    () =>
      [...(potholes.data ?? [])]
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
        .slice(0, 12),
    [potholes.data],
  );
  const queryError = overview.error ?? potholes.error;
  const error = queryError ? (queryError as Error).message : null;
  const graded = (stats?.large ?? 0) + (stats?.medium ?? 0) + (stats?.small ?? 0);
  const ungraded = Math.max(0, (stats?.active_potholes ?? 0) - graded);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Statistics"
        description="Road condition across Tashkent, from every drive and report."
        actions={
          <Link
            href="/map"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-strong px-3.5 text-[13.5px] font-medium text-white shadow-card transition-colors duration-150 hover:bg-blue-ink"
          >
            <Icon name="map" size={16} />
            Open map
          </Link>
        }
      />

      {error && (
        <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Could not load the dashboard</div>
          <p className="mt-1 text-secondary">{error}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel
          title="Active potholes"
          subtitle="By visual severity"
          icon="potholes"
          footer={{ label: "View the repair list", href: "/potholes" }}
        >
          <div className="tabular mb-4 flex items-baseline gap-2">
            <span className="text-[34px] font-semibold leading-none tracking-[-0.02em] text-primary">
              {count(stats?.active_potholes)}
            </span>
            <span className="text-[13px] text-muted">on the map now</span>
          </div>
          <SegmentedBar
            label="Active potholes by severity"
            segments={[
              { label: "Large", value: stats?.large ?? 0, color: "bg-severity-large" },
              { label: "Medium", value: stats?.medium ?? 0, color: "bg-severity-medium" },
              { label: "Small", value: stats?.small ?? 0, color: "bg-severity-small" },
              ...(ungraded > 0
                ? [{ label: "Not graded", value: ungraded, color: "bg-severity-unknown" }]
                : []),
            ]}
          />
        </Panel>

        <Panel
          title="Capture activity"
          subtitle="Drives and sightings"
          icon="drive"
          footer={{ label: "Start a live drive", href: "/drive" }}
        >
          <dl className="grid grid-cols-2 gap-3">
            {[
              { label: "New potholes today", value: stats?.new_today },
              { label: "Sightings today", value: stats?.sightings_today },
              { label: "Drive sessions", value: stats?.drive_sessions },
              { label: "All sightings", value: stats?.total_sightings },
            ].map((item) => (
              <div key={item.label} className="rounded-lg bg-subtle px-3 py-3">
                <dt className="text-[12.5px] leading-[18px] text-secondary">{item.label}</dt>
                <dd className="tabular mt-1 text-[24px] font-semibold leading-7 tracking-[-0.02em] text-primary">
                  {count(item.value)}
                </dd>
              </div>
            ))}
          </dl>
        </Panel>

        <Panel title="Quick actions" subtitle="Common tasks" icon="overview" bodyClassName="p-2 sm:p-2">
          <ul>
            {QUICK_ACTIONS.map((action) => (
              <li key={action.href}>
                <Link
                  href={action.href}
                  className="group flex items-center gap-3 rounded-lg px-3 py-3 transition-colors duration-150 hover:bg-hover"
                >
                  <IconTile name={action.icon} className="group-hover:bg-blue-soft group-hover:text-blue-strong" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-medium text-primary">{action.title}</span>
                    <span className="block text-[12.5px] text-muted">{action.detail}</span>
                  </span>
                  <Icon name="chevron" size={16} className="text-muted group-hover:text-primary" />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        title="Recently seen"
        subtitle="Latest sightings first. Open a row for photos and history."
        icon="dashboard"
        bodyClassName="p-0 sm:p-0"
      >
        {potholes.isPending ? (
          <p className="px-5 py-10 text-center text-[13px] text-muted">Loading potholes…</p>
        ) : recent.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[14px] font-medium text-primary">No potholes recorded yet</p>
            <p className="mt-1 text-[13px] text-muted">Start a live drive and they appear here.</p>
          </div>
        ) : (
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <thead>
                <tr className={TABLE.headRow}>
                  <th className={TABLE.th}>Severity</th>
                  <th className={TABLE.th}>Sightings</th>
                  <th className={TABLE.th}>GPS accuracy</th>
                  <th className={TABLE.th}>Last seen</th>
                  <th className={TABLE.th}>Location</th>
                  <th className={TABLE.th}>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.body}>
                {recent.map((pothole) => (
                  <tr key={pothole.id} className={TABLE.row}>
                    <td className={TABLE.td}>
                      <SeverityBadge level={pothole.severity} />
                    </td>
                    <td className={`${TABLE.td} tabular text-primary`}>{pothole.sighting_count}</td>
                    <td className={`${TABLE.td} tabular text-secondary`}>
                      ±{Math.round(pothole.location_accuracy_m)} m
                    </td>
                    <td className={`${TABLE.td} tabular text-secondary`}>
                      {new Date(pothole.last_seen_at).toLocaleString([], {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className={`${TABLE.td} font-mono text-[12px] text-muted`}>
                      {pothole.latitude.toFixed(5)}, {pothole.longitude.toFixed(5)}
                    </td>
                    <td className={`${TABLE.td} text-right`}>
                      <Link
                        href={`/potholes/${pothole.id}`}
                        className="inline-flex items-center gap-1 text-[13px] font-medium text-blue-strong hover:text-blue-ink"
                      >
                        Details
                        <Icon name="chevron" size={14} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
