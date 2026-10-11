# AI workspace

Offline inference, plus the place training, evaluation and export code belongs. Nothing
here is imported by the web application.

```text
ai/
  configs/vision.yaml   canonical thresholds, shared with the browser
  inference/            video CLI, detectors, tracking, severity, best frame
  training/             model training (not yet implemented)
  evaluation/           metrics and road-test comparison (not yet implemented)
  export/               PyTorch -> ONNX export (not yet implemented)
  tests/                pytest suite
```

## Setup

Python 3.12: newer interpreters do not yet have wheels for the whole stack.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r ai/requirements.txt
```

Run everything from the repository root so `ai` resolves as a package.

## Analysing a video

```bash
.venv/bin/python -m ai.inference.video --input ./input.mp4 --output ./annotated.mp4
```

| Flag | Meaning |
| --- | --- |
| `--input` | Source video (required) |
| `--output` | Annotated MP4 to write; omit to produce only the report |
| `--json` | Report path (default: `detections.json` beside the output) |
| `--model` | ONNX detector; omit to run the synthetic detector |
| `--model-version` | Semantic version recorded on every detection |
| `--layout` | Detector output layout: `auto`, `channels-first`, `channels-last` |
| `--sample-fps` | Frames per second to analyse |
| `--confidence` | Override the detection confidence threshold |
| `--crops-dir` | Save the best evidence crop per pothole |
| `--config` | Alternative `vision.yaml` |
| `--quiet` | Suppress progress and summary output |

Without `--model` the synthetic detector runs. It fabricates detections from a road
geometry simulation to exercise the pipeline; the warning on stderr, the report's
`engine.isSynthetic` flag, the `mock-` model version and a banner burned into every
annotated frame all say so. It is never presented as a reading of your footage.

## Tests

```bash
.venv/bin/python -m pytest
.venv/bin/ruff check ai/
.venv/bin/ruff format --check ai/
```

Post-processing is tested against hand-built tensors, since no trained weights live in
the repository. The CLI test generates its own short clip, so there is no binary fixture
to maintain.

## Relationship to the browser

`ai/configs/vision.yaml` is the single source of truth for thresholds; the browser mirrors
it and a TypeScript test fails the build if they drift.

Both implementations emit the same report schema, sample the same frame times and share a
bit-compatible synthetic sequence, so the same clip yields identical `analysis`, `summary`
and `tracks` blocks from either. Only `generatedAt` and the wording of
`engine.selectionReason` differ, since the two select their detector by different routes.
A discrepancy anywhere else is a bug in one of them, not a difference of opinion.

Training and export guidance: [`docs/ai.md`](../docs/ai.md).
