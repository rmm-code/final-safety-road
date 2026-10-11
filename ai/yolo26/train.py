"""Train YOLO26 on the set prepare_data.py built. Runs on the Colab VM.

    python train.py --data /content/data/data.yaml --name yolo26m-public
    python train.py --resume /content/runs/yolo26m-public/weights/last.pt

Starts from Ultralytics' COCO-pretrained `yolo26m.pt`: transfer learning, not from scratch.
Square 640, because the browser runs a square 640 ONNX; mfranzon's YOLO26 was trained at
512, one reason its frame-level test did not measure what the browser would run.

The run's own mAP is measured on the val split, i.e. on RDD2022 and jaygala24 images. It
picks best.pt and nothing more. Whether this model is any good is decided on the judged
Tashkent footage, by ai.evaluation.score_sets, back on the Mac.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--data", type=Path, default=Path("/content/data/data.yaml"))
    parser.add_argument("--model", default="yolo26m.pt")
    parser.add_argument("--name", default="yolo26m-public")
    parser.add_argument("--project", type=Path, default=Path("/content/runs"))
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--patience", type=int, default=15)
    parser.add_argument("--cache", default="disk", help="disk, ram or none")
    parser.add_argument("--resume", type=Path, help="last.pt of an interrupted run")
    args = parser.parse_args()

    from ultralytics import YOLO

    if args.resume:
        YOLO(str(args.resume)).train(resume=True)
        return

    YOLO(args.model).train(
        data=str(args.data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=args.patience,
        project=str(args.project),
        name=args.name,
        exist_ok=True,
        cache=False if args.cache == "none" else args.cache,
        workers=os.cpu_count() or 2,
        device=0,
        seed=7,
        close_mosaic=10,
        plots=True,
    )


if __name__ == "__main__":
    main()
