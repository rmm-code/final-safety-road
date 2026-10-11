"""Scoring fresh predictions against already-judged clusters (`ai/evaluation/score_sets.py`).

A judged set is expensive: every cluster was labelled by hand or by blind judges. Re-running
a detector (another GPU, a new export, a fine-tuned model) must be scorable against it
without judging again, and must never hide a box that nobody judged.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

from ai.evaluation.pool_review import build_clusters
from ai.evaluation.score_sets import attach_predictions, evaluate

FRAMES = ["f_1.jpg", "f_2.jpg", "f_3.jpg"]


def _pred(*detections: tuple[float, float, float, float, float, str]) -> dict:
    return {"detections": [{"xyxy": list(d[:4]), "score": d[4], "label": d[5]} for d in detections]}


def _preds() -> dict[str, dict[str, dict]]:
    # Two models agree on one hole, one model sees a second, a crack and a box below the
    # pooling floor stay out of a pothole set, and one judged frame has nothing on it.
    return {
        "a": {
            "f_1.jpg": _pred(
                (10, 10, 50, 50, 0.80, "Pothole"),
                (200, 200, 240, 240, 0.30, "Pothole"),
                (100, 10, 180, 30, 0.90, "Crack"),
            ),
            "f_2.jpg": _pred((0, 0, 20, 20, 0.10, "Pothole")),
        },
        "b": {
            "f_1.jpg": _pred((12, 12, 52, 52, 0.60, "pothole")),
            "f_3.jpg": _pred(),
        },
    }


def _judged() -> list[dict]:
    return build_clusters(_preds(), FRAMES, pool_min=0.25, cluster_iou=0.5)


def test_reseating_the_predictions_a_set_was_built_from_reproduces_it() -> None:
    clusters = _judged()
    expected = copy.deepcopy(clusters)

    seated, unjudged = attach_predictions(clusters, _preds(), FRAMES, target="pothole")

    assert seated == expected
    assert unjudged == []


def test_a_box_between_two_clusters_joins_the_one_founded_first() -> None:
    # The first two boxes overlap too little to merge; the third overlaps both, the second
    # more. Pooling put it with the first, so seating must too, or a re-run would move a
    # judged box onto another cluster's verdict.
    preds = {
        "a": {"f_1.jpg": _pred((0, 0, 10, 10, 0.9, "Pothole"), (3, 0, 13, 10, 0.5, "Pothole"))},
        "b": {"f_1.jpg": _pred((4, 0, 14, 10, 0.7, "pothole"))},
    }
    clusters = build_clusters(preds, FRAMES, pool_min=0.25, cluster_iou=0.5)
    assert [[m["score"] for m in c["members"]] for c in clusters] == [[0.9, 0.5], [0.7]]

    seated, _ = attach_predictions(clusters, preds, FRAMES, target="pothole")

    assert [[m["score"] for m in c["members"]] for c in seated] == [[0.9, 0.5], [0.7]]


def test_fresh_predictions_replace_the_boxes_a_cluster_was_built_from() -> None:
    fresh = _preds()
    fresh["b"]["f_1.jpg"]["detections"][0]["score"] = 0.33  # same box, another GPU's score
    fresh["a"]["f_1.jpg"]["detections"][1]["score"] = 0.20  # now below the pooling floor

    seated, unjudged = attach_predictions(_judged(), fresh, FRAMES, target="pothole")

    assert [(m["model"], m["score"]) for m in seated[0]["members"]] == [("a", 0.80), ("b", 0.33)]
    assert seated[1]["members"] == []
    assert unjudged == []


def test_a_box_on_no_judged_cluster_is_returned_not_scored() -> None:
    fresh = _preds()
    fresh["b"]["f_1.jpg"]["detections"].append(
        {"xyxy": [400, 400, 440, 440], "score": 0.5, "label": "pothole"}
    )
    fresh["b"]["f_3.jpg"]["detections"].append(
        {"xyxy": [5, 5, 25, 25], "score": 0.4, "label": "pothole"}
    )

    seated, unjudged = attach_predictions(_judged(), fresh, FRAMES, target="pothole")

    assert [(u["image"], u["model"], u["score"]) for u in unjudged] == [
        ("f_1.jpg", "b", 0.5),
        ("f_3.jpg", "b", 0.4),
    ]
    assert sum(len(c["members"]) for c in seated) == 3


def test_frames_outside_the_judged_sample_are_ignored() -> None:
    fresh = _preds()
    fresh["a"]["f_9.jpg"] = _pred((0, 0, 30, 30, 0.9, "Pothole"))

    _, unjudged = attach_predictions(_judged(), fresh, FRAMES, target="pothole")

    assert unjudged == []


def test_scoring_from_a_predictions_folder_uses_the_fresh_boxes(tmp_path: Path) -> None:
    (tmp_path / "clusters.json").write_text(json.dumps(_judged()))
    (tmp_path / "verdicts.json").write_text(json.dumps({"verdicts": {"1": "pothole", "2": "not"}}))
    fresh = _preds()
    fresh["a"]["f_1.jpg"]["detections"][0]["score"] = 0.30  # the real hole drops below 0.35
    fresh["a"]["f_3.jpg"] = _pred((300, 300, 330, 330, 0.70, "Pothole"))  # nobody judged this
    clip = tmp_path / "preds" / "clip"
    clip.mkdir(parents=True)
    for model, by_image in fresh.items():
        rows = [{"image": image, **pred} for image, pred in by_image.items()]
        (clip / f"{model}.json").write_text(json.dumps(rows))
    config = {
        "detectors": [["a"]],
        "sets": [
            {
                "name": "clip",
                "target": "pothole",
                "clusters": str(tmp_path / "clusters.json"),
                "verdicts": str(tmp_path / "verdicts.json"),
                "frames": FRAMES,
            }
        ],
    }

    frozen = {(r["mode"], r["threshold"]): r for r in evaluate(config)}
    fresh_rows = {
        (r["mode"], r["threshold"]): r for r in evaluate(config, preds_root=tmp_path / "preds")
    }

    assert frozen[("strict", 0.35)]["counts"]["tp_boxes"] == 1
    assert fresh_rows[("strict", 0.35)]["counts"]["tp_boxes"] == 0
    assert fresh_rows[("strict", 0.35)]["unjudged_boxes"] == 1
    assert "unjudged_boxes" not in frozen[("strict", 0.35)]
