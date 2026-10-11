# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Pothole Intelligence.** Read "Project status" below before trusting that anything works:
it separates what is built from what is proven, and lists what is broken.

## Mission

Build a production-quality internal road-damage intelligence system.

A phone mounted on a vehicle windshield provides:
- live rear-camera video
- GPS
- optionally IMU

The system detects potholes, tracks them, assigns visual severity, captures the best image, estimates location, uploads the event, deduplicates repeated sightings, and displays physical potholes on an internal MapLibre map.

Read `PROJECT_SPEC.md` before implementing anything.

## Product Principles

1. Vehicle-independent first. Do not integrate BYD/Li Auto/CAN/ADAS in the MVP.
2. Do not use Gemini/DeepSeek for continuous video detection.
3. Vision model must be replaceable behind an interface.
4. Browser inference first when supported; server fallback must exist architecturally.
5. Never upload continuous driving video by default.
6. Detection events and physical potholes are different entities.
7. Do not claim physical dimensions/depth from an uncalibrated single camera.
8. Severity in MVP is `visual severity`.
9. GPS uncertainty must be stored.
10. Prefer a modular monolith over microservices.
11. Build and test incrementally.
12. Do not introduce infrastructure before it is required.

## Repository

```text
apps/web                 Next.js app, two route groups. The console is "Pitstop":
                         (console) / dashboard of a sample video (?video=video-1..4), opened
                                   from its published analysis (ai/samples)
                                   /analyze live demo: upload, analyse, save for everyone
                                   /videos samples & insights, /videos/[id] a saved video
                                   /potholes photo gallery (videos) + the mapped list
                                   /potholes/[id] /map /drive
                                   off the menu: /models (comparison) /about
                                   /dashboard (statistics)
                                   _login, _review (parked, see "Parked for now")
                         (public)  citizen: /live (map)
                                   live/_report (parked: the Telegram Mini App)
apps/api                 FastAPI. models/ schemas/ repositories/ services/ api/v1/
                         alembic/ migrations; app/cli.py (create-user, seed-demo, ...)
packages/shared-types    Detection, track, severity, event schemas
packages/vision-web      Engines, post-processing, tracking, severity, best frame
ai/inference             Offline video CLI and detectors
ai/training              Dataset assembly and fine-tuning
ai/evaluation            Precision, recall, false alarms per driving minute
ai/export                PyTorch to ONNX, writes the browser manifest
ai/configs/vision.yaml   Canonical thresholds, mirrored in TypeScript
models/                  Server checkpoints (.pt), not committed
samples/  output/        Local footage and analysis output, not committed
infra/Caddyfile          HTTPS entry point for docker-compose.prod.yml (docs/deploy.md)
infra/server/            the same stack behind an existing nginx (pitstop.mardonjon.me):
                         compose override, nginx site, deploy.sh
ai/colab/                the model comparison on a Colab T4: notebook, bundle builder
ai/samples/              analyses the four sample videos with the 3-model merge and
                         publishes them: python -m ai.samples --api <site> [--reuse]
docs/                    audit.md (2026-10-10), architecture.md, ai.md, deploy.md,
                         milestone-0.md - architecture.md, milestone-0.md and parts of
                         ai.md predate the backend (audit.md section 8)
DESIGN_SYSTEM.md         Visual source of truth for the console (tokens: app/globals.css)
PRODUCT.md               Users, purpose, design principles (read before UI work)
```

## Architecture at a glance

The live path, end to end:

```text
camera frame
  -> VisionEngine.infer             Onnx | Server | Mock; createVisionEngine picks one
                                    and records why (selectionReason)
  -> TrackManager                   IoU + motion prediction + proximity gate
  -> BestFrameSelector, SeverityEngine
  -> EventBuilder                   GPS = LocationBuffer sample nearest the moment the
                                    track reached the trigger region       (vision-web)
  -> DriveRecorder                  paces frames to drive.targetFps   (features/drive)
  -> OfflineEventQueue -> uploader  IndexedDB first, then retries           (web/lib)
  -> POST /api/v1/detections        idempotent on clientEventId            (apps/api)
       services/ingest + services/dedup: PostGIS nearby -> merge, or a new pothole;
       returns presigned POST forms and the phone uploads images straight to MinIO
  -> GET /api/v1/potholes?bbox (/map)   |   /api/v1/public/* (/live)
```

