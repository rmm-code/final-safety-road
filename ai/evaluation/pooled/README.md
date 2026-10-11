# Pooled reference sets

A ground-truth substitute for clips nobody has labelled. Every candidate's boxes are
pooled and clustered (`ai/evaluation/pool_review.py`). Two independent, blind judges label
every cluster; where they disagree, the consensus is "unsure" and it is scored both ways.
`ai/evaluation/score_sets.py` scores any candidate against the consensus, with block-bootstrap
intervals.

A re-run needs no new judging. `score_sets --preds-root DIR` reads `DIR/<set name>/<model>.json`,
seats each box on the judged cluster it overlaps (the rule that built the clusters) and counts
boxes that land on none as unjudged, never scoring them. Seating the original predictions
reproduces `scores.json` exactly.

| File | What |
| --- | --- |
| `sets.json` | the scoring config: every set, its clusters, consensus verdicts and frame list |
| `tashkent-clip.clusters.json` | 96 pothole clusters, 18 frames of `samples/AQM2jw….mp4` (broken road) |
| `tashkent-clip-pothole.consensus.json` | judges A and B, plus the consensus |
| `tashkent-clip.verdicts.json` | the first, single-judge review (2026-10-10), kept for history |
| `dashcam-0939-{pothole,crack}.*` | `samples/2026-05-21-09-39-29.mp4`, 234 frames at 2 fps |
| `dashcam-1215-{pothole,crack}.*` | `samples/2026-05-21-12-15-16.mp4`, 240 frames at 2 fps |
| `events.key.json`, `events.consensus.json` | the 41 potholes the pipeline reported, with their judgments |
| `scores.json`, `scores.txt` | the results in `docs/model-comparison.md` |

Keep each clusters file with its verdicts: verdicts refer to cluster ids, and re-running
`pool_review` renumbers them. The frames are regenerated from the sample videos (see
`docs/model-comparison.md`, Reproduce).
