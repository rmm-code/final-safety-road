"""The image scorer that ranks candidate detectors on /models."""

from __future__ import annotations

from pathlib import Path

import pytest

from ai.evaluation.score_images import evaluate


def write_labels(directory: Path, labels: dict[str, str]) -> Path:
    for stem, text in labels.items():
        (directory / f"{stem}.txt").write_text(text)
    return directory


def image(name: str, *detections: tuple[list[float], float, str]) -> dict:
    return {
        "image": f"{name}.jpg",
        "width": 100,
        "height": 100,
        "inference_ms": 1.0,
        "detections": [
            {"xyxy": box, "score": score, "label": label} for box, score, label in detections
        ],
    }


@pytest.fixture
def labels(tmp_path: Path) -> Path:
    # One pothole in the middle of "a", none in "b".
    return write_labels(tmp_path, {"a": "0 0.5 0.5 0.2 0.2\n", "b": ""})


def test_a_perfect_detector_scores_one(labels: Path) -> None:
    result = evaluate([image("a", ([40, 40, 60, 60], 0.9, "Pothole")), image("b")], labels, {0})

    assert result["ap50"] == 1.0
    assert result["operating_points"][1] == {
        "threshold": 0.35,
        "precision": 1.0,
        "recall": 1.0,
        "f1": 1.0,
        "false_alarms_on_clean_images": 0,
    }


def test_other_classes_are_not_counted(labels: Path) -> None:
    """A crack or a lorry is not a pothole, however confident - the product's name rule."""
    result = evaluate([image("a", ([40, 40, 60, 60], 0.99, "Crack"))], labels, {0})

    assert result["ap50"] == 0.0
    assert result["operating_points"][1]["recall"] == 0.0


def test_the_rdd_class_name_counts_as_a_pothole(labels: Path) -> None:
    result = evaluate([image("a", ([40, 40, 60, 60], 0.9, "D40"))], labels, {0})

    assert result["ap50"] == 1.0


def test_a_box_on_a_clean_image_is_a_false_alarm(labels: Path) -> None:
    result = evaluate([image("b", ([5, 5, 15, 15], 0.8, "pothole"))], labels, {0})

    assert result["operating_points"][1]["false_alarms_on_clean_images"] == 1
    assert result["operating_points"][1]["precision"] == 0.0


def test_a_detection_on_an_unlabelled_real_pothole_is_ignored(labels: Path) -> None:
    """Labels that dropped a small real pothole must not punish the model that found it."""
    result = evaluate(
        [image("b", ([5, 5, 15, 15], 0.8, "pothole"))],
        labels,
        {0},
        ignore={"b": [[0, 0, 20, 20, 400]]},
    )

    assert result["ignored_detections"] == 1
    assert result["operating_points"][1]["false_alarms_on_clean_images"] == 0


def test_a_loose_box_does_not_count(labels: Path) -> None:
    """IoU 0.5 or better: a box twice the pothole's size in each direction misses."""
    result = evaluate([image("a", ([30, 30, 70, 70], 0.9, "pothole"))], labels, {0})

    assert result["operating_points"][1]["recall"] == 0.0
