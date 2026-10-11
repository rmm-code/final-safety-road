# Audit - 2026-10-10

A whole-repository audit: what is built, what is proven, what is broken, and what to fix
first. CLAUDE.md carries the summary; this file carries the evidence. Line numbers are as
of this date, and there is no git history to pin them to (see section 7).

**Changed since the audit.**
- 2026-10-10: the login page and the Telegram Mini App are parked, as CLAUDE.md "Parked for
  now" describes. That makes 2.6 and the `safeNextPath` open redirect dormant until they
  return.
- 2026-10-10: the model comparison on the team's clip is in `docs/model-comparison.md`.
- 2026-10-11: **2.1, 2.2 and 2.3 are fixed**, each with a test that failed first (details
  under each).
- 2026-10-11: the `/review` page is parked too, and the console was restyled (tokens in
  `apps/web/app/globals.css`, documented in DESIGN_SYSTEM.md).

**Method.**
- Ran every documented check (results in section 0).
- Ran the Playwright suite against the running dev server.
- Drove the running stack (web :3000, API :8000, PostGIS :5433, MinIO :9000) in Chromium
  with a fake camera and fake GPS. Every `/api/v1` call was stubbed, so nothing was
  written to the dev database.
- Ran a full `/analyze` pass in Chromium, and the Python CLI with the same ONNX, on the
  same sample clip.
- Read web, vision-web, API and `ai/` against CLAUDE.md and PROJECT_SPEC.md.
- Upgraded and downgraded the migrations on a scratch database, since dropped.
- Ran concurrency and edge-case scripts against that scratch database.

**Verification labels.**
- **R**: reproduced by running it.
- **C**: confirmed by tracing the code.
- **P**: plausible, or inferred from configuration rather than executed.

## Verdict

Everything builds and every suite passes. Even so, the product's central path does not
work in the current code: a phone on a drive cannot produce a sighting, because `/drive`
never feeds the camera to the detector (2.1). No test starts a drive, so the suite cannot
see it.

Behind that:
- The backend has several data-integrity holes: it commits after responding, dedup is
  unlocked, and synthetic sightings promote real citizen reports.
- The docs describe an earlier milestone.
- Detection accuracy on a driven route has never been measured. The only labelled run
  (Brazil, image level, third-party camera) gave **recall 0.21** at the working threshold.

## 0. Check results

| Check | Result |
| --- | --- |
| `npm run verify` | pass: eslint (apps/web only), tsc x3, vitest 126 + 151, next build |
| Playwright, `PLAYWRIGHT_BASE_URL=http://localhost:3000` | 17 / 17 pass |
| `.venv/bin/python -m pytest` (AI) | 149 pass |
| API pytest, real PostGIS | 153 pass. Storage tests skip when MinIO is down |
| `ruff check ai/` | pass |
| `ruff format --check ai/` | **fail**, 4 files: `ai/evaluation/{build_model_compare,run_detector,score_images}.py`, `ai/tests/test_score_images.py` |
| `ruff check apps/api/app` (no documented command runs it) | **32 errors**: 21 E501, 8 B008 (FastAPI `Depends`, a false positive), 2 F401, 1 I001. 22 files unformatted |
| `npm audit --omit=dev` | **2 critical** (next 16.3.1, maplibre-gl 6.4.0), **2 high** (sharp, source-map-js). 14 including dev |
| Dev database | at migration head `0003` |
| `alembic check`, scratch DB | models match the schema; only index noise (7) |
| Version control | **not a git repository** |

## 1. What is built, by strength of evidence

| Capability | Unit / integration tests | Exercised in a browser | Measured on a road |
| --- | --- | --- | --- |
| `/analyze` video analysis | yes | full run on `samples/pexels-pothole-street.mp4` in Chromium (WASM, 483 ms/frame): 11 frame detections, 1 pothole, 16 Speed-Bump | no |
| Python video CLI | yes (mock detector only) | shipped ONNX on the same clip: 9 frame detections, 0 potholes, 5 Speed-Bump | no |
| `/drive` camera → detection | pipeline classes yes; `DriveView` no | **broken: 0 frames analysed (2.1)** | no |
| GPS buffer, trigger-region geolocation | yes | not reachable (2.1) | no |
| Offline queue and uploader | yes (fake-indexeddb) | session creation only | no |
| Ingest, dedup, statuses, public API | yes (real PostGIS) | yes, on seed data | no |
| `/map`, `/live` | style helpers only | yes on seed data; `/map` blank after navigating from an isolated page (2.3) | n/a |
| `/dashboard`, `/review` | no | yes, on seed data | n/a |
| `/potholes`, `/potholes/[id]` | no | list renders (e2e); detail not exercised | n/a |
| Telegram bot and Mini App | handlers and initData unit-tested | Mini App cannot detect Telegram (2.6); webhook parked | n/a |
| Training, export, evaluation tooling | dataset and scorer yes; finetune and export no | export ran 3x; scorer never with real ground truth | Brazil only, image level |

