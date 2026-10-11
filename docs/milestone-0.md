# Milestone 0 — video analysis

Isolates detector quality from browser, device and network complexity. Nothing from later
milestones is stubbed in.

## Delivered

**Browser (`/analyze`)**

- Choose an MP4/MOV/WebM recording and preview it
- Deterministic sampling at a configurable rate (6 FPS by default)
- Detection overlay with confidence, visual severity and the trigger region
- Detections the pipeline did *not* count are drawn dimmed, so raw model output and
  counted potholes can be compared at a glance
- Unique pothole count, severity breakdown, average confidence, rejected-track count and
  inference latency
- Clickable detection timeline that seeks the video to the evidence frame
- Evidence crop and full frame per pothole, chosen by `BestFrameSelector`
- JSON report download
- Location explicitly reported as unavailable; coordinates are never invented

**Command line**

```bash
python -m ai.inference.video --input ./input.mp4 --output ./annotated.mp4
```

Annotated MP4 plus `detections.json` in the same schema as the browser, optional evidence
crops per pothole, and a summary on stdout.

**Shared**

- `VisionEngine` with ONNX, server and synthetic implementations
- `TrackManager`, `SeverityEngine`, `BestFrameSelector`, trigger region
- One canonical configuration file, enforced across both implementations by a test

## Verification

```bash
npm run verify                        # lint, types, unit tests, production build
.venv/bin/python -m pytest            # AI pipeline and CLI
.venv/bin/ruff check ai/              # Python lint
```

Post-processing is tested against hand-built tensors on both sides, because no trained
weights live in the repository: that is what catches a transposed output layout, a
forgotten letterbox offset or a broken NMS.

The synthetic engine is deterministic and bit-compatible across TypeScript and Python, and
both implementations sample the same frame times and emit the same schema. The same clip
therefore yields identical `analysis`, `summary` and `tracks` from the browser and from the
CLI - verified on a 20 s clip: 120 frames analysed, 101 raw detections, 5 potholes
(1 large / 3 medium / 1 small), matching track ids, times, areas and scores. Only
`generatedAt` and the wording of `engine.selectionReason` differ, because the two select
their detector by different routes. That equivalence is itself a check on both
implementations.

## Not in this milestone

Live camera, GPS, the event state machine beyond `FINALIZED`, the offline upload queue,
the backend, the map, deduplication, and human review. `/drive`, `/map`, `/potholes`,
`/dashboard` and `/review` appear in the navigation as unavailable, with the milestone
that will deliver them.

## Known limitations

- **No trained model ships with the repository.** Without one, `/analyze` and the CLI run
  the synthetic engine. Every surface says so; no output is presented as a model reading.
- **The ONNX path is implemented but unverified**, because there are no weights to run it
  against. Post-processing is covered by synthetic-tensor tests; the runtime integration
  needs a real model to confirm.
- **Tracking is IoU-based** with motion prediction and a proximity fallback. It handles
  the single-lane case the MVP targets; dense scenes with many overlapping defects will
  need ByteTrack.
- **End-to-end browser tests are not set up.** Playwright arrives with the live-camera
  milestone, where permission and device states genuinely need it.
