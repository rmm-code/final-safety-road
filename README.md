# Pothole Intelligence

Internal road-damage intelligence system. A phone mounted on a vehicle windshield is the
sensor: the system detects potholes, tracks each one across frames, grades its visual
severity, keeps the clearest image, estimates where it actually is on the road, and
deduplicates repeated sightings into physical potholes on a private map.

**Current state: Milestones 0–7 implemented.** Video analysis, live camera with GPS,
event capture with an offline queue, a FastAPI + PostGIS + MinIO backend, deduplication,
the map, and the review and dashboard surfaces.

Read [`PROJECT_SPEC.md`](PROJECT_SPEC.md) and [`CLAUDE.md`](CLAUDE.md) before changing
anything. They are the source of truth.

---

## Milestones

| | Capability | Where |
| --- | --- | --- |
| M0 | Analyse recorded footage: detect, track, grade, export | `/analyze`, `python -m ai.inference.video` |
| M1 | Rear camera, live inference, overlay, FPS and latency | `/drive` |
| M2 | `watchPosition`, `LocationBuffer`, accuracy readout | `/drive` |
| M3 | Trigger region, `EventBuilder`, IndexedDB offline queue | `/drive` |
| M4 | FastAPI, PostGIS, MinIO, auth, sessions, events | `apps/api`, `docker-compose.yml` |
| M5 | MapLibre map of stored potholes, clustered | `/map` |
| M6 | Deduplication of sightings into physical potholes | `apps/api/app/services/dedup.py` |
| M7 | Dashboard, review queue, pothole detail | `/dashboard`, `/review`, `/potholes/[id]` |

Severity is **visual severity**. A single uncalibrated phone camera cannot measure width,
length or depth, and nothing in this system claims to.

---

## Prerequisites

