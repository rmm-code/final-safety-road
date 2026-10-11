"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
// import Link from "next/link"; // only the parked sign-in link used it
import type { Detection, VisionEngineInfo } from "@pothole/shared-types";
import {
  createVisionEngine,
  resolveVisionConfig,
  type DescribedVisionEngine,
} from "@pothole/vision-web";
import { Button, PageHeader, Panel } from "@/components/ui";
import type { AppConfig } from "@/lib/config";
import { OfflineEventQueue } from "@/lib/offline-queue";
import { createApiClient } from "@/lib/api-client";
import { encodeCanvas } from "@/lib/image-encoding";
import { EventUploader, type UploadOutcome } from "@/lib/uploader";
import { ThresholdControl } from "@/components/threshold-control";
import { CameraStage, type LiveOverlay } from "./components/camera-stage";
import { DriveEvents } from "./components/drive-events";
import { DriveHud, formatDriveClock } from "./components/drive-hud";
import { DriveRecorder, type DriveEvent, type DriveStats } from "./lib/drive-recorder";
import { useCamera } from "./lib/use-camera";
import { useLocation } from "./lib/use-location";
import { useWakeLock } from "./lib/use-wake-lock";

const EMPTY_STATS: DriveStats = {
  framesInferred: 0,
  framesSkipped: 0,
  inferenceFps: 0,
  lastLatencyMs: 0,
  averageLatencyMs: 0,
  activeTracks: 0,
  eventsBuilt: 0,
  eventsRejected: 0,
};

