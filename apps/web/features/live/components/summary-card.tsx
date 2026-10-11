"use client";

import clsx from "clsx";
import type { PublicCounts, PublicState } from "@/lib/public-api";
import { STATE_COLOUR, STATE_LABEL, STATE_ORDER } from "../lib/state-style";

/**
 * The floating summary, top right.
 *
 * Doubles as the filter: each row is a toggle. Making the counts themselves the control
 * means there is one list of states on the screen rather than a legend, a filter bar and
 * a tally that can disagree with each other.
 */
export function SummaryCard({
  counts,
  loading,
  updatedAt,
  hidden,
  onToggle,
}: {
  counts: PublicCounts;
  loading: boolean;
  updatedAt: string | null;
  hidden: Set<PublicState>;
  onToggle: (state: PublicState) => void;
}) {
  return (
    <section
      aria-label="Ямы в этой области"
      className="absolute right-3 top-3 z-10 w-[236px] rounded-xl bg-raised p-3 shadow-[0_1px_2px_rgba(20,28,24,0.06)] backdrop-blur-sm"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h1 className="text-[15px] font-semibold leading-5">
          Карта<span className="text-blue-strong">.</span>ям
        </h1>
        <span className="tabular font-mono text-[12px] text-muted">{counts.total}</span>
      </div>

      <ul className="mt-2.5 space-y-1">
        {STATE_ORDER.map((state) => {
          const off = hidden.has(state);
          return (
            <li key={state}>
              <button
                type="button"
                onClick={() => onToggle(state)}
                aria-pressed={!off}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-[12px] transition-colors duration-150",
                  off
                    ? "border-transparent text-muted hover:bg-hover"
                    : "border-border bg-surface text-primary",
                )}
              >
                <span
                  aria-hidden
                  className={clsx("h-3 w-3 shrink-0 rounded-[3px]", off && "opacity-30")}
                  style={{ backgroundColor: STATE_COLOUR[state] }}
                />
                <span className="min-w-0 flex-1 truncate">{STATE_LABEL[state]}</span>
                <span className="tabular font-mono">{counts[state]}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2.5 border-t border-border pt-2 text-[11px] leading-4 text-muted">
        {loading ? "Обновление…" : updatedAt ? `Обновлено в ${updatedAt}` : " "}
      </p>
    </section>
  );
}