The dev database holds 54 potholes, 49 sightings and 3 drive sessions. All of it is
`seed-demo` data from 20 August; none comes from a real drive.

## 2. Critical and high

### 2.1 `/drive` never analyses a frame - CRITICAL, R

> **Fixed 2026-10-11.** An effect attaches `camera.stream` once CameraStage has mounted the
> `<video>`. `e2e/drive-live.spec.ts` starts a drive with Chromium's fake camera and a
> stubbed API, and asserts frames are analysed. It failed before the fix (0 frames) and
> passes after (26 frames in 12 s on WASM).

**Where.** `apps/web/features/drive/drive-view.tsx:209-216` attaches the stream to
`videoRef.current` straight after `await camera.start()`. But `<CameraStage>`, which owns
the `<video>`, only mounts on the next render (`:380`, condition
`running || camera.status === "ready"`).

**What happens.**
- The ref is still null, so `srcObject` is never set.
- `readyState` stays 0, and the frame loop (`:256-267`) returns early forever.
- The HUD meanwhile says "AI: Running".

**Reproduction.** Chromium, fake camera, API stubbed:
- After Start: `hasSrcObject: false`, `framesAnalysed: 0` after 12 s. The only request sent
  was `POST /drive-sessions`.
- Control: attaching a stream by hand to the same page gave 29 frames analysed (WASM, 1.9 FPS).

**Fix.**
1. Keep `<CameraStage>` mounted (hidden), or attach `camera.stream` in an effect.
2. Add the missing drive spec: a fake media device, geolocation permission and a routed
   `/api/v1`, asserting `framesAnalysed > 0` and a `POST /detections`.

`docs/deploy.md:8` says a sighting was verified end to end. That cannot be reproduced with
this code, and without history it is impossible to tell when it regressed.

### 2.2 Synthetic detections upload as real sightings - HIGH, C

> **Fixed 2026-10-11.** `OfflineEventQueue.enqueue` refuses any `mock-*` model version, so
> nothing synthetic is stored or uploaded. A synthetic drive still runs, for demos, and its
> banner says nothing is uploaded. The API rejects `mock-*` with 422 in
> `schemas/detection.py`. New tests: `offline-queue.test.ts` "never stores a synthetic
> sighting" and `test_api.py` `test_rejects_a_synthetic_sighting`.

**Chain.**
1. In `auto` mode, any ONNX failure falls back to `MockVisionEngine`
   (`packages/vision-web/src/engines/factory.ts:148`).
2. `/drive` shows a banner, but Start stays enabled (`drive-view.tsx:407`,
   `disabled={!engineInfo || blocked}`) and every event is queued.
3. The API has no filter for `mock-` versions. `apps/api/app/services/ingest.py:165-167`
   promotes `reported` to `active`, with the reason "confirmed by detector
   mock-synthetic-0.1.0".

**Effect.** Fabricated sightings at real GPS positions turn citizen reports red on the
public map. The same path is reachable from a full storage quota (3.1, service worker).

**Fix.** Block Start, or skip queueing, when `isSynthetic`. Reject `mock-*` model versions
server-side.

### 2.3 `/map` is blank after navigating from an isolated page - HIGH, R

> **Fixed 2026-10-11.** `next.config.ts` sends COOP/COEP on `/maplibre/:path*`.
> `e2e/navigation.spec.ts` "the map still works when reached from an isolated page" waits
> for MapLibre's worker to start after `/analyze` → Map. It failed before the fix and
> passes after.

**Mechanism.**
- Cross-origin isolation (COOP/COEP) is per document. It survives client-side navigation
  *out of* `/drive`, `/analyze` and `/models`.
- MapLibre then starts its worker from `/maplibre/maplibre-gl-worker.js`, which has no COEP
  header. `next.config.ts:50-56` covers only the isolated routes and `/ort/*`.
- The browser blocks the worker with `net::ERR_BLOCKED_BY_RESPONSE`.

**Reproduction.**
- Loading `/map` directly shows the basemap and clusters.
- Going from `/analyze` to `/map` via the sidebar link shows an empty canvas: no basemap,
  no potholes. The side panel still reports "53 in view".

**Why the suite misses it.** `e2e/navigation.spec.ts:31-37` takes exactly this route and
passes, because it checks only the URL.

**Fix.** Add `{ source: "/maplibre/:path*", headers: isolation }`, or force a full page
load when leaving an isolated route.

### 2.4 The API commits after it responds - HIGH, R

