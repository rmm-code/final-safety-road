import Link from "next/link";
import { Icon } from "@/components/icons";

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; href: string }
  | { kind: "sample"; href: string }
  | { kind: "error"; message: string };

/** One line on whether the finished analysis is saved for everyone; nothing before that. */
export function SaveNote({ state }: { state: SaveState }) {
  if (state.kind === "idle") return null;
  const link =
    state.kind === "saved" || state.kind === "sample" ? (
      <Link href={state.href} className="font-medium text-primary underline underline-offset-2">
        Open its dashboard
      </Link>
    ) : null;
  return (
    <p
      role={state.kind === "error" ? "alert" : "status"}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-[10px] border border-[#ebebeb] bg-white px-4 py-2.5 text-[13px] leading-5 text-secondary shadow-card"
    >
      {state.kind === "saved" && <Icon name="check" size={15} className="text-green-ink" />}
      {state.kind === "saving" && "Saving the video, its potholes and their photos…"}
      {state.kind === "saved" && "Saved for everyone."}
      {state.kind === "sample" && "Samples already have a saved analysis, made with three detectors merged."}
      {state.kind === "error" && <span className="text-red-ink">Not saved: {state.message}</span>}
      {link}
    </p>
  );
}
