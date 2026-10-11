"""Run B: fine-tune run A's YOLO26 on Tashkent frames, one fold at a time. Runs on the VM.

    python finetune_local.py --fold video-2 --base /content/runs/yolo26m-public/weights/best.pt

A fold trains on one judged pothole video plus the smooth-road clip dashcam-0939 (manhole
covers and lane paint, all judged "not"), and is scored on the OTHER pothole video. Two
folds, video-2 and video-3, so each Tashkent pothole video is scored by a model that never
saw it. dashcam-1215 is never trained on: it is where false alarms on a smooth road are
counted.

Local frames are repeated, and mixed with a random slice of the public set, so a few
hundred frames teach the camera and the roads without the model forgetting the 7,000
public images. The backbone stays frozen for the same reason (`--freeze 10`, as in
ai/training/finetune.py).

Scored on last.pt, not best.pt: the only validation split here is public data, and
choosing the checkpoint on it would choose for India and Japan, not Tashkent.
"""

from __future__ import annotations

import argparse
import random
from pathlib import Path

NEGATIVE_CLIP = "dashcam-0939"


def link(src: Path, dst: Path) -> None:
    if not dst.exists():
        dst.symlink_to(src)


def build_fold(args: argparse.Namespace) -> Path:
    root = Path(f"/content/fold-{args.fold}")
    rng = random.Random(7)
    for split in ("train", "val"):
        (root / "images" / split).mkdir(parents=True, exist_ok=True)
        (root / "labels" / split).mkdir(parents=True, exist_ok=True)

    for clip in (args.fold, NEGATIVE_CLIP):
        for image in sorted((args.local / clip / "images").glob("*.jpg")):
            label = args.local / clip / "labels" / f"{image.stem}.txt"
            for r in range(args.repeat):
                name = f"{image.stem}_r{r}"
                link(image, root / "images" / "train" / f"{name}.jpg")
                (root / "labels" / "train" / f"{name}.txt").write_text(label.read_text())

    for split, count in (("train", args.public_train), ("val", args.public_val)):
        images = sorted((args.public / "images" / split).glob("*.jpg"))
        for image in rng.sample(images, min(count, len(images))):
            link(image, root / "images" / split / image.name)
            link(
                args.public / "labels" / split / f"{image.stem}.txt",
                root / "labels" / split / f"{image.stem}.txt",
            )

    names = (args.public / "data.yaml").read_text().split("names:", 1)[1]
    data = root / "data.yaml"
    data.write_text(f"path: {root}\ntrain: images/train\nval: images/val\nnames:{names}")
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--fold", required=True, choices=["video-2", "video-3"])
    parser.add_argument("--base", type=Path, required=True, help="run A's best.pt")
    parser.add_argument("--local", type=Path, default=Path("/content/local"))
    parser.add_argument("--public", type=Path, default=Path("/content/data"))
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--public-train", type=int, default=2000)
    parser.add_argument("--public-val", type=int, default=400)
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--freeze", type=int, default=10)
    args = parser.parse_args()

    data = build_fold(args)

    from ultralytics import YOLO

    YOLO(str(args.base)).train(
        data=str(data),
        epochs=args.epochs,
        imgsz=640,
        batch=16,
        freeze=args.freeze,
        optimizer="AdamW",
        lr0=0.0005,
        warmup_epochs=1,
        close_mosaic=5,
        patience=args.epochs,
        project="/content/runs",
        name=f"yolo26m-local-{args.fold}",
        exist_ok=True,
        workers=2,
        device=0,
        seed=7,
        plots=False,
    )


if __name__ == "__main__":
    main()