**Mechanism.** `apps/api/app/api/deps.py:27-35` commits in the teardown of a yield
dependency. On the installed FastAPI 0.141.1, that teardown runs after the response.
Reproduced order: endpoint return, `response-start 201`, commit, rollback. The client saw
201 for a commit that failed.

**Consequences.**
- After a failed COMMIT the phone still holds a 2xx, so `uploader.ts` marks the sighting
  uploaded and deletes it.
- The console has a read-after-write race: a refetch straight after a status change can
  return the old row.
- Routes that never flush (status, review, drive end) report success before anything is
  written.
- `fastapi>=0.115` is unpinned, so the behaviour depends on when it was installed. Tests
  cannot see it, because httpx's ASGITransport waits for the teardown.

**Fix.** Use `Depends(get_db, scope="function")`, or commit explicitly before returning.
Pin FastAPI.

### 2.5 Rate limits key on the proxy, not the client - HIGH in production, C (production half P)

**Code.** `deps.py:124,141` use `request.client.host`. Every browser call reaches the API
through the Next.js rewrite; in production the path is Caddy → web → api.

**Production.** The TCP peer is always the web container.
- One 60/min bucket serves every public-map visitor and every citizen submission. `/live`
  refetches on every `moveend` without a debounce, so about 30 pans a minute from anyone
  exhaust it.
- One 240/min bucket serves the whole fleet.

**Development.** On one host, 127.0.0.1 is trusted. A client-supplied `X-Forwarded-For`
passes through and picks its own bucket. `limiter.py` never evicts an identity, so spoofed
values accumulate in memory.

**Fix.** Set uvicorn's `--forwarded-allow-ips` to the compose network. Key `/detections` by
user. Add eviction.

### 2.6 The Telegram Mini App never detects Telegram - HIGH when re-enabled, C

`apps/web/lib/telegram-webapp.ts:88-91` requires `window.Telegram.WebApp`. That object is
created by `https://telegram.org/js/telegram-web-app.js`, and nothing in the app loads the
script. Comments at `telegram-webapp.ts:8-9` and `next.config.ts:19-20` say Telegram
injects it; it does not. `/live/report` always shows the "only via Telegram" screen.

### 2.7 A demo operator with a published password - HIGH if the docs are followed, C

`apps/api/app/cli.py:66-76` (`seed-demo`) creates `demo@example.com` as an **operator**
with the password `demo-password`, prints it, and has no environment guard.
`docs/deploy.md:55` suggests running it on the production server.

It also turns the `AUTH_DISABLED` stand-in, which is otherwise an unloginable admin, into an
account anyone can sign into.

**Fix.** Refuse `seed-demo` when `ENVIRONMENT=production`, generate the password, and
remove the deploy.md line.

### 2.8 Vulnerable dependencies - HIGH, C

`npm audit` reports:
- **next 16.3.1, critical.** The RCE, SSRF and cache-poisoning advisories are fixed after
  16.3.7, and the self-hosted image optimizer is reachable in the production image.
- **maplibre-gl ≤ 6.4.0, critical.** An XSS sanitizer bypass.
- **sharp and source-map-js, high.**

`npm audit fix` resolves all of them within the current semver ranges. Python
dependencies were not scanned; pip-audit is not installed.

### 2.9 Unpublishable assets ship in the production web image - HIGH, C

The root `.dockerignore` excludes `models/`, `samples/` and `output/`, but not:
- `apps/web/public/model-compare/`: 13 MB of team Tashkent frames and third-party Brazil
  images. `.gitignore:29-31` calls them "not ours to publish".
- `apps/web/public/models/candidates/`: about 57 MB of third-party models.

`apps/web/Dockerfile:12,35` copies the whole context into the final image, and Next
serves `public/` without authentication.

**Fix.** Two `.dockerignore` lines, and gate `/models` behind a flag.

## 3. Medium

### 3.1 Web and vision

- **The confidence slider does not do what its hint says** (C; two auditors found it
  independently).
  - Mid-drive: `thresholdRef` (`drive-view.tsx:58-61`) is written and never read, and the
    recorder keeps the config it was built with.
  - Below the configured 0.35 it never works anywhere: `OnnxVisionEngine` decodes with its
    construction-time threshold (`onnx-vision-engine.ts:208`).
  - `/analyze` still writes the slider value into the report (`report.ts:76`), so a report
    can say 0.20 when 0.35 was applied.
- **The evidence image comes from a later frame than the one analysed**
  (`drive-recorder.ts:144-157` → `drive-view.tsx:172`). At 300 ms WASM latency the box no
  longer matches the pixels. Two images per track are also encoded on every analysed
  frame, on the main thread, before `wouldAccept` (`drive-recorder.ts:215` vs `:221`).
