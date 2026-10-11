import type { VisionEngineInfo } from "@pothole/shared-types";
import { Icon } from "@/components/icons";

/**
 * Standing warning shown whenever results come from the synthetic engine.
 *
 * Synthetic output must never be mistaken for detection: the banner stays on screen for
 * the whole session, and the same fact is written into every exported report.
 */
export function SyntheticEngineNotice({ engine }: { engine: VisionEngineInfo }) {
  if (!engine.isSynthetic) return null;

  return (
    <div
      role="status"
      className="flex gap-2.5 rounded-xl bg-yellow-soft px-4 py-3"
    >
      <Icon name="alert" className="mt-0.5 text-yellow-ink" />
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-yellow-ink">
          Synthetic detections - no trained model is installed
        </div>
        <p className="mt-1 text-[13px] leading-5 text-secondary">
          Everything below is fabricated by{" "}
          <code className="font-mono text-[12px]">MockVisionEngine</code> to exercise tracking,
          severity and the UI. It is not a reading of this video.
        </p>
        <p className="mt-1 text-[12px] leading-[18px] text-muted">{engine.selectionReason}</p>
        <p className="mt-1 text-[12px] leading-[18px] text-muted">
          Install a detector at <code className="font-mono">apps/web/public/models/</code> to run
          real inference. See <code className="font-mono">docs/ai.md</code>.
        </p>
      </div>
    </div>
  );
}
