"""Score candidates against a pooled, hand-judged reference (see pool_review.py).

    .venv/bin/python -m ai.evaluation.score_pooled \\
        --clusters ai/evaluation/pooled/tashkent-clip.clusters.json \\
        --verdicts ai/evaluation/pooled/tashkent-clip.verdicts.json \\
        [--ensemble current_collabdoor_v8m,mfranzon_yolo26]

Frame level, per box: a box in a cluster judged "pothole" is a true positive, anything else
a false positive. Recall is the share of judged-pothole clusters a model hit, so it is
relative to the pool. "strict" counts "unsure" clusters as not-a-pothole, "lenient" as
potholes; the truth sits between them. An ensemble is scored as union + NMS, which the
clusters already are: one hit per cluster.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

THRESHOLDS = (0.25, 0.35, 0.50)
MODES = {"strict": {"pothole"}, "lenient": {"pothole", "unsure"}}


def score(
    clusters: list[dict],
    verdicts: dict[str, str],
    models: tuple[str, ...],
    *,
    threshold: float,
    positive: set[str],
    ensemble: bool,
) -> dict:
    truth = {c["id"] for c in clusters if verdicts[str(c["id"])] in positive}
    tp = fp = 0
    found: set[int] = set()
    for c in clusters:
        hits = [m for m in c["members"] if m["model"] in models and m["score"] >= threshold]
        if not hits:
            continue
        count = 1 if ensemble else len(hits)
        if c["id"] in truth:
            tp += count
            found.add(c["id"])
        else:
            fp += count
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = len(found) / len(truth) if truth else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {
        "boxes": tp + fp,
        "tp": tp,
        "fp": fp,
        "found": len(found),
        "truth": len(truth),
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--clusters", required=True, type=Path)
    parser.add_argument("--verdicts", required=True, type=Path)
    parser.add_argument(
        "--ensemble",
        action="append",
        default=[],
        help="comma-separated model ids scored as one merged detector",
    )
    parser.add_argument("--json", type=Path, help="also write the rows here")
    args = parser.parse_args(argv)

    clusters = json.loads(args.clusters.read_text())
    verdicts = json.loads(args.verdicts.read_text())["verdicts"]
    models = sorted({m["model"] for c in clusters for m in c["members"]})
    candidates = [((m,), m, False) for m in models]
    candidates += [(tuple(e.split(",")), "+".join(e.split(",")), True) for e in args.ensemble]

    rows = []
    for mode, positive in MODES.items():
        print(f"\n{mode.upper()}")
        print(
            f"{'detector':48} {'t':>5} {'boxes':>6} {'TP':>4} {'FP':>4} {'P':>6} {'R':>6} {'F1':>6}"
        )
        for members, name, ensemble in candidates:
            for t in THRESHOLDS:
                row = score(
                    clusters, verdicts, members, threshold=t, positive=positive, ensemble=ensemble
                )
                rows.append({"mode": mode, "detector": name, "threshold": t, **row})
                print(
                    f"{name:48} {t:>5} {row['boxes']:>6} {row['tp']:>4} {row['fp']:>4} "
                    f"{row['precision']:>6.2f} {row['recall']:>6.2f} {row['f1']:>6.2f}"
                )
    if args.json:
        args.json.write_text(json.dumps(rows, indent=1))


if __name__ == "__main__":
    main()