- **Events are lost silently when IndexedDB fails.**
  - The banner promised by the comment at `drive-view.tsx:111-114` does not exist.
  - `queueRef.current?.enqueue` becomes a no-op while the counters keep counting.
  - `put` resolves on request success rather than `tx.oncomplete` (`offline-queue.ts:61-66`).
  - There is no `onblocked` or `onversionchange` handling.
- **Inference errors are unhandled.** `DriveRecorder.tick` has try/finally with no catch.
  A WebGPU device loss produces an unhandled rejection on every frame while the HUD says
  "Running".
- **Service worker.**
  - `cache.put` runs inside `respondWith` (`sw.js:48-57`), so a full storage quota fails
    the model fetch and `auto` falls back to mock, which leads into 2.2.
  - `.onnx` files are cache-first by file name, so a re-export under the same name and
    version never reaches phones.
- **The drive lifecycle is fragile.**
  - Leaving mid-drive (the sidebar stays tappable) loses open tracks and never ends the
    session; there is no `beforeunload`.
  - Start is not disabled while the camera starts, so a double tap runs two loops.
- **`ServerVisionEngine` is broken twice.** It compares `className !== "pothole"`
  case-sensitively (`server-vision-engine.ts:171`), which is the failure CLAUDE.md warns
  about. And no server endpoint exists for it.
- **`NEXT_PUBLIC_ANALYZE_SAMPLE_FPS` has no effect.** `analyze-view.tsx:43-46` rebuilds the
  config from defaults.
- **The camera/GPS join has a fixed tolerance.** Frames are stamped with `Date.now()` and
  fixes with `position.timestamp`, and the nearest fix must fall within a hard-coded 5 s
  (`location-buffer.ts:60`).
  - There is no interpolation (at 1 Hz, up to about 7 m at 54 km/h), and skew is
    unmeasured.
  - Events send no `metadata`, so the server cannot tell a fallback location from a good
    one.

### 3.2 API

- **Dedup has no locking** (R, scratch DB with a barrier after `nearby()`).
  - Two sightings of one new pothole arriving together create **two potholes**.
  - Two concurrent merges lose a `sighting_count`, along with one merge's location and
    severity update.
  - A concurrent duplicate `clientEventId` returns 500.
  - Citizen reports share the path (`services/citizen_reports.py:217-282`).
  - Fix: an advisory lock on a geohash cell before `nearby()`, `FOR UPDATE` on the
    candidate, increments done in SQL, and catching `IntegrityError` to return the
    existing row.
- **Photos are lost on an idempotent retry** (C; found by both the web and API auditors).
  - `detections.py:53` returns no upload forms when the event is `already_ingested`, but
    the first attempt already stored the image keys.
  - The phone then marks the event uploaded and deletes its images.
  - The keys point at objects that never arrive; spec §17/§39's confirmation step does not
    exist.
  - `primary_image_key` is set only when empty, so a broken face is never replaced.
- **Rejecting a pothole's only citizen report leaves its marker on the public map.**
  `services/citizen_reports.py:337-348` only demotes `active` to `reported`.
- **A `false_positive` verdict does not stick.** `nearby()` excludes false positives
  (`repositories/potholes.py:33`), so the next pass over the same manhole creates a fresh
  `active` pothole.
- **Heading is never compared.** `ingest.py:121-122` passes `pothole_heading_deg=None`, so
  `heading_agreement` is always 0.5 and opposite carriageways merge, against spec §14.
- **`detectedAt` accepts naive and far-future datetimes** (`schemas/detection.py:21`).
  - A naive value near an existing pothole raises `TypeError` in `dedup.py:74`: a 500 the
    phone retries forever.
  - `2099-01-01Z` pins `last_seen_at` to 2099.
- **`GET /citizen-reports` requires only a signed-in user**
  (`api/v1/citizen_reports.py:123-131`). Drivers and viewers can read reporters' Telegram
  usernames and unreviewed photos.
- **Accepted citizen photos can be replaced.** The presigned POST stays reusable for 15
  minutes, and the public endpoint serves whatever is at the key. Publish an immutable copy
  on accept.

### 3.3 AI pipeline and Python/browser parity

- **Python and the browser disagree on the same clip** (R). Same clip
  (`samples/pexels-pothole-street.mp4`), same ONNX, same config:

  | | CLI | Browser `/analyze` |
  | --- | --- | --- |
  | frame detections | 9 | 11 |
  | potholes | 0 | 1 (small, 61%) |
  | rejected tracks | 3 | 4 |
  | Speed-Bump | 5 | 16 |

  The browser also downsizes frames to a 1280 px canvas before letterboxing, and the two run
  different ONNX Runtime backends (CoreML vs WASM). The sampling difference below is the
  confirmed cause; how much each factor contributes is unmeasured.
