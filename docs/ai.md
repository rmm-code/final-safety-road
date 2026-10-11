# AI workflow

From dataset to a model running in the browser. Training code lives under `ai/` and is
never imported by the application.

```text
dataset  ->  training  ->  best.pt  ->  evaluation  ->  ONNX export  ->  apps/web/public/models
```

## Currently deployed

YOLOv8m from [collabdoor/road-anomaly-detection](https://github.com/collabdoor/road-anomaly-detection),
**Apache 2.0**, trained on ~30,700 images pooled from RAD, Indian Roads, Humps/Bumps/
Potholes and HighRPD.

Seven classes: `Heavy-Vehicle, Light-Vehicle, Pedestrian, Crack, Crack-Severe, Pothole,
Speed-Bump`. Only `Pothole` is reported; the rest are dropped in post-processing. They are
worth keeping in the model, though, because `Speed-Bump` and `Crack` are exactly the
false-positive classes section 5.2 warns about, and a model that can name them is less
likely to call them potholes.

### Chosen by measurement, not by benchmark

Every candidate was run over the same local dashcam clip. Unique potholes after the full
tracking and confirmation pipeline:

| Model | Licence | Potholes found | Peak confidence |
| --- | --- | --- | --- |
| `keremberke/yolov8n-pothole-segmentation` | undeclared | 0 | 0.29 |
| `keremberke/yolov8m-pothole-segmentation` | undeclared | - | 0.17 |
| `rezzzq/yolo12s-road-damage-rdd2022` | MIT | 3 | 0.64 |
| **collabdoor road-anomaly YOLOv8m** | **Apache 2.0** | **13** | **0.73** |

The first row is the important one. That model's card advertises **0.995 mask mAP@0.5** -
and it found nothing. The figure is real but measured on its own test split, images from
the same small dataset it trained on. Its own table also ranks nano above small above
medium, and a smaller model beating larger ones on the same test set usually means the
split is too easy or leaks augmented duplicates across train and test. The ranking held in
our measurements too, which is corroboration that it is real and irrelevant.

Never adopt a detector on a published mAP. Run it over footage from the road it will
actually work on.

### Class matching

The pothole class is matched by NAME, case-insensitively (`POTHOLE_CLASS_ALIASES` in
`ai/inference/types.py`, mirrored in `packages/vision-web/src/postprocess/decode.ts`).
Never by index: RDD2022 puts potholes at index 3 behind three crack types, and this model
puts them at index 5 behind vehicles and pedestrians. Matching by position would report
longitudinal cracks, or lorries, as potholes.

## 1. Dataset

Start with **RDD2022**, normalising its road-damage labels down to a single class:

```text
pothole
```

An international dataset alone will not be enough for production. Build a local set in
phases:

| Phase | Data |
| --- | --- |
| A | RDD2022 only |
| B | RDD2022 + ~1,000 validated local frames |
| C | RDD2022 + 5,000–10,000 local frames |
| D | Continuous retraining on difficult production examples |

Cover sunny, cloudy, wet and night roads, shadows, different asphalt, patched surfaces and
both very small and very large defects.

**Negative examples matter as much as positive ones.** The model must learn that these
are *not* potholes: shadows, puddles, repaired asphalt, road paint, manholes, expansion
joints and oil stains. Without them, a detector trained on potholes alone fires on every
dark patch.

Datasets are never downloaded during application startup. Fetch them explicitly, and keep
them outside the repository.

Evidence crops from real runs are a good source of hard examples:

```bash
.venv/bin/python -m ai.inference.video --input drive.mp4 --crops-dir ./review-crops
```

## 2. Training

Place training scripts and configs under `ai/training/`. Recommended starting point is a
small YOLO-family detector (nano/small) so the exported model is viable on a phone.

Detect **one class**. Do not train `small_pothole` / `medium_pothole` / `large_pothole`:
severity is computed by `SeverityEngine` from visual features, which means it can be
retuned without retraining, and the detector stays focused on the harder question of
whether a defect is present at all.

Segmentation is worth migrating to once detection works — a mask gives a much better
visible-area estimate than a box, and severity reads visible area.

## 3. Evaluation

Under `ai/evaluation/`. Track precision, recall and mAP at the *frame* level, but judge
the system at the **event** level: what matters is whether a physical pothole was
reported once, not how many frames it was seen in.

For a road test, record a human ground-truth list of a fixed route and compare:

```text
actual potholes:  30
system detected:  26
true detections:  23
false detections:  3
missed potholes:   7
```

Do not tune from impressions.

## 4. Export to ONNX

Under `ai/export/`. Export at the input size the manifest will declare (640 is the
default), with static shapes, and verify that the exported graph reproduces the PyTorch
predictions on a handful of frames before deploying it.

Post-processing assumes the Ultralytics YOLOv8/v11 detection head:
`[1, 4 + numClasses, numAnchors]`, centre-form boxes in input pixels, sigmoid-activated
class scores, no separate objectness channel. A transposed head is detected
automatically; anything else needs a decoder in
`packages/vision-web/src/postprocess/decode.ts` and `ai/inference/postprocess.py`. Do not
work around a mismatch in product code.

## 5. Deploy

Copy the weights and a manifest into `apps/web/public/models/`:

```json
{
  "name": "pothole-detector",
  "version": "0.1.0",
  "file": "pothole-detector-0.1.0.onnx",
  "inputSize": 640,
  "classNames": ["pothole"]
}
```

Then copy the ONNX Runtime WebAssembly binaries once per checkout:

```bash
npm run sync:ort-runtime --workspace @pothole/web
```

Full manifest reference: [`apps/web/public/models/README.md`](../apps/web/public/models/README.md).

Check the model offline first — it is much faster than driving:

```bash
.venv/bin/python -m ai.inference.video \
  --input ./tashkent-drive.mp4 \
  --output ./annotated.mp4 \
  --model ./pothole-detector-0.1.0.onnx \
  --model-version pothole-detector-0.1.0
```

## Versioning

Every deployed model has a semantic version, and every detection records it. A deployed
version is never overwritten — publish a new one:

```text
pothole-detector-0.1.0
pothole-detector-0.2.0
```

That is what makes it possible to explain, months later, why a particular pothole was
reported.

## What AI does not do here

- No LLM runs in the detection path. Gemini, DeepSeek and similar are not used for
  frame-by-frame detection; a dedicated vision model is.
- The model answers "is there a pothole, and where". It does not assign severity, does
  not estimate location and does not decide whether two sightings are the same pothole.
- Nothing in this system measures physical width, length or depth from a single
  uncalibrated camera.
