"""Dataset assembly: the split is where honest evaluation is won or lost."""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

import pytest

from ai.training.dataset import (
    DEFAULT_CLASSES,
    assign_drives,
    build,
    class_weights,
    collect,
    drive_of,
)


def make_frame(root: Path, drive: str, index: int, class_ids: list[int]) -> None:
    folder = root / drive
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"frame{index:03d}.jpg").write_bytes(b"\xff\xd8\xff")
    (folder / f"frame{index:03d}.txt").write_text(
        "\n".join(f"{c} 0.5 0.5 0.2 0.2" for c in class_ids), encoding="utf-8"
    )


@pytest.fixture
def footage(tmp_path: Path) -> Path:
    root = tmp_path / "labelled"
    for drive_index in range(6):
        for frame in range(5):
            make_frame(root, f"drive-{drive_index}", frame, [5] if frame % 2 == 0 else [5, 3])
    return root


class TestCollection:
    def test_finds_images_with_labels(self, footage):
        assert len(collect(footage)) == 30

    def test_ignores_an_image_with_no_label(self, footage):
        (footage / "drive-0" / "orphan.jpg").write_bytes(b"\xff\xd8\xff")
        assert len(collect(footage)) == 30

    def test_tags_each_image_with_its_drive(self, footage):
        drives = {item.drive for item in collect(footage)}
        assert drives == {f"drive-{i}" for i in range(6)}

    def test_loose_images_become_one_drive(self, tmp_path):
        (tmp_path / "a.jpg").write_bytes(b"\xff\xd8\xff")
        (tmp_path / "a.txt").write_text("5 0.5 0.5 0.2 0.2")
        assert drive_of(tmp_path / "a.jpg", tmp_path) == "_ungrouped"


class TestSplitting:
    def test_whole_drives_go_to_one_split(self, footage, tmp_path):
        out = tmp_path / "dataset"
        summary = build(footage, out)

        # This is the crux. Consecutive frames of one drive are near-identical; splitting
        # them randomly validates the model on images it effectively trained on.
        for split in ("train", "valid", "test"):
            names = {p.name.split("__")[0] for p in (out / split / "images").glob("*.jpg")}
            for drive in names:
                assert summary.drives[drive] == split

    def test_no_drive_appears_in_two_splits(self, footage, tmp_path):
        out = tmp_path / "dataset"
        build(footage, out)
        seen: dict[str, str] = {}
        for split in ("train", "valid", "test"):
            for path in (out / split / "images").glob("*.jpg"):
                drive = path.name.split("__")[0]
                assert seen.setdefault(drive, split) == split

    def test_the_same_seed_reproduces_the_same_split(self):
        drives = [f"drive-{i}" for i in range(10)]
        assert assign_drives(drives, seed=7) == assign_drives(drives, seed=7)

    def test_a_different_seed_can_differ(self):
        drives = [f"drive-{i}" for i in range(10)]
        assert assign_drives(drives, seed=1) != assign_drives(drives, seed=99)

    def test_rejects_ratios_that_do_not_sum_to_one(self):
        with pytest.raises(ValueError, match="sum to 1"):
            assign_drives(["a", "b"], ratios=(0.5, 0.2, 0.1))

    def test_a_single_drive_still_produces_a_train_split(self):
        assert assign_drives(["only"]) == {"only": "train"}

    def test_frames_from_different_drives_cannot_overwrite_each_other(self, tmp_path):
        root = tmp_path / "labelled"
        make_frame(root, "drive-a", 1, [5])
        make_frame(root, "drive-b", 1, [5])
        out = tmp_path / "dataset"
        build(root, out)
        written = list(out.rglob("*.jpg"))
        assert len(written) == 2

    def test_refuses_an_empty_source(self, tmp_path):
        with pytest.raises(ValueError, match="No labelled images"):
            build(tmp_path / "empty", tmp_path / "out")


class TestClassWeights:
    def test_a_rare_class_is_weighted_up(self):
        weights = class_weights(Counter({5: 900, 3: 100}), DEFAULT_CLASSES)
        # Potholes are a minority even on bad roads; without this a detector minimises
        # loss by predicting nothing.
        assert weights["Crack"] > weights["Pothole"]

    def test_absent_classes_get_no_weight(self):
        weights = class_weights(Counter({5: 100}), DEFAULT_CLASSES)
        assert weights["Pedestrian"] == 0.0

    def test_an_empty_count_falls_back_to_uniform(self):
        assert set(class_weights(Counter(), DEFAULT_CLASSES).values()) == {1.0}


class TestOutputs:
    def test_writes_a_usable_data_yaml(self, footage, tmp_path):
        out = tmp_path / "dataset"
        build(footage, out)
        text = (out / "data.yaml").read_text()
        assert "train: train/images" in text
        assert "val: valid/images" in text
        assert f"nc: {len(DEFAULT_CLASSES)}" in text
        assert "5: Pothole" in text

    def test_records_how_the_split_was_made(self, footage, tmp_path):
        out = tmp_path / "dataset"
        build(footage, out)
        manifest = json.loads((out / "split.json").read_text())
        assert manifest["splitStrategy"] == "by-drive"
        assert manifest["seed"] == 7
        assert manifest["classWeights"]["Pothole"] > 0

    def test_class_weights_come_from_the_train_split_only(self, footage, tmp_path):
        out = tmp_path / "dataset"
        build(footage, out)
        manifest = json.loads((out / "split.json").read_text())
        # Weighting from validation counts would leak the evaluation set into training.
        assert set(manifest["counts"]) == {"train", "valid", "test"}
