"""Pool the boxes new models drew on no judged cluster, so blind judges can label them.

    .venv/bin/python -m ai.yolo26.pool_unjudged build \\
        --configs ai/yolo26/sets-yolo26.json ai/yolo26/sets-smooth.json \\
        --preds-root output/yolo26/preds --models yolo26m_public_e16 \\
        --out output/yolo26/judging-supp [--existing-root DIR] [--save-dir DIR]
    .venv/bin/python -m ai.yolo26.pool_unjudged merge-verdicts --supp output/yolo26/judging-supp \\
        --judge-a A1.json [A2.json ...] --judge-b B1.json [B2.json ...]

`score_sets --preds-root` seats a model's boxes on the judged clusters they overlap and counts
the rest as unjudged, never scoring them. `build` finds exactly those boxes, with score_sets' own
seating rule (`attach_predictions`) against the original clusters plus any earlier
supplementary round, clusters them per frame as `pool_review` does, and draws blind sheets and
overviews in the format the frame-level judges saw. Ids continue after the highest id already
in that set, so merged files never collide. It writes, under --out:

    <set>/supp.clusters.json             the new clusters; members name model and score
    <set>/sheets/sheet_NN.jpg            blind crop tiles labelled "#<id> f_<frame>"
    <set>/overview/<frame>.jpg           frames holding a new cluster, its boxes numbered
    merged/<set>-<target>.clusters.json  the earlier clusters followed by the new ones
    chunks.json                          judging chunks of at most --chunk-size clusters
    brief.txt, briefs/chunk-NN-{A,B}.txt the judge brief template and each chunk's briefs
    build.json                           everything merge-verdicts needs

`merge-verdicts` reads each judge's answers, {"<set>": {"<id>": "pothole"|"not"|"unsure"}}, from
one file per chunk, combines them as every earlier consensus was (agree -> label, disagree ->
"unsure"), appends them to the earlier consensus as merged/<set>-<target>.consensus.json, and
writes each config again pointing at the merged files (sets-merged.json, smooth-merged.json),
with every judged model added as a detector. A detector without predictions under --preds-root
is left out of those configs, and named, because score_sets refuses to run without them.

A later round for more models passes this --out as --existing-root and a new --out. Its
verdicts are merged after this round's, which they extend.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from string import Template

from ai.evaluation.pool_review import (
    CLUSTER_IOU,
    POOL_MIN,
    build_clusters,
    draw_overviews,
    draw_sheets,
)
from ai.evaluation.score_sets import _load_preds, attach_predictions

PER_SHEET = 20  # tiles per sheet, as in every earlier review
CHUNK_SIZE = 40
VERDICTS = frozenset({"pothole", "not", "unsure"})
BRIEF_TEMPLATE = Path(__file__).with_name("judge_brief.txt")
MERGED_CONFIG_NAMES = {"sets-yolo26": "sets-merged", "sets-smooth": "smooth-merged"}
SET_DESCRIPTIONS = {
    "video-1": "A short residential lane, partly patched asphalt.",
    "video-2": (
        "A side road along a large building with a worn, patched surface (first ~8 s), then a "
        "parking lot (about 7–20 s), a road between buildings (20–26 s) and an open area by "
        "refuse containers (26–32 s)."
    ),
    "video-3": "Residential streets; in parts rain drops sit on the windscreen.",
    "video-4": "A phone clip of a badly broken road filmed in portrait (many water-filled holes).",
    "dashcam-0939": "Smooth city roads, Tashkent dashcam, 2 frames per second.",
    "dashcam-1215": "Smooth city roads, Tashkent dashcam, 2 frames per second.",
}
NUMBER_WORDS = ("One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten")


def cluster_unjudged(
    unjudged: list[dict], images: list[str], *, target: str, first_id: int, pool_min: float
) -> list[dict]:
    """Cluster unjudged boxes per frame by pool_review's rule, numbering from `first_id`."""
    preds: dict[str, dict[str, dict]] = {}
    for box in unjudged:
        frame = preds.setdefault(box["model"], {}).setdefault(box["image"], {"detections": []})
        frame["detections"].append({"xyxy": box["xyxy"], "score": box["score"], "label": target})
    clusters = build_clusters(
        preds, images, pool_min=pool_min, cluster_iou=CLUSTER_IOU, target=target
    )
    for cluster in clusters:
        cluster["id"] += first_id - 1
    return clusters


def _sheets(clusters: list[dict], folder: Path) -> list[dict]:
    """The sheets draw_sheets wrote for `clusters`, with the id range on each."""
    sheets = []
    for start in range(0, len(clusters), PER_SHEET):
        ids = [c["id"] for c in clusters[start : start + PER_SHEET]]
        path = folder / f"sheet_{start // PER_SHEET + 1:02d}.jpg"
        sheets.append(
            {"sheet": str(path.resolve()), "ids": [ids[0], ids[-1]], "clusters": len(ids)}
        )
    return sheets