- **Python and the browser no longer sample the same frames** (C, measured).
  - Python takes the first decoded frame at or after k/fps and records that frame's own
    time (`ai/inference/video.py:249-255`).
  - The browser seeks to k/fps and records k/fps (`analyse-video.ts:155-163`).
  - They agree only when the source fps is an integer multiple of `sampleFps`.
  - On the 25 fps sample at 12 fps, 221 of 242 timestamps differ, and frame counts can
    differ by one.
  - The CLI test passes only because its fixture is a 12 fps clip sampled at 12 fps.
- **Python timestamps drift on variable-frame-rate video.** It computes
  `frame_index / CAP_PROP_FPS`. On a synthetic VFR clip the error reached 2.45 s, beyond the
  scorer's ±2 s tolerance. Phones usually record VFR. Use `CAP_PROP_POS_MSEC`, or transcode
  to constant frame rate first.
- **The CLI's `.pt` path is not what ships.** It runs Ultralytics with rectangular
  letterboxing (`detector.py:208-214`, no `rect=False`), while the browser runs the square
  ONNX. Every documented evaluation command uses `.pt`.
- **Dataset assembly works by label index** (`ai/training/dataset.py:54-58,171-177`).
  - A local set labelled `0: pothole` silently becomes `Heavy-Vehicle`.
  - Class weights are written only as YAML comments.
  - With 5 or fewer drives, the validation or test split can come out empty.
  - `finetune.py` never checks class compatibility with the checkpoint.
- **The model version is keyed on the file name only** (`detector.py:417-435`).
  `models/pothole-detector.pt` has already held two different models, and
  `output/detections.json` came from the earlier segmentation checkpoint, so do not cite
  it. Without a manifest the CLI records the file stem, so a fine-tuned file would be
  versioned "best".

## 4. Low (selected)

- **Open redirect.** `safeNextPath` (`apps/web/lib/auth.ts:55-57`) accepts
  `/\t/evil.example`, which resolves to `http://evil.example/`. Reject control characters
  or compare origins.
- **No CSP anywhere.** The bearer token lives in memory plus `sessionStorage`
  (`api-client.ts:129-165`).
- **`otherClasses` accumulates across analyses** (`onnx-vision-engine.ts:112,215`).
- **Stale map loads.** `moveend` requests are neither sequenced nor aborted, so a late
  answer for an old view can overwrite a newer one.
- **The bbox edges curve.** The geography cast in `repositories/potholes.py:75-80` makes the
  north and south edges great-circle arcs. At wide zoom, points just inside the bottom edge
  are dropped.
- **Public lists and counts can be wrong.** `/public/potholes` filters by state after the
  SQL `LIMIT`. `/public/counts` loads up to 3000 ORM rows and saturates there.
- **Duplicate device rows.** There is no unique `(user_id, device_name)`, so a duplicate
  row makes every session create for that user agent return 500.
- **A non-ASCII initData hash** raises `TypeError` and returns 500
  (`telegram/initdata.py:88`).
- **Internal status leak.** The Mini App submit response returns the internal
  `PotholeStatus` and can expose `false_positive`.
- **Missing history rows.** Pothole creation writes no `pothole_status_history` row, and
  `seed-demo` sets `repaired` without one.
- **Constants outside the YAML.** `MAX_SCALE_GROWTH`, `MAX_CENTRE_SHIFT` and the crop
  padding are duplicated in both languages. No cross-language golden test covers decode,
  tracking or severity.
- **Recall lever worth measuring.** The decoder keeps only the best class per anchor
  (`decode.ts:226-233`, `postprocess.py:223-224`), so a box scored Speed-Bump 0.50 and
  Pothole 0.45 loses its pothole.
- **The Python ONNX detector needs its `model.json`.** Without the file beside it, it falls
  back to `["pothole"]` and fails with a misleading layout error (`detector.py:76`). That is
  exactly the invocation `docs/ai.md` shows.

## 5. Deviations from CLAUDE.md's own rules

- **"Never hard-code a threshold in a component."**
  - `live-browser-test.tsx:95` (0.1).
  - `drive-hud.tsx:18` (25 m GPS "ok").
  - `drive-view.tsx:141,164,174,180,188-189` (15 s drain, 640 px, 0.35 padding, 0.7/0.82
    quality), which duplicate `analyse-video.ts:92-97`.
  - `CITY_BBOX` repeated in `dashboard-view.tsx:11`, `pothole-list-view.tsx:11` and
    `review-view.tsx:12`, so the review queue silently drops anything outside Tashkent.
  - The 5 s GPS age in `location-buffer.ts:60`.
