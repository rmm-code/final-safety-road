"""Score image predictions for the POTHOLE class against YOLO-format ground truth.

    python -m ai.evaluation.score_images --labels DIR --preds a.json b.json \\
        [--pothole-ids 0] [--ignore dropped_components.json]

Complements `score.py`, which scores a whole drive at the level of unique potholes. This
one answers "on this labelled image set, how often is a box right": the question for
choosing a detector, before tracking smooths anything over.

- A prediction counts only if its label is a pothole alias - the product's own name rule.
- Matching is greedy by score at IoU >= 0.5, one prediction per labelled pothole.
- `--ignore` takes regions that are real potholes the labels left out (e.g. ones too small
  to survive a dataset's mask clean-up). A detection there is neither right nor wrong.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ai.inference.types import is_pothole_class

IOU_THRESHOLD = 0.5
OPERATING_THRESHOLDS = (0.25, 0.35, 0.5)


def iou(a: list[float], b: list[float]) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def centre_inside(box: list[float], region: list[float]) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return region[0] <= cx <= region[2] and region[1] <= cy <= region[3]


def load_truth(
    labels: Path, stem: str, width: int, height: int, ids: set[int]
) -> list[list[float]]:
    path = labels / f"{stem}.txt"
    boxes = []
    if path.exists():
        for line in path.read_text().splitlines():
            parts = line.split()
            if len(parts) != 5 or int(parts[0]) not in ids:
                continue
            cx, cy, w, h = (float(v) for v in parts[1:])
            boxes.append(
                [
                    (cx - w / 2) * width,
                    (cy - h / 2) * height,
                    (cx + w / 2) * width,
                    (cy + h / 2) * height,
                ]
            )
    return boxes


def evaluate(
    preds: list[dict],
    labels: Path,
    ids: set[int],
    ignore: dict[str, list[list[float]]] | None = None,
) -> dict:
    ignore = ignore or {}
    scored: list[tuple[float, bool, bool]] = []  # (score, true positive, image has no truth)
    total_truth = clean_images = ignored = 0

    for item in preds:
        stem = Path(item["image"]).stem
        truth = load_truth(labels, stem, item["width"], item["height"], ids)
        total_truth += len(truth)
        clean_images += not truth
        regions = ignore.get(stem, [])
        detections = sorted(
            (d for d in item["detections"] if is_pothole_class(d["label"])),
            key=lambda d: -d["score"],
        )
        used: set[int] = set()
        for det in detections:
            best, best_index = 0.0, -1
            for index, box in enumerate(truth):
                if index not in used and (overlap := iou(det["xyxy"], box)) > best:
                    best, best_index = overlap, index
            if best >= IOU_THRESHOLD:
                used.add(best_index)
                scored.append((det["score"], True, not truth))
            elif any(centre_inside(det["xyxy"], region) for region in regions):
                ignored += 1
            else:
                scored.append((det["score"], False, not truth))

    scored.sort(key=lambda s: -s[0])
    curve, hits = [], 0
    for rank, (score, hit, _) in enumerate(scored, start=1):
        hits += hit
        curve.append((score, hits / max(total_truth, 1), hits / rank))

    # AP50 with all-point interpolation: precision at each recall step is the best
    # precision achievable at that recall or beyond.
    ap, previous_recall, best_after = 0.0, 0.0, 0.0
    envelope = []
    for _, _, precision in reversed(curve):
        best_after = max(best_after, precision)
        envelope.append(best_after)
    envelope.reverse()
    for (_, recall, _), precision in zip(curve, envelope, strict=True):
        ap += (recall - previous_recall) * precision
        previous_recall = recall

    def at(threshold: float) -> dict:
        chosen = [s for s in scored if s[0] >= threshold]
        hits_at = sum(1 for s in chosen if s[1])
        precision = hits_at / len(chosen) if chosen else 0.0
        recall = hits_at / max(total_truth, 1)
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        return {
            "threshold": threshold,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
            "false_alarms_on_clean_images": sum(1 for s in chosen if s[2] and not s[1]),
        }

    return {
        "images": len(preds),
        "clean_images": clean_images,
        "labelled_potholes": total_truth,
        "ignored_detections": ignored,
        "ap50": round(ap, 3),
        "operating_points": [at(t) for t in OPERATING_THRESHOLDS],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.evaluation.score_images")
    parser.add_argument("--labels", required=True, type=Path)
    parser.add_argument("--preds", required=True, nargs="+", type=Path)
    parser.add_argument(
        "--pothole-ids", default="0", help="Comma-separated label ids meaning pothole"
    )
    parser.add_argument("--ignore", type=Path, help="JSON: image stem -> [[x0, y0, x1, y1, ...]]")
    args = parser.parse_args(argv)

    ids = {int(value) for value in args.pothole_ids.split(",")}
    ignore = None
    if args.ignore:
        raw = json.loads(args.ignore.read_text())
        ignore = {stem: regions for stem, regions in raw.items() if isinstance(regions, list)}
    for path in args.preds:
        result = evaluate(json.loads(path.read_text()), args.labels, ids, ignore)
        print(json.dumps({"model": path.stem, **result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
