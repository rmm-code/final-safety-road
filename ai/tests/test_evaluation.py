"""Scoring a run against human ground truth."""

from __future__ import annotations

import json

import pytest

from ai.evaluation.score import (
    DetectedTrack,
    GroundTruthPothole,
    evaluate,
    main,
    parse_ground_truth,
    parse_report,
    run,
)


def gt(id_: str, at: float, severity: str | None = None) -> GroundTruthPothole:
    return GroundTruthPothole(id=id_, at_seconds=at, severity=severity)


def track(
    id_: str, first: float, last: float, conf: float = 0.9, severity: str = "medium"
) -> DetectedTrack:
    return DetectedTrack(
        track_id=id_,
        first_seen_seconds=first,
        last_seen_seconds=last,
        max_confidence=conf,
        severity=severity,
    )


class TestMatching:
    def test_credits_a_track_covering_the_noted_time(self):
        result = evaluate([gt("gt-1", 10.0)], [track("track-001", 8.0, 10.5)], 60)
        assert result.true_positives == 1
        assert not result.false_positives
        assert not result.missed

    def test_uses_the_tolerance_window(self):
        # The human noted 12.0s; the track ended at 10.5s. Within 2s of slack.
        result = evaluate(
            [gt("gt-1", 12.0)], [track("track-001", 8.0, 10.5)], 60, tolerance_seconds=2.0
        )
        assert result.true_positives == 1

    def test_a_track_far_from_any_pothole_is_a_false_positive(self):
        result = evaluate([gt("gt-1", 10.0)], [track("track-001", 40.0, 42.0)], 60)
        assert result.true_positives == 0
        assert [t.track_id for t in result.false_positives] == ["track-001"]
        assert [g.id for g in result.missed] == ["gt-1"]

    def test_one_track_cannot_be_credited_with_two_potholes(self):
        # Otherwise a model that fires constantly would score perfectly.
        result = evaluate([gt("gt-1", 10.0), gt("gt-2", 10.4)], [track("track-001", 9.0, 10.2)], 60)
        assert result.true_positives == 1
        assert len(result.missed) == 1

    def test_one_pothole_cannot_be_credited_to_two_tracks(self):
        result = evaluate(
            [gt("gt-1", 10.0)],
            [track("track-001", 9.0, 10.1), track("track-002", 9.5, 10.2)],
            60,
        )
        assert result.true_positives == 1
        assert len(result.false_positives) == 1

    def test_prefers_the_closest_track_in_time(self):
        result = evaluate(
            [gt("gt-1", 10.0)],
            [track("track-far", 6.0, 8.5), track("track-near", 9.0, 10.0)],
            60,
        )
        assert result.matches[0].track.track_id == "track-near"
        assert result.matches[0].time_error_seconds == pytest.approx(0.0)

    def test_confidence_sweep_drops_weak_tracks(self):
        tracks = [track("track-001", 9.0, 10.0, conf=0.4), track("track-002", 40.0, 41.0, conf=0.4)]
        loose = evaluate([gt("gt-1", 10.0)], tracks, 60, min_confidence=0.0)
        strict = evaluate([gt("gt-1", 10.0)], tracks, 60, min_confidence=0.6)
        assert loose.true_positives == 1 and len(loose.false_positives) == 1
        assert strict.true_positives == 0 and not strict.false_positives


class TestMetrics:
    def test_worked_example(self):
        """30 actual, 25 correct, 5 missed, 3 false - the shape from the build brief."""
        ground_truth = [gt(f"gt-{i}", i * 10.0) for i in range(1, 31)]
        tracks = [track(f"track-{i:03d}", i * 10.0 - 1.0, i * 10.0) for i in range(1, 26)]
        tracks += [track(f"fp-{i}", 1000.0 + i * 10, 1002.0 + i * 10) for i in range(3)]

        result = evaluate(ground_truth, tracks, duration_seconds=600)

        assert result.true_positives == 25
        assert len(result.missed) == 5
        assert len(result.false_positives) == 3
        assert result.precision == pytest.approx(25 / 28, abs=1e-4)
        assert result.recall == pytest.approx(25 / 30, abs=1e-4)
        assert result.false_positives_per_minute == pytest.approx(0.3, abs=1e-4)

    def test_no_detections_at_all(self):
        result = evaluate([gt("gt-1", 10.0)], [], 60)
        assert result.precision == 0.0
        assert result.recall == 0.0
        assert result.f1 == 0.0

    def test_no_potholes_and_no_detections_does_not_divide_by_zero(self):
        result = evaluate([], [], 60)
        assert (result.precision, result.recall, result.f1) == (0.0, 0.0, 0.0)
        assert result.false_positives_per_minute == 0.0

    def test_a_clean_drive_with_a_false_alarm_scores_zero_precision(self):
        result = evaluate([], [track("track-001", 5.0, 6.0)], 120)
        assert result.precision == 0.0
        assert result.false_positives_per_minute == pytest.approx(0.5)


