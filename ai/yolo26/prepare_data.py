"""Build the public training set for our YOLO26 pothole detector. Runs on the Colab VM.

    python prepare_data.py --work /content/work --out /content/data

Sources, neither needing an account or a key:

- RDD2022 (CC BY 4.0, figshare article 21431547): road damage from six countries, Pascal
  VOC labels. D00, D10 and D20 are crack types, D40 is a pothole. China_Drone is skipped:
  a drone looks down at the road, a windscreen camera looks along it.
- jaygala24/pothole-detection v1.0.0 (MIT): 1,243 pothole images, YOLO labels.

The Bangladesh set on Mendeley is deliberately absent: it labels cracks and broken surface
as "pothole", the confusion this model exists to avoid.

Every image with a pothole is kept, plus about as many without one - up to half of them
showing a manhole cover or a patch, the rest cracks and bare road - so the model sees what
is NOT a pothole. Cracks, manholes, road markings and patches keep classes of their own: a
single-class model has nowhere to put a manhole cover except "pothole", which is how
mfranzon's YOLO26 fails on Tashkent footage.

Splits are contiguous blocks of image ids, never random images. Consecutive RDD ids come
from one drive, and a random split validates on near-copies of training images.

Images are shrunk so the long side is 640, the size training runs at. The VM has two CPU
cores, and decoding 3,650-pixel Norwegian frames every epoch would starve the GPU.

Finally it crops a sample of pothole boxes onto a contact sheet: look at it before
training. One copy of RDD2022 labelled manhole covers and lane paint as potholes.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import subprocess
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from multiprocessing import Pool
from pathlib import Path

from PIL import Image, ImageDraw

RDD_URL = "https://ndownloader.figshare.com/files/38030910"
JAYGALA_URL = (
    "https://github.com/jaygala24/pothole-detection/releases/download/v1.0.0/"
    "Pothole.Dataset.IVCNZ.zip"
)

# The browser and the Python pipeline find the pothole class by NAME (POTHOLE_CLASS_ALIASES).
# Manholes, road markings and patches are the things a pothole detector mistakes for
# potholes. RDD2022's Japanese labels name them (D50, D43/D44, Repair), so they get classes
# of their own instead of being left as unlabelled road.
CLASSES = (
    "Crack-Longitudinal",
    "Crack-Transverse",
    "Crack-Alligator",
    "Pothole",
    "Manhole",
    "Road-Marking",
    "Repair",
)
POTHOLE = CLASSES.index("Pothole")
LOOKALIKES = {CLASSES.index(name) for name in ("Manhole", "Repair")}
RDD_CLASSES = {
    "D00": 0,
    "D10": 1,
    "D20": 2,
    "D40": POTHOLE,
    "D50": CLASSES.index("Manhole"),
    "D43": CLASSES.index("Road-Marking"),
    "D44": CLASSES.index("Road-Marking"),
    "Repair": CLASSES.index("Repair"),
}
SKIP_COUNTRIES = {"China_Drone"}

MAX_SIDE = 640
BLOCK_IDS = 100
MIN_BOX_PX = 4
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}


@dataclass
class Item:
    source: str  # "rdd" or "jaygala"
    group: str  # country, or jaygala's own split folder
    image: Path
    boxes: list[tuple[int, float, float, float, float]] = field(default_factory=list)
    split: str = "train"

    @property
    def has_pothole(self) -> bool:
        return any(b[0] == POTHOLE for b in self.boxes)

    @property
    def out_name(self) -> str:
        return f"{self.source}_{self.image.stem}"


def fetch(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0 and not dest.with_suffix(".part").exists():
        print(f"have {dest.name}", flush=True)
        return
    part = dest.with_suffix(".part")
    part.touch()
    print(f"downloading {url}", flush=True)
    subprocess.run(["curl", "-sSL", "--retry", "5", "-C", "-", "-o", str(dest), url], check=True)
    part.unlink()


def extract(archive: Path, into: Path) -> None:
    """Unzip, then unzip any archive found inside (RDD has shipped nested per-country zips)."""
    marker = into / ".extracted"
    if marker.exists():
        return
    into.mkdir(parents=True, exist_ok=True)
    subprocess.run(["unzip", "-q", "-o", str(archive), "-d", str(into)], check=True)
    while nested := [p for p in into.rglob("*.zip") if not p.name.startswith(".")]:
        for inner in nested:
            subprocess.run(["unzip", "-q", "-o", str(inner), "-d", str(inner.parent)], check=True)
            inner.unlink()
    marker.touch()


def parse_voc(xml_path: Path) -> list[tuple[str, float, float, float, float]]:
    root = ET.parse(xml_path).getroot()
    boxes = []
    for obj in root.iter("object"):
        name = (obj.findtext("name") or "").strip()
        bb = obj.find("bndbox")
        if bb is None:
            continue
        try:
            coords = [float(bb.findtext(k) or "nan") for k in ("xmin", "ymin", "xmax", "ymax")]
        except ValueError:
            continue
        boxes.append((name, *coords))
    return boxes


def rdd_items(root: Path, unknown: Counter) -> list[Item]:
    items = []
    for xml_path in sorted(root.rglob("annotations/xmls/*.xml")):
        country = xml_path.parents[3].name
        if country in SKIP_COUNTRIES:
            continue
        image = xml_path.parents[2] / "images" / f"{xml_path.stem}.jpg"
        if not image.exists():
            unknown["missing image"] += 1
            continue
        with Image.open(image) as im:
            width, height = im.size
        boxes = []
        for name, x1, y1, x2, y2 in parse_voc(xml_path):
            if name not in RDD_CLASSES:
                unknown[name] += 1
                continue
            x1, x2 = sorted((max(0.0, min(x1, width)), max(0.0, min(x2, width))))
            y1, y2 = sorted((max(0.0, min(y1, height)), max(0.0, min(y2, height))))
            if x2 - x1 < MIN_BOX_PX or y2 - y1 < MIN_BOX_PX:
                unknown["degenerate box"] += 1
                continue
            boxes.append(
                (
                    RDD_CLASSES[name],
                    (x1 + x2) / 2 / width,
                    (y1 + y2) / 2 / height,
                    (x2 - x1) / width,
                    (y2 - y1) / height,
                )
            )
        items.append(Item("rdd", country, image, boxes))
    return items


def jaygala_items(root: Path, problems: Counter) -> list[Item]:
    """YOLO-format labels beside or parallel to the images; every class is a pothole."""
    items = []
    images = sorted(
        p
        for p in root.rglob("*")
        if p.suffix.lower() in IMAGE_SUFFIXES
        and not p.name.startswith("._")
        and "__MACOSX" not in p.parts
    )
    for image in images:
        candidates = [
            image.with_suffix(".txt"),
            Path(str(image.with_suffix(".txt")).replace("/images/", "/labels/")),
        ]
        label = next((c for c in candidates if c.exists()), None)
        if label is None:
            problems["no label file"] += 1
            continue
        boxes = []
        for line in label.read_text().splitlines():
            parts = line.split()
            if not parts:
                continue
            try:
                _, cx, cy, w, h = (float(v) for v in parts[:5])
            except ValueError:
                problems["bad label line"] += 1
                continue
            if len(parts) != 5 or not all(0.0 <= v <= 1.0 for v in (cx, cy, w, h)):
                problems["bad label line"] += 1
                continue
            boxes.append((POTHOLE, cx, cy, w, h))
        lowered = str(image.relative_to(root)).lower()
        group = "val" if ("test" in lowered or "val" in lowered) else "train"
        items.append(Item("jaygala", group, image, boxes))
    return items


def select_rdd(items: list[Item], neg_ratio: float, min_neg: int, seed: int) -> list[Item]:
    by_country: dict[str, list[Item]] = defaultdict(list)
    for item in items:
        by_country[item.group].append(item)
    rng = random.Random(seed)
    chosen = []
    for country, group in sorted(by_country.items()):
        positives = [i for i in group if i.has_pothole]
        lookalike = [
            i for i in group if not i.has_pothole and any(b[0] in LOOKALIKES for b in i.boxes)
        ]
        plain = [
            i for i in group if not i.has_pothole and not any(b[0] in LOOKALIKES for b in i.boxes)
        ]
        want = max(min_neg, round(neg_ratio * len(positives)))
        # Up to half the pothole-free images show a manhole or a patch; the rest stay a
        # random draw of cracks and bare road.
        hard = rng.sample(lookalike, min(len(lookalike), want // 2))
        rest = rng.sample(plain, min(len(plain), want - len(hard)))
        chosen += positives + hard + rest
        print(
            f"  {country:16} {len(positives):5} with pothole, {len(hard):5} manhole/patch,"
            f" {len(rest):5} other",
            flush=True,
        )
    return chosen


def assign_splits(items: list[Item], val_share: float, seed: int) -> None:
    for item in items:
        if item.source == "jaygala" and item.group == "val":
            item.split = "val"
            continue
        # RDD names end in a sequential id ("Japan_000123"), jaygala's too ("img-105").
        digits = re.search(r"(\d+)$", item.image.stem)
        block = int(digits.group(1)) // BLOCK_IDS if digits else item.image.stem
        draw = random.Random(f"{seed}-{item.group}-{block}").random()
        item.split = "val" if draw < val_share else "train"


def write_one(job: tuple[str, str, str, list]) -> str:
    src, dst_image, dst_label, boxes = job
    with Image.open(src) as im:
        im = im.convert("RGB")
        im.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
        im.save(dst_image, quality=92)
    lines = [f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for c, x, y, w, h in boxes]
    Path(dst_label).write_text("\n".join(lines) + ("\n" if lines else ""))
    return dst_image


def contact_sheet(
    items: list[Item], out_dir: Path, dest: Path, seed: int, cls: int = POTHOLE, n: int = 96
) -> None:
    rng = random.Random(seed)
    boxes = [
        (item, box)
        for item in items
        if item.split == "train"
        for box in item.boxes
        if box[0] == cls
    ]
    sample = rng.sample(boxes, min(n, len(boxes)))
    tile, cols = 160, 12
    rows = (len(sample) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile, rows * (tile + 14)), "white")
    draw = ImageDraw.Draw(sheet)
    for k, (item, (_, cx, cy, w, h)) in enumerate(sample):
        with Image.open(out_dir / "images" / item.split / f"{item.out_name}.jpg") as im:
            W, H = im.size
            pad_w, pad_h = w * W * 0.3, h * H * 0.3
            crop = im.crop(
                (
                    max(0, (cx - w / 2) * W - pad_w),
                    max(0, (cy - h / 2) * H - pad_h),
                    min(W, (cx + w / 2) * W + pad_w),
                    min(H, (cy + h / 2) * H + pad_h),
                )
            )
            crop.thumbnail((tile, tile))
        x, y = (k % cols) * tile, (k // cols) * (tile + 14)
        sheet.paste(crop, (x, y))
        draw.text((x + 2, y + tile), f"{item.group[:12]} {item.image.stem[-6:]}", fill="black")
    sheet.save(dest, quality=88)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--work", type=Path, default=Path("/content/work"))
    parser.add_argument("--out", type=Path, default=Path("/content/data"))
    parser.add_argument(
        "--neg-ratio",
        type=float,
        default=1.0,
        help="Images without a pothole per image with one, per country",
    )
    parser.add_argument(
        "--min-neg",
        type=int,
        default=150,
        help="At least this many pothole-free images per country",
    )
    parser.add_argument("--val-share", type=float, default=0.12)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--skip-download", action="store_true", help="Archives are already extracted under --work"
    )
    args = parser.parse_args()

    args.work.mkdir(parents=True, exist_ok=True)
    rdd_root, jay_root = args.work / "rdd", args.work / "jaygala"
    if not args.skip_download:
        for url, archive, root in (
            (JAYGALA_URL, args.work / "jaygala.zip", jay_root),
            (RDD_URL, args.work / "rdd2022.zip", rdd_root),
        ):
            if (root / ".extracted").exists():
                continue
            fetch(url, archive)
            extract(archive, root)
            archive.unlink()  # RDD's is 13 GB the disk needs back

    unknown: Counter = Counter()
    rdd = rdd_items(rdd_root, unknown)
    print(f"RDD2022: {len(rdd)} labelled images; labels not used: {dict(unknown)}", flush=True)
    rdd = select_rdd(rdd, args.neg_ratio, args.min_neg, args.seed)
    problems: Counter = Counter()
    jay = jaygala_items(jay_root, problems)
    print(f"jaygala24: {len(jay)} images; problems: {dict(problems)}", flush=True)

    items = rdd + jay
    assign_splits(items, args.val_share, args.seed)

    jobs = []
    for split in ("train", "val"):
        (args.out / "images" / split).mkdir(parents=True, exist_ok=True)
        (args.out / "labels" / split).mkdir(parents=True, exist_ok=True)
    for item in items:
        jobs.append(
            (
                str(item.image),
                str(args.out / "images" / item.split / f"{item.out_name}.jpg"),
                str(args.out / "labels" / item.split / f"{item.out_name}.txt"),
                item.boxes,
            )
        )
    with Pool(os.cpu_count()) as pool:
        for done, _ in enumerate(pool.imap_unordered(write_one, jobs, chunksize=32), 1):
            if done % 2000 == 0:
                print(f"  wrote {done}/{len(jobs)}", flush=True)

    (args.out / "data.yaml").write_text(
        f"path: {args.out}\ntrain: images/train\nval: images/val\nnames:\n"
        + "".join(f"  {i}: {name}\n" for i, name in enumerate(CLASSES))
    )

    stats: dict = {"classes": CLASSES, "splits": {}}
    for split in ("train", "val"):
        chosen = [i for i in items if i.split == split]
        boxes = Counter(CLASSES[b[0]] for i in chosen for b in i.boxes)
        stats["splits"][split] = {
            "images": len(chosen),
            "images_with_pothole": sum(i.has_pothole for i in chosen),
            "images_without_pothole": sum(not i.has_pothole for i in chosen),
            "boxes": dict(boxes),
            "by_group": dict(Counter(f"{i.source}:{i.group}" for i in chosen)),
        }
    stats["unused_rdd_labels"] = dict(unknown)
    stats["jaygala_problems"] = dict(problems)
    (args.out / "stats.json").write_text(json.dumps(stats, indent=1))
    print(json.dumps(stats["splits"], indent=1), flush=True)

    for name in ("Pothole", "Manhole"):
        sheet = args.out / f"contact-{name.lower()}.jpg"
        contact_sheet(
            items,
            args.out,
            sheet,
            args.seed,
            cls=CLASSES.index(name),
            n=96 if name == "Pothole" else 48,
        )
        print(f"contact sheet: {sheet}", flush=True)


if __name__ == "__main__":
    main()
