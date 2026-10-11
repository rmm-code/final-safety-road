import { Stat } from "@/components/ui";
import { formatLatency, formatPercent } from "@/lib/format";
import type { AnalysisSummary } from "../lib/report";

/**
 * The headline counts get metric treatment; the numbers an operator only consults when a
 * result looks wrong stay in a compact secondary row.
 */
export function AnalysisSummaryGrid({
  summary,
  rejectedTracks,
  rawDetections,
  averageInferenceMs,
}: {
  summary: AnalysisSummary;
  rejectedTracks: number;
  rawDetections: number;
  averageInferenceMs: number;
}) {
  const diagnostics = [
    {
      label: "Average confidence",
      value: summary.total === 0 ? "-" : formatPercent(summary.averageConfidence),
      hint: "peak per pothole",
    },
    { label: "Unknown severity", value: String(summary.unknown), hint: "no usable visible area" },
    { label: "Filtered out", value: String(rejectedTracks), hint: "below confirmation rules" },
    { label: "Inference", value: formatLatency(averageInferenceMs), hint: "average per frame" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Potholes detected"
          value={String(summary.total)}
          hint={`${rawDetections} frame detections tracked`}
        />
        <Stat label="Large" value={String(summary.large)} tone="large" />
        <Stat label="Medium" value={String(summary.medium)} tone="medium" />
        <Stat label="Small" value={String(summary.small)} tone="small" />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3 sm:grid-cols-4">
        {diagnostics.map((item) => (
          <div key={item.label}>
            <dt className="text-[12px] leading-[18px] text-secondary">{item.label}</dt>
            <dd className="tabular text-[13px] font-medium">
              {item.value}
              <span className="ml-1.5 font-normal text-muted">{item.hint}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
