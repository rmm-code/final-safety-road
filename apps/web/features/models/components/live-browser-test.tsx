"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVisionEngine,
  resolveVisionConfig,
  type DescribedVisionEngine,
} from "@pothole/vision-web";
import { Badge, Button, Panel } from "@/components/ui";
import type { AppConfig } from "@/lib/config";
import type { CompareModel, FrameBoxes } from "../lib/compare-data";
import { FramePanel } from "./frame-panel";

/** Runs before timing starts: the first inference compiles shaders and allocates buffers. */
const WARMUP_RUNS = 2;
const TIMED_RUNS = 5;

/**
 * Which ONNX Runtime backend to load with. "auto" is what the product does: WebGPU, falling
 * back to WASM. Forcing WASM shows what a phone without WebGPU would get, and whether a
 * model that misbehaves on the GPU path works at all.
 */
const BACKENDS = {
  auto: { label: "Auto (WebGPU, then WASM)", providers: undefined },
  webgpu: { label: "WebGPU only", providers: ["webgpu"] },
  wasm: { label: "WASM (CPU) only", providers: ["wasm"] },
} as const;
type BackendChoice = keyof typeof BACKENDS;

/**
 * The "does it fit our web app" test, measured rather than claimed.
 *
 * Loads the chosen model through the SAME engine /analyze and /drive use - same download,
 * same WebGPU-or-WASM choice, same decoder - and runs it on the frame being viewed. A model
 * that cannot do that here cannot do it for a driver either.
 *
 * Detections are requested at a low threshold and filtered by the page's slider, so the
 * boxes are comparable with the precomputed panels above.
 */
export function LiveBrowserTest({
  config,
  models,
  frameUrl,
  aspect,
  threshold,
}: {
  config: AppConfig;
  models: CompareModel[];
  frameUrl: string;
  aspect: number;
  threshold: number;
}) {
  const runnable = models.filter((model) => model.web.manifestUrl);
  const [modelId, setModelId] = useState(runnable[0]?.id ?? "");
  const [backend, setBackend] = useState<BackendChoice>("auto");
  const [phase, setPhase] = useState<"idle" | "loading" | "running" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    modelId: string;
    frameUrl: string;
    backend: string;
    loadMs: number;
    meanMs: number;
    boxes: FrameBoxes;
  } | null>(null);
  const engineRef = useRef<{ key: string; engine: DescribedVisionEngine; loadMs: number } | null>(
    null,
  );

  // Engines hold GPU buffers; release the old one when the model changes or the page goes.
  useEffect(
    () => () => {
      void engineRef.current?.engine.dispose();
      engineRef.current = null;
    },
    [],
  );

  const run = useCallback(async () => {
    const model = runnable.find((candidate) => candidate.id === modelId);
    if (!model?.web.manifestUrl) return;
    setError(null);

    try {
      const key = `${model.id}:${backend}`;
      if (engineRef.current?.key !== key) {
        await engineRef.current?.engine.dispose();
        engineRef.current = null;
        setPhase("loading");
        const started = performance.now();
        const engine = await createVisionEngine({
          // Forced, never "auto": a failed load must be reported as a failure, not
          // quietly replaced by the synthetic engine and passed off as this model.
          mode: "onnx",
          config: resolveVisionConfig({ detection: { confidenceThreshold: 0.1 } }),
          manifestUrl: model.web.manifestUrl,
          wasmPath: config.ortWasmPath,
          ortLogLevel: config.ortLogLevel,
          ...(BACKENDS[backend].providers
            ? { executionProviders: [...BACKENDS[backend].providers] }
            : {}),
        });
        engineRef.current = { key, engine, loadMs: performance.now() - started };
      }

      setPhase("running");
      const image = await loadImage(frameUrl);
      const { engine, loadMs } = engineRef.current!;
      for (let i = 0; i < WARMUP_RUNS; i++) await engine.infer(image);

      let total = 0;
      let detections = await engine.infer(image);
      for (let i = 0; i < TIMED_RUNS; i++) {
        const started = performance.now();
        detections = await engine.infer(image);
        total += performance.now() - started;
      }

      setResult({
        modelId: model.id,
        frameUrl,
        backend: engine.info.backend,
        loadMs,
        meanMs: total / TIMED_RUNS,
        boxes: detections.map((d) => [
          d.bbox.x,
          d.bbox.y,
          d.bbox.x + d.bbox.width,
          d.bbox.y + d.bbox.height,
          d.confidence,
        ]),
      });
      setPhase("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPhase("error");
    }
  }, [backend, config.ortLogLevel, config.ortWasmPath, frameUrl, modelId, runnable]);

  const busy = phase === "loading" || phase === "running";
  const label = runnable.find((model) => model.id === result?.modelId)?.label ?? "";
  const stale = result && (result.frameUrl !== frameUrl || result.modelId !== modelId);

  return (
    <Panel
      title="Run it in this browser"
      subtitle="The same engine the drive and analyze pages use. Only models already exported for the web can run here."
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-[220px] flex-1 text-[12px] text-secondary">
          Model
          <select
            value={modelId}
            disabled={busy}
            onChange={(event) => setModelId(event.target.value)}
            className="mt-1 block h-9 w-full rounded-lg bg-fill px-2.5 text-[13px] text-primary"
          >
            {runnable.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label} ({model.web.onnxMB} MB)
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[200px] text-[12px] text-secondary">
          Backend
          <select
            value={backend}
            disabled={busy}
            onChange={(event) => setBackend(event.target.value as BackendChoice)}
            className="mt-1 block h-9 w-full rounded-lg bg-fill px-2.5 text-[13px] text-primary"
          >
            {Object.entries(BACKENDS).map(([id, option]) => (
              <option key={id} value={id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <Button variant="primary" disabled={busy || !modelId} onClick={() => void run()}>
          {phase === "loading" ? "Downloading model…" : phase === "running" ? "Running…" : "Run on this frame"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-red-ink">
          Could not run here: {error}
        </p>
      )}

      {result && (
        <div className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <FramePanel
            src={result.frameUrl}
            aspect={aspect}
            boxes={result.boxes}
            threshold={threshold}
            colour="#137A4E"
            title={`${label}, live`}
            emptyNote="Nothing above the threshold on this frame"
          />
          <dl className="space-y-2 self-start text-[13px]">
            <Row label="Backend">
              <Badge tone="info">{result.backend}</Badge>
            </Row>
            <Row label="Per frame">
              <span className="tabular font-mono">{result.meanMs.toFixed(1)} ms</span>
            </Row>
            <Row label="Frames per second">
              <span className="tabular font-mono">{(1000 / result.meanMs).toFixed(1)}</span>
            </Row>
            <Row label="First load">
              <span className="tabular font-mono">{(result.loadMs / 1000).toFixed(1)} s</span>
            </Row>
            {stale && (
              <p className="pt-1 text-[12px] leading-4 text-muted">
                Shown for an earlier frame or model. Run again to update.
              </p>
            )}
            <p className="pt-1 text-[12px] leading-4 text-muted">
              Mean of {TIMED_RUNS} runs after {WARMUP_RUNS} warm-ups. A phone is slower than this
              machine; live drive needs about 6 frames per second.
            </p>
          </dl>
        </div>
      )}
    </Panel>
  );
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Frame failed to load: ${url}`));
    image.src = url;
  });
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
