"""Pooled review: cluster every candidate's boxes so a person judges each one once.

    .venv/bin/python -m ai.evaluation.pool_review --frames output/model-eval/frames \\
        --preds output/model-eval/preds --out output/model-eval

With no ground truth for a clip, every box any candidate drew (>= --pool-min) on the
review frames is clustered per frame by IoU. Each cluster is judged once from the crop
sheets and full-frame overviews this writes; the verdicts become the reference that
`score_pooled.py` scores every candidate against. Recall measured this way is relative to
the pool: a pothole no candidate boxed is invisible to it.

Writes <out>/clusters.json, <out>/sheets/*.jpg and <out>/overview/*.jpg. Cluster ids are
what verdicts refer to, so keep the clusters.json that was judged beside its verdicts.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2
import numpy as np

from ai.inference.types import is_pothole_class

# Crack classes across the candidates' vocabularies: collabdoor (Crack, Crack-Severe),
# RDD2022 codes (D00 longitudinal, D10 transverse, D20 alligator) and DetectionBench names.
CRACK_CLASS_NAMES = frozenset(
    {"crack", "crack-severe", "d00", "d10", "d20"}
    | {"longitudinal_crack", "transverse_crack", "alligator_crack"}
)


def is_crack_class(label: str) -> bool:
    return label.strip().lower() in CRACK_CLASS_NAMES


TARGETS = {"pothole": is_pothole_class, "crack": is_crack_class}

# How every judged set in ai/evaluation/pooled/ was pooled. Fresh predictions are seated
# on those clusters by the same rule (`score_sets.attach_predictions`).
POOL_MIN = 0.25
CLUSTER_IOU = 0.5


def iou(a: list[float], b: list[float]) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def pooled_boxes(
    preds: dict[str, dict[str, dict]], image: str, *, pool_min: float, target: str
) -> list[dict]:
    """Every box of the target class at or above `pool_min` on one frame, most confident first."""
    wanted = TARGETS[target]
    boxes = [
        {"model": model, "xyxy": det["xyxy"], "score": det["score"]}
        for model, by_image in preds.items()
        for det in (by_image[image]["detections"] if image in by_image else [])
        if det["score"] >= pool_min and wanted(det["label"])
    ]
    boxes.sort(key=lambda b: -b["score"])
    return boxes


def build_clusters(
    preds: dict[str, dict[str, dict]],
    images: list[str],
    *,
    pool_min: float,
    cluster_iou: float,
    target: str = "pothole",
) -> list[dict]:
    clusters: list[dict] = []
    for image in images:
        frame_clusters: list[dict] = []
        for box in pooled_boxes(preds, image, pool_min=pool_min, target=target):
            home = next(
                (c for c in frame_clusters if iou(c["xyxy"], box["xyxy"]) >= cluster_iou), None
            )
            if home is None:
                home = {"image": image, "xyxy": box["xyxy"], "members": []}
                frame_clusters.append(home)
            home["members"].append(box)
        clusters.extend(frame_clusters)
    for n, cluster in enumerate(clusters, start=1):
        cluster["id"] = n
    return clusters


def _crop(frame: np.ndarray, xyxy: list[float], size: int = 260) -> np.ndarray:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = xyxy
    mx, my = (x2 - x1) * 0.6 + 20, (y2 - y1) * 0.6 + 20
    cx1, cy1 = int(max(0, x1 - mx)), int(max(0, y1 - my))
    cx2, cy2 = int(min(w, x2 + mx)), int(min(h, y2 + my))
    patch = frame[cy1:cy2, cx1:cx2].copy()
    top_left = (int(x1 - cx1), int(y1 - cy1))
    cv2.rectangle(patch, top_left, (int(x2 - cx1), int(y2 - cy1)), (0, 255, 255), 2)
    scale = size / max(patch.shape[:2])
    patch = cv2.resize(patch, (int(patch.shape[1] * scale), int(patch.shape[0] * scale)))
    canvas = np.full((size + 26, size, 3), 30, np.uint8)
    canvas[26 : 26 + patch.shape[0], : patch.shape[1]] = patch
    return canvas


def draw_sheets(
    clusters: list[dict], frames_dir: Path, out: Path, per_sheet: int = 20, blind: bool = False
) -> None:
    """Crop sheets to judge from. `blind` hides which models drew a box and how confident
    they were, so neither can sway the judge."""
    out.mkdir(parents=True, exist_ok=True)
    cols = 5
    cache: dict[str, np.ndarray] = {}
    for start in range(0, len(clusters), per_sheet):
        tiles = []
        for c in clusters[start : start + per_sheet]:
            frame = cache.setdefault(c["image"], cv2.imread(str(frames_dir / c["image"])))
            tile = _crop(frame, c["xyxy"])
            label = f"#{c['id']} {Path(c['image']).stem}"
            if not blind:
                models = "+".join(sorted({m["model"].split("_")[0][:4] for m in c["members"]}))
                label += f" {max(m['score'] for m in c['members']):.2f} {models}"
            cv2.putText(tile, label, (4, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
            tiles.append(tile)
        while len(tiles) % cols:
            tiles.append(np.full_like(tiles[0], 30))
        rows = [np.hstack(tiles[i : i + cols]) for i in range(0, len(tiles), cols)]
        name = out / f"sheet_{start // per_sheet + 1:02d}.jpg"
        cv2.imwrite(str(name), np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 88])


def draw_overviews(clusters: list[dict], frames_dir: Path, images: list[str], out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    for image in images:
        frame = cv2.imread(str(frames_dir / image))
        for c in (c for c in clusters if c["image"] == image):
            x1, y1, x2, y2 = (int(v) for v in c["xyxy"])
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(
                frame,
                str(c["id"]),
                (x1 + 2, max(14, y1 - 4)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                (0, 255, 255),
                2,
            )
        cv2.imwrite(str(out / image), frame, [cv2.IMWRITE_JPEG_QUALITY, 85])


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--frames", required=True, type=Path)
    parser.add_argument("--preds", type=Path, help="directory of <model>.json")
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--pool-min", type=float, default=POOL_MIN)
    parser.add_argument("--cluster-iou", type=float, default=CLUSTER_IOU)
    parser.add_argument(
        "--every", type=int, default=3, help="review every Nth frame (adjacent frames repeat)"
    )
    parser.add_argument(
        "--clusters", type=Path, help="redraw sheets for an already-judged clusters.json"
    )
    parser.add_argument("--blind", action="store_true", help="hide models and scores on sheets")
    parser.add_argument("--target", choices=sorted(TARGETS), default="pothole")
    args = parser.parse_args(argv)

    all_images = sorted(p.name for p in args.frames.glob("*.jpg"))
    if args.clusters:
        clusters = json.loads(args.clusters.read_text())
        judged = {c["image"] for c in clusters}
        images = [i for i in all_images if i in judged]
    else:
        if not args.preds:
            parser.error("--preds is required unless --clusters is given")
        preds = {
            path.stem: {item["image"]: item for item in json.loads(path.read_text())}
            for path in sorted(args.preds.glob("*.json"))
        }
        images = all_images[:: args.every]
        clusters = build_clusters(
            preds, images, pool_min=args.pool_min, cluster_iou=args.cluster_iou, target=args.target
        )
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "clusters.json").write_text(json.dumps(clusters, indent=1))
    draw_sheets(clusters, args.frames, args.out / "sheets", blind=args.blind)
    draw_overviews(clusters, args.frames, images, args.out / "overview")
    print(f"{len(images)} review frames, {len(clusters)} clusters -> {args.out}")


if __name__ == "__main__":
    main()
