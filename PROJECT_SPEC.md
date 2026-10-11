# Pothole Intelligence System
## Technical Specification, Architecture, System Design, and Build Plan

**Version:** 1.0  
**Status:** Build-ready MVP specification  
**Primary use case:** Internal road-damage detection and mapping from a phone mounted in a moving vehicle.

---

# 1. Product Goal

Build a web-based internal service that can:

1. Open the rear camera of a phone mounted on a vehicle windshield.
2. Analyze the road continuously while the vehicle is moving.
3. Detect potholes in near real time.
4. Track each pothole across multiple frames.
5. Assign a visual severity: `small`, `medium`, or `large`.
6. Capture and upload the best pothole image automatically.
7. Read the phone's current GPS location.
8. Estimate the pothole's actual road location rather than blindly saving the first detection location.
9. Store the event in a geospatial database.
10. Deduplicate repeated sightings of the same pothole.
11. Display potholes as points on a private internal map.
12. Let an operator click a marker and see photo, severity, confidence, first seen, last seen, number of sightings, and status.
13. Later support multiple drivers/vehicles and continuously update road condition data.
14. Later add contractor/tender/complaint workflows.

This system must not depend on BYD, Li Auto, Mercedes, or any OEM-specific API in Version 1.

---

# 2. Key Product Principle

The phone is the sensor.

The first product architecture is:

```text
Phone Camera
    +
Phone GPS
    +
Optional Phone IMU
        |
        v
Road Detection Client
        |
        v
Pothole Event
        |
        v
Backend API
        |
        +--------> Image Storage
        |
        +--------> PostgreSQL/PostGIS
                           |
                           v
                    Internal Map
```

This makes the solution vehicle-independent.

---

# 3. What AI Does and Does Not Do

## 3.1 Detection

The computer-vision model answers:

> "Is there a pothole in this frame, and where is it?"

Recommended task:

**Instance segmentation**, not only bounding-box detection, once the MVP detector works.

Why segmentation?

A bounding box tells us:

```text
+----------------+
|    pothole     |
+----------------+
```

A segmentation model tells us the actual visible pothole shape.

That gives better information for:

- visual size
- visible surface area
- shape
- severity heuristics
- future depth/area estimation

Start with detection if it is easier, then migrate to segmentation.

## 3.2 Severity

Do not claim physical dimensions in centimeters from a single normal phone camera in V1.

V1 severity means **visual severity**, not engineering-grade measurement.

Recommended classes:

```text
small
medium
large
unknown
```

Severity should be calculated by a separate `SeverityEngine`, not trained as three separate YOLO classes initially.

Inputs can include:

- segmentation mask area
- position in the frame
- how large the pothole becomes as the car approaches
- persistence across frames
- estimated distance from camera
- optional IMU shock
- optional monocular depth model later

Example:

```text
YOLO:
class = pothole
confidence = 0.93
mask = ...

SeverityEngine:
visual_severity = large
severity_confidence = 0.81
```

Keeping detection and severity separate lets us improve severity without retraining the entire detector.

---

# 4. Recommended Technology Stack

## Client / Driver Web App

- Next.js
- React
- TypeScript
- PWA
- `navigator.mediaDevices.getUserMedia()` for camera
- `navigator.geolocation.watchPosition()` for GPS
- Device Motion / Generic Sensor APIs when available for IMU
- ONNX Runtime Web
- WebGPU when supported
- WASM fallback
- Canvas/WebGL overlay for bounding boxes/masks
- Screen Wake Lock where supported

## Admin Dashboard

- Next.js
- React
- TypeScript
- MapLibre GL JS
- OpenStreetMap-compatible map tiles
- TanStack Query
- optional Zustand for client state

## Backend

Recommended:

- Python 3.12+
- FastAPI
- SQLAlchemy 2
- Alembic
- Pydantic

Why Python?

The AI ecosystem is strongest there and it keeps model training, server inference, evaluation, and APIs in one language.

## Database

- PostgreSQL
- PostGIS

PostGIS is important because we need:

- nearby-point searches
- distance calculations
- map bounding-box queries
- road-segment matching later
- clustering/deduplication

## Object Storage

Use one:

- MinIO for self-hosting
- Cloudflare R2
- AWS S3
- any S3-compatible provider

