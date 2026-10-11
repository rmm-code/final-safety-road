import Link from "next/link";
import { Panel } from "@/components/ui";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; href: string }
  | { kind: "sample"; href: string }
  | { kind: "error"; message: string };

function DashboardLink({ href }: { href: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 font-medium text-primary underline underline-offset-2">
      Open its dashboard
    </Link>
  );
}

/** Whether the finished analysis is saved for everyone. */
export function SavePanel({ state }: { state: SaveState }) {
  return (
    <Panel title="Saved for everyone" icon="check">
      {state.kind === "saved" ? (
        <div className="space-y-2 text-[13px] leading-5">
          <p className="text-green-ink">This video, its potholes and their photos are saved. Anyone can open them.</p>
          <DashboardLink href={state.href} />
          <p className="text-[12px] text-muted">From the dashboard you can put the video on the map.</p>
        </div>
      ) : state.kind === "sample" ? (
        <div className="space-y-2 text-[13px] leading-5">
          <p className="text-secondary">
            Samples are not saved from here. Each already has a saved analysis, made with three detectors merged.
          </p>
          <DashboardLink href={state.href} />
        </div>
      ) : state.kind === "saving" ? (
        <p className="text-[13px] leading-5 text-secondary">Saving the video, its potholes and their photos…</p>
      ) : state.kind === "error" ? (
        <p role="alert" className="text-[13px] leading-5 text-red-ink">
          Not saved: {state.message}
        </p>
      ) : (
        <p className="text-[13px] leading-5 text-secondary">
          When the analysis finishes, an uploaded video and its potholes are saved, so anyone can open them under Samples
          &amp; insights. A video file has no GPS; you can place it on the map afterwards.
        </p>
      )}
    </Panel>
  );
}