def make_chunks(sets: list[dict], size: int) -> list[dict]:
    """Whole sheets, in order, packed into chunks of at most `size` clusters."""
    packed: list[list[tuple[dict, dict]]] = []
    count = 0
    for s in sets:
        for sheet in s["sheets"]:
            if not packed or count + sheet["clusters"] > size:
                packed.append([])
                count = 0
            packed[-1].append((s, sheet))
            count += sheet["clusters"]
    chunks = []
    for n, items in enumerate(packed, start=1):
        parts: list[dict] = []
        for s, sheet in items:
            if parts and parts[-1]["set"] == s["name"]:
                part = parts[-1]
                part["sheets"].append(sheet["sheet"])
                part["ids"][1] = sheet["ids"][1]
                part["clusters"] += sheet["clusters"]
            else:
                parts.append(
                    {
                        "set": s["name"],
                        "sheets": [sheet["sheet"]],
                        "overview": s["overview"],
                        "ids": list(sheet["ids"]),
                        "clusters": sheet["clusters"],
                    }
                )
        chunks.append({"chunk": n, "clusters": sum(p["clusters"] for p in parts), "parts": parts})
    return chunks


def _brief_sections() -> dict[str, str]:
    text = BRIEF_TEMPLATE.read_text()
    _, a = text.split("=== JUDGE A ===\n", 1)
    a, b = a.split("=== JUDGE B ===\n", 1)
    return {"A": a, "B": b}


def render_briefs(chunks: list[dict], root: Path, save_dir: Path | None) -> dict[str, str]:
    """Fill the brief template for every chunk and judge: {"chunk-NN-A": text, ...}."""
    sections = _brief_sections()
    briefs = {}
    for chunk in chunks:
        parts = chunk["parts"]
        lines = []
        for n, p in enumerate(parts, start=1):
            sheets = ", ".join(str(Path(s).relative_to(root)) for s in p["sheets"])
            lines.append(
                f"{n}. {p['set']} — {p['clusters']} clusters (#{p['ids'][0]} to #{p['ids'][1]}),"
                f" {sheets}. {SET_DESCRIPTIONS.get(p['set'], '')}".rstrip()
            )
        count = len(parts)
        word = NUMBER_WORDS[count - 1] if count <= len(NUMBER_WORDS) else str(count)
        first = parts[0]
        example = [
            f'"{first["set"]}": {{"{first["ids"][0]}": "pothole", "{first["ids"][0] + 1}"'
            ': "not", ...}'
        ]
        example += [f'"{p["set"]}": {{...}}' for p in parts[1:]]
        if count > 1:
            order = (
                f"work through the sets in this order: {', '.join(map(str, range(count, 0, -1)))},"
                " and within each set go from the LAST sheet to the first"
            )
        else:
            order = "go from the LAST sheet to the first"
        for judge, template in sections.items():
            name = f"chunk-{chunk['chunk']:02d}-{judge}"
            save = (
                f"You may try to save your JSON to {save_dir / f'supp-{name}.json'} "
                "(if writing is blocked, that is fine). "
                if save_dir
                else ""
            )
            briefs[name] = Template(template).substitute(
                root=root,
                set_count=f"{word} set{'s' if count > 1 else ''}",
                sets="\n".join(lines),
                totals=", ".join(str(p["clusters"]) for p in parts),
                ranges=", ".join(f"{p['set']} #{p['ids'][0]}..#{p['ids'][1]}" for p in parts),
                json_example="{" + ", ".join(example) + "}",
                order=order,
                save=save,
            )
    return briefs