Do not store image bytes directly in PostgreSQL.

## Optional Infrastructure

- Redis for queues/caching
- Celery / Dramatiq / RQ for background jobs
- Nginx or Caddy
- Docker Compose for the MVP

---

# 5. AI Model Strategy

## 5.1 Training Dataset

Start with RDD2022.

RDD2022 includes road-damage images from multiple countries and includes potholes plus several crack types.

For our MVP, normalize the source labels into:

```text
pothole
```

Optionally retain:

```text
longitudinal_crack
transverse_crack
alligator_crack
pothole
```

But the first production product should focus on potholes only.

## 5.2 Uzbekistan Fine-Tuning

A model trained only on international road images will not be enough for production.

Build a local dataset.

Target phases:

```text
Phase A:
RDD2022 only

Phase B:
RDD2022 + 1,000 validated Uzbekistan frames

Phase C:
RDD2022 + 5,000-10,000 Uzbekistan frames

Phase D:
Continuously retrain using difficult production examples
```

Collect:

- sunny roads
- cloudy roads
- shadows
- wet roads
- nighttime
- different asphalt
- small potholes
- very large potholes
- patched roads
- manholes
- speed bumps
- dark stains
- puddles
- road debris

Negative examples are extremely important.

The model must learn that these are NOT potholes:

- shadows
- puddles
- repaired asphalt
- road paint
- manholes
- expansion joints
- oil stains

## 5.3 Model

Recommended initial model:

```text
YOLO26n
```

or a small segmentation variant if performance is acceptable.

Use the nano/small model for edge inference.

Model pipeline:

```text
training data
     |
     v
YOLO training
     |
     v
best.pt
     |
     +----> Python server inference
     |
     +----> export ONNX
                   |
                   v
          browser inference
```

## 5.4 Licensing Warning

Before a proprietary commercial launch, review the model/framework license.

Keep the AI layer abstract so another detector can be swapped in without rewriting the product.

Create interface:

```ts
interface VisionEngine {
  initialize(): Promise<void>;
  infer(frame: ImageBitmap): Promise<Detection[]>;
  dispose(): Promise<void>;
}
```

Implement:

```text
OnnxVisionEngine
ServerVisionEngine
MockVisionEngine
```

Do not couple the frontend directly to Ultralytics-specific objects.

---

# 6. Inference Architecture

Use a hybrid architecture.

## Mode A — Browser / Edge Inference

```text
Phone Camera
    |
    v
Frame Sampler
    |
    v
Resize / Normalize
    |
    v
ONNX Runtime Web
    |
    v
WebGPU
    |
    v
Detections
```

Benefits:

- low server cost
- video remains on device
- low latency
- scalable to many cars

Only events/images need to be uploaded.

## Mode B — Server Inference Fallback

```text
Phone Camera
    |
    v
Frame Sampler
    |
    v
JPEG/WebP frame
    |
    v
WebSocket/API
    |
    v
GPU/CPU inference server
    |
    v
Detection result
```

Use this when:

- WebGPU is unavailable
- browser inference is too slow
- debugging model differences
- testing before ONNX export is ready

Do not permanently stream 30 FPS to the server unless necessary.

For MVP target:

```text
camera = 30 FPS
AI inference = 4-10 FPS
UI overlay = 30/60 FPS
GPS sampling = approximately 1 Hz or as delivered by browser
```

The detector does not need every video frame.

---

# 7. Client-Side Capture Pipeline

## 7.1 Start Session

User opens:

```text
/drive
```

and taps:

```text
START DRIVE
```

App requests:

1. Camera permission
2. Location permission
3. Optional motion permission
4. Wake lock where supported

Then backend creates:

```text
drive_session
```

## 7.2 Camera

Prefer the outward-facing rear camera.

Example constraints:

```ts
{
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 }
  },
  audio: false
}
```

1080p input is acceptable, but the inference tensor should be much smaller.

Do not run inference at native camera resolution.

## 7.3 Frame Sampling

Maintain camera rendering independently from AI inference.

Pseudo logic:

```text
camera frame
    |
    +----> screen preview
    |
    +----> Is inference engine free?
                |
              yes
                |
                v
          sample frame
                |
                v
             infer
```

