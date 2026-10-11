#!/usr/bin/env bash
# Run one checkpoint over the judged frames, into output/yolo26/preds/<set>/<name>.json.
#
#   ai/yolo26/predict_sets.sh <name> <weights.pt> [imgsz] [sets...]
#   .venv/bin/python -m ai.evaluation.score_sets --config ai/yolo26/sets-yolo26.json \
#       --preds-root output/yolo26/preds
#
# Default sets: the four test videos and the two smooth-road clips (sets-smooth.json).
# Square input, threshold 0.05, the same settings docs/model-comparison.md used.
set -euo pipefail
cd "$(dirname "$0")/../.."
name=$1 weights=$2 imgsz=${3:-640}
shift $(( $# < 3 ? $# : 3 ))
sets=${*:-video-1 video-2 video-3 video-4 dashcam-0939 dashcam-1215}
device=${DEVICE:-mps}
for set in $sets; do
  # Video 4's frames predate the per-set layout (macOS bash 3.2 has no associative arrays).
  if [ "$set" = video-4 ]; then frames=output/model-eval/frames; else frames=output/model-eval/sets/$set/frames; fi
  mkdir -p "output/yolo26/preds/$set"
  .venv/bin/python -m ai.evaluation.run_detector --weights "$weights" --images "$frames" \
    --out "output/yolo26/preds/$set/$name.json" --imgsz "$imgsz" --device "$device" --threshold 0.05
done