def build(
    configs: list[Path],
    preds_root: Path,
    models: list[str],
    out: Path,
    *,
    threshold: float = POOL_MIN,
    existing_root: Path | None = None,
    chunk_size: int = CHUNK_SIZE,
    save_dir: Path | None = None,
) -> dict:
    if existing_root is not None and existing_root.resolve() == out.resolve():
        raise SystemExit("--out must be a new folder, not --existing-root")
    if threshold != POOL_MIN:
        print(
            f"warning: score_sets seats boxes from {POOL_MIN}; at --threshold {threshold} its "
            f"unjudged counts at {POOL_MIN} will not reach zero",
            file=sys.stderr,
        )
    previous = json.loads((existing_root / "build.json").read_text()) if existing_root else None
    out.mkdir(parents=True, exist_ok=True)
    (out / "merged").mkdir(exist_ok=True)

    manifest_sets: list[dict] = []
    manifest_configs = []
    for config_path in configs:
        config = json.loads(config_path.read_text())
        merged_name = MERGED_CONFIG_NAMES.get(config_path.stem, f"{config_path.stem}-merged")
        manifest_configs.append({"path": str(config_path), "merged": f"{merged_name}.json"})
        for s in config["sets"]:
            key = f"{s['name']}-{s['target']}"
            if any(m["key"] == key for m in manifest_sets):
                raise SystemExit(f"{key} appears in more than one config")
            if existing_root is not None:
                base_clusters = existing_root / "merged" / f"{key}.clusters.json"
                base_verdicts = existing_root / "merged" / f"{key}.consensus.json"
            else:
                base_clusters, base_verdicts = Path(s["clusters"]), Path(s["verdicts"])
            base = json.loads(base_clusters.read_text())
            frames = list(s["frames"])
            preds = _load_preds(preds_root / s["name"], models)
            _, unjudged = attach_predictions(
                base, preds, frames, target=s["target"], pool_min=threshold
            )
            first_id = max((c["id"] for c in base), default=0) + 1
            supp = cluster_unjudged(
                unjudged, frames, target=s["target"], first_id=first_id, pool_min=threshold
            )

            set_dir = out / s["name"]
            for sub in ("sheets", "overview"):
                shutil.rmtree(set_dir / sub, ignore_errors=True)
            frames_dir = Path(s["framesDir"])
            draw_sheets(supp, frames_dir, set_dir / "sheets", per_sheet=PER_SHEET, blind=True)
            judged = {c["image"] for c in supp}
            draw_overviews(
                supp, frames_dir, [f for f in frames if f in judged], set_dir / "overview"
            )
            (set_dir / "supp.clusters.json").write_text(json.dumps(supp, indent=1))
            merged_clusters = out / "merged" / f"{key}.clusters.json"
            merged_clusters.write_text(json.dumps(base + supp, indent=1))

            manifest_sets.append(
                {
                    "key": key,
                    "name": s["name"],
                    "target": s["target"],
                    "unjudged_boxes": len(unjudged),
                    "clusters": len(supp),
                    "ids": [supp[0]["id"], supp[-1]["id"]] if supp else None,
                    "base_clusters": str(base_clusters),
                    "base_verdicts": str(base_verdicts),
                    "supp_clusters": str(set_dir / "supp.clusters.json"),
                    "merged_clusters": str(merged_clusters),
                    "merged_verdicts": str(out / "merged" / f"{key}.consensus.json"),
                    "overview": str((set_dir / "overview").resolve()),
                    "sheets": _sheets(supp, set_dir / "sheets"),
                }
            )

    chunks = make_chunks(manifest_sets, chunk_size)
    (out / "chunks.json").write_text(json.dumps(chunks, indent=1))
    shutil.copyfile(BRIEF_TEMPLATE, out / "brief.txt")
    shutil.rmtree(out / "briefs", ignore_errors=True)
    (out / "briefs").mkdir()
    for name, text in render_briefs(chunks, out.resolve(), save_dir).items():
        (out / "briefs" / f"{name}.txt").write_text(text)

    earlier = previous["all_models"] if previous else []
    manifest = {
        "models": models,
        "all_models": earlier + [m for m in models if m not in earlier],
        "threshold": threshold,
        "preds_root": str(preds_root),
        "existing_root": str(existing_root) if existing_root else None,
        "configs": manifest_configs,
        "sets": manifest_sets,
    }
    (out / "build.json").write_text(json.dumps(manifest, indent=1))
    for s in manifest_sets:
        ids = f"#{s['ids'][0]}..#{s['ids'][1]}" if s["ids"] else "-"
        print(
            f"{s['key']:22} {s['unjudged_boxes']:4} unjudged boxes -> {s['clusters']:3} clusters"
            f" {ids:12} {len(s['sheets'])} sheets"
        )
    for chunk in chunks:
        where = ", ".join(f"{p['set']} #{p['ids'][0]}..#{p['ids'][1]}" for p in chunk["parts"])
        print(f"chunk {chunk['chunk']:02d}: {chunk['clusters']:3} clusters  {where}")
    return manifest


def _read_judge(paths: list[Path], sets: list[dict]) -> dict[str, dict[str, str]]:
    """One judge's verdicts from one file per chunk, keyed by set name then id."""
    names = {s["name"]: s["name"] for s in sets} | {s["key"]: s["name"] for s in sets}
    verdicts: dict[str, dict[str, str]] = {s["name"]: {} for s in sets}
    for path in paths:
        for set_key, answers in json.loads(path.read_text()).items():
            if set_key not in names:
                raise SystemExit(f"{path}: unknown set {set_key!r}")
            seen = verdicts[names[set_key]]
            for cid, verdict in answers.items():
                value = str(verdict).strip().lower()
                if value not in VERDICTS:
                    raise SystemExit(f"{path}: {set_key} #{cid}: {verdict!r} is not a verdict")
                if seen.get(str(cid), value) != value:
                    raise SystemExit(f"{path}: {set_key} #{cid} answered twice, differently")
                seen[str(cid)] = value
    return verdicts


