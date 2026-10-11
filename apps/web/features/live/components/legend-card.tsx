"use client";

import clsx from "clsx";
import type { PublicState } from "@/lib/public-api";
import { STATE_COLOUR, STATE_LABEL, STATE_ORDER } from "../lib/state-style";

/**
 * The legend, bottom left.
 *
 * Three colours and three sentences. Every marker on the map means one of these, and a
 * visitor who does not know what purple means cannot read the map at all - so the legend
 * is always visible rather than hidden behind a control.
 *
 * Hidden on the narrowest screens, where the summary card already carries the same three
 * rows and the button below needs the room.
 */
export function LegendCard({
  hidden,
  onToggle,
}: {
  hidden: Set<PublicState>;
  onToggle: (state: PublicState) => void;
}) {
  return (
    <section
      aria-label="Обозначения"
      className="absolute bottom-3 left-3 z-10 hidden rounded-xl bg-raised p-2.5 shadow-[0_1px_2px_rgba(20,28,24,0.06)] backdrop-blur-sm sm:block"
    >
      <ul className="space-y-1">
        {STATE_ORDER.map((state) => {
          const off = hidden.has(state);
          return (
            <li key={state}>
              <button
                type="button"
                onClick={() => onToggle(state)}
                aria-pressed={!off}
                className={clsx(
                  "flex items-center gap-2 rounded px-1 py-0.5 text-[12px] transition-colors duration-150 hover:bg-hover",
                  off ? "text-muted" : "text-secondary",
                )}
              >
                <span
                  aria-hidden
                  className={clsx("h-3 w-3 shrink-0 rounded-[3px]", off && "opacity-30")}
                  style={{ backgroundColor: STATE_COLOUR[state] }}
                />
                {STATE_LABEL[state]}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
