# Architecture

## Principle

The phone is the sensor. Camera, GPS and optionally IMU feed a detection client that
produces *pothole events*; a backend turns repeated events into *physical potholes* on a
private map. Nothing depends on a vehicle manufacturer's API.

```text
Phone camera + GPS
        |
        v
Detection client  (browser inference, this repository)
        |
        v
Pothole event  ---> Backend API ---> Image storage
                          |
                          v
                    PostgreSQL/PostGIS ---> Internal map
```

Milestone 0 implements the detection client's pipeline and exercises it against video
files. Everything to the right of "Pothole event" arrives with the backend milestone.

## The local pipeline

```text
frame
  |
  v
VisionEngine.infer()          normalised detections, our schema
  |
  v
TrackManager.update()         one track per physical pothole
  |
  +--> BestFrameSelector      strongest evidence frame
  |
  v
SeverityEngine.calculate()    visual severity at finalisation
  |
  v
finalised track  ->  event
```

### VisionEngine

```ts
interface VisionEngine {
  init(): Promise<void>;
  infer(source: CanvasImageSource): Promise<Detection[]>;
  dispose(): Promise<void>;
}
```

Three implementations, selected by `createVisionEngine`:

| Engine | When | Notes |
| --- | --- | --- |
| `OnnxVisionEngine` | A model manifest is deployed | WebGPU, falling back to WASM |
| `ServerVisionEngine` | An inference endpoint is configured | For devices where browser inference is unavailable or too slow |
| `MockVisionEngine` | Neither is available | Deterministic synthetic output, always labelled as such |

Selection is never silent: the chosen engine carries a `selectionReason` that the UI
displays. Product code depends only on the interface and on our own `Detection` type;
a model's native output layout is normalised inside `postprocess/` and never leaks out.

### Coordinates

Every bounding box crossing a module boundary is **normalised to 0..1** against the
source frame. That keeps tracking, severity and overlay rendering independent of camera
resolution, video resolution and model input size. Pixels appear only in rendering and
cropping code.

### Tracking

One pothole appears in many consecutive frames; counting each frame separately would
inflate results by an order of magnitude. Association is IoU-based with two additions
that the geometry forces:

1. **Motion prediction with an acceleration term.** Under perspective, a pothole's row
   position and apparent size both accelerate as the vehicle closes in. A
   constant-velocity model lags exactly at close range, which is where the largest and
   clearest observations are.
2. **A proximity fallback gate.** At 4–10 FPS a pothole near the vehicle can travel
   further than its own height between analysed frames, at which point IoU is exactly
   zero however good the prediction was. A detection whose centre is close to the
   prediction, and whose size is comparable, is still accepted. Proximity matches always
   score below the IoU gate, so real overlap wins the assignment.

Without these, tracks break at close range: the tail of every track splits into
one-observation fragments that fail the confirmation rules, so the pothole count inflates
and severity — which reads the peak area — is measured from far too far back.

ByteTrack or optical flow can replace this later without changing the interface.

### Track lifecycle

```text
CANDIDATE -> TRACKING -> CONFIRMED -> FINALIZED -> PENDING_UPLOAD -> UPLOADED
                    \
                     -> REJECTED_LOW_CONFIDENCE
```

A track is promoted to `CONFIRMED` only when it has enough observations, a high enough
peak confidence and a long enough duration — all configured, none hard-coded.
`REJECTED_LOW_CONFIDENCE` covers every promotion-rule failure: to the pipeline they are
all "not enough evidence". Rejected tracks are counted and reported rather than silently
discarded, because the count is what tells an operator whether the thresholds are right.

`PENDING_UPLOAD` and `UPLOADED` belong to the offline event queue and arrive with the
upload pipeline.

### Trigger region

The lower band of the frame. A pothole reaching it is close to the vehicle, which is when
both its apparent size and the vehicle's GPS position are most trustworthy. Severity is
measured there when possible; saving a location the moment a distant pothole first
appears would place the marker many metres too early.

### Severity

Visual severity only, derived from the peak normalised area observed near the trigger
region, mapped through a square-root curve and cut into bands from configuration. It is
deliberately *not* a detector class, so it can be retuned — or later upgraded with depth
estimation and IMU shock — without retraining the detector.

### Best frame

The first frame of a track is usually the worst: the pothole is far away, small and often
clipped. Candidates are scored as a weighted product of detector confidence, visible
area, sharpness (variance of the Laplacian) and distance from the frame edge. Scoring
runs every frame because it is cheap; encoding runs only when a candidate wins.

## Configuration

`ai/configs/vision.yaml` is canonical. `packages/vision-web/src/config/vision-config.ts`
mirrors it because a browser cannot read YAML from the repository at runtime, and
`vision-config.test.ts` parses the YAML and fails the build if they diverge. Python reads
the YAML directly.

## Video analysis

Both implementations analyse `ceil(duration x sampleFps)` frames, at times
`0, 1/fps, 2/fps, ...` strictly before the end of the video - there is no frame at exactly
`duration`. Keeping that bound identical is what makes the browser and the CLI comparable
on the same file.

`/analyze` seeks to fixed media times rather than sampling playback: playback-rate
sampling would make results depend on decode speed, and re-analysing a file would give a
different report. The Python CLI runs two passes — analyse, then render — because a
track's severity is only known once it finalises, which happens after the pothole has
left the frame.

## What is deliberately absent

No OEM or CAN integrations, no LLM in the detection path, no continuous video upload, no
microservices, no Kafka, no Kubernetes, and no physical dimension or depth claims.