Never create an unlimited inference queue.

If the model is busy, skip frames.

The system should favor **fresh frames**, not process old frames late.

---

# 8. Detection Tracking

A single pothole will appear in many consecutive frames.

Never upload each detection as a new pothole.

Create a local `TrackManager`.

Example:

```text
Frame 100 -> pothole A
Frame 104 -> pothole A
Frame 108 -> pothole A
Frame 112 -> pothole A
Frame 116 -> pothole A
```

These become:

```text
Track #45
```

Track data:

```ts
type PotholeTrack = {
  localTrackId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  maxConfidence: number;
  detections: DetectionObservation[];
  bestFrame?: CapturedFrame;
  finalized: boolean;
};
```

Tracking options:

- IoU matching for V0
- ByteTrack later
- optical flow later

V0 does not need sophisticated tracking.

---

# 9. Best Image Selection

Do not upload the first detected frame automatically.

The first frame often shows a tiny distant pothole.

Maintain the best frame across the track.

Score candidates using:

```text
imageScore =
  detectionConfidence
  * visibleAreaScore
  * sharpnessScore
  * centerVisibilityScore
```

Avoid frames where:

- object touches image edge
- blur is high
- pothole is too far away
- vehicle hood blocks most of it

At track finalization:

```text
best frame -> crop -> WebP/JPEG -> upload
```

Optionally keep:

1. full road frame
2. cropped pothole image

---

# 10. GPS / Geolocation Design

The map itself does not determine the phone's position.

The browser obtains the coordinates from the device through the Geolocation API.

Maintain a timestamped ring buffer:

```ts
type LocationSample = {
  timestamp: number;
  lat: number;
  lng: number;
  accuracyM: number;
  speedMps: number | null;
  headingDeg: number | null;
};
```

Keep the last 30-60 seconds.

Example:

```text
21:41:11.000 -> 41.311...
21:41:12.000 -> 41.311...
21:41:13.000 -> 41.312...
```

Every camera detection also has a timestamp.

This allows us to correlate:

```text
video time <-> location time
```

---

# 11. Pothole Geolocation

This is one of the most important algorithms.

## Problem

The car can detect the pothole before reaching it.

If we save GPS at first sight:

```text
car GPS ------- 15m ------- pothole
```

the marker is wrong.

## V0

Save the GPS when the tracked pothole reaches a predefined lower region of the camera frame.

Define virtual line:

```text
+-----------------------+
|                       |
|       road            |
|                       |
|         []            |
|         []            |
|-----------------------| <- trigger zone
|                       |
+-----------------------+
```

When the pothole centroid/mask passes into this zone, capture the nearest GPS sample.

## V1

Estimate distance using:

- calibrated camera height
- camera pitch
- image geometry
- heading
- GPS speed

Then project a point ahead of the car.

```text
estimated pothole coordinate =
vehicle coordinate
+ distance along vehicle heading
```

## V2

Fuse:

- camera estimate
- GPS
- IMU impact timestamp
- repeated sightings

## Accuracy Rule

Store uncertainty.

Every pothole event should have:

```text
location_accuracy_m
```

Never pretend a consumer phone location is exact.

---

# 12. Severity Engine

## V0 Severity

Use normalized visible area near the trigger region.

Example concept:

```text
mask_area / road_region_area
```

Then thresholds:

```text
small
medium
large
```

Do not hard-code thresholds permanently.

Put them in configuration.

Example:

```yaml
severity:
  small_max_score: 0.30
  medium_max_score: 0.65
```

## V1 Severity Features

Create feature vector:

```text
mask relative area
mask width
mask height
estimated distance
persistence
max apparent area
road lane width ratio
optional shock magnitude
```

Use a small classifier or regression model.

## V2 Engineering Severity

If actual dimensions/depth are required, add:

- camera calibration
- monocular depth estimation
- stereo/depth camera
- LiDAR
- repeated geometry
- calibrated reference plane

Until then, label the UI:

```text
Visual severity
```

not:

```text
Physical pothole size
```

---

# 13. Event Creation Logic

A local track becomes a server candidate only if rules pass.

Example:

```text
minimum observations: 3
minimum max confidence: 0.60
minimum track duration: 200 ms
best image exists: yes
GPS sample exists: yes
```

