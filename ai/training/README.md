# Training

Fine-tuning the deployed detector on local footage.

Always transfer learning, never from scratch: the deployed checkpoint already understands
road damage from ~30,700 images, and local footage is there to teach it *our* roads,
weather and camera. That job needs hundreds of images, not tens of thousands.

## 1. Collect and label

Organise footage **one directory per drive**, images alongside YOLO `.txt` labels:

```text
samples/labelled/
  tashkent-2026-08-17-morning/
    f000.jpg
    f000.txt          # "5 0.51 0.62 0.18 0.09"  -> class 5 = Pothole
  tashkent-2026-08-17-ring-road/
    ...
```

`--crops-dir` on the inference CLI harvests candidate images from a drive, and `/review`
is where they get confirmed or rejected.

Class indices must match the checkpoint being fine-tuned:

```text
0 Heavy-Vehicle   1 Light-Vehicle   2 Pedestrian   3 Crack
4 Crack-Severe    5 Pothole         6 Speed-Bump
```

Negative examples matter as much as positives. A frame containing a shadow, a puddle, a
manhole or patched asphalt and **no** label is what teaches the model those are not
potholes.

## 2. Assemble the dataset

```bash
.venv/bin/python -m ai.training.dataset \
  --source ./samples/labelled \
  --out ./datasets/tashkent
```

Writes `data.yaml`, the three splits, and `split.json` recording exactly how the split was
made and the class weights derived from the train split.

**Splits are by drive, never by frame.** Consecutive frames of one drive are nearly
identical - frame 100 and 101 show the same pothole 15 cm apart. Split those randomly and
the model is validated on images it effectively trained on, and the resulting mAP is
fiction. That is the likeliest explanation for a public pothole model advertising
**0.995 mAP@0.5** and then finding nothing on a real road.

Class weights are inverse-frequency and computed from the **train split only**. Potholes
are a minority even in bad-road footage - most frames contain none - and without weighting
a detector minimises loss by predicting nothing at all.

## 3. Fine-tune

```bash
.venv/bin/python -m ai.training.finetune \
  --data ./datasets/tashkent/data.yaml \
  --base ./models/pothole-detector.pt \
  --epochs 60
```

`--freeze 10` by default: with a few hundred local images, letting the whole network move
overwrites what it learned from 30,700.

## 4. Judge it before deploying

Training metrics describe the training run's own validation split. They are not evidence.

```bash
.venv/bin/python -m ai.inference.video --model runs/.../best.pt \
  --input ./samples/drive.mp4 --json ./output/detections.json

.venv/bin/python -m ai.evaluation.score \
  --report ./output/detections.json --truth ./samples/drive.truth.json
```

Run the same comparison against the model you started from. Deploy only if precision and
recall actually improved on a driven route.

## 5. Deploy

```bash
.venv/bin/python -m ai.export.to_onnx --model runs/.../best.pt \
  --name pothole-local --version 1.1.0 --imgsz 640 --quantize 16
npm run sync:ort-runtime --workspace @pothole/web
```

Never overwrite a deployed version - publish a new one. Every detection event records the
model version that produced it.
