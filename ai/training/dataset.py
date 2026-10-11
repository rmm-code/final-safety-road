"""Assemble a YOLO training set from labelled local footage.

Follows the structure the collabdoor road-anomaly project used to build its 30,685-image
set - standardise labels, merge, split, augment the minority classes, compute class
weights - with one change that matters for our data.

**Splits are by drive, never by frame.** Consecutive frames of the same drive are nearly
identical: frame 100 and frame 101 show the same pothole from 15 cm further on. Split
those randomly and the model is validated on images it effectively trained on, and the
resulting mAP is fiction. That is the most likely explanation for a public pothole model
advertising 0.995 mAP@0.5 and then finding nothing on a real road.

Augmentation happens after the split and only on the train set, for the same reason.
"""

from __future__ import annotations

import hashlib
import json
import random
import shutil
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

# The class vocabulary a fine-tune must match, because we start from a checkpoint that
# already uses it. Changing this means retraining a head, not fine-tuning.
DEFAULT_CLASSES: tuple[str, ...] = (
    "Heavy-Vehicle",
    "Light-Vehicle",
    "Pedestrian",
    "Crack",
    "Crack-Severe",
    "Pothole",
    "Speed-Bump",
)

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass(frozen=True, slots=True)
class LabelledImage:
    """One image and its YOLO label file, tagged with the drive it came from."""

    image: Path
    label: Path
    drive: str

    @property
    def class_ids(self) -> list[int]:
        if not self.label.exists():
            return []
        ids: list[int] = []
        for line in self.label.read_text(encoding="utf-8").splitlines():
            parts = line.split()
            if parts:
                ids.append(int(float(parts[0])))
        return ids


@dataclass(slots=True)
class SplitSummary:
    train: int = 0
    valid: int = 0
    test: int = 0
    drives: dict[str, str] = field(default_factory=dict)
    class_counts: dict[str, Counter[int]] = field(default_factory=dict)


def drive_of(image: Path, root: Path) -> str:
    """Which drive an image belongs to.

    The immediate parent directory under the source root, so footage is organised one
    folder per drive. Everything loose at the top level is treated as a single drive.
    """
    relative = image.relative_to(root)
    return relative.parts[0] if len(relative.parts) > 1 else "_ungrouped"


def collect(root: Path) -> list[LabelledImage]:
    """Find every image with a matching YOLO label file."""
    found: list[LabelledImage] = []
    for image in sorted(root.rglob("*")):
        if image.suffix.lower() not in IMAGE_SUFFIXES or not image.is_file():
            continue
        label = image.with_suffix(".txt")
        if not label.exists():
            continue
        found.append(LabelledImage(image=image, label=label, drive=drive_of(image, root)))
    return found


def assign_drives(
    drives: list[str], ratios: tuple[float, float, float] = (0.7, 0.2, 0.1), seed: int = 7
) -> dict[str, str]:
    """Assign whole drives to train/valid/test.

    Deterministic for a given seed and drive list, so a rerun reproduces the same split
    and two runs remain comparable.
    """
    if abs(sum(ratios) - 1.0) > 1e-6:
        raise ValueError(f"Split ratios must sum to 1, got {ratios}")

    ordered = sorted(set(drives), key=lambda d: hashlib.sha1(d.encode()).hexdigest())
    rng = random.Random(seed)
    rng.shuffle(ordered)

    total = len(ordered)
    if total == 0:
        return {}
    # With very few drives, guarantee train is non-empty before anything else.
    train_end = max(1, round(total * ratios[0]))
    valid_end = min(total, train_end + max(0, round(total * ratios[1])))

    assignment: dict[str, str] = {}
    for index, drive in enumerate(ordered):
        if index < train_end:
            assignment[drive] = "train"
        elif index < valid_end:
            assignment[drive] = "valid"
        else:
            assignment[drive] = "test"
    return assignment


