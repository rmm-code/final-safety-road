"""Analyse the sample videos with the merged detector and publish them to a site.

python -m ai.samples --api http://localhost:3000 [--only video-2] [--reuse]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from ai.evaluation.merged_detector import MergedDetector
from ai.inference.config import load_vision_config
from ai.inference.detector import create_detector
from ai.inference.video import _apply_overrides
from ai.samples.analyse import analyse
from ai.samples.catalog import MODELS, SAMPLE_FPS, SAMPLES, THRESHOLD
from ai.samples.publish import publish


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m ai.samples")
    parser.add_argument("--api", required=True, help="the site's base URL")
    parser.add_argument("--only", nargs="*", help="sample ids, e.g. video-2")
    parser.add_argument("--out", type=Path, default=Path("output/samples"))
    parser.add_argument(
        "--reuse", action="store_true", help="publish saved analyses without re-running"
    )
    args = parser.parse_args(argv)
    config = _apply_overrides(load_vision_config(), sample_fps=SAMPLE_FPS, confidence=THRESHOLD)

    for sample in SAMPLES:
        if args.only and sample.id not in args.only:
            continue
        folder = args.out / sample.id
        saved = folder / "analysis.json"
        if args.reuse and saved.exists():
            analysis = json.loads(saved.read_text())
        else:
            detector = MergedDetector([create_detector(config, path) for path in MODELS])
            try:
                analysis = analyse(sample.file, detector, config, folder / "crops")
            finally:
                detector.close()
            folder.mkdir(parents=True, exist_ok=True)
            saved.write_text(json.dumps(analysis))
        aid = publish(
            args.api.rstrip("/"), sample, analysis, folder / "crops", THRESHOLD, SAMPLE_FPS
        )
        print(f"{sample.id}: {len(analysis['potholes'])} potholes -> {aid}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
