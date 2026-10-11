"""Run the product pipeline (tracking, confirmation, severity) on several detectors merged.

    python -m ai.evaluation.run_merged --models a.onnx b.onnx c.onnx -- \\
        --input clip.mp4 --json report.json [--confidence 0.35] [--crops-dir DIR]

Everything after `--` is `python -m ai.inference.video`'s own options. Each member is built
as that CLI builds its one model, and `--confidence` applies to every member before the
merge (`merged_detector.py`), so the report is directly comparable with single-model runs.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from ai.evaluation.merged_detector import MergedDetector
from ai.inference.config import load_vision_config
from ai.inference.detector import create_detector

# Private on purpose: the product CLI has no reason to accept a detector from outside.
from ai.inference.video import _analyse, _apply_overrides, parse_args


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.evaluation.run_merged")
    parser.add_argument("--models", nargs="+", required=True, type=Path)
    ours, video_argv = parser.parse_known_args(argv)
    args = parse_args([a for a in video_argv if a != "--"])
    config = _apply_overrides(
        load_vision_config(args.config), sample_fps=args.sample_fps, confidence=args.confidence
    )
    detector = MergedDetector([create_detector(config, path) for path in ours.models])
    try:
        _analyse(args, config, detector)
    finally:
        detector.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
