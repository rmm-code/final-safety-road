"""Score detectors across several pooled-review sets, with bootstrap confidence intervals.

    .venv/bin/python -m ai.evaluation.score_sets --config ai/evaluation/pooled/sets.json \\
        [--preds-root DIR] [--json out.json]

The config lists judged sets, each a clusters file from `pool_review.py` plus its
verdicts, the target it was pooled for ("pothole" or "crack"), and how many frames were
reviewed (frames without a single cluster still count as sampled road):

    {"detectors": [["current_collabdoor_v8m"], ["current_collabdoor_v8m", "mfranzon_yolo26"]],
     "sets": [{"name": "dashcam-0939", "target": "pothole", "clusters": "...",
               "verdicts": "...", "frames": ["f_0001.jpg", ...]}]}

A detector with several members is scored as one merged detector (union + NMS), which
the clusters already are: one hit per cluster. Precision is per box (per cluster for a
merged detector), recall is the share of judged-positive clusters hit, so it is relative
to the pool. "strict" counts "unsure" as negative, "lenient" as positive.

With --preds-root, the boxes come from fresh predictions, `DIR/<set name>/<model>.json` as
`run_detector.py` writes them, instead of the boxes the clusters were built from: a run on
another GPU, a new export or a fine-tuned model is scored without judging again. A box that
lands on no judged cluster cannot be scored; it is counted as unjudged, never dropped.

Intervals come from a block bootstrap: review frames are cut into consecutive blocks,
resampled with replacement within each set, and every metric is recomputed. Blocks keep
the repeated sightings of one physical defect together, so the intervals are not
overconfident.
"""

from __future__ import annotations

import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

from ai.evaluation.pool_review import CLUSTER_IOU, POOL_MIN, iou, pooled_boxes

THRESHOLDS = (0.25, 0.35, 0.50)
MODES = ("strict", "lenient")
BLOCK_FRAMES = 6
ITERATIONS = 2000


def attach_predictions(
    clusters: list[dict],
    preds: dict[str, dict[str, dict]],
    images: list[str],
    *,
    target: str,
    pool_min: float = POOL_MIN,
    cluster_iou: float = CLUSTER_IOU,
) -> tuple[list[dict], list[dict]]:
    """Seat fresh predictions on judged clusters; return the clusters and the unjudged boxes.

    `preds` is model -> image -> prediction, as `build_clusters` takes it. Each pooled box on
    a judged frame joins the first cluster there whose founding box it overlaps by
    `cluster_iou`. That is the rule that built the clusters, so seating the predictions a set
    was built from reproduces it.
    """
    seated = [{**c, "members": []} for c in clusters]
    by_image: dict[str, list[dict]] = defaultdict(list)
    for cluster in seated:
        by_image[cluster["image"]].append(cluster)
    unjudged = []
    for image in images:
        for box in pooled_boxes(preds, image, pool_min=pool_min, target=target):
            home = next(
                (c for c in by_image[image] if iou(c["xyxy"], box["xyxy"]) >= cluster_iou), None
            )
            if home is None:
                unjudged.append({"image": image, **box})
            else:
                home["members"].append(box)
    return seated, unjudged


def _load_preds(folder: Path, models: list[str]) -> dict[str, dict[str, dict]]:
    preds = {}
    for model in models:
        path = folder / f"{model}.json"
        if not path.exists():
            raise SystemExit(f"No predictions for {model}: expected {path}")
        preds[model] = {item["image"]: item for item in json.loads(path.read_text())}
    return preds


def _positive(target: str, mode: str) -> set[str]:
    return {target, "unsure"} if mode == "lenient" else {target}


def _frame_counts(
    clusters: list[dict],
    verdicts: dict[str, str],
    members: tuple[str, ...],
    *,
    threshold: float,
    positive: set[str],
) -> dict[str, list[int]]:
    """Per frame: [true-positive boxes, false-positive boxes, positives hit, positives]."""
    merged = len(members) > 1
    counts: dict[str, list[int]] = defaultdict(lambda: [0, 0, 0, 0])
    for c in clusters:
        row = counts[c["image"]]
        is_positive = verdicts[str(c["id"])] in positive
        row[3] += is_positive
        hits = [m for m in c["members"] if m["model"] in members and m["score"] >= threshold]
        if not hits:
            continue
        n = 1 if merged else len(hits)
        if is_positive:
            row[0] += n
            row[2] += 1
        else:
            row[1] += n
    return counts


def _metrics(tp: int, fp: int, hit: int, total: int) -> dict[str, float]:
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = hit / total if total else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"precision": precision, "recall": recall, "f1": f1}


