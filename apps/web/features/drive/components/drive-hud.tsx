import clsx from "clsx";
import type { LocationState } from "../lib/use-location";
import type { DriveStats } from "../lib/drive-recorder";

/** Formats a drive duration as hh:mm:ss. */
export function formatDriveClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "00:00:00";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((v) => String(v).padStart(2, "0")).join(":");
}

/** Short description of GPS quality, or why there is none. */
export function formatGps(location: LocationState): { text: string; ok: boolean } {
  if (location.status === "tracking" && location.latest) {
    return { text: `±${Math.round(location.latest.accuracyM)} m`, ok: location.latest.accuracyM <= 25 };
  }
  if (location.status === "requesting") return { text: "acquiring", ok: false };
  if (location.status === "denied") return { text: "denied", ok: false };
  if (location.status === "unavailable") return { text: "unavailable", ok: false };
  if (location.status === "error") return { text: "error", ok: false };
  return { text: "off", ok: false };
}

/**
 * The only readout a driver sees while moving.
 *
 * Four numbers, large, no interaction. Everything that needs a decision waits until the
 * vehicle has stopped.
 */
export function DriveHud({
  stats,
  location,
  running,
  eventsQueued,
}: {
  stats: DriveStats;
  location: LocationState;
  running: boolean;
  eventsQueued: number;
}) {
  const gps = formatGps(location);

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      <HudCell label="AI" value={running ? "Running" : "Stopped"} tone={running ? "ok" : "muted"} />
      <HudCell label="GPS" value={gps.text} tone={gps.ok ? "ok" : "warn"} />
      <HudCell label="Inference" value={`${stats.inferenceFps.toFixed(1)} FPS`} />
      <HudCell label="Detected" value={String(eventsQueued)} />
    </div>
  );
}

function HudCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "muted";
}) {
  return (
    <div className="rounded-xl bg-surface px-3.5 py-3 shadow-card">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">{label}</div>
      <div
        className={clsx(
          "mt-0.5 font-mono text-lg leading-none tabular-nums",
          tone === "ok" && "text-green-ink",
          tone === "warn" && "text-yellow-ink",
          tone === "muted" && "text-secondary",
          tone === "default" && "text-primary",
        )}
      >
        {value}
      </div>
    </div>
  );
}
