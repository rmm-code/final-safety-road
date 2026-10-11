"""Run one Ultralytics checkpoint over a folder of images; write the shared predictions JSON.

    python -m ai.evaluation.run_detector --weights models/candidates/x.pt \\
        --images DIR --out preds.json [--imgsz 640] [--device mps]

Every candidate detector writes the same format, so all of them are scored and shown by
the same code (`ai/evaluation/build_model_compare.py`):

    [{"image", "width", "height", "inference_ms",
      "detections": [{"xyxy": [x1, y1, x2, y2], "score", "label"}]}]

ALL classes are kept, at a deliberately low threshold: the consumer decides what counts as
a pothole (by name, as the product does) and at which confidence.

Checkpoints are pickles and loading one runs code. Only load files whose imports have been
inspected first - see `ai/evaluation/README.md`.
"""

from __future__ import annotations

import argparse
import json
import time
import warnings
from pathlib import Path

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp"}
WARMUP_RUNS = 2


def run(
    weights: Path, images: Path, *, imgsz: int, device: str, threshold: float, square: bool = True
) -> list[dict]:
    warnings.filterwarnings("ignore")
    from ultralytics import YOLO

    model = YOLO(str(weights))
    files = sorted(p for p in images.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)
    if not files:
        raise SystemExit(f"No images in {images}")

    def predict(path: Path):
        # Square by default: that is what an ONNX export runs in the browser. Ultralytics'
        # own default is rectangular, and it scores the same frame differently - comparing
        # models that way would compare something we never ship.
        return model.predict(
            str(path),
            imgsz=imgsz,
            conf=threshold,
            device=device,
            verbose=False,
            max_det=300,
            rect=not square,
        )[0]

    # Excluded from timing: the first calls compile kernels and allocate buffers.
    for _ in range(WARMUP_RUNS):
        predict(files[0])

    out = []
    for path in files:
        started = time.perf_counter()
        result = predict(path)
        elapsed_ms = (time.perf_counter() - started) * 1000
        height, width = result.orig_shape
        boxes = result.boxes
        detections = [
            {
                "xyxy": [round(v, 1) for v in box],
                "score": round(score, 4),
                "label": model.names[int(cls)],
            }
            for box, score, cls in zip(
                boxes.xyxy.tolist(), boxes.conf.tolist(), boxes.cls.tolist(), strict=True
            )
        ]
        out.append(
            {
                "image": path.name,
                "width": width,
                "height": height,
                "inference_ms": round(elapsed_ms, 1),
                "detections": detections,
            }
        )
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.evaluation.run_detector")
    parser.add_argument("--weights", required=True, type=Path)
    parser.add_argument("--images", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--threshold", type=float, default=0.05)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--device", default="cpu", help="cpu, mps or cuda:0")
    parser.add_argument(
        "--rect", action="store_true", help="Ultralytics' rectangular mode instead of square"
    )
    args = parser.parse_args(argv)

    preds = run(
        args.weights,
        args.images,
        imgsz=args.imgsz,
        device=args.device,
        threshold=args.threshold,
        square=not args.rect,
    )
    args.out.write_text(json.dumps(preds))
    mean_ms = sum(p["inference_ms"] for p in preds) / len(preds)
    print(f"{len(preds)} images, mean {mean_ms:.1f} ms/image -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
