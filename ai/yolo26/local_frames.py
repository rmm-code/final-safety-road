"""Turn the judged Tashkent frames into YOLO training data for run B. Runs on the Mac.

    .venv/bin/python -m ai.yolo26.local_frames --out output/yolo26/local

The only labels our own footage has are the pooled clusters two blind judges labelled for
docs/model-comparison.md (`ai/evaluation/pooled/<set>-pothole.*`):

- a cluster judged "pothole" becomes a Pothole box;
- a cluster judged "not" stays unlabelled road, which is what teaches a detector that a
  manhole cover or a painted arrow is not a pothole;
- a frame with any "unsure" cluster is left out, because nobody knows what to teach there.

Recall was measured against this pool, and the miss audit found no pothole every model
missed in videos 2 and 3, so an unlabelled region of those frames is road, not a missed hole.

Each set keeps its own folder. Which sets train and which test is decided per fold in
`finetune_local.py`: a video used for training is never scored.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from PIL import Image

from ai.yolo26.prepare_data import CLASSES, MAX_SIDE

POTHOLE = CLASSES.index("Pothole")
POOLED = Path("ai/evaluation/pooled")
SETS = {
    "video-2": Path("output/model-eval/sets/video-2/frames"),
    "video-3": Path("output/model-eval/sets/video-3/frames"),
    "dashcam-0939": Path("output/model-eval/sets/dashcam-0939/frames"),
    "dashcam-1215": Path("output/model-eval/sets/dashcam-1215/frames"),
}


def judged_frames(name: str) -> list[str]:
    for config in ("sets-four-videos.json", "sets.json"):
        for s in json.loads((POOLED / config).read_text())["sets"]:
            if s["name"] == name and s["target"] == "pothole":
                return s["frames"]
    raise SystemExit(f"{name} is in no pooled config")


def build(name: str, frames_dir: Path, out: Path) -> dict:
    clusters = json.loads((POOLED / f"{name}-pothole.clusters.json").read_text())
    verdicts = json.loads((POOLED / f"{name}-pothole.consensus.json").read_text())["verdicts"]
    by_image: dict[str, list[tuple[str, list[float]]]] = {}
    for c in clusters:
        by_image.setdefault(c["image"], []).append((verdicts[str(c["id"])], c["xyxy"]))

    (out / "images").mkdir(parents=True, exist_ok=True)
    (out / "labels").mkdir(parents=True, exist_ok=True)
    kept = dropped = boxes = 0
    for image in judged_frames(name):
        found = by_image.get(image, [])
        if any(label == "unsure" for label, _ in found):
            dropped += 1
            continue
        with Image.open(frames_dir / image) as im:
            width, height = im.size
        lines = []
        for label, (x1, y1, x2, y2) in found:
            if label != "pothole":
                continue
            lines.append(
                f"{POTHOLE} {(x1 + x2) / 2 / width:.6f} {(y1 + y2) / 2 / height:.6f}"
                f" {(x2 - x1) / width:.6f} {(y2 - y1) / height:.6f}"
            )
        stem = f"{name}_{Path(image).stem}"
        # Training runs at 640, so a 1080p frame only costs upload time and CPU on the VM.
        with Image.open(frames_dir / image) as im:
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
            im.save(out / "images" / f"{stem}.jpg", quality=92)
        (out / "labels" / f"{stem}.txt").write_text("".join(f"{line}\n" for line in lines))
        kept += 1
        boxes += len(lines)
    return {"frames": kept, "dropped_unsure": dropped, "pothole_boxes": boxes}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=Path("output/yolo26/local"))
    args = parser.parse_args()
    summary = {name: build(name, frames, args.out / name) for name, frames in SETS.items()}
    (args.out / "summary.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