Then create:

```json
{
  "driveSessionId": "uuid",
  "clientEventId": "uuid",
  "detectedAt": "ISO-8601",
  "confidence": 0.92,
  "severity": "large",
  "severityConfidence": 0.78,
  "latitude": 41.3112,
  "longitude": 69.2797,
  "locationAccuracyM": 8.4,
  "headingDeg": 123.0,
  "speedMps": 8.9,
  "modelVersion": "pothole-yolo-0.1.0"
}
```

Upload metadata and image.

---

# 14. Server-Side Deduplication

100 cars should not create 100 potholes for one physical hole.

Use two concepts:

```text
Detection Event
Physical Pothole
```

A `detection_event` is one observation.

A `pothole` is the persistent real-world entity.

## V0 Dedup

For every incoming event:

1. Search active potholes within approximately 10 meters.
2. Compare severity loosely.
3. Compare road direction if available.
4. If one good candidate exists, attach observation.
5. Otherwise create a new pothole.

Use PostGIS:

```sql
ST_DWithin(...)
```

Tune radius based on actual GPS accuracy.

## V1 Dedup

Add:

- same road segment
- direction of travel
- image similarity embedding
- lane estimate
- temporal evidence
- clustering

## Important

Do not merge opposite carriageways just because GPS points are close.

Road and heading information becomes important on divided roads.

---

# 15. Pothole Lifecycle

Statuses:

```text
active
suspected_repaired
repaired
false_positive
ignored
archived
```

Example rules:

```text
First detection:
active

More detections:
update last_seen_at
increase sighting_count

No detections after repeated passes:
suspected_repaired

Human confirms:
repaired
```

Later, the system can automatically detect road repair.

---

# 16. Core Database Schema

Enable PostGIS.

## users

```text
id UUID PK
email
name
role
created_at
```

Roles:

```text
admin
operator
driver
viewer
```

## devices

```text
id UUID PK
user_id FK
device_name
platform
browser
last_seen_at
created_at
```

## vehicles

Optional for V0.

```text
id UUID PK
name
plate_number nullable
vehicle_type
camera_height_cm nullable
created_at
```

## drive_sessions

```text
id UUID PK
user_id FK
device_id FK
vehicle_id FK nullable
started_at
ended_at nullable
distance_m nullable
status
created_at
```

## potholes

```text
id UUID PK
location GEOGRAPHY(Point, 4326)
location_accuracy_m REAL
severity VARCHAR
severity_score REAL
status VARCHAR
first_seen_at TIMESTAMPTZ
last_seen_at TIMESTAMPTZ
sighting_count INTEGER
primary_image_key TEXT
road_name TEXT nullable
road_segment_id TEXT nullable
created_at
updated_at
```

Indexes:

```text
GIST(location)
status
last_seen_at
severity
```

## detection_events

```text
id UUID PK
pothole_id UUID FK nullable
drive_session_id UUID FK
client_event_id UUID UNIQUE
location GEOGRAPHY(Point, 4326)
location_accuracy_m REAL
detected_at TIMESTAMPTZ
confidence REAL
severity VARCHAR
severity_score REAL
heading_deg REAL nullable
speed_mps REAL nullable
model_version TEXT
full_image_key TEXT nullable
crop_image_key TEXT nullable
metadata JSONB
created_at
```

## model_versions

```text
id UUID PK
name
version
task
dataset_version
metrics JSONB
active BOOLEAN
created_at
```

## pothole_status_history

```text
id UUID PK
pothole_id UUID FK
old_status
new_status
reason
changed_by UUID nullable
created_at
```

---

# 17. API Design

Prefix:

```text
/api/v1
```

## Authentication

```text
POST /auth/login
POST /auth/refresh
GET  /auth/me
```

For an internal MVP, use simple secure authentication.

## Drive Sessions

```text
POST /drive-sessions
GET  /drive-sessions/:id
POST /drive-sessions/:id/end
```

## Detection Events

```text
POST /detections
POST /detections/:id/image
GET  /detections/:id
```

Better production flow:

1. create event metadata
2. backend returns signed upload URL
3. client uploads image directly to object storage
4. client/backend confirms upload

This prevents large images from flowing through the API server.

## Potholes

