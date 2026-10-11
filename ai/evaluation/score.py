"""Score a detection run against a human ground-truth list.

    python -m ai.evaluation.score \\
      --report ./output/detections.json \\
      --truth ./samples/tashkent-drive.truth.json

Detecting some potholes is not evidence that a model works. What matters is how many
real potholes were found, how many reports were wrong, and how often a driver would be
interrupted by a false alarm - so this reports precision, recall and false positives per
driving minute, at the EVENT level.

Event level, not frame level: the product's unit is a physical pothole reported once, not
a box drawn on a frame. A model that fires on 40 frames of one pothole has found one
pothole, not forty.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# A human notes roughly when the vehicle reached a pothole; a track spans the whole time
# it was visible, which starts earlier. This slack absorbs that disagreement.
DEFAULT_TOLERANCE_SECONDS = 2.0


@dataclass(frozen=True, slots=True)
class GroundTruthPothole:
    id: str
    at_seconds: float
    severity: str | None = None
    note: str | None = None


@dataclass(frozen=True, slots=True)
class DetectedTrack:
    track_id: str
    first_seen_seconds: float
    last_seen_seconds: float
    max_confidence: float
    severity: str

    def closest_time(self) -> float:
        """When the vehicle was nearest the defect - the end of the track."""
        return self.last_seen_seconds


@dataclass(frozen=True, slots=True)
class Match:
    ground_truth: GroundTruthPothole
    track: DetectedTrack
    time_error_seconds: float


@dataclass(frozen=True, slots=True)
class Evaluation:
    matches: list[Match]
    false_positives: list[DetectedTrack]
    missed: list[GroundTruthPothole]
    duration_seconds: float
    tolerance_seconds: float

    @property
    def true_positives(self) -> int:
        return len(self.matches)

    @property
    def precision(self) -> float:
        reported = self.true_positives + len(self.false_positives)
        return self.true_positives / reported if reported else 0.0

    @property
    def recall(self) -> float:
        actual = self.true_positives + len(self.missed)
        return self.true_positives / actual if actual else 0.0

    @property
    def f1(self) -> float:
        total = self.precision + self.recall
        return 2 * self.precision * self.recall / total if total else 0.0

    @property
    def false_positives_per_minute(self) -> float:
        minutes = self.duration_seconds / 60
        return len(self.false_positives) / minutes if minutes > 0 else 0.0

    @property
    def mean_time_error_seconds(self) -> float:
        if not self.matches:
            return 0.0
        return sum(m.time_error_seconds for m in self.matches) / len(self.matches)

    def to_dict(self) -> dict[str, Any]:
        return {
            "durationSeconds": round(self.duration_seconds, 3),
            "toleranceSeconds": self.tolerance_seconds,
            "actualPotholes": self.true_positives + len(self.missed),
            "reportedPotholes": self.true_positives + len(self.false_positives),
            "truePositives": self.true_positives,
            "falsePositives": len(self.false_positives),
            "missed": len(self.missed),
            "precision": round(self.precision, 4),
            "recall": round(self.recall, 4),
            "f1": round(self.f1, 4),
            "falsePositivesPerDrivingMinute": round(self.false_positives_per_minute, 3),
            "meanTimeErrorSeconds": round(self.mean_time_error_seconds, 3),
            "matches": [
                {
                    "groundTruthId": m.ground_truth.id,
                    "trackId": m.track.track_id,
                    "timeErrorSeconds": round(m.time_error_seconds, 3),
                    "reportedSeverity": m.track.severity,
                    "actualSeverity": m.ground_truth.severity,
                }
                for m in self.matches
            ],
            "falsePositiveTracks": [t.track_id for t in self.false_positives],
            "missedPotholes": [g.id for g in self.missed],
        }


def parse_ground_truth(raw: dict[str, Any]) -> tuple[list[GroundTruthPothole], float | None]:
    potholes = raw.get("potholes")
    if not isinstance(potholes, list):
        raise ValueError('Ground truth must contain a "potholes" array')

    parsed: list[GroundTruthPothole] = []
    for index, item in enumerate(potholes):
        if not isinstance(item, dict):
            raise ValueError(f"Ground-truth entry {index} is not an object")
        if "atSeconds" not in item:
            raise ValueError(f'Ground-truth entry {index} has no "atSeconds"')
        parsed.append(
            GroundTruthPothole(
                id=str(item.get("id", f"gt-{index + 1}")),
                at_seconds=float(item["atSeconds"]),
                severity=item.get("severity"),
                note=item.get("note"),
            )
        )

    duration = raw.get("durationSeconds")
    return parsed, float(duration) if duration is not None else None


def parse_report(raw: dict[str, Any]) -> tuple[list[DetectedTrack], float]:
    tracks = raw.get("tracks")
    if not isinstance(tracks, list):
        raise ValueError('Report must contain a "tracks" array')

    parsed = [
        DetectedTrack(
            track_id=str(t["trackId"]),
            first_seen_seconds=float(t["firstSeenSeconds"]),
            last_seen_seconds=float(t["lastSeenSeconds"]),
            max_confidence=float(t.get("maxConfidence", 0.0)),
            severity=str(t.get("severity", "unknown")),
        )
        for t in tracks
    ]
    duration = float(raw.get("source", {}).get("durationSeconds", 0.0))
    return parsed, duration


def evaluate(
    ground_truth: list[GroundTruthPothole],
    tracks: list[DetectedTrack],
    duration_seconds: float,
    tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
    min_confidence: float = 0.0,
) -> Evaluation:
    """Match reported tracks to actual potholes, one to one.

    A track matches a pothole when the noted time falls inside the track's visible window
    (widened by the tolerance). Pairs are assigned greedily by smallest time error, so a
    track cannot be credited with two potholes, nor a pothole with two tracks - otherwise
    a model that fires constantly would score perfectly.
    """
    considered = [t for t in tracks if t.max_confidence >= min_confidence]

    candidates: list[tuple[float, int, int]] = []
    for gt_index, gt in enumerate(ground_truth):
        for track_index, track in enumerate(considered):
            window_start = track.first_seen_seconds - tolerance_seconds
            window_end = track.last_seen_seconds + tolerance_seconds
            if window_start <= gt.at_seconds <= window_end:
                error = abs(gt.at_seconds - track.closest_time())
                candidates.append((error, gt_index, track_index))

    candidates.sort(key=lambda item: item[0])
    used_gt: set[int] = set()
    used_tracks: set[int] = set()
    matches: list[Match] = []

    for error, gt_index, track_index in candidates:
        if gt_index in used_gt or track_index in used_tracks:
            continue
        used_gt.add(gt_index)
        used_tracks.add(track_index)
        matches.append(Match(ground_truth[gt_index], considered[track_index], error))

    matches.sort(key=lambda m: m.ground_truth.at_seconds)

    return Evaluation(
        matches=matches,
        false_positives=[t for i, t in enumerate(considered) if i not in used_tracks],
        missed=[g for i, g in enumerate(ground_truth) if i not in used_gt],
        duration_seconds=duration_seconds,
        tolerance_seconds=tolerance_seconds,
    )


def format_report(evaluation: Evaluation, model_version: str, synthetic: bool) -> str:
    lines: list[str] = []
    if synthetic:
        lines.append("*** SYNTHETIC RUN - these numbers measure nothing about a model ***")
    lines += [
        f"Model             {model_version}",
        f"Drive duration    {evaluation.duration_seconds / 60:.1f} min",
        f"Match tolerance   +/-{evaluation.tolerance_seconds:.1f} s",
        "",
        f"Actual potholes   {evaluation.true_positives + len(evaluation.missed)}",
        f"Reported          {evaluation.true_positives + len(evaluation.false_positives)}",
        f"Correct           {evaluation.true_positives}",
        f"Missed            {len(evaluation.missed)}",
        f"False detections  {len(evaluation.false_positives)}",
        "",
        f"Precision         {evaluation.precision * 100:.1f}%",
        f"Recall            {evaluation.recall * 100:.1f}%",
        f"F1                {evaluation.f1 * 100:.1f}%",
        f"False alarms      {evaluation.false_positives_per_minute:.2f} per driving minute",
        f"Mean time error   {evaluation.mean_time_error_seconds:.2f} s",
    ]
    if evaluation.missed:
        lines += ["", "Missed: " + ", ".join(g.id for g in evaluation.missed)]
    if evaluation.false_positives:
        lines += ["False: " + ", ".join(t.track_id for t in evaluation.false_positives)]
    return "\n".join(lines)


def truth_template(report: dict[str, Any]) -> dict[str, Any]:
    """Turn a detection report into a ground-truth file to correct by hand.

    Labelling a drive from nothing is slow enough that it does not get done. Starting from
    what the model reported and correcting it - deleting the false positives, adding what
    it missed - takes a fraction of the time, and an unedited file is useless in an
    obvious way rather than a subtle one.
    """
    tracks = report.get("tracks", [])
    return {
        "video": report.get("source", {}).get("name", "drive.mp4"),
        "durationSeconds": report.get("source", {}).get("durationSeconds", 0),
        "_instructions": [
            "This is a TEMPLATE generated from the model's own output, not ground truth.",
            "1. Watch the video. Delete any entry that is not really a pothole.",
            "2. Add an entry for every pothole the model missed.",
            "3. Correct 'severity' to what you actually saw.",
            "4. Delete this _instructions key when done.",
            "Scoring a template against itself measures nothing: it would report 100%.",
        ],
        "potholes": [
            {
                "id": track["trackId"],
                "atSeconds": track.get("bestFrameSeconds") or track["lastSeenSeconds"],
                "severity": track.get("severity", "unknown"),
                "note": f"model reported {round(track.get('maxConfidence', 0) * 100)}% confidence",
            }
            for track in tracks
        ],
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m ai.evaluation.score",
        description="Score a detection report against a human ground-truth list.",
    )
    parser.add_argument("--report", required=True, type=Path, help="detections.json from a run")
    parser.add_argument("--truth", type=Path, help="Ground-truth JSON")
    parser.add_argument(
        "--make-truth-template",
        type=Path,
        help=(
            "Write a ground-truth template from the report instead of scoring. Correct it "
            "by hand, then pass it back with --truth."
        ),
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_TOLERANCE_SECONDS,
        help="Seconds of slack when matching a noted time to a track",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.0,
        help="Ignore reported tracks below this confidence, to sweep the threshold",
    )
    parser.add_argument("--json", dest="json_path", type=Path, help="Write the scores as JSON")
    return parser.parse_args(argv)


def run(argv: list[str] | None = None) -> Evaluation | None:
    args = parse_args(argv)

    report_raw = json.loads(args.report.read_text(encoding="utf-8"))

    if args.make_truth_template is not None:
        template = truth_template(report_raw)
        args.make_truth_template.parent.mkdir(parents=True, exist_ok=True)
        args.make_truth_template.write_text(json.dumps(template, indent=2) + "\n", encoding="utf-8")
        print(f"Template written to {args.make_truth_template}")
        print(f"  {len(template['potholes'])} entries, taken from the model's own output.")
        print("  Correct it by hand, then score with --truth. It is NOT ground truth yet.")
        return None

    if args.truth is None:
        raise ValueError("--truth is required unless --make-truth-template is given")

    truth_raw = json.loads(args.truth.read_text(encoding="utf-8"))
    if "_instructions" in truth_raw:
        raise ValueError(
            "This ground-truth file is still an unedited template. Correct it by hand and "
            "remove the _instructions key; scoring a template against its own report would "
            "report 100% and mean nothing."
        )

    tracks, report_duration = parse_report(report_raw)
    ground_truth, truth_duration = parse_ground_truth(truth_raw)
    duration = truth_duration if truth_duration is not None else report_duration

    evaluation = evaluate(
        ground_truth,
        tracks,
        duration_seconds=duration,
        tolerance_seconds=args.tolerance,
        min_confidence=args.min_confidence,
    )

    engine = report_raw.get("engine", {})
    print(
        format_report(
            evaluation,
            model_version=str(engine.get("modelVersion", "unknown")),
            synthetic=bool(engine.get("isSynthetic", False)),
        )
    )

    if args.json_path is not None:
        args.json_path.parent.mkdir(parents=True, exist_ok=True)
        payload = evaluation.to_dict()
        payload["modelVersion"] = engine.get("modelVersion")
        payload["isSynthetic"] = engine.get("isSynthetic", False)
        args.json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    return evaluation


def main(argv: list[str] | None = None) -> int:
    try:
        run(argv)
    except (FileNotFoundError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
