# Model comparison on the four test videos - 2026-10-11

**The question:** which available detector finds potholes best, measured on the team's own
footage: videos 1, 2 and 3 (a car's built-in dashcam in Tashkent) and video 4 (a phone clip of
a badly broken road in Russia). Every number here comes from those four videos.

## Answer

| Setup | What reaches the map (judged reports) | Frame precision | Frame recall |
| --- | --- | --- | --- |
| Current model at 0.35 (the app's threshold until 2026-10-11) | 12 real, 1 false, 3 unsure | 74% | 35% |
| **Current model at 0.25** | **17 real, 1 false, 2 unsure** | **74%** | **55%** |
| mfranzon YOLO26m at 0.35 | 21 real, 1 false, 3 unsure | 64% | 49% |
| **Merge: current + mfranzon + rezzzq at 0.35** | **32 real, 2 false, 5 unsure** | **66%** | **73%** |

- **The merge finds the most.** After tracking it reports nearly twice as many real potholes
  as the current model at 0.25 (32 against 17), for one more false report (2 against 1).
  Tracking removes most of its frame-level false alarms (a third of its boxes are not
  potholes, mostly manhole covers).
- **The current model at 0.25 is the best single model.** It is as precise as at 0.35 and
  finds half again as many potholes. It runs as one model in a phone's browser.
- **mfranzon alone trades precision for recall.** At the same 0.25 threshold it has frame
  precision 62% against 74% and recall 63% against 55% (the row above is at 0.35); on video 2
  most of its boxes are manhole covers. Its frame-level row was measured at 640, but it was
  trained at 512 and its browser export runs at 512, where its recall drops to 42%.
- The merge needs three models per frame: about three times the download and the time, so it
  suits analysing video files rather than a live drive on a phone. rezzzq does not run on
  WebGPU in our engine (it works on the slower WASM path).

On the site, the four sample dashboards show our own YOLO26m's results since later on
2026-10-11 (below), analysed offline and published by `python -m ai.samples`. The live demo
and the live drive run the current model alone, in the browser, at 0.25 since 2026-10-11.

## Update, later 2026-10-11: our own YOLO26m

`pothole-yolo26m-public-0.1.0`, trained by `ai/yolo26/` from Ultralytics' COCO `yolo26m.pt`
on public data only: RDD2022 (six countries, China_Drone skipped) and jaygala24, 7,381 train
and 1,116 val images split by id blocks, 40 epochs at 640 on a Colab A100. Seven classes, so
manhole covers, road markings and repairs have somewhere to go other than "pothole". It never
saw these four videos.

What reaches the map, at threshold 0.25 (real / false / unsure, two fresh blind judges per
report; the merge rows are the earlier judges'):

| Setup | All four videos | Tashkent videos 1-3 | Video 4 |
| --- | --- | --- | --- |
| Merge at 0.35 (the samples until today) | 32 / 2 / 5 | 7 / 2 / 2 | 25 / 0 / 3 |
| Merge at 0.25 | 41 / 2 / 6 | 8 / 2 / 4 | 33 / 0 / 2 |
| mfranzon YOLO26m at 0.25 | 25 / 1 / 3 | 2 / 1 / 2 | 23 / 0 / 1 |
| Our YOLO26m, confirmation gate 0.55 (vision.yaml) | 24 / 2 / 14 | 12 / 2 / 13 | 12 / 0 / 1 |
| **Our YOLO26m, gate 0.40 (published samples)** | **37 / 4 / 19** | **17 / 4 / 18** | **20 / 0 / 1** |
| Our YOLO26m, gate 0.35 | 39 / 6 / 20 | 17 / 6 / 19 | 22 / 0 / 1 |

- **On Tashkent dashcam footage it reports twice the merge's real potholes** (17 against 8),
  with one model instead of three, for two more false reports (a manhole lid and a crack in
  video 2) and many more "unsure": tiny distant marks the judges could not call.
- **The 0.55 gate was tuned on the current model.** Our YOLO26m scores real holes lower, and
  at 0.55 it dropped tracks peaking at 0.31-0.48 that the judges call potholes (video 1
  reported 1 of 3). The samples use 0.40 (`ai/samples/catalog.py`); 0.35 adds 2 real and 2 false.
- **Weaker on video 4**, the portrait phone clip: 20 real against the merge's 33.
- **Not on the live drive.** At frame level on the two smooth-road clips it draws 22 false
  boxes at 0.25 (13 at 0.35) against the current model's 1, and it has never been driven.
  It runs on WebGPU in our engine (same output layout as the current model).

Frame level: the boxes it drew outside the earlier pool (160 clusters from its epoch-16
checkpoint, 77 more from the final model) were labelled by blind judge pairs
(`ai/yolo26/pool_unjudged.py`, `output/yolo26/judging-supp*/`), which added clusters judged pothole
(per frame, not distinct holes) that no earlier model had drawn: 10 in video 1, 29 in video 2,
32 in video 3. Against that larger pool, every
box judged, on the 254 Tashkent frames (videos 1-3) at 0.25:

| Setup | Precision (strict) | Recall (strict) | Precision / recall, unsure counted as pothole |
| --- | --- | --- | --- |
| Current model (live drive) | 47% | 16% | 66% / 12% |
| Merge | 40% | 38% | 59% / 32% |
| **Our YOLO26m** | **51%** [38-61] | **64%** [51-75] | 82% / 59% |

On the two smooth-road clips (474 frames, about 4 minutes) it draws 28 false boxes at 0.25 and
15 at 0.35; the current model draws 1. Recall of every model is lower than in the table at the
top, because the pool now holds potholes they all missed.

## The videos

| Video | What | Judged frames |
| --- | --- | --- |
| 1 (`samples/2026-05-25-10-12-58.mp4`) | 6 s, residential lane, Tashkent, patched asphalt | 26, at 4 fps |
| 2 (`samples/2026-05-24-16-53-36.mp4`) | 33 s, off Labzak street by Osiyo Grand: a worn side road, a parking lot, roads between buildings | 131, at 4 fps |
| 3 (`samples/2026-05-24-13-36-41.mp4`) | 24 s, residential streets, Tashkent; rain drops on the windscreen | 97, at 4 fps |
| 4 (`samples/AQM2jw….mp4`) | 8.6 s, badly broken road in Russia, phone in portrait | 18, at 2 fps |

None of the files carries GPS. Video 4 was called "the Tashkent clip" in earlier versions of
this document; it is from Russia.

## Method

1. **Detections.** The three pothole models ran over the frames (`ai/evaluation/run_detector.py`,
   square 640 input as in the browser, every box down to 0.05).
2. **Pooled review** (`ai/evaluation/pool_review.py`): every box at or above 0.25 from any model,
   merged per frame at IoU 0.5 into clusters (110 for videos 1-3; video 4's 96 come from the
   first comparison), drawn on blind sheets with no model names or scores.
3. **Two independent blind AI judges** (Claude) labelled every cluster against written rules.
   Videos 1-3: they agreed on 89 of 110 (kappa 0.64; 0.71 for pothole or not). Video 4: 0.91.
   Where they disagreed the cluster is "unsure", and precision and recall here count it as
   wrong.
4. **A miss auditor** counted potholes no model boxed on every second frame of videos 1-3: one
   physical pothole, in video 1. Video 4's audit found 19 frame-level misses.
5. **What reaches the map.** The full pipeline (12 fps, tracking, confirmation, the exported
   ONNX) ran each setup on each video (`ai/evaluation/run_merged.py` for the merge: union, NMS
   at IoU 0.5). Both judges labelled all 100 reported potholes from shuffled evidence crops;
   they agreed on 89 (kappa 0.52).
6. **Intervals:** block bootstrap over 6-frame blocks, 2000 resamples (`score_sets.py`).

## Results by video (frame level, unsure counted as wrong)

| Setup | Video 1 | Video 2 | Video 3 | Video 4 |
| --- | --- | --- | --- | --- |
| Judged potholes | 0 (1 unsure) | 23 | 21 | 87 |
| Current at 0.35: precision / recall | no boxes | 67% / 43% | 40% / 19% | 86% / 37% |
| Current at 0.25 | no boxes | 59% / 56% | 31% / 24% | 90% / 62% |
| mfranzon at 0.35 | 6 false boxes | 28% / 30% | 50% / 52% | 94% / 53% |
| Merge at 0.35 | 6 false boxes | 41% / 74% | 56% / 86% | 91% / 70% |

All four videos pooled, with 95% intervals: current at 0.25 precision 0.74 [0.57-0.88], recall
0.55 [0.35-0.75]; merge at 0.35 precision 0.66 [0.54-0.77], recall 0.73 [0.68-0.78]. Full tables:
`ai/evaluation/pooled/scores-four-videos.txt`.

## Video 2 and the stretch by Osiyo Grand

The team marked potholes on the side road north of Osiyo Grand (about 1.5-7.5 s into video 2).
Both judges rejected every box the models drew there (windscreen marks, flat patches), and the
auditor found no clear hole that every model missed: the surface there is worn and patched.
The clip's real potholes start at the broken strip at the parking entrance (8.25 s) and
continue through the parking lot and the road behind the building (15.75-25 s).

## Same result on a Colab T4

`ai/colab/model_comparison_t4.ipynb` ran the three models on the four videos on a Tesla T4
through the Colab CLI. All 547 boxes at 0.25 or above paired with the Mac's; confidences differ
in the third decimal (PyTorch 2.11 with CUDA there, 2.13 here), which moves a few boxes across
a threshold and the scores by 1-2 points. The verdict does not change. On the Mac, GPU and CPU
agree exactly.

## How far to trust this

- **Footage:** four videos, about 73 seconds, mostly damaged roads, all in daylight. An earlier
  test on two smooth-road clips (not part of this comparison; its data stays in
  `ai/evaluation/pooled/sets.json`) found mfranzon firing on manhole covers and lane paint about
  11 times a minute.
- **Judges:** AI, not road engineers. On the reported potholes they agreed only moderately
  (kappa 0.52), mostly over puddles in gravel in video 4. Every verdict is saved
  (`ai/evaluation/pooled/*.consensus.json`) for a person to spot-check.
- **Recall is relative to the pool** of boxes the models drew, except where the auditor's
  misses are counted.

## Reproduce

```bash
.venv/bin/python -m ai.evaluation.run_detector --weights <model.pt> --images <frames> \
  --out output/model-eval/sets/<video>/preds/<model>.json --imgsz 640 --device mps --threshold 0.05
.venv/bin/python -m ai.evaluation.pool_review --frames <frames> --preds <preds-dir> \
  --out <review-dir> --every 1 --target pothole --blind
.venv/bin/python -m ai.evaluation.score_sets --config ai/evaluation/pooled/sets-four-videos.json
# what reaches the map, for the merge:
.venv/bin/python -m ai.evaluation.run_merged --models a.onnx b.onnx c.onnx -- \
  --input <video> --confidence 0.35 --json report.json --crops-dir crops
# a re-run (another GPU, a new export, a fine-tuned model), scored without judging again:
.venv/bin/python -m ai.evaluation.score_sets --config ai/evaluation/pooled/sets-four-videos.json \
  --preds-root <dir>   # <dir>/<video>/<model>.json; boxes on no judged cluster: "unjudged"
# the same comparison on a Colab T4:
.venv/bin/python -m ai.colab.build_bundle ai/colab/bundles/four-videos.json \
  output/colab/pothole-colab-four-videos.zip
```