```text
GET   /potholes
GET   /potholes/:id
PATCH /potholes/:id
POST  /potholes/:id/status
```

Map query:

```text
GET /potholes?bbox=minLng,minLat,maxLng,maxLat
```

Filters:

```text
severity
status
seen_after
seen_before
minimum_sightings
```

## Dashboard

```text
GET /stats/overview
GET /stats/severity
GET /stats/detections-over-time
```

---

# 18. Internal Map

Use MapLibre GL JS.

Dashboard layout:

```text
+-----------------------------------------------------+
| Pothole Intelligence       Filters        Account   |
+------------------+----------------------------------+
|                  |                                  |
| Active 1,284     |                                  |
| Large 184        |              MAP                 |
| Medium 637       |                                  |
| Small 463        |       • •   •                    |
|                  |                                  |
| Last 24h: 87     |                                  |
|                  |                                  |
+------------------+----------------------------------+
```

Marker styling:

```text
small  -> green
medium -> yellow/orange
large  -> red
```

Use clustering when zoomed out.

When clicked:

```text
Pothole #PH-001824

[image]

Visual severity: Large
Detection confidence: 94%
Sightings: 12
First seen: Aug 10
Last seen: Aug 16
Location accuracy: ±8 m
Status: Active

[View history]
[Mark repaired]
[False positive]
```

---

# 19. Map Tile Architecture

There are two separate things:

```text
Base map
Your pothole data
```

OpenStreetMap is geospatial data.

MapLibre renders the map in the browser.

For initial internal testing, use a compatible tile provider.

For larger scale, do not abuse public community tile infrastructure. Use a proper tile provider or self-host tiles.

Your pothole database remains private.

---

# 20. Frontend Routes

Recommended:

```text
/login
/drive
/dashboard
/map
/potholes
/potholes/[id]
/drives
/drives/[id]
/models
/settings
```

## `/drive`

Must be optimized for phone portrait/landscape.

Display only essential data while driving:

```text
LIVE

Camera preview

AI: Running
GPS: ±7m
FPS: 7
Detected: 4

[STOP]
```

Avoid requiring driver interaction while moving.

---

# 21. Backend Service Boundaries

Do not begin with microservices.

Use a modular monolith.

```text
FastAPI Application
|
+-- auth
+-- users
+-- drives
+-- detections
+-- potholes
+-- geospatial
+-- storage
+-- inference
+-- deduplication
+-- analytics
```

This is easier for Claude Code, easier to test, and easier to deploy.

Split services only when load justifies it.

---

# 22. Repository Architecture

Recommended monorepo:

```text
pothole-intelligence/
|
+-- apps/
|   |
|   +-- web/
|   |   +-- app/
|   |   +-- components/
|   |   +-- features/
|   |   |   +-- drive/
|   |   |   +-- map/
|   |   |   +-- potholes/
|   |   |   +-- dashboard/
|   |   +-- lib/
|   |   +-- public/
|   |
|   +-- api/
|       +-- app/
|           +-- api/
|           +-- core/
|           +-- db/
|           +-- models/
|           +-- schemas/
|           +-- services/
|           +-- repositories/
|           +-- workers/
|           +-- tests/
|
+-- ai/
|   +-- datasets/
|   +-- training/
|   +-- evaluation/
|   +-- export/
|   +-- inference/
|   +-- configs/
|
+-- packages/
|   +-- shared-types/
|   +-- vision-web/
|
+-- infra/
|   +-- docker/
|   +-- nginx/
|   +-- scripts/
|
+-- docs/
|   +-- architecture.md
|   +-- api.md
|   +-- ai.md
|   +-- geolocation.md
|
+-- docker-compose.yml
+-- CLAUDE.md
+-- README.md
```

---

# 23. Browser Vision Package

Create:

```text
packages/vision-web
```

Responsibilities:

- load ONNX model
- select execution provider
- preprocess frames
- perform inference
- postprocess output
- return normalized detections
- expose performance stats

API:

```ts
export type Detection = {
  classId: number;
  className: "pothole";
  confidence: number;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  polygon?: Array<[number, number]>;
};

export interface VisionEngine {
  init(): Promise<void>;
  infer(source: CanvasImageSource): Promise<Detection[]>;
  dispose(): Promise<void>;
}
```