def class_weights(counts: Counter[int], classes: tuple[str, ...]) -> dict[str, float]:
    """Inverse-frequency weights, normalised to a mean of 1.

    Potholes are a minority even in bad-road footage - most frames contain none. Without
    weighting, a detector minimises loss by predicting nothing at all.
    """
    present = {index: counts.get(index, 0) for index in range(len(classes))}
    total = sum(present.values())
    if total == 0:
        return {name: 1.0 for name in classes}

    raw = {
        index: (total / (len(classes) * count)) if count else 0.0
        for index, count in present.items()
    }
    non_zero = [value for value in raw.values() if value > 0]
    mean = sum(non_zero) / len(non_zero) if non_zero else 1.0
    return {
        classes[index]: round(value / mean, 4) if value else 0.0 for index, value in raw.items()
    }


def build(
    source: Path,
    out: Path,
    classes: tuple[str, ...] = DEFAULT_CLASSES,
    ratios: tuple[float, float, float] = (0.7, 0.2, 0.1),
    seed: int = 7,
) -> SplitSummary:
    """Assemble a YOLO dataset directory from labelled footage."""
    items = collect(source)
    if not items:
        raise ValueError(
            f"No labelled images under {source}. Expected image files alongside YOLO .txt "
            "labels, organised one directory per drive."
        )

    assignment = assign_drives([item.drive for item in items], ratios, seed)
    summary = SplitSummary(drives=assignment)
    summary.class_counts = {split: Counter() for split in ("train", "valid", "test")}

    for split in ("train", "valid", "test"):
        (out / split / "images").mkdir(parents=True, exist_ok=True)
        (out / split / "labels").mkdir(parents=True, exist_ok=True)

    for item in items:
        split = assignment[item.drive]
        # Prefix with the drive so identically-named frames from different drives cannot
        # overwrite each other.
        stem = f"{item.drive}__{item.image.stem}"
        shutil.copy2(item.image, out / split / "images" / f"{stem}{item.image.suffix}")
        shutil.copy2(item.label, out / split / "labels" / f"{stem}.txt")

        summary.class_counts[split].update(item.class_ids)
        setattr(summary, split, getattr(summary, split) + 1)

    weights = class_weights(summary.class_counts["train"], classes)
    data_yaml = out / "data.yaml"
    data_yaml.write_text(
        "\n".join(
            [
                f"path: {out.resolve()}",
                "train: train/images",
                "val: valid/images",
                "test: test/images",
                f"nc: {len(classes)}",
                "names:",
                *[f"  {index}: {name}" for index, name in enumerate(classes)],
                "",
                "# Inverse-frequency class weights from the TRAIN split only.",
                *[f"# {name}: {weight}" for name, weight in weights.items()],
                "",
            ]
        ),
        encoding="utf-8",
    )

    (out / "split.json").write_text(
        json.dumps(
            {
                "seed": seed,
                "ratios": list(ratios),
                "drives": assignment,
                "counts": {
                    split: {classes[i]: c for i, c in sorted(counter.items()) if i < len(classes)}
                    for split, counter in summary.class_counts.items()
                },
                "classWeights": weights,
                # Recorded because splitting by drive is the whole point: it is what makes
                # the validation number mean something.
                "splitStrategy": "by-drive",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    return summary


def parse_args(argv: list[str] | None = None):
    import argparse

    parser = argparse.ArgumentParser(
        prog="python -m ai.training.dataset",
        description="Assemble a YOLO dataset from labelled footage, split by drive.",
    )
    parser.add_argument(
        "--source",
        required=True,
        type=Path,
        help="Root of labelled footage, one directory per drive",
    )
    parser.add_argument("--out", required=True, type=Path, help="Dataset directory to write")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--ratios",
        default="0.7,0.2,0.1",
        help="train,valid,test proportions of DRIVES (not frames)",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    import sys

    args = parse_args(argv)
    try:
        ratios = tuple(float(part) for part in args.ratios.split(","))
        if len(ratios) != 3:
            raise ValueError("--ratios needs three values: train,valid,test")
        summary = build(args.source, args.out, ratios=ratios, seed=args.seed)  # type: ignore[arg-type]
    except (ValueError, FileNotFoundError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    splits = len(set(summary.drives.values()))
    print(f"Drives          {len(summary.drives)} drives across {splits} splits")
    print(f"Train           {summary.train} images")
    print(f"Valid           {summary.valid} images")
    print(f"Test            {summary.test} images")
    print(f"Dataset         {args.out / 'data.yaml'}")
    print("\nSplit is BY DRIVE, so validation images come from journeys the model never saw.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