def _total(
    target_sets: list[dict],
    per_set: dict[str, dict[str, list[int]]],
    selection: dict[str, list[list[str]]] | None,
) -> list[int]:
    """Sum frame counts over the chosen blocks (all blocks when `selection` is None)."""
    acc = [0, 0, 0, 0]
    for s in target_sets:
        key = s["name"] + s["target"]
        for block in selection[key] if selection else s["blocks"]:
            for frame in block:
                for i, v in enumerate(per_set[key].get(frame, (0, 0, 0, 0))):
                    acc[i] += v
    return acc


def evaluate(config: dict, *, seed: int = 7, preds_root: Path | None = None) -> list[dict]:
    models = sorted({model for members in config["detectors"] for model in members})
    sets = []
    for s in config["sets"]:
        clusters = json.loads(Path(s["clusters"]).read_text())
        verdicts = json.loads(Path(s["verdicts"]).read_text())["verdicts"]
        frames = list(s["frames"])
        unjudged: list[dict] = []
        if preds_root is not None:
            preds = _load_preds(preds_root / s["name"], models)
            clusters, unjudged = attach_predictions(clusters, preds, frames, target=s["target"])
        blocks = [frames[i : i + BLOCK_FRAMES] for i in range(0, len(frames), BLOCK_FRAMES)]
        sets.append(
            {
                **s,
                "clusters_data": clusters,
                "verdicts_data": verdicts,
                "blocks": blocks,
                "unjudged": unjudged,
            }
        )

    rng = random.Random(seed)
    resamples = []
    for _ in range(ITERATIONS):
        resamples.append(
            {s["name"] + s["target"]: [rng.choice(s["blocks"]) for _ in s["blocks"]] for s in sets}
        )

    rows = []
    targets = sorted({s["target"] for s in sets})
    for target in targets:
        target_sets = [s for s in sets if s["target"] == target]
        for members in map(tuple, config["detectors"]):
            for mode in MODES:
                for threshold in THRESHOLDS:
                    per_set = {
                        s["name"] + s["target"]: _frame_counts(
                            s["clusters_data"],
                            s["verdicts_data"],
                            members,
                            threshold=threshold,
                            positive=_positive(target, mode),
                        )
                        for s in target_sets
                    }

                    point = _metrics(*_total(target_sets, per_set, None))
                    samples = [_metrics(*_total(target_sets, per_set, r)) for r in resamples]
                    row = {
                        "target": target,
                        "detector": "+".join(members),
                        "mode": mode,
                        "threshold": threshold,
                        "counts": dict(
                            zip(
                                ("tp_boxes", "fp_boxes", "positives_hit", "positives"),
                                _total(target_sets, per_set, None),
                                strict=True,
                            )
                        ),
                    }
                    if preds_root is not None:
                        row["unjudged_boxes"] = sum(
                            box["model"] in members and box["score"] >= threshold
                            for s in target_sets
                            for box in s["unjudged"]
                        )
                    for name, value in point.items():
                        values = sorted(s[name] for s in samples)
                        row[name] = round(value, 3)
                        row[f"{name}_ci"] = [
                            round(values[int(0.025 * len(values))], 3),
                            round(values[int(0.975 * len(values)) - 1], 3),
                        ]
                    rows.append(row)
    return rows


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument(
        "--preds-root",
        type=Path,
        help="score fresh predictions, DIR/<set name>/<model>.json, against the judged clusters",
    )
    parser.add_argument("--json", type=Path)
    args = parser.parse_args(argv)
    rows = evaluate(json.loads(args.config.read_text()), preds_root=args.preds_root)
    unjudged = "  unjudged" if args.preds_root else ""
    for target in sorted({r["target"] for r in rows}):
        for mode in MODES:
            print(f"\n{target.upper()}  {mode}")
            print(
                f"{'detector':58} {'t':>5} {'P':>5} {'95% CI':>13} {'R':>5} {'95% CI':>13}"
                f" {'F1':>5}  boxes{unjudged}"
            )
            for r in rows:
                if r["target"] != target or r["mode"] != mode:
                    continue
                c = r["counts"]
                print(
                    f"{r['detector']:58} {r['threshold']:>5} {r['precision']:>5.2f} "
                    f"{str(r['precision_ci']):>13} {r['recall']:>5.2f} {str(r['recall_ci']):>13}"
                    f" {r['f1']:>5.2f}  {c['tp_boxes'] + c['fp_boxes']}"
                    + (f"  {r['unjudged_boxes']:>8}" if args.preds_root else "")
                )
    if args.json:
        args.json.write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