---

# 24. Performance Requirements

MVP targets, not strict guarantees:

```text
UI preview: smooth
AI inference: >= 4 FPS preferred
detection event latency: < 1 second preferred
map API p95: < 500 ms
image upload: asynchronous
```

Adaptive performance:

```text
if inference > 200 ms:
  reduce inference FPS

if device is hot:
  reduce inference resolution

if GPS unavailable:
  do not create geolocated event

if network unavailable:
  queue event locally
```

---

# 25. Offline Design

This is important for driving.

Use IndexedDB.

If connection disappears:

```text
Detection
   |
   v
IndexedDB Queue
   |
   v
Network returns
   |
   v
Upload metadata/image
```

Each event has a `client_event_id` UUID.

The backend treats it idempotently.

This prevents duplicates after retries.

---

# 26. Privacy and Storage

Default behavior:

- do not upload continuous video
- upload only pothole evidence frames
- optionally crop to road region
- automatically blur faces/license plates later if necessary
- retain model/debug footage only with explicit admin mode

This keeps bandwidth and storage manageable.

---

# 27. Observability

Backend:

- structured JSON logs
- request ID
- Sentry or equivalent
- Prometheus later

Track AI metrics:

```text
inference_ms
inference_fps
detections_per_km
events_uploaded
events_rejected
dedup_merge_rate
false_positive_rate
model_version
device type
```

These metrics will tell us whether the model actually works.

---

# 28. Model Evaluation

Do not judge the model only from training loss.

Maintain a private Uzbekistan test set that is never used in training.

Track:

```text
precision
recall
mAP
false positives per driving hour
missed potholes per driving hour
event-level precision
```

For the actual product, the most understandable KPI is:

```text
Of 100 potholes a person sees, how many did we catch?

Of 100 detections produced by the system, how many were real?
```

---

# 29. Human Review Workflow

Build a review screen early.

```text
/review
```

Show candidate images:

```text
[image]

Model: pothole 87%

[Correct]
[Not pothole]
[Small]
[Medium]
[Large]
```

Those labels become future training data.

This creates a continuous improvement loop:

```text
production
    |
difficult examples
    |
human review
    |
new dataset
    |
retrain
    |
new model
```

---

# 30. Model Registry

Never overwrite model files without versioning.

Example:

```text
pothole-detector-0.1.0
pothole-detector-0.2.0
pothole-detector-0.3.0
```

Every detection records:

```text
model_version
```

Then you can compare models accurately.

---

# 31. Security

Minimum:

- HTTPS only
- secure authentication
- JWT/session rotation
- RBAC
- signed object-storage URLs
- rate limiting
- server-side file validation
- image size limits
- CORS restricted to your domains
- secrets outside Git
- DB not publicly reachable
- regular backups

Camera and geolocation browser permissions should only be requested on the drive page.

---

# 32. Docker Development Environment

Use Docker Compose for infrastructure.

Services:

```text
postgres + postgis
redis
minio
api
web
```

AI training should not be forced into the normal web development container.

Example logical topology:

```text
Browser
   |
   v
Nginx
   |
   +------ / --------> Next.js
   |
   +------ /api -----> FastAPI
                         |
              +----------+----------+
              |                     |
           PostGIS                Redis
              |
           Object storage
```

---

# 33. Deployment

For initial internal use, one VPS is enough for everything except heavy model training.

```text
VPS
|
+-- Nginx
+-- Next.js
+-- FastAPI
+-- PostgreSQL/PostGIS
+-- Redis
+-- MinIO
```

If browser inference works, server GPU is unnecessary for normal driving.

Train models separately on:

- local NVIDIA machine
- rented GPU
- cloud notebook
- GPU VPS

Then export the final model and deploy it.

---

# 34. Build Phases

## Phase 0 — AI Feasibility

Goal:

Prove the detector works on local road footage.

Build:

```text
video file
  ->
Python YOLO inference
  ->
annotated output video
```

Acceptance:

The model detects obvious Tashkent potholes with tolerable false positives.

Do not build the whole product before this works.

## Phase 1 — Live Browser Camera

Build `/drive`.

Requirements:

- open rear camera
- render preview
- run model
- draw detection overlay
- show confidence
- show inference FPS