- **"Must name the default."** The hint at `drive-view.tsx:427` replaces the text that
  names it.
- **"Match the pothole class by NAME, case-insensitively."**
  - `server-vision-engine.ts:171`.
  - `ai/training/dataset.py` copies labels by index.
  - `score_images.py --pothole-ids` defaults to 0.
- **"Database access belongs behind repositories; business logic in services."**
  - Routes query the ORM directly: `auth.py:16-18`, `drive_sessions.py:22,35-62,68,84`,
    `detections.py:37`, `stats.py:20-37`, `citizen_reports.py:200`, `deps.py:53-72`.
  - Status change plus history row is implemented four times: `ingest.py:170`,
    `services/citizen_reports.py:197`, `potholes.py:175,209`.
- **"Internal status names never reach a public response."** The Mini App submit response
  (`schemas/citizen_report.py:38`).
- **"Validate all API input."**
  - `detectedAt` (3.2).
  - bbox values are not range-checked.
  - `metadata` is an unbounded dict.
  - Status and severity filters accept free text.
- **"Server fallback must exist architecturally."** Only the client adapter exists.
- **"Every worker … needs the same COEP header."** Not `/maplibre/*` (2.3).
- **"The browser and the Python CLI … sample the same frame times."** False (3.3).
- **"The two rates must stay separate."** `drive-recorder.ts:99` falls back to
  `analysis.sampleFps`.
- **"Every deployed model has a semantic version."** Never validated; the CLI falls back to
  the file stem.
- **"Do not build workflows that require tapping small controls while driving."** The
  slider is advertised as "takes effect immediately, mid-drive". In landscape at 844x390,
  the preview and Stop cannot be on screen together.

## 6. Test gaps

- ~~**No test starts a drive.**~~ Added 2026-10-11 (`e2e/drive-live.spec.ts`).
- **e2e coverage.**
  - No spec covers `/live`, `/live/report`, `/login`, `/models` or `/potholes/[id]`.
  - ~~The navigation spec asserts URLs, not map content (2.3).~~ It now waits for the map worker (2026-10-11).
  - There are no UI states for: location denied, WASM-only, model fetch failure, IndexedDB
    unavailable, or an insecure context.
- **Untested web code.**
  - Hooks: `use-camera`, `use-location`, `use-wake-lock`.
  - Components and pages: `drive-view`, `cross-origin-isolation`, `live-map-view`,
    `login-view`.
  - Scripts and modules: `sw.js`, `public-api`, `telegram-webapp`.
- **API schema.** The suite builds it with `Base.metadata.create_all`
  (`app/tests/conftest.py:59`), never the migrations. "A model ahead of its schema" cannot
  fail a test. Add `alembic upgrade head` and `alembic check`.
- **API behaviour with no test:**
  - concurrency (3.2);
  - rate limiting;
  - naive or future `detectedAt`;
  - a retry receiving upload targets;
  - rejecting a pothole's only report;
  - recurring false positives;
  - wide-zoom bbox edges;
  - commit timing (ASGITransport hides it).
- **API routes with no route test:**
  - the three citizen-report routes, which is how the missing role check slipped through;
  - `GET /detections/{id}`;
  - `PATCH /potholes/{id}`;
  - the CLI.
- **AI.**
  - `OnnxDetector`, `finetune.py`, `to_onnx.py`, `run_detector.py` and
    `build_model_compare.py` have no tests.
  - The CLI fixture (12 fps sampled at 12 fps) cannot catch the sampling divergence.
  - Parity is tested only through the YAML and three PRNG values.
- **Lint.** `packages/vision-web` and `packages/shared-types` have no lint script, and no
  documented command lints `apps/api`.

## 7. Infrastructure and deployment

- **No version control.** This directory is not a git repository. `.gitignore` does
  nothing, and `docs/deploy.md`'s update procedure (`git pull`) cannot run here.
- **Setup fails as documented.** `apps/api` settings read `.env` from the current
  directory. Following the README (put `JWT_SECRET` in the root `.env`, then
  `cd apps/api && alembic upgrade head`) fails with "JWT_SECRET must be set".
- **Migration autogenerate noise.**
  - `alembic/env.py` has no `include_object`, so autogenerate proposes
    `DROP TABLE spatial_ref_sys`.
  - Four unique columns have duplicate btree indexes.
  - All three geography columns have duplicate GiST indexes.
- **Demo mode is open by design.** `AUTH_DISABLED` is refused only when `ENVIRONMENT` is
  `production` or `prod`. The documented demo mode (`ENVIRONMENT=demo`) makes every
  anonymous visitor an admin (`deps.py:66`).
- **API image.** It runs as root, ships build-essential and pytest, installs unpinned
  dependencies and has no `HEALTHCHECK`. `web` does not wait for a healthy `api`.
