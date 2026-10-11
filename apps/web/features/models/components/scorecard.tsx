import clsx from "clsx";
import { Badge, Panel, TABLE } from "@/components/ui";
import type { JudgedReports, Scorecard as ScorecardData } from "../lib/compare-data";

const NONE: JudgedReports = { reported: 0, real: 0, falseAlarms: 0, unsure: 0 };

function total(reports: JudgedReports[]): JudgedReports {
  return reports.reduce(
    (sum, r) => ({
      reported: sum.reported + r.reported,
      real: sum.real + r.real,
      falseAlarms: sum.falseAlarms + r.falseAlarms,
      unsure: sum.unsure + r.unsure,
    }),
    NONE,
  );
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function Counts({ reports }: { reports: JudgedReports | undefined }) {
  if (!reports) return <span className="text-muted">-</span>;
  if (reports.reported === 0) return <span className="text-muted">Nothing reported</span>;
  return (
    <div className="tabular leading-5">
      <div className="font-medium text-green-ink">{reports.real} real</div>
      <div className="text-[12.5px]">
        <span className={reports.falseAlarms > 0 ? "font-medium text-red-ink" : "text-muted"}>
          {reports.falseAlarms} false
        </span>
        {reports.unsure > 0 && (
          <>
            <span aria-hidden className="text-muted">
              {" · "}
            </span>
            <span className="text-muted">{reports.unsure} unsure</span>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The comparison in one table: what each setup would put on the map from each video, judged
 * by two reviewers who never saw which model made a report, plus frame-level precision and
 * recall over every reviewed frame.
 */
export function Scorecard({
  scorecard,
  titles,
}: {
  scorecard: ScorecardData;
  titles: Record<string, string>;
}) {
  return (
    <Panel
      icon="dashboard"
      title="Scorecard"
      subtitle="What each setup would put on the map from our videos. Every report was checked by two independent reviewers."
      bodyClassName="p-0"
      footer={{ label: scorecard.method }}
    >
      <div className={TABLE.wrap}>
        <table className={clsx(TABLE.table, "min-w-[880px]")}>
          <thead>
            <tr className={TABLE.headRow}>
              <th scope="col" className={TABLE.th}>
                Setup
              </th>
              {scorecard.videos.map((id) => (
                <th key={id} scope="col" className={TABLE.th}>
                  {titles[id] ?? id}
                </th>
              ))}
              <th scope="col" className={TABLE.th}>
                All videos
              </th>
              <th scope="col" className={TABLE.th}>
                Frame precision
              </th>
              <th scope="col" className={TABLE.th}>
                Frame recall
              </th>
            </tr>
          </thead>
          <tbody className={TABLE.body}>
            {scorecard.setups.map((setup) => {
              const perVideo = scorecard.reports[setup.id] ?? {};
              const frames = scorecard.frames[setup.id];
              const shown = scorecard.videos.map((id) => perVideo[id]).filter(Boolean) as JudgedReports[];
              return (
                <tr key={setup.id} className="align-top">
                  <th scope="row" className={clsx(TABLE.td, "text-left font-normal")}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-primary">{setup.label}</span>
                      {setup.id === scorecard.recommended && (
                        <Badge tone="ok" icon="check">
                          Recommended
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5 max-w-[34ch] text-[12.5px] leading-[18px] text-muted">
                      {setup.detail}
                    </div>
                  </th>
                  {scorecard.videos.map((id) => (
                    <td key={id} className={TABLE.td}>
                      <Counts reports={perVideo[id]} />
                    </td>
                  ))}
                  <td className={clsx(TABLE.td, "bg-subtle")}>
                    <Counts reports={total(shown)} />
                  </td>
                  <td className={clsx(TABLE.td, "tabular text-[15px] font-semibold text-primary")}>
                    {frames ? percent(frames.precision) : "-"}
                  </td>
                  <td className={clsx(TABLE.td, "tabular text-[15px] font-semibold text-primary")}>
                    {frames ? percent(frames.recall) : "-"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <dl className="grid gap-x-6 gap-y-1 px-4 py-3 text-[12.5px] leading-[18px] text-secondary sm:grid-cols-2 sm:px-5">
        <div>
          <dt className="inline font-medium text-primary">Real / false: </dt>
          <dd className="inline">potholes the pipeline would put on the map, confirmed or rejected.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-primary">Frame precision: </dt>
          <dd className="inline">of the boxes a setup drew, the share that were real potholes.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-primary">Unsure: </dt>
          <dd className="inline">the two reviewers disagreed.</dd>
        </div>
        <div>
          <dt className="inline font-medium text-primary">Frame recall: </dt>
          <dd className="inline">of the potholes the reviewers confirmed, the share it found.</dd>
        </div>
      </dl>
    </Panel>
  );
}