No backend requirement yet.

## Phase 2 — GPS

Add:

- location permission
- watchPosition
- location ring buffer
- show accuracy
- timestamp synchronization

Display:

```text
GPS ±8m
```

## Phase 3 — Tracking + Event Capture

Add:

- track manager
- trigger region
- best-frame selector
- visual severity
- event generation

For development, events can remain local.

## Phase 4 — Backend

Build:

- auth
- drive sessions
- detections
- object storage
- PostgreSQL/PostGIS

Upload:

- metadata
- pothole image

## Phase 5 — Map

Build:

- MapLibre
- bounding-box API
- markers
- clustering
- detail drawer/page

Now the core MVP is complete.

## Phase 6 — Deduplication

Implement:

```text
incoming detection
   ->
nearby search
   ->
merge/create pothole
```

Display:

```text
sighting count
first seen
last seen
```

## Phase 7 — Local Dataset

Add review tools.

Collect Tashkent examples.

Fine-tune model.

## Phase 8 — IMU

Add motion sensor input where browser/device support allows.

Use shocks as supporting evidence.

Do not make IMU mandatory.

## Phase 9 — Advanced Geolocation

Add:

- camera calibration
- heading projection
- map matching
- road segment identification

## Phase 10 — City Intelligence

Later:

- contractor/tender data
- road ownership
- repair tracking
- automated reports
- complaint generation
- route heatmaps
- fleet analytics

---

# 35. MVP Definition

The MVP is complete when:

```text
1. User opens website on phone.
2. User taps Start Drive.
3. Camera and GPS become active.
4. AI detects a real pothole.
5. System tracks it.
6. System chooses a useful image.
7. System determines visual severity.
8. System saves an approximate coordinate.
9. Image + event upload automatically.
10. Internal map displays the pothole.
11. Clicking marker shows details.
12. Seeing the same pothole again updates the existing pothole rather than always creating a duplicate.
```

Anything beyond that is V2.

---

# 36. Recommended Event State Machine

```text
IDLE
  |
candidate detected
  v
TRACKING
  |
enough observations
  v
CONFIRMED
  |
best frame + GPS
  v
FINALIZED
  |
queued locally
  v
PENDING_UPLOAD
  |
server accepted
  v
UPLOADED
```

Failure states:

```text
REJECTED_LOW_CONFIDENCE
REJECTED_NO_LOCATION
UPLOAD_RETRY
```

---

# 37. Deduplication Pseudocode

```python
def process_detection(event):
    nearby = find_active_potholes(
        point=event.location,
        radius_m=max(10, event.location_accuracy_m)
    )

    candidates = []

    for pothole in nearby:
        score = 0

        score += distance_score(event, pothole)
        score += heading_score(event, pothole)
        score += road_segment_score(event, pothole)

        if image_embeddings_available:
            score += visual_similarity_score(event, pothole)

        candidates.append((pothole, score))

    best = max(candidates, key=lambda x: x[1], default=None)

    if best and best.score >= MERGE_THRESHOLD:
        attach_detection(best.pothole, event)
        return best.pothole

    return create_new_pothole(event)
```

---

# 38. Client Detection Pseudocode

```ts
async function inferenceLoop() {
  if (!running) return;

  if (!visionEngine.isBusy()) {
    const frame = await captureCurrentFrame();
    const detections = await visionEngine.infer(frame);

    const potholes = detections.filter(
      d => d.className === "pothole" && d.confidence >= threshold
    );

    trackManager.update(potholes, {
      timestamp: performance.timeOrigin + performance.now(),
      latestLocation: locationBuffer.latest()
    });

    const finalized = trackManager.takeFinalizedTracks();

    for (const track of finalized) {
      const event = eventBuilder.fromTrack(track);
      await offlineQueue.enqueue(event);
    }
  }

  requestAnimationFrame(inferenceLoop);
}
```

---

# 39. Image Upload Flow

Recommended production pattern:

```text
client
  |
POST /detections
  |
backend saves metadata
  |
returns:
detection_id
signed_upload_url
  |
client uploads image directly
  |
object storage
  |
client confirms upload
```

This scales better than sending every image through FastAPI.

---

# 40. Open Questions to Resolve During Development

