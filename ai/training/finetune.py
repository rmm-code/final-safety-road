"""Fine-tune a pothole detector from an existing checkpoint.

    python -m ai.training.finetune \\
      --data ./datasets/tashkent/data.yaml \\
      --base ./models/pothole-detector.pt \\
      --epochs 60

Always transfer learning, never from scratch. The deployed checkpoint already knows what
road damage looks like from ~30,700 images; local footage is there to teach it *our*
roads, weather and camera - a job that needs hundreds of images, not tens of thousands.

Training from random initialisation on a few hundred local frames would produce something
far worse than the model we already have.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ai.training.finetune",
        description="Fine-tune a road-damage detector on local footage.",
    )
    parser.add_argument(
        "--data", required=True, type=Path, help="data.yaml from ai.training.dataset"
    )
    parser.add_argument(
        "--base",
        type=Path,
        default=Path("models/pothole-detector.pt"),
        help="Checkpoint to start from. Never train from scratch.",
    )
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=8)
    parser.add_argument("--device", help="cpu, cuda:0, mps")
    parser.add_argument("--name", default="local-finetune", help="Run name under runs/")
    parser.add_argument(
        "--freeze",
        type=int,
        default=10,
        help=(
            "Backbone layers to freeze. With a few hundred images, letting the whole "
            "network move overwrites what it learned from 30,700."
        ),
    )
    parser.add_argument("--patience", type=int, default=15, help="Early-stopping patience")
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> Path:
    args = parse_args(argv)

    if not args.data.exists():
        raise FileNotFoundError(
            f"{args.data} not found. Build a dataset first:\n"
            "  python -m ai.training.dataset --source ./samples/labelled --out ./datasets/local"
        )
    if not args.base.exists():
        raise FileNotFoundError(f"Base checkpoint not found: {args.base}")

    from ultralytics import YOLO

    model = YOLO(str(args.base))
    print(f"Fine-tuning {args.base} on {args.data}", file=sys.stderr)
    print(f"  starting classes: {list((model.names or {}).values())}", file=sys.stderr)

    train_kwargs: dict[str, Any] = {
        "data": str(args.data.resolve()),
        "epochs": args.epochs,
        "imgsz": args.imgsz,
        "batch": args.batch,
        "freeze": args.freeze,
        "patience": args.patience,
        "name": args.name,
        "exist_ok": True,
        # Modest augmentation: the dataset builder already balanced the classes, and
        # aggressive colour jitter would undo the point of training on local conditions.
        "hsv_v": 0.3,
        "fliplr": 0.5,
        "mosaic": 0.5,
    }
    if args.device:
        train_kwargs["device"] = args.device

    results = model.train(**train_kwargs)
    weights = Path(results.save_dir) / "weights" / "best.pt"

    print(f"\nBest weights  {weights}")
    print("Next:")
    print(f"  1. python -m ai.inference.video --model {weights} --input ./samples/drive.mp4 \\")
    print("       --output ./output/annotated.mp4")
    print("  2. python -m ai.evaluation.score --report ./output/detections.json \\")
    print("       --truth ./samples/drive.truth.json")
    print("  3. Compare against the model you started from BEFORE deploying.")
    print(f"  4. python -m ai.export.to_onnx --model {weights} --name pothole-local \\")
    print("       --version 1.1.0 --imgsz 640 --quantize 16")

    metrics_path = Path(results.save_dir) / "local-finetune.json"
    metrics_path.write_text(
        json.dumps(
            {
                "base": str(args.base),
                "data": str(args.data),
                "epochs": args.epochs,
                "freeze": args.freeze,
                "weights": str(weights),
                # A reminder rather than a claim: these are the training run's own
                # numbers, on its own validation split.
                "note": (
                    "Validation metrics describe this dataset's own split. Judge the model "
                    "with ai.evaluation.score on a driven route before deploying."
                ),
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    return weights


def main(argv: list[str] | None = None) -> int:
    try:
        run(argv)
    except (FileNotFoundError, ValueError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