- Node.js 20.9+ (developed on 26)
- Python 3.12 for the AI and API tooling — newer interpreters do not yet have wheels for
  the whole stack. [`uv`](https://docs.astral.sh/uv/) is the easiest way to get one.
- Docker, for PostgreSQL/PostGIS and MinIO.
- `ffmpeg` is optional, useful for preparing test clips.

## Running the whole system

```bash
cp .env.example .env                    # then set JWT_SECRET
openssl rand -hex 32                    # a value for it
docker compose up -d postgres minio     # infrastructure
```

Postgres is published on **5433**, not 5432, so it cannot collide with a local install.

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r apps/api/requirements.txt
cd apps/api && ../../.venv/bin/alembic upgrade head       # schema
../../.venv/bin/python -m app.cli seed-demo               # optional demo data
../../.venv/bin/python -m app.cli demo-images             # real pothole photos on it
../../.venv/bin/uvicorn app.main:app --port 8000          # API
```

```bash
npm install
npm run sync:maplibre-worker --workspace @pothole/web     # maps need this once
npm run dev                                               # web app
```

`docker compose up` runs the API in a container instead, once `JWT_SECRET` is set.

Create a real account with:

```bash
cd apps/api && ../../.venv/bin/python -m app.cli create-user \
  --email you@example.com --name "You" --role admin
```

---

## Web application

```bash
npm install
npm run sync:maplibre-worker --workspace @pothole/web   # required for the maps
cp .env.example apps/web/.env.local                     # optional; the defaults work
npm run dev
```

`sync:maplibre-worker` copies MapLibre's web worker out of `node_modules` and into
`public/maplibre`. It is not optional: MapLibre does all GeoJSON work in that worker, the
bundler does not emit a URL the browser can load, and without it every map renders its
basemap and no potholes at all — with no error to explain it.

Open <http://localhost:3000/analyze>, choose an MP4/MOV/WebM road recording and press
**Analyze video**.

With no trained model installed the app runs `MockVisionEngine`, which fabricates
detections from a road-geometry simulation so the pipeline and UI stay usable. This is
labelled as synthetic in the interface, in the exported JSON and in the annotated video —
it is never presented as a reading of your footage. See
[Installing a model](#installing-a-model).

### Checks

```bash
npm run verify                                     # lint, types, unit tests, build
npm run test:e2e --workspace @pothole/web          # Playwright
.venv/bin/python -m pytest                         # AI pipeline and CLI
cd apps/api && ../../.venv/bin/python -m pytest    # API, needs Postgres running
```

The API tests run against a real PostGIS database, created and dropped per run.
Deduplication and the map queries *are* PostGIS behaviour; testing them against a fake
would prove nothing about production.

---

## Python inference

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r ai/requirements.txt
```

Then, from the repository root:

```bash
.venv/bin/python -m ai.inference.video --input ./input.mp4 --output ./annotated.mp4
```

Outputs an annotated video and `detections.json` next to it:

```json
{
  "tracks": [
    {
      "trackId": "track-001",
      "firstSeenSeconds": 4.2,
      "lastSeenSeconds": 5.1,
      "confidence": 0.94,
      "severity": "large"
    }
  ]
}
```

Useful flags: `--model path/to.onnx` for real inference, `--sample-fps`, `--confidence`,
`--crops-dir` to save the best evidence crop per pothole, `--json` for the report path.
Run with `--help` for the full list.

```bash
.venv/bin/python -m pytest
.venv/bin/ruff check ai/
.venv/bin/ruff format --check ai/
```

The browser and the CLI share one configuration file and produce the same report schema,
so results from either are directly comparable.

---

## The detector

YOLOv8m from [collabdoor/road-anomaly-detection](https://github.com/collabdoor/road-anomaly-detection),
**Apache 2.0**, trained on ~30,700 road images. Chosen by running every candidate over
real dashcam footage — see [`docs/ai.md`](docs/ai.md) for the comparison, including why a
model advertising 99.5% mAP found nothing at all.

Weights are not committed — they are versioned build artifacts:

```bash
git clone --depth 1 https://github.com/collabdoor/road-anomaly-detection /tmp/rad
cp /tmp/rad/RoadDetectionModel/RoadModel_yolov8m.pt_rounds120_b9/weights/best.pt \
   models/pothole-detector.pt

.venv/bin/python -m ai.export.to_onnx --model ./models/pothole-detector.pt \
  --name pothole-road-anomaly --version 1.0.0 --imgsz 640 --quantize 16
npm run sync:ort-runtime --workspace @pothole/web
```

`--quantize 16` halves the browser download to 49 MB with no measurable accuracy cost.
Export **square** unless the footage orientation is known — see
[`apps/web/public/models/README.md`](apps/web/public/models/README.md).

## Installing a different model

No weights are committed: they are versioned build artifacts.

1. Train and export a detector — see [`docs/ai.md`](docs/ai.md).
2. Drop the `.onnx` file and a `model.json` manifest into
   `apps/web/public/models/` — that directory's
   [README](apps/web/public/models/README.md) documents the manifest format.
3. Copy the ONNX Runtime WebAssembly binaries once:
   `npm run sync:ort-runtime --workspace @pothole/web`
4. Reload `/analyze`. The engine badge switches to **ONNX Runtime Web** and the synthetic
   warning disappears.

For the Python CLI, pass `--model` instead.

---

## Repository layout

```text
apps/web                 Next.js console (/ and /analyze today)
packages/shared-types    Detection, track, severity and event schemas
packages/vision-web      Vision engines, post-processing and the local pipeline
ai/                      Offline inference, training, evaluation and export
ai/configs/vision.yaml   Canonical thresholds, read by both implementations
docs/                    Architecture, AI workflow, milestone notes
infra/                   Deployment assets (arrives with the backend milestone)
```

`ai/configs/vision.yaml` is the single source of truth for detection, tracking, severity
and best-frame parameters. The browser mirrors it in
`packages/vision-web/src/config/vision-config.ts`, and a unit test fails the build if the
two ever drift. Thresholds are never hard-coded in components.

---

## Configuration

Copy `.env.example` to `apps/web/.env.local`. Everything has a working default.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_VISION_ENGINE` | `auto` (default), `onnx`, `server` or `mock` |
| `NEXT_PUBLIC_MODEL_MANIFEST_URL` | Where the model manifest is served from |
| `NEXT_PUBLIC_ORT_WASM_PATH` | Directory serving the onnxruntime-web binaries |
| `NEXT_PUBLIC_ORT_LOG_LEVEL` | ONNX Runtime log severity, `error` by default. Raise to `warning` to debug the runtime |
| `NEXT_PUBLIC_MAPLIBRE_WORKER_URL` | Where MapLibre's worker is served from. Populate with `npm run sync:maplibre-worker` |
| `NEXT_PUBLIC_SERVER_VISION_URL` | Server inference endpoint (unused until the backend exists) |
| `API_INTERNAL_URL` | Where the Next.js server forwards `/api/v1`, default `http://localhost:8000`. The browser calls the API on the page's own origin |
| `NEXT_PUBLIC_API_BASE_URL` | Leave unset. Only to call an API on a different origin |
| `NEXT_PUBLIC_ANALYZE_SAMPLE_FPS` | Frames per second sampled from an uploaded video |

---

## Documentation

- [`docs/deploy.md`](docs/deploy.md) — running it on a server over HTTPS, and the iPhone checklist
- [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) — the visual source of truth for the web console
- [`docs/architecture.md`](docs/architecture.md) — how the pipeline fits together
- [`docs/ai.md`](docs/ai.md) — dataset, training, evaluation, export, deployment
- [`docs/milestone-0.md`](docs/milestone-0.md) — what is built, what is deliberately not
