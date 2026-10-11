"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { SeverityLevel } from "@pothole/shared-types";
import { Icon } from "@/components/icons";
import {
  FilterTabs,
  PageHeader,
  Panel,
  SeverityBadge,
  SeverityIcon,
  StatusBadge,
  TABLE,
} from "@/components/ui";
import { createApiClient, type Pothole } from "@/lib/api-client";
import type { AppConfig } from "@/lib/config";
import { RepairListEmpty } from "./components/repair-list-empty";

const CITY_BBOX = { minLng: 69.0, minLat: 41.15, maxLng: 69.55, maxLat: 41.45 };
const SEVERITIES: SeverityLevel[] = ["large", "medium", "small"];

export function PotholeListView({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);
  const [severity, setSeverity] = useState<SeverityLevel[]>([]);

  const query = useQuery<Pothole[]>({
    queryKey: ["potholes", "list", severity],
    // Worst first: this list is the repair crew's work order, not a feed.
    queryFn: () =>
      api.potholes({ bbox: CITY_BBOX, order: "severity", ...(severity.length ? { severity } : {}) }),
  });
  const potholes = query.data ?? [];
  const error = query.error ? (query.error as Error).message : null;

  const filters = (
    <FilterTabs<SeverityLevel | "all">
      label="Filter by severity"
      options={[
        { value: "all", label: "All" },
        ...SEVERITIES.map((level) => ({
          value: level,
          label: level[0]!.toUpperCase() + level.slice(1),
          icon: <SeverityIcon level={level} size={15} />,
        })),
      ]}
      isActive={(value) => (value === "all" ? severity.length === 0 : severity.includes(value))}
      onSelect={(value) =>
        setSeverity((current) =>
          value === "all"
            ? []
            : current.includes(value)
              ? current.filter((s) => s !== value)
              : [...current, value],
        )
      }
    />
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Potholes"
        description="Every physical pothole, worst first. Repeated sightings of one hole count once."
      />

      {error && (
        <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Could not load potholes</div>
          <p className="mt-1 text-secondary">{error}</p>
        </div>
      )}

      <Panel
        title="Repair list"
        subtitle={query.isPending ? "Loading…" : `${potholes.length} potholes in Tashkent`}
        icon="potholes"
        actions={filters}
        bodyClassName="p-0 sm:p-0"
      >
        {query.isPending ? (
          <p className="px-5 py-10 text-center text-[13px] text-muted">Loading potholes…</p>
        ) : potholes.length === 0 ? (
          <RepairListEmpty filtered={severity.length > 0} />
        ) : (
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <thead>
                <tr className={TABLE.headRow}>
                  <th className={TABLE.th}>Severity</th>
                  <th className={TABLE.th}>Status</th>
                  <th className={TABLE.th}>Sightings</th>
                  <th className={TABLE.th}>GPS accuracy</th>
                  <th className={TABLE.th}>Last seen</th>
                  <th className={TABLE.th}>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.body}>
                {potholes.map((pothole) => (
                  <tr key={pothole.id} className={TABLE.row}>
                    <td className={TABLE.td}>
                      <SeverityBadge level={pothole.severity} />
                    </td>
                    <td className={TABLE.td}>
                      <StatusBadge status={pothole.status} />
                    </td>
                    <td className={`${TABLE.td} tabular text-primary`}>{pothole.sighting_count}</td>
                    <td className={`${TABLE.td} tabular text-secondary`}>
                      ±{Math.round(pothole.location_accuracy_m)} m
                    </td>
                    <td className={`${TABLE.td} tabular text-secondary`}>
                      {new Date(pothole.last_seen_at).toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })}
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
