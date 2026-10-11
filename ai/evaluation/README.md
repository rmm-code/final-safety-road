# Evaluation

Scores a detection run against a human ground-truth list.

Detecting some potholes is not evidence that a model works. What matters is how many real
potholes were found, how many reports were wrong, and how often a driver would be
interrupted by a false alarm.

```bash
.venv/bin/python -m ai.evaluation.score \
  --report ./output/detections.json \
  --truth ./samples/tashkent-drive.truth.json
```

```text
Model             pothole-detector-0.1.0
Drive duration    8.0 min
Match tolerance   +/-2.0 s

Actual potholes   30
Reported          28
Correct           25
Missed            5
False detections  3

Precision         89.3%
Recall            83.3%
F1                86.2%
False alarms      0.38 per driving minute
Mean time error   0.84 s
```

## Getting a ground-truth file

Labelling a drive from nothing is slow enough that it does not get done. Start from the
model's own output and correct it:

```bash
.venv/bin/python -m ai.evaluation.score \
  --report ./output/detections.json \
  --make-truth-template ./samples/drive.truth.json
```

Then watch the video and edit: delete anything that is not really a pothole, add every one
the model missed, correct the severities, and remove the `_instructions` key.

Scoring an unedited template is refused. It would compare the report against itself and
report 100%, which is worse than no measurement at all.

## Ground-truth format

Drive the route, note roughly when the vehicle reaches each pothole, and write:

```json
{
  "video": "tashkent-drive.mp4",
  "durationSeconds": 480,
  "potholes": [
    { "id": "gt-1", "atSeconds": 12.5, "severity": "large", "note": "left lane, after bridge" },
    { "id": "gt-2", "atSeconds": 47.0, "severity": "medium" },
    { "id": "gt-3", "atSeconds": 118.5, "severity": "small" }
  ]
}
```

Only `atSeconds` is required; `id` defaults to a sequence. `severity` and `note` are
carried into the output so reported and actual severity can be compared later.

A phone voice memo while driving, transcribed afterwards against the video timeline, is
usually the least painful way to produce this.

## How matching works

A reported track matches a pothole when the noted time falls inside the track's visible
window, widened by `--tolerance` (2 s by default). The slack exists because a human notes
roughly when the vehicle *reached* the defect, while a track starts when it first became
visible, several seconds earlier.

Assignment is one to one, greedily by smallest time error. A track cannot be credited
with two potholes, nor a pothole with two tracks — otherwise a model that fires
constantly would score perfectly.

## Sweeping the confidence threshold

```bash
for c in 0.3 0.4 0.5 0.6 0.7; do
  echo "--- conf $c ---"
  .venv/bin/python -m ai.evaluation.score --report ./output/detections.json \
    --truth ./samples/drive.truth.json --min-confidence $c | grep -E "Precision|Recall|False alarms"
done
```

Raising the threshold trades recall for precision. For a road-maintenance backlog, a
false alarm costs an inspector's time while a miss leaves a hazard — pick the operating
point deliberately, from this table, not from impressions.

## Level of measurement

Scores are computed at the **event** level: one physical pothole reported once. A model
that draws boxes on 40 frames of the same defect has found one pothole, not forty.
Frame-level precision and recall are useful during training; they are not what the
product is judged on.

## Comparing candidate detectors (`/models`)

The console's `/models` page shows every candidate on the same footage, side by side, plus
a live test that runs a model through the browser engine the product uses.

```bash
# 1. Predictions, one file per model per image set (square input, as the browser runs it)
.venv/bin/python -m ai.evaluation.run_detector --weights models/candidates/x.pt \
  --images <frames-dir> --out preds/<set>/x.json --imgsz 640 --device mps

# 2. Image-level scores where labels exist (pothole class only, by name)
.venv/bin/python -m ai.evaluation.score_images --labels <labels-dir> \
  --preds preds/<set>/*.json [--ignore unlabelled_regions.json]

# 3. Package frames, boxes and scores for the page
.venv/bin/python -m ai.evaluation.build_model_compare --config compare_config.json
```

The config lists local paths, so it is not committed; nor are `models/candidates/` or the
generated `apps/web/public/model-compare/`. RF-DETR checkpoints need their own environment
(`pip install rfdetr`) and a runner that writes the same predictions format.

**Checkpoints are pickles: loading one runs code.** Before loading a downloaded `.pt`,
list the globals it imports without unpickling it (`pickletools` over the archive's `.pkl`
streams) and refuse anything that reaches `os`, `subprocess`, `builtins.eval`/`exec` and
the like. A Hugging Face "caution" flag on an Ultralytics file usually means only that it
imports `ultralytics.nn.*` classes - check rather than assume either way.

Two things the first comparison taught, both invisible from a model card:

- **Read a dataset's labels, not its class names.** The RDD2022 copy several benchmarked
  models were trained on labels manhole covers and lane markings as `pothole`. Their
  published pothole score was real; it measured the wrong thing.
- **Test in the browser, not just in Python.** A YOLO12 model exported cleanly, scored well
  in Python, and returned nothing at all on WebGPU in our engine. Only the live test on
  `/models` shows that.