- **Web image.** It copies the whole build tree including dev dependencies, runs as root,
  and does not use `output: "standalone"`.
- **Production compose.** The API uses MinIO's **root** credentials
  (`docker-compose.prod.yml:59-60`). There are no automated backups.
- **Reproducibility.**
  - Python requirements are `>=` floors with no lock file.
  - The venv is far ahead of them: numpy 2.5.2, ruff 0.16.3, and Ultralytics 8.4.120,
    whose `quantize=` argument `to_onnx.py` depends on.
  - `opencv-python` and `opencv-python-headless` are both installed.
- **Not an installable PWA.** `manifest.webmanifest` has `icons: []`, and the service
  worker caches only `/models` and `/ort` (no app shell).
- **Licence review pending.** README and docs/ai.md call the deployed model Apache 2.0, but
  its exported ONNX metadata reads "AGPL-3.0 License (https://ultralytics.com/license)",
  with author Ultralytics. The licence review required by spec §5.4 is still open.

## 8. Documentation drift

| Where | Says | Actually |
| --- | --- | --- |
| `.env.example:28`, `config.py:28` (CLAUDE.md fixed by this audit) | "There is no login screen" | `/login` exists; accounts come only from `app.cli create-user` |
| README:156, `docs/architecture.md:143-146`, `ai/README.md:69-73`, `docs/milestone-0.md:49-56` (CLAUDE.md fixed by this audit) | browser and CLI analyse identical frames | only when the source fps is a multiple of `sampleFps` (3.3) |
| CLAUDE.md repository and stack (fixed by this audit) | route list; "Nginx (not yet needed)" | `/models` and `/login` were missing; production uses Caddy |
| README:46-59 | `JWT_SECRET` in the root `.env`, then alembic from `apps/api` | `apps/api` reads `apps/api/.env`, so it fails (7) |
| README:84,222; `.env.example:3,102` | copy `.env.example` to `apps/web/.env.local`, "the defaults work" | it sets `NEXT_PUBLIC_API_BASE_URL=http://localhost:8000`, so a phone calls itself (`lib/config.ts:59`) |
| README:139 | track field `confidence` | `maxConfidence` |
| README:204,210 | web app has "/ and /analyze today"; infra "arrives with the backend milestone" | 11 console routes and 2 public; Caddy and the production compose exist |
| README:231, `.env.example:67`, `docs/architecture.md:60` | server inference URL unused "until the backend exists" / "Milestone 4+" | the backend exists; no inference endpoint does |
| README:234, `.env.example:73` | `NEXT_PUBLIC_ANALYZE_SAMPLE_FPS` | has no effect (3.1) |
| README:163, `docs/ai.md:12-13,32` | the model is Apache 2.0 | ONNX metadata says AGPL-3.0 (Ultralytics); needs review |
| `infra/README.md` | "Empty by design… Nginx" | contains the Caddyfile |
| `docs/architecture.md:13,22-23,110-111` | backend and upload pipeline are future work | both built; no backend section (dedup, verification states) |
| `docs/milestone-0.md:11,60-76` | 6 FPS default; later routes "unavailable"; no model; ONNX unverified; no e2e | 12 FPS; all routes live; model deployed; ONNX run; 17 e2e tests |
| `docs/deploy.md:8` | a sighting verified end to end | `/drive` analyses no frames (2.1) |
| `docs/deploy.md:55` | run `seed-demo` on the server | creates an operator with a known password (2.7) |
| `docs/deploy.md:73-76` | offline sightings upload "when signal returns" | only while `/drive` is open; no Background Sync |
| `ai/README.md:10-12`, `ai/export/README.md:3` | training, evaluation and export "not yet implemented" | all three exist |
| `ai/evaluation/README.md:15-31,86-90` | example results (89.3% precision); confidence sweep 0.3-0.5 | illustrative only, never measured; the sweep is a no-op below 0.55 |
| `ai/training/README.md:53-55`, `finetune.py:83` | classes are weighted / balanced | YAML comments only |
| `docs/ai.md:54-58,65-68,89-92,135-161` | RDD2022 one-class nano model; hand-written manifest; ONNX run without `model.json` | the deployed model is a 7-class YOLOv8m; export writes the manifest; that invocation fails (4) |
| `apps/web/public/models/README.md:13-48` | hand-written manifest and its field table | omits `inputWidth`, `inputHeight`, `task`, `maskCoefficients` and the end-to-end layout |
| `telegram-webapp.ts:8-9`, `next.config.ts:19-20` | Telegram injects its script / the Mini App loads it | nothing loads it (2.6) |
| `drive-view.tsx:56-57,111-114,427` | the threshold applies mid-drive; an IndexedDB failure shows a banner | neither is true (3.1) |
| `review-view.tsx:88` | "Reviewed examples become training data" | no path from reviews to `ai/training`; events carry no bounding box |
| `DESIGN_SYSTEM.md:381-388` | Active badge green, Repaired blue | public map: active red, repaired green, reported purple |
| `services/citizen_reports.py:166-169` | anonymous reports "count once between them" | `COUNT(DISTINCT)` ignores NULLs, so they count zero |