- Citizen reports (Telegram bot or Mini App) go through `services/citizen_reports` into
  the same dedup, and start `reported`.
- `/analyze` and `python -m ai.inference.video` run the same pipeline over a file, with no
  GPS and no upload.
- Boxes crossing a module boundary are normalised to 0..1 against the source frame;
  pixels exist only in rendering and cropping code.
- The browser never calls the API directly: `next.config.ts` rewrites `/api/v1/*` and
  `/api/health` to `API_INTERNAL_URL`. In production the path is Caddy -> web -> api.
- Saved video analyses (`/api/v1/video-analyses`) are a separate path: an upload analysed
  on `/analyze` is saved under an id derived from its bytes and settings, the samples are
  published by `ai/samples` under ids derived from `SAMPLE_SETUP`
  (`features/videos/lib/samples.ts`), and a placed video is one map marker - never
  sightings, never potholes.

## Stack

Frontend:
- Next.js
- TypeScript
- React
- PWA
- MapLibre GL JS (the open-source fork of Mapbox GL)
- Basemap: OpenFreeMap "Liberty" vector style - OpenStreetMap data, free, no key. If it
  cannot load within 8s the map swaps to an inline OSM raster style, so potholes never
  depend on a third-party style server. Mapbox itself needs an account and a token, and
  its style URLs are not a drop-in value (`mapbox://` sources)
- TanStack Query

Vision:
- ONNX Runtime Web
- WebGPU preferred
- WASM fallback
- server inference adapter fallback (the browser adapter only: the API has no inference
  endpoint)

Backend:
- FastAPI
- Pydantic
- SQLAlchemy 2
- Alembic

Data:
- PostgreSQL
- PostGIS
- S3-compatible object storage
- Redis only when needed

Infra:
- Docker Compose (postgres + minio; the API runs in a container or locally)
- Postgres is published on host port **5433**, not 5432, so it cannot collide with a
  developer's existing local install
- Caddy terminates HTTPS in production (`infra/Caddyfile`, `docker-compose.prod.yml`):
  a phone grants camera and GPS only to an HTTPS page. On the shared host behind
  pitstop.mardonjon.me the host's nginx does it instead (`infra/server/`).
- The official MinIO image is gone from Docker Hub and quay.io (checked 2026-10-11). The
  server runs Bitnami's build of the same release (`bitnamilegacy/minio`, pinned in
  `infra/server/docker-compose.server.yml`). `docker-compose.yml` still names the official
  tag, which only starts where it is already cached.

## Coding Rules

- TypeScript strict mode.
- Python type hints everywhere practical.
- Keep files focused; avoid giant components/services.
- Use feature-oriented frontend folders.
- Business logic belongs in services, not route handlers.
- Database access belongs behind repositories.
- Never hard-code model thresholds in UI code.
- Put runtime configuration in environment/config modules.
- All writes must be idempotent where retries are possible.
- Use UUIDs.
- Store timestamps as UTC.
- Geospatial coordinates are WGS84 / EPSG:4326.
- Validate all API input.
- Never put secrets in Git.
- Add tests with every important business rule.
- Never hard-code a threshold in a component. Read it from configuration; the UI may only
  move a value off its configured default, and must name the default.
- Unit tests must not derive fixtures from a config value they are not testing. Deriving a
  frame interval from `analysis.sampleFps` coupled the tracker's tests to a rate they had
  no opinion about, and broke six of them when it changed.
- Wrap third-party event-handler bodies in try/catch when the library swallows exceptions.
  MapLibre does, and a thrown error there produced an empty map with nothing to explain it.
- Do not gate our own data on a third party. The map waited for OpenStreetMap tiles before
  loading potholes, so blocked tiles meant a blank map.