These should be answered experimentally, not guessed:

1. Which model input resolution gives the best phone speed/accuracy tradeoff?
2. How many inference frames per second are required at typical city driving speeds?
3. How reliable is WebGPU on the exact target phones/browsers?
4. How much better is segmentation than detection?
5. What trigger region gives the best GPS alignment?
6. What dedup radius works for Tashkent GPS conditions?
7. What visual-severity thresholds correlate with human judgment?
8. Does IMU materially improve precision?
9. How much nighttime performance degrades?
10. Should the final driver client remain a PWA or become a native iOS/Android app?

---

# 41. Do Not Build Yet

Do not start V1 by implementing:

- BYD APIs
- Li Auto APIs
- CAN bus
- vehicle ADAS camera access
- tender scraping
- Gemini
- DeepSeek
- automated government complaints
- complex microservices
- Kubernetes
- Kafka
- physical pothole depth claims

Those can be added after the core signal works.

---

# 42. Where an LLM Fits Later

YOLO/vision model:

```text
detect road damage
```

LLM such as Gemini:

```text
analyze documents
classify repair/tender responsibility
generate summaries
generate complaint drafts
reason over historical data
```

Do not use an LLM as the continuous frame-by-frame pothole detector.

---

# 43. Suggested Initial Milestone

The first milestone Claude Code should implement is only:

```text
Upload/choose local driving video
        |
        v
Run pothole detector
        |
        v
Render bounding boxes/masks
        |
        v
Produce annotated video + JSON detections
```

Then move to the live phone camera.

This isolates AI quality from browser/device complexity.

---

# 44. Acceptance Test for First Road Test

Mount the phone securely.

Drive a predefined route.

Separately record a human ground-truth list.

Compare:

```text
actual potholes: 30
system detected: 26
true detections: 23
false detections: 3
missed potholes: 7
```

Calculate event-level precision and recall.

Do not tune from impressions alone.

---

# 45. Final Architecture

```text
                         DRIVER PHONE
+------------------------------------------------------------+
|                                                            |
| Camera -> Frame Sampler -> Vision Engine -> Track Manager  |
|                                    |              |         |
| GPS -> Location Buffer ------------+--------------+         |
| IMU ----------------------------------------------+ optional |
|                                                   |         |
|                                        Severity Engine      |
|                                                   |         |
|                                        Best Frame Selector  |
|                                                   |         |
|                                         Event Builder       |
|                                                   |         |
|                                         Offline Queue       |
+---------------------------------------------------|---------+
                                                    |
                                                  HTTPS
                                                    |
                                                    v
+------------------------------------------------------------+
|                         API                                |
|                                                            |
| Auth | Drives | Detections | Potholes | Storage | Stats    |
|                  |             |                           |
|                  v             v                           |
|             Dedup Engine   Geospatial Service              |
+------------------|-------------|---------------------------+
                   |             |
                   v             v
              PostgreSQL + PostGIS
                   |
              Physical potholes
              Detection history
                   |
          +--------+---------+
          |                  |
          v                  v
     Object Storage      Map API
          |                  |
          +---------+--------+
                    |
                    v
+------------------------------------------------------------+
|                    INTERNAL DASHBOARD                      |
|                                                            |
| MapLibre Map | Filters | Pothole Details | History | Stats |
+------------------------------------------------------------+
```

---

# 46. Recommended First Production Stack Summary

```text
Web/PWA:
Next.js + React + TypeScript

Vision in browser:
ONNX Runtime Web
WebGPU first
WASM fallback

Model:
small pothole-specific detector/segmenter
start from road-damage dataset
fine-tune with Uzbekistan data

Backend:
FastAPI + Python

Database:
PostgreSQL + PostGIS

Storage:
S3-compatible

Map:
MapLibre GL JS
OpenStreetMap-compatible data/tiles

Deployment:
Docker Compose + Nginx

Later AI:
Gemini/other LLM only for reasoning/document workflows
```

---

# 47. Definition of Success

The product is valuable when it stops being:

> "AI draws a box around a pothole."

and becomes:

> "We maintain a trustworthy, continuously updated database of real road damage, where each physical pothole has location, image evidence, severity, history, sightings, and repair status."

The durable asset is the geospatial road-condition dataset.
