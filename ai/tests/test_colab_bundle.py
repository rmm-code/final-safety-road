"""Packing a Colab run into one zip (`ai/colab/build_bundle.py`)."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from ai.colab.build_bundle import build


def _write(path: Path, text: str = "x") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _repo(root: Path) -> Path:
    for name in ("ai/__init__.py", "ai/evaluation/score_sets.py", "ai/__pycache__/a.pyc"):
        _write(root / name)
    _write(root / "ai/tests/test_a.py")
    _write(root / "ai/.DS_Store")
    _write(root / "models/m.pt")
    _write(root / "out/clip/frames/f_0001.jpg")
    _write(root / "out/clip/preds/m.json", "[]")
    _write(root / "pooled/clip.clusters.json", "[]")
    _write(root / "pooled/clip.consensus.json", '{"verdicts": {}}')
    _write(root / "pooled/scores.json", "[]")
    _write(
        root / "pooled/sets.json",
        json.dumps(
            {
                "detectors": [["m"]],
                "sets": [
                    {
                        "name": "clip",
                        "target": "pothole",
                        "clusters": "pooled/clip.clusters.json",
                        "verdicts": "pooled/clip.consensus.json",
                        "frames": ["f_0001.jpg"],
                    }
                ],
            }
        ),
    )
    manifest = {
        "models": {"m": "models/m.pt"},
        "clips": {"clip": {"frames": "out/clip/frames", "macPreds": "out/clip/preds"}},
        "scoring": {"config": "pooled/sets.json", "macScores": "pooled/scores.json"},
        "summary": [["pothole", "m", 0.35]],
    }
    _write(root / "manifest.json", json.dumps(manifest))
    return root / "manifest.json"


def test_packs_what_the_manifest_names_and_the_manifest_itself(tmp_path: Path) -> None:
    manifest = _repo(tmp_path)

    build(manifest, tmp_path / "bundle.zip", root=tmp_path)

    names = set(zipfile.ZipFile(tmp_path / "bundle.zip").namelist())
    assert {
        "colab_bundle.json",
        "ai/__init__.py",
        "ai/evaluation/score_sets.py",
        "models/m.pt",
        "out/clip/frames/f_0001.jpg",
        "out/clip/preds/m.json",
        "pooled/sets.json",
        "pooled/clip.clusters.json",
        "pooled/clip.consensus.json",
        "pooled/scores.json",
    } <= names
    bundled = json.loads(zipfile.ZipFile(tmp_path / "bundle.zip").read("colab_bundle.json"))
    assert bundled["models"] == {"m": "models/m.pt"}


def test_leaves_out_caches_tests_and_finder_files(tmp_path: Path) -> None:
    manifest = _repo(tmp_path)

    build(manifest, tmp_path / "bundle.zip", root=tmp_path)

    names = zipfile.ZipFile(tmp_path / "bundle.zip").namelist()
    assert not [n for n in names if "__pycache__" in n or n.startswith("ai/tests/")]
    assert not [n for n in names if n.endswith(".DS_Store")]


def test_refuses_to_pack_a_bundle_with_a_missing_file(tmp_path: Path) -> None:
    manifest = _repo(tmp_path)
    (tmp_path / "models/m.pt").unlink()

    with pytest.raises(SystemExit, match="models/m.pt"):
        build(manifest, tmp_path / "bundle.zip", root=tmp_path)
    assert not (tmp_path / "bundle.zip").exists()