## 9. Spec gaps (PROJECT_SPEC.md)

| Section | Status |
| --- | --- |
| §35 MVP definition | Items 4-9 blocked by 2.1. Items 10-12 work on seed data |
| §44 first road test | Not done |
| §3.1 segmentation | Missing; the deployed model detects only |
| §5.3 nano/small edge model | Deviation: YOLOv8m, 49 MB, about 2 FPS on WASM (spec §24 asks ≥ 4; `drive.targetFps` is 6) |
| §5.4 licence review | Open (7) |
| §6 Mode B server inference | Browser adapter only; no endpoint |
| §7.1, Phase 8 IMU | Missing (wake lock done) |
| §11 V1 calibration, heading projection | Missing; V0 trigger region done |
| §12 severity | V0 implemented; never compared with human judgement |
| §13 event rules | Implemented. Peak confidence 0.55 vs the spec's 0.60 |
| §14 dedup heading | Computed but always neutral (3.2) |
| §15 `suspected_repaired` | Manual only; nothing sets it automatically |
| §16/§30 `model_versions` registry | Table exists; nothing reads or writes it |
| §17 API | Missing `/auth/refresh` (deliberate), `/detections/:id/image`, `/stats/severity`, `/stats/detections-over-time` |
| §20 routes | Missing `/drives`, `/drives/[id]`, `/settings` |
| §24 adaptive FPS | Frame skipping only; no adaptation |
| §25 offline queue | Implemented; drains only while `/drive` is open |
| §26 face/plate blurring | Missing (spec: "later if necessary") |
| §27 observability | Missing: structured logs, request IDs, error tracking, AI metrics |
| §29 review → training loop | Verdict is only correct or false positive. Nothing exports labels |
| §31 security | Login, sessions, potholes and stats are not rate-limited; image bytes never validated; backups manual |
| §4 PWA | Partial: no icons, no app shell |

## 10. Recommended order

1. Put the repository under git; nothing else can be rolled back without it.
2. **Done 2026-10-11:** fix `/drive` (2.1) and add the drive spec. Fix the MapLibre COEP header (2.3), and make
   the navigation spec assert that markers render.
3. **Done 2026-10-11:** stop synthetic uploads (2.2), on both client and server.
4. Public-deploy blockers: `npm audit fix` (2.8), `.dockerignore` (2.9), the `seed-demo`
   guard (2.7), rate-limit identity (2.5), `GET /citizen-reports` role.
5. Data integrity: commit inside the request and pin FastAPI (2.4); dedup locking with
   concurrency tests (3.2); re-issue upload targets on retry (3.2).
6. Wire the threshold slider through or remove it (3.1); fix the Python sampling (3.3).
7. Record and score the first driven route (section 11). Every model decision waits on it.
8. Refresh the docs (section 8). Get the lint gates green and add `packages/*` and
   `apps/api` to them.

## 11. Path to the first real measurement

The tooling exists (`ai/evaluation/score.py`: event-level precision, recall, F1 and false
alarms per driving minute). Only footage and ground truth are missing.

1. **Record.** Use the phone's camera app (`/drive` does not record video) on a fixed
   5-10 km route: landscape, bonnet out of shot, 1280x720.
2. **Transcode to constant frame rate** until 3.3 is fixed:
   `ffmpeg -i drive.mov -vf fps=30 -an -c:v libx264 -crf 18 samples/route-01.mp4`.
   Label against the transcoded file.
3. **Label blind.** Write `samples/route-01.truth.json` without looking at model output.
   Cross-check with `--make-truth-template` only afterwards.
4. **Run the shipped model.** This is the square ONNX, which reads its `model.json`:
   `.venv/bin/python -m ai.inference.video --input samples/route-01.mp4 --model apps/web/public/models/pothole-road-anomaly-1.0.0.onnx --json output/route-01.json --crops-dir output/route-01-crops`
5. **Score it.**
   `.venv/bin/python -m ai.evaluation.score --report output/route-01.json --truth samples/route-01.truth.json`
6. **Build an operating curve.** Re-run step 4 with `--confidence 0.25` and `0.45`; the
   `--min-confidence` sweep is a no-op below 0.55. Repeat with the YOLO26m candidate.
7. **Report intervals.** With about 30 potholes, recall is known only to about ±15 points.
