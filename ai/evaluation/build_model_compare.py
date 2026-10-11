"""Package detector comparisons for the web app's /models page.

    python -m ai.evaluation.build_model_compare --config ai/evaluation/model_compare.json

The config names the frames and the predictions to show; it lists local paths, so it lives
beside the prediction files rather than in the repository. Predictions use the shared format
`[{"image", "width", "height", "inference_ms", "detections": [{"xyxy", "score", "label"}]}]`
- by `ai/evaluation/run_detector.py` for Ultralytics checkpoints, and by an RF-DETR runner
for those - and writes what the page needs under apps/web/public/model-compare/:

    index.json                     models, sets, summary numbers
    <set>/frames/<name>.jpg        frames, resized so the page stays light
    <set>/<model>.json             per-frame pothole boxes, normalised 0-1

Only POTHOLE boxes are written, matched by name exactly as the product matches them, so the
page shows what each model would put on our map and nothing it would not.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import cv2

from ai.inference.types import is_pothole_class

# The page draws boxes above this. Anything lower is noise nobody needs to download.
MIN_SCORE = 0.10
# Wide enough that the highway set is served at its original 1024 px, so the live test sees
# the same pixels the precomputed panels were scored on.
MAX_FRAME_WIDTH = 1024


def _pothole_boxes(item: dict) -> list[list[float]]:
    w, h = item["width"], item["height"]
    out = []
    for det in item["detections"]:
        if det["score"] < MIN_SCORE or not is_pothole_class(det["label"]):
            continue
        x1, y1, x2, y2 = det["xyxy"]
        out.append(
            [
                round(x1 / w, 4),
                round(y1 / h, 4),
                round(x2 / w, 4),
                round(y2 / h, 4),
                round(det["score"], 3),
            ]
        )
    return out


def _summary(preds: list[dict]) -> dict:
    scores = [b[4] for item in preds for b in _pothole_boxes(item)]
    frames_with = sum(1 for item in preds if any(b[4] >= 0.35 for b in _pothole_boxes(item)))
    ms = [item["inference_ms"] for item in preds if item.get("inference_ms") is not None]
    return {
        "boxesAt035": sum(1 for s in scores if s >= 0.35),
        "framesWithPotholeAt035": frames_with,
        "frames": len(preds),
        "topScore": round(max(scores, default=0.0), 3),
        "meanMs": round(sum(ms) / len(ms), 1) if ms else None,
    }


def build(config: dict, out_root: Path) -> None:
    out_root.mkdir(parents=True, exist_ok=True)
    index = {
        "generatedAt": config.get("generatedAt"),
        # The conclusion is written by whoever ran the comparison, from these numbers. Kept
        # in the data rather than the page so a rerun cannot leave an old verdict standing.
        "verdict": config.get("verdict", []),
        "models": config["models"],
        "sets": [],
    }

    for test_set in config["sets"]:
        set_dir = out_root / test_set["id"]
        frames_dir = set_dir / "frames"
        frames_dir.mkdir(parents=True, exist_ok=True)

        frames = []
        for name in test_set["frames"]:
            image = cv2.imread(str(Path(test_set["framesDir"]) / name))
            if image is None:
                raise SystemExit(f"Cannot read {name} in {test_set['framesDir']}")
            h, w = image.shape[:2]
            if w > MAX_FRAME_WIDTH:
                scale = MAX_FRAME_WIDTH / w
                image = cv2.resize(
                    image, (MAX_FRAME_WIDTH, round(h * scale)), interpolation=cv2.INTER_AREA
                )
            out_name = Path(name).stem + ".jpg"
            cv2.imwrite(str(frames_dir / out_name), image, [cv2.IMWRITE_JPEG_QUALITY, 80])
            frames.append({"file": out_name, "width": image.shape[1], "height": image.shape[0]})

        summaries = {}
        wanted = {Path(n).name for n in test_set["frames"]}
        for model_id, pred_path in test_set["predictions"].items():
            preds = [p for p in json.loads(Path(pred_path).read_text()) if p["image"] in wanted]
            by_name = {p["image"]: p for p in preds}
            boxes = [_pothole_boxes(by_name[n]) if n in by_name else [] for n in test_set["frames"]]
            (set_dir / f"{model_id}.json").write_text(json.dumps(boxes, separators=(",", ":")))
            summaries[model_id] = _summary(preds)

        pipeline = {}
        for model_id, report_path in test_set.get("pipeline", {}).items():
            report = json.loads(Path(report_path).read_text())
            tracks = report.get("tracks", [])
            pipeline[model_id] = {
                "potholes": report["summary"]["totalPotholes"],
                "rawDetections": report["analysis"]["rawDetections"],
                "topConfidence": round(max((t["maxConfidence"] for t in tracks), default=0.0), 3),
            }

        index["sets"].append(
            {
                "id": test_set["id"],
                "title": test_set["title"],
                "description": test_set["description"],
                "source": test_set["source"],
                "frames": frames,
                "summaries": summaries,
                "pipeline": pipeline,
                "metrics": test_set.get("metrics", {}),
                "notes": test_set.get("notes", []),
            }
        )

    (out_root / "index.json").write_text(json.dumps(index, indent=1))
    print(f"Wrote {len(index['sets'])} set(s), {len(index['models'])} model(s) to {out_root}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.evaluation.build_model_compare")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--out", type=Path, default=Path("apps/web/public/model-compare"))
    args = parser.parse_args(argv)
    build(json.loads(args.config.read_text()), args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
