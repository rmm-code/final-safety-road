/** Where a detector comes from. None was trained by the team; all are open-source checkpoints. */
export type ModelSource = { label: string; url: string | null };

const SOURCES: Record<string, ModelSource> = {
  "pothole-road-anomaly": { label: "collabdoor YOLOv8m", url: "https://github.com/collabdoor/road-anomaly-detection" },
  "mfranzon-yolo26m": { label: "mfranzon YOLO26m", url: "https://huggingface.co/mfranzon/pothole-yolo26" },
  "rezzzq-yolo12s": { label: "rezzzq YOLO12s", url: "https://huggingface.co/rezzzq/yolo12s-road-damage-rdd2022" },
};

/** "a-1.0.0+b-1.0.0" (a merge) -> one source per model. */
export function modelSources(modelVersion: string): ModelSource[] {
  return modelVersion.split("+").map((version) => {
    const name = version.replace(/-\d+\.\d+\.\d+$/, "");
    return SOURCES[name] ?? { label: version, url: null };
  });
}