export function DriveView({ config }: { config: AppConfig }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<LiveOverlay>({ detections: [] });
  const recorderRef = useRef<DriveRecorder | null>(null);
  const engineRef = useRef<DescribedVisionEngine | null>(null);
  const queueRef = useRef<OfflineEventQueue | null>(null);
  const uploaderRef = useRef<EventUploader | null>(null);
  const frameRef = useRef(0);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const camera = useCamera();
  const location = useLocation();
  const wakeLock = useWakeLock();

  const [threshold, setThreshold] = useState(config.vision.detection.confidenceThreshold);
  const visionConfig = useMemo(
    () => resolveVisionConfig({ detection: { confidenceThreshold: threshold } }),
    [threshold],
  );
  // The running recorder reads this on every frame, so the slider takes effect mid-drive
  // rather than only on the next session.
  const thresholdRef = useRef(threshold);
  useEffect(() => {
    thresholdRef.current = threshold;
  }, [threshold]);

  const [engineInfo, setEngineInfo] = useState<VisionEngineInfo | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [stats, setStats] = useState<DriveStats>(EMPTY_STATS);
  const [events, setEvents] = useState<DriveEvent[]>([]);
  const [driveSessionId, setDriveSessionId] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);
  const [uploaded, setUploaded] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);

  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);

  // Resolve the detector once, before the driver taps anything.
  useEffect(() => {
    let disposed = false;
    createVisionEngine({
      mode: config.visionMode,
      config: config.vision,
      manifestUrl: config.modelManifestUrl,
      wasmPath: config.ortWasmPath,
      ortLogLevel: config.ortLogLevel,
      ...(config.serverVisionUrl ? { serverUrl: config.serverVisionUrl } : {}),
    })
      .then((engine) => {
        if (disposed) return void engine.dispose();
        engineRef.current = engine;
        setEngineInfo(engine.info);
      })
      .catch((cause: unknown) =>
        setEngineError(cause instanceof Error ? cause.message : String(cause)),
      );
    return () => {
      disposed = true;
      void engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [config]);

  useEffect(() => {
    OfflineEventQueue.open()
      .then((queue) => {
        queueRef.current = queue;
        uploaderRef.current = new EventUploader({ client: api, queue });
      })
      .catch(() => {
        // Without IndexedDB events cannot survive a lost connection; the drive still
        // works and the banner explains the limitation.
      });
  }, [api]);

  /**
   * Empty the queue whenever the network allows.
   *
   * On a timer and on `online`, because a vehicle passes through tunnels and dead spots:
   * the moment signal returns is exactly when the backlog should go, and waiting for the
   * driver to do something would mean it never does.
   */
  const drain = useCallback(async () => {
    const uploader = uploaderRef.current;
    const queue = queueRef.current;
    if (!uploader || !queue) return;
    try {
      const outcome: UploadOutcome = await uploader.drain();
      if (outcome.uploaded > 0) setUploaded((count) => count + outcome.uploaded);
      setSignInNeeded(outcome.blocked === "auth");
      const counts = await queue.counts();
      setQueued(counts.pending + counts.failed);
      setUploadError(null);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void drain(), 15_000);
    const onOnline = () => void drain();
    window.addEventListener("online", onOnline);
    void drain();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [drain]);

  useEffect(() => {
    if (!running || startedAt === null) return;
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 500);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);

  /** Captures the evidence crop for a detection from the live video. */
  const captureFrame = useCallback((bbox: Detection["bbox"]) => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return null;

    if (!captureCanvasRef.current) captureCanvasRef.current = document.createElement("canvas");
    const canvas = captureCanvasRef.current;
    const width = Math.min(640, video.videoWidth);
    const height = Math.round((width / video.videoWidth) * video.videoHeight);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);

    const pad = 0.35;
    const cropX = Math.max(0, Math.floor((bbox.x - bbox.width * pad) * width));
    const cropY = Math.max(0, Math.floor((bbox.y - bbox.height * pad) * height));
    const cropW = Math.min(width - cropX, Math.ceil(bbox.width * (1 + pad * 2) * width));
    const cropH = Math.min(height - cropY, Math.ceil(bbox.height * (1 + pad * 2) * height));
    // One encoder for both, so both images are the one type the upload is signed for.
    if (cropW < 4 || cropH < 4) return { fullImage: encodeCanvas(canvas, 0.7) };

    const crop = document.createElement("canvas");
    crop.width = cropW;
    crop.height = cropH;
    crop.getContext("2d")?.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    return {
      fullImage: encodeCanvas(canvas, 0.7),
      cropImage: encodeCanvas(crop, 0.82),
    };
  }, []);

  const handleEvent = useCallback((event: DriveEvent) => {
    setEvents((current) => [...current, event]);
    if (!event.build.ok) return;
    // Written to IndexedDB immediately: connectivity is exactly what fails while driving.
    void queueRef.current
      ?.enqueue(event.build.event, {
        ...(event.fullImage ? { fullImage: event.fullImage } : {}),
        ...(event.cropImage ? { cropImage: event.cropImage } : {}),
      })
      .then(() => drain());
  }, [drain]);

  const startDrive = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    // The stream reaches the <video> in the effect below, once CameraStage has mounted it.
    const stream = await camera.start();
    if (!stream) return;

    location.start();
    void wakeLock.acquire();

    // The phone names the drive, and the queue tells the server. Every sighting carries
    // this id from the first frame, so a drive started in a dead spot is still one drive:
    // the uploader creates the session whenever it next reaches the API, then sends the
    // sightings, then the end. Asking the server first used to mean a drive started out
    // of signal stamped its sightings with an id the server never learned.
    const sessionId = crypto.randomUUID();
    const device = { device_name: navigator.userAgent.slice(0, 120), platform: navigator.platform };
    const queue = queueRef.current;
    if (queue) {
      await queue.startSession(sessionId, device);
    } else {
      // No IndexedDB: nothing can be held for later, so this is the only chance.
      void api.createDriveSession({ id: sessionId, ...device }).catch((cause: unknown) =>
        setUploadError(cause instanceof Error ? cause.message : String(cause)),
      );
    }
    setDriveSessionId(sessionId);
    void drain();

    const recorder = new DriveRecorder({
      engine,
      config: visionConfig,
      locations: location.buffer,
      driveSessionId: sessionId,
      targetFps: visionConfig.drive.targetFps,
      onEvent: handleEvent,
    });
    recorderRef.current = recorder;

    setEvents([]);
    setStats(EMPTY_STATS);
    setStartedAt(Date.now());
    setElapsedMs(0);
    setRunning(true);

    const loop = async () => {
      frameRef.current = requestAnimationFrame(() => void loop());
      const element = videoRef.current;
      if (!element || element.readyState < 2) return;

      const analysed = await recorder.tick(element, captureFrame);
      if (analysed) {
        setStats(recorder.stats);
        overlayRef.current = buildOverlay(recorder);
      }
    };
    void loop();
  }, [api, camera, captureFrame, drain, handleEvent, location, visionConfig, wakeLock]);

  const stopDrive = useCallback(() => {
    cancelAnimationFrame(frameRef.current);
    recorderRef.current?.finish();
    setStats(recorderRef.current?.stats ?? EMPTY_STATS);
    recorderRef.current = null;
    overlayRef.current = { detections: [] };
    camera.stop();
    location.stop();
    void wakeLock.release();
    setRunning(false);

    if (driveSessionId) {
      const queue = queueRef.current;
      // Queued like the sightings, and sent after them: a drive stopped in a car park
      // with no signal still ends at the moment the driver stopped it.
      if (queue) void queue.endSession(driveSessionId).then(() => drain());
      else void api.endDriveSession(driveSessionId).catch(() => {});
    }
  }, [api, camera, drain, driveSessionId, location, wakeLock]);

  // The <video> belongs to CameraStage, which mounts on the render after the camera reports
  // "ready" - later than `startDrive` resumes from `camera.start()`. Attaching the stream
  // there found a null ref, so no frame ever reached the detector. Attach it once both exist.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !camera.stream || video.srcObject === camera.stream) return;
    video.srcObject = camera.stream;
    void video.play().catch(() => {});
  }, [camera.stream]);

  // The model sees whatever orientation Safari delivers. With rotation lock on, a phone
  // mounted sideways still streams a portrait picture, and portrait footage hides the
  // trigger region under the bonnet: measured, zero detections ever reached it.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const measure = () =>
      setVideoSize(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : null);
    video.addEventListener("loadedmetadata", measure);
    video.addEventListener("resize", measure);
    measure();
    return () => {
      video.removeEventListener("loadedmetadata", measure);
      video.removeEventListener("resize", measure);
    };
  }, [running, camera.status]);
  const portrait = running && videoSize !== null && videoSize.height > videoSize.width;

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const blocked = camera.status === "denied" || camera.status === "insecure" || camera.status === "unavailable";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Live drive"
        description="Mount the phone before moving. Start the drive while stationary and stop it after parking."
        actions={
          running ? (
            <span className="font-mono text-lg tabular-nums text-primary">
              {formatDriveClock(elapsedMs)}
            </span>
          ) : null
        }
      />

      {engineError && (
        <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Detector unavailable</div>
          <p className="mt-1 text-secondary">{engineError}</p>
        </div>
      )}

      {engineInfo?.isSynthetic && (
        <div role="status" className="rounded-xl bg-yellow-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-yellow-ink">Synthetic detections</div>
          <p className="mt-1 text-secondary">
            No usable model loaded, so the boxes below are fabricated and unrelated to the road
            in front of you. Nothing recorded in this drive is a real observation, and none of
            it is uploaded.
          </p>
        </div>
      )}

      {camera.error && (
        <div role="alert" className="rounded-xl bg-red-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-red-ink">Camera</div>
          <p className="mt-1 text-secondary">{camera.error}</p>
        </div>
      )}

      {portrait && (
        <div role="alert" className="rounded-xl bg-yellow-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-yellow-ink">Camera picture is portrait</div>
          <p className="mt-1 text-secondary">
            Turn off rotation lock and turn the phone sideways. In portrait the bottom of the
            picture is the bonnet, so potholes are never located and severity is unreliable.
          </p>
        </div>
      )}

      {signInNeeded && (
        <div role="alert" className="rounded-xl bg-yellow-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-yellow-ink">Sign in to upload</div>
          <p className="mt-1 text-secondary">
            The server refused this phone, so {queued} sighting{queued === 1 ? " is" : "s are"} held
            here, untouched. They upload on their own once the server accepts this phone.
            {/* The login page is parked (app/(console)/_login); the API must run with
                AUTH_DISABLED=true. Restore when sign-in returns:
                <Link href="/login?next=/drive" className="underline">Sign in</Link> */}
          </p>
        </div>
      )}

      {location.error && running && (
        <div role="alert" className="rounded-xl bg-yellow-soft px-4 py-3 text-[13px]">
          <div className="font-semibold text-yellow-ink">Location</div>
          <p className="mt-1 text-secondary">{location.error}</p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-3">
          {running || camera.status === "ready" ? (
            <CameraStage
              videoRef={videoRef}
              overlayRef={overlayRef}
              triggerRegionTopY={visionConfig.triggerRegion.topY}
            />
          ) : (
            <div className="grid aspect-[4/3] w-full place-items-center rounded-lg bg-subtle text-[13px] text-muted sm:aspect-video">
              Camera preview appears when the drive starts
            </div>
          )}

          <DriveHud
            stats={stats}
            location={location}
            running={running}
            eventsQueued={stats.eventsBuilt}
          />

          {running ? (
            <Button variant="destructive" className="h-12 w-full text-base" onClick={stopDrive}>
              Stop drive
            </Button>
          ) : (
            <Button
              variant="primary"
              className="h-12 w-full text-base"
              disabled={!engineInfo || blocked}
              onClick={() => void startDrive()}
            >
              Start drive
            </Button>
          )}
        </div>

        <div className="space-y-4">
          <Panel title="This drive" subtitle={`${events.length} captured`} icon="potholes">
            <DriveEvents events={events} />
          </Panel>

          <Panel title="Detector" subtitle="Model and runtime on this phone" icon="models">
            <EngineLine info={engineInfo} />
            <ThresholdControl
              value={threshold}
              defaultValue={config.vision.detection.confidenceThreshold}
              onChange={setThreshold}
              onReset={() => setThreshold(config.vision.detection.confidenceThreshold)}
              hint="Takes effect immediately, mid-drive. Lower finds more and reports more mistakes."
            />
          </Panel>

          <Panel title="Session" subtitle="Frames, events and uploads" icon="dashboard">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              <Metric label="Frames analysed" value={String(stats.framesInferred)} />
              <Metric label="Frames skipped" value={String(stats.framesSkipped)} />
              <Metric label="Latency" value={`${stats.averageLatencyMs.toFixed(0)} ms`} />
              <Metric label="Tracking" value={String(stats.activeTracks)} />
              <Metric label="Queued" value={String(stats.eventsBuilt)} />
              <Metric label="Not located" value={String(stats.eventsRejected)} />
              <Metric label="Uploaded" value={String(uploaded)} />
              <Metric label="Awaiting upload" value={String(queued)} />
            </dl>
            <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted">
              Only pothole evidence images are stored, never the video. Events are held on this
              device until a connection is available, then uploaded automatically.
            </p>
            {uploadError && <p className="mt-2 text-[11px] text-red-ink">{uploadError}</p>}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * Which runtime the model actually got, read before the drive starts.
 *
 * WebGPU or WASM is decided by the browser, not by us, and it is the difference between
 * a usable frame rate and a useless one. Shown so it can be checked on the phone itself.
 */
function EngineLine({ info }: { info: VisionEngineInfo | null }) {
  if (!info) return <p className="mb-3 text-[12px] text-muted">Loading the detector...</p>;
  const runtime: Record<string, string> = { webgpu: "WebGPU", wasm: "WASM (CPU)", http: "Server" };
  return (
    <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px]">
      <dt className="text-muted">Runtime</dt>
      <dd className="font-mono text-primary">{runtime[info.backend] ?? info.backend}</dd>
      <dt className="text-muted">Model</dt>
      <dd className="truncate font-mono text-primary">{info.modelVersion}</dd>
    </dl>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] leading-4 text-muted">{label}</dt>
      <dd className="mt-0.5 font-mono tabular-nums text-primary">{value}</dd>
    </div>
  );
}

/** The latest detection of every live track. */
function buildOverlay(recorder: DriveRecorder): LiveOverlay {
  const detections: Detection[] = [];
  for (const track of recorder.activeTracks) {
    const observation = track.observations[track.observations.length - 1];
    if (observation) detections.push(observation.detection);
  }
  return { detections };
}