- A library that does its work in a worker fails as an empty screen, not an error.
  MapLibre parses, tiles and clusters all GeoJSON in a web worker; Next.js emits no URL
  for it, so the worker dies, no source ever loads, and the basemap keeps rendering
  because tiles load on the main thread. `npm run sync:maplibre-worker` copies the worker
  AND `maplibre-gl-shared.mjs`, which it imports - shipping one without the other moves
  the 404 rather than fixing it.
- A third-party warning is not an error, but it looks like one. ONNX Runtime writes
  warnings to stderr, Emscripten pipes stderr to `console.error`, and the Next.js dev
  overlay reports every `console.error` as a page error. Set the library's own log level
  (`NEXT_PUBLIC_ORT_LOG_LEVEL`, default `error`) rather than filtering the overlay.
- Test uploads against real storage, not the shape of the signed URL. Presigned PUTs
  signed `Content-Length`, so every evidence photo failed while every test passed. Uploads
  are presigned POST forms (`ObjectStorage.presign_upload`), which also let storage enforce
  type and size; `test_storage_upload.py` POSTs to MinIO.
- 401/403 describe the phone, not the sighting. The uploader keeps those events queued;
  only other 4xx are permanent. Drive sessions are created from the phone's own UUID and
  queued like sightings, so a drive started without signal is not rejected as unknown.
- `/drive`, `/analyze` and `/models` are cross-origin isolated (threaded WASM). Every
  worker they start needs the same COEP header - `/ort/*` has it - or the detector hangs
  with no error. Isolation is per document: `CrossOriginIsolation` reloads once after a
  client-side navigation INTO those routes, but nothing undoes it on the way out. A page
  reached by a sidebar click from one of them is still isolated, so every worker it starts
  needs COEP too. `/maplibre/*` has had it since 2026-10-11. Without it `/map` rendered
  blank after `/analyze` -> Map, which `e2e/navigation.spec.ts` now checks.
- The browser calls the API on its own origin; `next.config.ts` forwards `/api/v1`. Never
  reintroduce `localhost:8000` in client code - on a phone that is the phone.
- A model change ships with its migration applied: the dev API runs with `--reload`, and
  a model ahead of its schema made every pothole query fail.
- `get_db` commits in a yield-dependency teardown, and FastAPI (>= 0.118; 0.141 is
  installed) runs that teardown after the response is sent: a client can hold a 2xx for a
  commit that failed. Commit before returning anything a client treats as durable.
- Every browser request reaches the API through the Next.js rewrite (and Caddy in
  production), so `request.client.host` is the proxy, never the phone. Anything keyed on
  client identity - the rate limiter today - needs a trusted forwarded header or the user.
- Synthetic detections must never leave the device. `auto` falls back to
  `MockVisionEngine` whenever ONNX fails, and a synthetic drive still runs, for demos.
  `OfflineEventQueue.enqueue` refuses any `mock-*` model version, and the API rejects one
  with 422. Keep both guards.
- Samples are published, never saved from a browser. The dashboard and the live demo
  used to save their own single-model analyses of the samples, which put duplicate
  markers on the map and duplicate photos in the gallery. Only uploads are saved from
  the browser; `ai/samples` publishes the samples.
- Anchor rsync excludes to the root (`--exclude /models`). A bare `--exclude models`
  matches at any depth: it kept `apps/api/app/models` and `apps/web/public/models` off the
  server, so the API could not start and the web image shipped no detector.
- Test what the user sees, not the route. The navigation spec passed while `/map` was
  blank, and `/drive` analysed zero frames because no test ever started a drive.
  `e2e/drive-live.spec.ts` now starts one, with Chromium's fake camera and a stubbed API.

## Required Abstractions

### VisionEngine

```ts
interface VisionEngine {
  init(): Promise<void>;
  infer(source: CanvasImageSource): Promise<Detection[]>;
  dispose(): Promise<void>;
}
```

Implementations:
- `OnnxVisionEngine`
- `ServerVisionEngine`
- `MockVisionEngine`

### LocationBuffer

Maintains timestamped location samples and can return the closest sample to a given camera timestamp.