class TestParsing:
    def test_reads_the_report_track_shape(self):
        raw = {
            "source": {"durationSeconds": 42.0},
            "tracks": [
                {
                    "trackId": "track-001",
                    "firstSeenSeconds": 1.0,
                    "lastSeenSeconds": 2.0,
                    "maxConfidence": 0.9,
                    "severity": "large",
                }
            ],
        }
        tracks, duration = parse_report(raw)
        assert duration == 42.0
        assert tracks[0].track_id == "track-001"
        assert tracks[0].severity == "large"

    def test_ground_truth_ids_default_to_a_sequence(self):
        potholes, duration = parse_ground_truth(
            {"potholes": [{"atSeconds": 4.0}], "durationSeconds": 30}
        )
        assert potholes[0].id == "gt-1"
        assert duration == 30.0

    def test_rejects_ground_truth_without_a_time(self):
        with pytest.raises(ValueError, match="atSeconds"):
            parse_ground_truth({"potholes": [{"id": "gt-1"}]})

    def test_rejects_a_report_without_tracks(self):
        with pytest.raises(ValueError, match="tracks"):
            parse_report({"source": {}})


class TestCli:
    def _write(self, tmp_path, synthetic: bool = False):
        report = tmp_path / "detections.json"
        truth = tmp_path / "truth.json"
        report.write_text(
            json.dumps(
                {
                    "engine": {"modelVersion": "pothole-detector-0.1.0", "isSynthetic": synthetic},
                    "source": {"durationSeconds": 120.0},
                    "tracks": [
                        {
                            "trackId": "track-001",
                            "firstSeenSeconds": 9.0,
                            "lastSeenSeconds": 10.0,
                            "maxConfidence": 0.9,
                            "severity": "large",
                        }
                    ],
                }
            )
        )
        truth.write_text(json.dumps({"potholes": [{"id": "gt-1", "atSeconds": 10.0}]}))
        return report, truth

    def test_prints_and_writes_scores(self, tmp_path, capsys):
        report, truth = self._write(tmp_path)
        out = tmp_path / "scores.json"
        evaluation = run(["--report", str(report), "--truth", str(truth), "--json", str(out)])

        assert evaluation.true_positives == 1
        printed = capsys.readouterr().out
        assert "Precision         100.0%" in printed
        assert "per driving minute" in printed

        scores = json.loads(out.read_text())
        assert scores["truePositives"] == 1
        assert scores["modelVersion"] == "pothole-detector-0.1.0"

    def test_marks_a_synthetic_run_as_measuring_nothing(self, tmp_path, capsys):
        report, truth = self._write(tmp_path, synthetic=True)
        run(["--report", str(report), "--truth", str(truth)])
        assert "SYNTHETIC RUN" in capsys.readouterr().out

    def test_reports_a_missing_file_without_a_traceback(self, tmp_path, capsys):
        assert (
            main(["--report", str(tmp_path / "nope.json"), "--truth", str(tmp_path / "no.json")])
            == 1
        )
        assert "error:" in capsys.readouterr().err


class TestTruthTemplate:
    """Starting from the model's output is the only way ground truth gets produced."""

    def _report(self, tmp_path):
        path = tmp_path / "detections.json"
        path.write_text(
            json.dumps(
                {
                    "engine": {"modelVersion": "m", "isSynthetic": False},
                    "source": {"name": "drive.mp4", "durationSeconds": 120.0},
                    "tracks": [
                        {
                            "trackId": "track-001",
                            "firstSeenSeconds": 9.0,
                            "lastSeenSeconds": 10.0,
                            "bestFrameSeconds": 9.6,
                            "maxConfidence": 0.82,
                            "severity": "large",
                        }
                    ],
                }
            )
        )
        return path

    def test_writes_one_entry_per_reported_pothole(self, tmp_path, capsys):
        out = tmp_path / "truth.json"
        run(["--report", str(self._report(tmp_path)), "--make-truth-template", str(out)])

        template = json.loads(out.read_text())
        assert len(template["potholes"]) == 1
        assert template["potholes"][0]["atSeconds"] == 9.6
        assert template["video"] == "drive.mp4"

    def test_the_template_says_it_is_not_ground_truth(self, tmp_path):
        out = tmp_path / "truth.json"
        run(["--report", str(self._report(tmp_path)), "--make-truth-template", str(out)])
        assert "_instructions" in json.loads(out.read_text())

    def test_refuses_to_score_an_unedited_template(self, tmp_path, capsys):
        report = self._report(tmp_path)
        out = tmp_path / "truth.json"
        run(["--report", str(report), "--make-truth-template", str(out)])

        # Scoring a template against the report it came from would report 100% and mean
        # nothing at all. That is exactly the mistake this guard exists to prevent.
        assert main(["--report", str(report), "--truth", str(out)]) == 1
        assert "still an unedited template" in capsys.readouterr().err

    def test_requires_a_truth_file_when_scoring(self, tmp_path, capsys):
        assert main(["--report", str(self._report(tmp_path))]) == 1
        assert "--truth is required" in capsys.readouterr().err
