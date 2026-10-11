"""Pack what a Colab run needs into one zip.

    python -m ai.colab.build_bundle ai/colab/bundles/videos.json \\
        output/colab/pothole-colab-videos.zip

The manifest names the models, the clips (their frames and the Mac's predictions) and the
judged reference to score against. Everything it names, plus the `ai/` code, goes into the
zip, and the manifest itself goes in as `colab_bundle.json`, which
`model_comparison_t4.ipynb` reads. Paths are relative to the repository root.
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

# Already compressed: deflating them again costs time and saves nothing. Model weights do
# shrink (by about 7%), and the zip goes up over the user's uplink, so they are deflated.
STORED_SUFFIXES = {".jpg", ".jpeg", ".png"}


def _skipped(relative: Path) -> bool:
    return (
        "__pycache__" in relative.parts
        or relative.parts[:2] == ("ai", "tests")
        or relative.name == ".DS_Store"
    )


def bundle_files(manifest: dict, root: Path) -> list[Path]:
    """Every file the run needs, relative to `root`."""
    files = {p.relative_to(root) for p in (root / "ai").rglob("*") if p.is_file()}
    files |= {Path(path) for path in manifest["models"].values()}
    for clip in manifest["clips"].values():
        for folder in (clip["frames"], clip["macPreds"]):
            files |= {p.relative_to(root) for p in (root / folder).iterdir() if p.is_file()}
    scoring = manifest["scoring"]
    files |= {Path(scoring["config"]), Path(scoring["macScores"])}
    config_path = root / scoring["config"]
    if config_path.exists():
        for judged in json.loads(config_path.read_text())["sets"]:
            files |= {Path(judged["clusters"]), Path(judged["verdicts"])}
    return sorted(f for f in files if not _skipped(f))


def build(manifest_path: Path, out: Path, root: Path = Path(".")) -> int:
    manifest = json.loads(manifest_path.read_text())
    files = bundle_files(manifest, root)
    missing = [f.as_posix() for f in files if not (root / f).is_file()]
    if missing:
        raise SystemExit(f"Not packed, {len(missing)} file(s) missing: {', '.join(missing[:5])}")
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w") as bundle:
        for f in files:
            stored = f.suffix.lower() in STORED_SUFFIXES
            bundle.write(
                root / f,
                f.as_posix(),
                compress_type=zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED,
            )
        bundle.writestr("colab_bundle.json", json.dumps(manifest, indent=1))
    return len(files)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.colab.build_bundle")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("out", type=Path)
    args = parser.parse_args(argv)
    count = build(args.manifest, args.out)
    size_mb = args.out.stat().st_size / 1e6
    print(f"{count} files, {size_mb:.0f} MB -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