def merge_verdicts(supp: Path, judge_a: list[Path], judge_b: list[Path]) -> None:
    manifest = json.loads((supp / "build.json").read_text())
    sets = manifest["sets"]
    answers = {"A": _read_judge(judge_a, sets), "B": _read_judge(judge_b, sets)}
    for s in sets:
        ids = [str(i) for i in range(s["ids"][0], s["ids"][1] + 1)] if s["ids"] else []
        for judge, by_set in answers.items():
            got = set(by_set[s["name"]])
            if missing := [i for i in ids if i not in got]:
                raise SystemExit(f"judge {judge}, {s['name']}: no verdict for {missing}")
            if extra := sorted(got - set(ids), key=int):
                raise SystemExit(f"judge {judge}, {s['name']}: ids {extra} are not in this round")

    for s in sets:
        base_path = Path(s["base_verdicts"])
        if not base_path.exists():
            raise SystemExit(f"{base_path} is missing: merge the earlier round's verdicts first")
        base = json.loads(base_path.read_text())
        ids = [str(i) for i in range(s["ids"][0], s["ids"][1] + 1)] if s["ids"] else []
        if clash := [i for i in ids if i in base["verdicts"]]:
            raise SystemExit(f"{s['name']}: ids {clash} are already judged in {base_path}")
        a = {i: answers["A"][s["name"]][i] for i in ids}
        b = {i: answers["B"][s["name"]][i] for i in ids}
        new = {i: a[i] if a[i] == b[i] else "unsure" for i in ids}
        rule = base["rule"]
        Path(s["supp_clusters"]).with_name("supp.consensus.json").write_text(
            json.dumps({"rule": rule, "judges": {"A": a, "B": b}, "verdicts": new}, indent=1)
        )
        judges = base.get("judges", {})
        merged = {
            "rule": rule,
            "judges": {"A": {**judges.get("A", {}), **a}, "B": {**judges.get("B", {}), **b}},
            "verdicts": {**base["verdicts"], **new},
        }
        Path(s["merged_verdicts"]).write_text(json.dumps(merged, indent=1))
        labels = {v: list(new.values()).count(v) for v in sorted(VERDICTS)}
        print(f"{s['key']:22} {len(ids):3} new verdicts {labels}")

    by_key = {s["key"]: s for s in sets}
    preds_root = Path(manifest["preds_root"])
    for entry in manifest["configs"]:
        config = json.loads(Path(entry["path"]).read_text())
        for s in config["sets"]:
            merged_set = by_key[f"{s['name']}-{s['target']}"]
            s["clusters"] = merged_set["merged_clusters"]
            s["verdicts"] = merged_set["merged_verdicts"]
        detectors = list(config["detectors"])
        detectors += [[m] for m in manifest["all_models"] if [m] not in detectors]
        kept = []
        for members in detectors:
            missing = [
                f"{s['name']}/{m}.json"
                for s in config["sets"]
                for m in members
                if not (preds_root / s["name"] / f"{m}.json").exists()
            ]
            if missing:
                print(
                    f"{entry['merged']}: left out {'+'.join(members)}, no predictions under "
                    f"{preds_root}: {', '.join(missing)}",
                    file=sys.stderr,
                )
            else:
                kept.append(members)
        config["detectors"] = kept
        (supp / entry["merged"]).write_text(json.dumps(config, indent=1))
        print(f"-> {supp / entry['merged']}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="pool the unjudged boxes and draw blind judging material")
    b.add_argument("--configs", required=True, nargs="+", type=Path)
    b.add_argument("--preds-root", required=True, type=Path)
    b.add_argument("--models", required=True, nargs="+")
    b.add_argument("--threshold", type=float, default=POOL_MIN)
    b.add_argument("--existing-root", type=Path, help="an earlier round's --out, to extend")
    b.add_argument("--out", required=True, type=Path)
    b.add_argument("--chunk-size", type=int, default=CHUNK_SIZE)
    b.add_argument("--save-dir", type=Path, help="where the briefs invite judges to save JSON")

    m = sub.add_parser("merge-verdicts", help="combine judges A and B into merged consensus")
    m.add_argument("--supp", required=True, type=Path, help="the build's --out")
    m.add_argument("--judge-a", required=True, nargs="+", type=Path)
    m.add_argument("--judge-b", required=True, nargs="+", type=Path)

    args = parser.parse_args(argv)
    if args.command == "build":
        build(
            args.configs,
            args.preds_root,
            args.models,
            args.out,
            threshold=args.threshold,
            existing_root=args.existing_root,
            chunk_size=args.chunk_size,
            save_dir=args.save_dir,
        )
    else:
        merge_verdicts(args.supp, args.judge_a, args.judge_b)


if __name__ == "__main__":
    main()
