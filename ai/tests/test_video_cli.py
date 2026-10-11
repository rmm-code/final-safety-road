"""End-to-end run of `python -m ai.inference.video` over a generated clip."""

from __future__ import annotations

import json
import math

import pytest

from ai.inference.video import main, parse_args, run


class TestArguments:
    def test_requires_an_input(self):
        with pytest.raises(SystemExit):
            parse_args([])

    def test_defaults_to_auto_layout_and_no_model(self, tmp_path):
        args = parse_args(["--input", str(tmp_path / "clip.mp4")])
        assert args.layout == "auto"
        assert args.model is None


class TestRun:
    def test_reports_unique_potholes_and_writes_both_outputs(self, synthetic_video, tmp_path):
        output = tmp_path / "annotated.mp4"
        outcome = run(["--input", str(synthetic_video), "--output", str(output), "--quiet"])

        assert output.exists() and output.stat().st_size > 0
        assert outcome.json_path == tmp_path / "detections.json"
        assert outcome.json_path.exists()

        report = json.loads(outcome.json_path.read_text(encoding="utf-8"))
        assert report["schemaVersion"] == 1
        assert report["source"]["name"] == synthetic_video.name
        assert report["source"]["width"] == 320
        assert report["summary"]["totalPotholes"] == len(report["tracks"])
        assert report["summary"]["totalPotholes"] > 0

        # Tracking must collapse many frame detections into far fewer potholes.
        assert report["analysis"]["rawDetections"] > report["summary"]["totalPotholes"]

    def test_analysis_block_matches_the_browser_schema(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        # Same keys as VideoAnalysisReport["analysis"] in packages/shared-types, so a
        # report from either implementation can be read by the same consumer.
        assert set(outcome.report["analysis"]) == {
            "sampleFps",
            "framesAnalysed",
            "confidenceThreshold",
            "iouMatchThreshold",
            "minObservations",
            "rawDetections",
            "rejectedTracks",
            "otherClasses",
        }

    def test_samples_only_frames_that_exist(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        analysis = outcome.report["analysis"]
        duration = outcome.report["source"]["durationSeconds"]
        # There is no frame at exactly `duration`; the browser uses the same bound.
        assert analysis["framesAnalysed"] == math.ceil(duration * analysis["sampleFps"])

    def test_marks_a_synthetic_run_in_the_report(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        engine = outcome.report["engine"]
        assert engine["isSynthetic"] is True
        assert engine["modelVersion"].startswith("mock-")
        assert "synthetic" in engine["selectionReason"].lower()

    def test_never_invents_coordinates(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        assert outcome.report["location"] == {
            "available": False,
            "reason": (
                "Uploaded video files carry no GPS telemetry. Coordinates are recorded only "
                "for live drive sessions."
            ),
        }
        assert "latitude" not in json.dumps(outcome.report)

    def test_tracks_carry_the_documented_fields(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        track = outcome.report["tracks"][0]
        assert set(track) == {
            "trackId",
            "firstSeenSeconds",
            "lastSeenSeconds",
            "maxConfidence",
            "severity",
            "severityScore",
            "severityConfidence",
            "observationCount",
            "maxArea",
            "bestFrameSeconds",
        }
        assert track["severity"] in {"small", "medium", "large", "unknown"}
        assert track["lastSeenSeconds"] >= track["firstSeenSeconds"]
        assert track["observationCount"] >= 1

    def test_is_reproducible(self, synthetic_video, tmp_path):
        first = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "a.json"), "--quiet"]
        )
        second = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "b.json"), "--quiet"]
        )
        assert first.report["tracks"] == second.report["tracks"]

    def test_writes_the_best_evidence_crop_per_pothole(self, synthetic_video, tmp_path):
        crops = tmp_path / "crops"
        outcome = run(
            [
                "--input",
                str(synthetic_video),
                "--json",
                str(tmp_path / "r.json"),
                "--crops-dir",
                str(crops),
                "--quiet",
            ]
        )
        written = sorted(path.stem for path in crops.glob("*.jpg"))
        assert written == sorted(track["trackId"] for track in outcome.report["tracks"])

    def test_sample_rate_is_configurable(self, synthetic_video, tmp_path):
        outcome = run(
            [
                "--input",
                str(synthetic_video),
                "--json",
                str(tmp_path / "r.json"),
                "--sample-fps",
                "3",
                "--quiet",
            ]
        )
        assert outcome.report["analysis"]["sampleFps"] == 3


class TestFailures:
    def test_reports_a_missing_input_without_a_traceback(self, tmp_path, capsys):
        code = main(["--input", str(tmp_path / "missing.mp4")])
        assert code == 1
        assert "error:" in capsys.readouterr().err

    def test_rejects_an_impossible_sample_rate(self, synthetic_video, capsys):
        assert main(["--input", str(synthetic_video), "--sample-fps", "0"]) == 1
        assert "--sample-fps must be positive" in capsys.readouterr().err

    def test_rejects_an_out_of_range_confidence(self, synthetic_video, capsys):
        assert main(["--input", str(synthetic_video), "--confidence", "1.4"]) == 1
        assert "--confidence must be between 0 and 1" in capsys.readouterr().err


class TestOtherClasses:
    """A multi-class road model recognises more than this product reports."""

    def test_a_single_class_model_reports_nothing_else(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        # The synthetic detector only ever emits potholes.
        assert outcome.report["analysis"]["otherClasses"] == {}

    def test_the_tally_never_becomes_a_pothole(self, synthetic_video, tmp_path):
        outcome = run(
            ["--input", str(synthetic_video), "--json", str(tmp_path / "r.json"), "--quiet"]
        )
        counted = sum(outcome.report["analysis"]["otherClasses"].values())
        # Whatever else the model saw, only potholes are entities.
        assert outcome.report["summary"]["totalPotholes"] == len(outcome.report["tracks"])
        assert counted == 0 or all(t["severity"] != "crack" for t in outcome.report["tracks"])