### TrackManager

Converts repeated frame detections into one local pothole track.

### SeverityEngine

Takes a finalized track and produces:
- small | medium | large | unknown
- numeric score
- confidence

### BestFrameSelector

Chooses the strongest evidence frame for a pothole track.

### OfflineEventQueue

Uses IndexedDB and retries uploads safely.

## Project status (audited 2026-10-10)

Milestones 0-7 exist as code and every suite passes (vitest 155 + 157, Playwright 27, AI
pytest 172, API pytest 283 on real PostGIS). That is not the same as working. The full
audit, with file:line evidence for everything below, is `docs/audit.md`. Work now is
fixing, measuring and improving, not new milestones.

Strength of evidence:
- **Measured on video, not on a located drive.** Four test videos, judged blind frame by
  frame and report by report (`docs/model-comparison.md`). Accuracy on a GPS-located drive
  has never been measured; the route-test recipe is `docs/audit.md` section 11.
- **Exercised in a browser against the running stack:**
  - a full `/analyze` run on `samples/pexels-pothole-street.mp4` (WASM, ~2 FPS, 1 pothole);
  - a `/drive` session with Chromium's fake camera, where frames reach the detector
    (~2 FPS on WASM) - but no real road yet;
  - `/map`, `/live`, `/dashboard` and `/review` on seed data;
  - the four samples' published analyses on `/`, `/potholes`, `/videos/[id]` and `/map`
    (Video 2's marker at Osiyo Grand, with its photos).

  The dev database is empty. The `seed-demo` rows and one hand-made test sighting were
  deleted on 2026-10-11 (dump: `output/backups/pothole-db-2026-10-11-before-sample-cleanup.dump`).
  Every map, dashboard and list now shows its empty state until a real drive uploads.
- **Tested only in isolation:** the vision pipeline classes, the offline queue and
  uploader, ingest, dedup, statuses and the public API.

**Fixed on 2026-10-11, each with a test that failed first:**
- `/drive` analysed zero frames. The stream is now attached once CameraStage has mounted
  the `<video>`.
- Synthetic sightings uploaded as real. The offline queue and the API now refuse `mock-*`.
- `/map` was blank after a sidebar click from an isolated page. `/maplibre/*` now carries
  COEP.
- Merged potholes claimed accuracy no sighting had: `merge_location` divided the accuracy
  on every merge (six pins at +-100 m gave 3.7 m). It now keeps the best one, floored at 1 m.
- `ruff format --check ai/` passes.

Broken now, in priority order:
1. **Backend integrity.** The API commits after responding; dedup is unlocked, so
   concurrent sightings of a new pothole create two potholes; a retried upload loses its
   photos; rejecting a pothole's only citizen report, or marking it `false_positive`, does
   not keep it off the map.
2. **Before any public deployment:** rate limits key on the proxy (one bucket for
   everyone); `npm audit` criticals in next 16.3.1 and maplibre-gl 6.4.0; `seed-demo`
   creates operator `demo@example.com` / `demo-password`; `public/model-compare` (team
   footage) and `public/models/candidates` ship in the web image.
3. **Python and browser reports disagree.** Same clip, same ONNX, same config: the CLI
   found 0 potholes (9 frame detections, 5 Speed-Bump), the browser 1 (11, and 16
   Speed-Bump). Sampling differs (see Video analysis report), and the CLI's `.pt` path
   letterboxes rectangularly where the browser runs the square ONNX.
4. **Gates and docs.** Nothing lints `packages/*` or `apps/api`. README, `docs/architecture.md`, `docs/milestone-0.md`,
   `infra/README.md`, `ai/README.md` and `.env.example` describe an earlier milestone.
5. **Public repository** (2026-10-11): github.com/rmm-code/final-road-safety. Never commit
   the server's address (the domain is behind Cloudflare; `deploy.sh` takes `DEPLOY_HOST`),
   `reports/` or `research_notes/` (other products' notes, gitignored).

**Parked for now (2026-10-10), each reversible.** Sign-in and the Telegram Mini App come
back later. Keep their code; do not build on it meanwhile.

- **Sign-in.** The login page is parked: `app/(console)/_login`, where the underscore keeps
  it out of the router. Its links in `components/auth-status.tsx` and
  `features/drive/drive-view.tsx` are commented out.
  - So the API must run with `AUTH_DISABLED=true` (set in `apps/api/.env`), which serves
    the console with nobody signed in. Without it every console call answers 401, and
    the header shows "Sign-in disabled".
  - Auth itself is not removed: tokens still verify and roles still apply. The flag only
    decides what happens when no credentials arrive.
  - The API refuses to start with the flag true when `ENVIRONMENT` is `production`.
    Under `ENVIRONMENT=demo`, every anonymous visitor acts as an admin.
  - Restore: rename `_login` back to `login`, uncomment the two links, and create
    accounts with `python -m app.cli create-user`.
- **Review queue.** `app/(console)/_review` is parked and has no entry in `NAV_ITEMS`
  (`components/sidebar.tsx`); the review API routes still exist. Restore: rename it back
  to `review`, and re-add the nav entry and the `/review` row in `e2e/navigation.spec.ts`.
- **Telegram.**
  - The webhook route is commented out in `apps/api/app/api/v1/__init__.py`.
  - The Mini App page is parked at `app/(public)/live/_report`, and its report button in
    `features/live/live-map-view.tsx` is commented out.
  - Bot code, tests, CLI commands and the citizen-report API remain.
  - Before un-parking the Mini App: nothing loads `telegram-web-app.js`, which is what
    creates `window.Telegram.WebApp`, so the form could never detect Telegram.

## Development Order (delivered)

History, kept because it records what each milestone covers.

| | Scope |
| --- | --- |
| M0 | Python video-file inference: MP4 in, annotated MP4 and JSON detections out, post-processing tests |
| M1 | `/drive` live camera: rear camera, preview, browser inference, overlay, FPS/latency, configurable confidence threshold |
| M2 | GPS: `watchPosition`, timestamped location buffer, accuracy display, nearest-sample lookup |
| M3 | Tracking: IoU association, trigger region, best-frame selection, visual severity, local event preview |
| M4 | Backend: authentication, drive sessions, detection events, PostGIS, object storage, signed image upload |
| M5 | Map: MapLibre, bbox query, markers, clustering, pothole details |
| M6 | Deduplication: nearby PostGIS lookup, then merge into an existing pothole or create one |
| M7 | Human review and model improvement |

## AI Rules

### Deployed model

`models/pothole-detector.pt` - YOLOv8m from
[collabdoor/road-anomaly-detection](https://github.com/collabdoor/road-anomaly-detection),
Apache 2.0, trained on ~30,700 road images. Seven classes; only `Pothole` is reported.
It was trained with Ultralytics, and the exported ONNX's metadata reads `AGPL-3.0 License`;
the licence review PROJECT_SPEC §5.4 asks for has not been done.

Do not train from scratch. Fine-tune from this checkpoint - see `ai/training/`.

**Latest comparison** (2026-10-11, `docs/model-comparison.md`): the four test videos (videos
1-3, Tashkent dashcam; video 4, a broken road in Russia, formerly mislabelled "Tashkent
clip"), two blind AI judges, pooled reference in `ai/evaluation/pooled/` (`sets-four-videos.json`).
- What reaches the map, judged: this model at 0.35 reported 12 real / 1 false; at 0.25,
  17 real / 1 false; the merge of this model + mfranzon + rezzzq at 0.35, 32 real / 2 false.
- Frame level: this model at 0.25 has precision 74%, recall 55%; the merge 66% / 73%.
- The merge runs three models per frame (and rezzzq fails on WebGPU), so it suits video
  files; this model at 0.25 is the best single model for a live drive.
- Applied 2026-10-11: the product threshold is 0.25 (`ai/configs/vision.yaml`), and neither
  the live drive nor the live demo has a threshold control. The published samples keep the merge at 0.35, frozen in
  `SAMPLE_SETUP`.

### Read a dataset's labels, not its class names

The RDD2022 copy that DetectionBench's models (dronefreak/* on Hugging Face) were trained on
labels manhole covers, lane markings and crosswalks as `pothole` - checked by eye on the
crops. Those models score 74 mAP@50 "on potholes" and find none on real roads. Never deploy
them. Crop and look at a sample of any dataset's target class before trusting it.

### A model that exports is not a model that runs in the browser

rezzzq's YOLO12s exported cleanly and is the best crack model on the Tashkent clips in
Python, yet returned no detections at all on WebGPU in our engine (it works on the slow
WASM path). Every candidate must pass the live test on `/models` before it is considered.

### Never adopt a model on its published mAP

A public pothole model advertising **0.995 mask mAP@0.5** found *zero* potholes on real
Tashkent footage. That figure was measured on its own test split, and its own table ranked
nano above small above medium - a smaller model beating larger ones usually means the split
is too easy or leaks augmented duplicates across train and test.

Always measure a candidate on footage from the road it will actually work on. On the same
clip: that model peaked at 0.29 confidence, the deployed one at 0.73.

### Match the pothole class by NAME, never by index

`POTHOLE_CLASS_ALIASES` in `ai/inference/types.py`, mirrored in
`packages/vision-web/src/postprocess/decode.ts`. RDD2022 puts potholes at index 3 behind
three crack types; the deployed model puts them at index 5 behind vehicles. Matching by
position reports cracks, or lorries, as potholes.

Matching is case-insensitive. A decoder comparing `== "pothole"` against a model whose
class is `"Pothole"` silently discards every detection.

### Export square, and quantize

`python -m ai.export.to_onnx --imgsz 640 --quantize 16`.

Ultralytics runs `.pt` inference rectangularly, matching the source aspect. An ONNX export
has a fixed input, so a mismatch letterboxes most of the frame away. Measured on portrait
footage: portrait export 21 detections, square 19, landscape 10. Square costs a tenth and
survives either orientation.

The Python CLI's `.pt` path still runs Ultralytics' default rectangular letterbox, so it
measures a setup the browser never runs. Evaluate the exported `.onnx` instead; the CLI
reads the `model.json` beside it.

`--quantize 16` halves the browser download with identical detections. That matters when a
driver fetches it over mobile data.

The export tool writes the manifest from shapes it OBSERVES in the graph. Never hand-write
`inputSize` or `outputLayout`.

Keep training code isolated under `ai/`.

Split training data **by drive, never by frame**. Consecutive frames of one drive are
nearly identical; splitting them randomly validates the model on images it effectively
trained on. This is the likeliest cause of the 0.995 figure above.

Every deployed model has a semantic version.

Every detection event records its `model_version`.

Do not couple backend DB entities to a particular YOLO output format.

Normalize model output into our own schema.

## Pothole Event Schema

At minimum:

```json
{
  "clientEventId": "uuid",
  "driveSessionId": "uuid",
  "detectedAt": "ISO timestamp",
  "confidence": 0.92,
  "severity": "large",
  "severityScore": 0.82,
  "severityConfidence": 0.78,
  "latitude": 41.3112,
  "longitude": 69.2797,
  "locationAccuracyM": 8.4,
  "headingDeg": 123,
  "speedMps": 8.9,
  "modelVersion": "pothole-detector-0.1.0"
}
```

### Video analysis report

Distinct from the event schema above. Per track: `trackId`, `firstSeenSeconds`,
`lastSeenSeconds`, **`maxConfidence`**, `severity`, `severityScore`, `severityConfidence`,
`observationCount`, `maxArea`, `bestFrameSeconds`.

`analysis` also carries `rawDetections`, `rejectedTracks` and `otherClasses` - the classes
the model recognised but this product does not report. Counted, never turned into
entities: it is how we learn whether cracks are worth modelling without inventing a table
for them.

The browser and the Python CLI emit the identical schema and are meant to sample the same
frame times, so that reports from either are directly comparable. Today they agree only
when the source fps is an integer multiple of `sampleFps`: Python takes the first decoded
frame at or after k/fps and records that frame's own time (`ai/inference/video.py`), while
the browser seeks to k/fps and records k/fps (`analyse-video.ts`). Python's
`frame_index / fps` clock also drifts on variable-frame-rate phone footage.

## Critical Data Model Rule

`detection_events` = sightings.

`citizen_reports` = sightings reported by the public through Telegram.

`potholes` = physical real-world entities.

Many detection events can belong to one pothole. So can many citizen reports, and the two
kinds of sighting can belong to the same one - a report and a detection of the same hole
must not produce two markers.

Never treat one incoming detection as necessarily one new physical pothole.

## Verification States

Three states reach the public map, and they answer "how much should you believe this",
not "how bad is it". Severity is a separate scale and stays on the internal map.

```text
reported            purple   a member of the public said so; nothing corroborates it
active              red      corroborated, not repaired
repaired            green    fixed
```

A pothole created from a citizen report starts `reported`. It is promoted to `active` by
either our own detector seeing it, or by `CITIZEN_CONFIRMATIONS_TO_VERIFY` **distinct
people** reporting it - distinct, because counting reports would let one person confirm
their own. Every promotion writes a `pothole_status_history` row even when no human made
it, so "why is this red" is always answerable.

`false_positive`, `ignored` and `archived` are absent from the public mapping, so they are
absent from the public map. Statuses are translated in `apps/api/app/schemas/public.py`
(`reported` -> `unverified`, `active` and `suspected_repaired` -> `confirmed`, `repaired`
-> `fixed`); internal status names never reach a public response.

Photos from the public are held until an operator accepts them. The `/review` queue is
parked, so for now acceptance goes only through `POST /api/v1/citizen-reports/{id}/review`.
A bot open to anyone accepts images from anyone.

## Sample Rates

Two separate rates, and they must stay separate:

```yaml
analysis.sampleFps: 12   # video files - offline, so it can afford accuracy
drive.targetFps: 6       # live camera - bounded by what a phone sustains
```

Raising the file rate from 6 to 12 found 50% more potholes and rejected fewer tracks.
The live rate cannot follow, because the phone also renders a 30 fps preview.

`minDurationMs` is wall-clock, so the number of sightings needed to satisfy it depends on
the rate. That is intended: a flicker is measured in time, not frames.

## Camera

`/drive` requests 1280x720 at 30 fps, all `ideal` so a phone that cannot deliver returns
something usable. Higher is wasted: the model input is 640x640 and inference runs at 6 fps
at best - that is the target; the WASM fallback manages about 2 with the YOLOv8m model.

**Mount landscape with the bonnet out of shot.** In portrait test footage, 129 pothole
detections landed in the trigger region **zero** times - the bottom 28% of the frame was
all bonnet, so geolocation and severity both fell back to their degraded paths.

## Geolocation Rule

Do not save GPS at the first frame where a distant pothole appears.

For MVP:
- track pothole
- wait until it approaches the lower trigger region
- select GPS sample nearest that timestamp

Frames are stamped with `Date.now()` and fixes carry `position.timestamp`.
`LocationBuffer.nearestTo` accepts a fix up to 5 s away (hard-coded, no interpolation);
an event with no fix in range is dropped and counted as "Not located" in the HUD.

Always save location accuracy.

Later add camera calibration and heading projection.

## Safety / UX

The driver-facing page must require minimal interaction while driving.

The user should start the session before moving and stop after parking.

Do not build workflows that require tapping small controls while driving.

## Commands and testing

Usually already running on the developer's machine: `next dev` on :3000, the API
(`../../.venv/bin/uvicorn app.main:app --port 8000 --reload`, from `apps/api`) on :8000,
and postgres (:5433) + minio (:9000) in Docker. Check before starting anything: Next 16
refuses a second `next dev` in `apps/web` (a `next build` alongside it is fine).

```bash
npm run verify                                     # eslint (apps/web only), tsc x3, vitest x2, next build
npm test --workspace @pothole/vision-web -- src/pipeline/track-manager.test.ts   # one file
npm test --workspace @pothole/web -- -t "queue"                                    # by test name
cd apps/web && PLAYWRIGHT_BASE_URL=http://localhost:3000 npx playwright test e2e/drive.spec.ts

.venv/bin/python -m pytest                         # AI pipeline, CLI, training, evaluation
.venv/bin/python -m pytest ai/tests/test_tracking.py -k horizon
.venv/bin/ruff check ai/ && .venv/bin/ruff format --check ai/

cd apps/api && ../../.venv/bin/python -m pytest    # API, needs Postgres on 5433
cd apps/api && ../../.venv/bin/python -m pytest app/tests/test_dedup_scoring.py -k heading
```

- Without `PLAYWRIGHT_BASE_URL`, Playwright tries to start its own `npm run dev`, which
  fails while the developer's server is running.
- Every API test run, even a single unit test, drops and recreates `pothole_test` (an
  autouse fixture) and builds the schema with `create_all`, not the migrations - a broken
  migration passes every test. Never run two API test processes at once.
- `apps/api` reads `.env` from the current directory. Run from `apps/api`, that is
  `apps/api/.env`, not the root `.env` (which is Docker Compose's). `JWT_SECRET` must be in
  the environment or in `apps/api/.env`, even for alembic.
- Migrations: `cd apps/api && ../../.venv/bin/alembic revision --autogenerate -m "..."`,
  then `../../.venv/bin/alembic upgrade head`. Read the generated file: `env.py` has no
  `include_object`, so autogenerate proposes dropping PostGIS's `spatial_ref_sys`.
- API CLI: `cd apps/api && ../../.venv/bin/python -m app.cli` with `create-user`,
  `seed-demo`, `demo-images`, `bot-poll` or `bot-webhook`.
- After `npm install`, once: `npm run sync:maplibre-worker --workspace @pothole/web` and
  `npm run sync:ort-runtime --workspace @pothole/web`.
- Model work, from the repo root: `python -m ai.inference.video` (analyse a file),
  `ai.training.dataset` and `ai.training.finetune`, `ai.evaluation.score` (route-level
  precision and recall), `ai.export.to_onnx`. Each takes `--help`; `ai/*/README.md` has the
  recipes.
- Candidate comparison: `ai.evaluation.run_detector`, then `pool_review`, then `score_sets`
  (recipe in `docs/model-comparison.md`). `score_sets --preds-root DIR` scores a re-run
  (another GPU, a new export, a fine-tuned model) against the judged clusters without judging
  again. `ai/colab/model_comparison_t4.ipynb` runs it on a free Colab T4.

API tests run against a real PostGIS database, created and dropped per run. Deduplication
and the map queries *are* PostGIS behaviour; a fake would prove nothing.

At minimum:
- unit tests for track association
- unit tests for severity thresholds
- unit tests for event state transitions
- unit tests for dedup scoring
- API integration tests
- PostGIS nearby-query tests
- frontend tests for permission/error states

## Before Every Major Implementation

1. Read relevant part of PROJECT_SPEC.md.
2. State the milestone being implemented.
3. Inspect existing repository structure before creating files.
4. Reuse existing abstractions rather than duplicating.
5. Implement the smallest complete vertical slice.
6. Run lint/tests/build.
7. Fix failures before moving on.

## Deliberately Not Done

**Cracks as entities.** The model already outputs `Crack` and `Crack-Severe`, and they are
counted in `otherClasses`. They are not reported, because severity grades by visible area
(a 40 m crack would read as "small"), geolocation takes one point (a crack has extent), and
dedup matches a point and radius (`ST_DWithin` cannot express a line). Add them as a defect
with a `LINESTRING` geometry, not as a pothole with a different label.

On the test footage cracks were essentially absent: 129 pothole detections, 2 low-confidence
cracks below the working threshold.

## Non-Goals for MVP

Do not implement:
- OEM factory camera access
- BYD integration
- Li Auto integration
- CAN bus
- contractor/tender analysis
- automated complaints
- Kubernetes
- Kafka
- microservice sprawl
- exact pothole depth
- exact physical dimensions
