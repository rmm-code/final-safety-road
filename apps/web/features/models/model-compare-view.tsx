"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Badge, Button, PageHeader, Panel } from "@/components/ui";
import type { AppConfig } from "@/lib/config";
import {
  COMPARE_ROOT,
  MODEL_A_COLOUR,
  MODEL_B_COLOUR,
  WEB_STATUS,
  loadBoxes,
  loadIndex,
  type AlsoTested,
  type CompareIndex,
  type CompareModel,
  type CompareSet,
  type FrameBoxes,
} from "./lib/compare-data";
import { FramePanel } from "./components/frame-panel";
import { LiveBrowserTest } from "./components/live-browser-test";
import { Scorecard } from "./components/scorecard";

const PLAY_INTERVAL_MS = 450;

/**
 * Candidate detectors, side by side on the same frames.
 *
 * Everything shown was computed offline by `ai/evaluation/build_model_compare.py` except the
 * live test, which runs in the viewer's browser. The page exists so a person can SEE why
 * one model is preferred - published benchmark numbers alone picked the wrong model once.
 */
export function ModelCompareView({ config }: { config: AppConfig }) {
  const index = useQuery({ queryKey: ["model-compare"], queryFn: loadIndex, staleTime: Infinity });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Model comparison"
        description="Which detector should the product run? Each setup on our own road videos, every report checked by two independent reviewers, plus a live test in this browser."
      />
      {index.isLoading && <p className="text-[13px] text-muted">Loading comparison…</p>}
      {index.error && (
        <p role="alert" className="text-[13px] text-red-ink">
          {(index.error as Error).message}
        </p>
      )}
      {index.data && <Comparison data={index.data} config={config} />}
    </div>
  );
}

function Comparison({ data, config }: { data: CompareIndex; config: AppConfig }) {
  const [setId, setSetId] = useState(data.sets[0]?.id ?? "");
  const [modelA, setModelA] = useState(data.models[0]?.id ?? "");
  // Open on the comparison the scorecard is about: today's model against the merge.
  const [modelB, setModelB] = useState(
    data.models.find((model) => model.id === "ens_all3")?.id ?? data.models[1]?.id ?? "",
  );
  const [threshold, setThreshold] = useState(config.vision.detection.confidenceThreshold);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  const set = data.sets.find((candidate) => candidate.id === setId) ?? data.sets[0];
  const frameCount = set?.frames.length ?? 0;
  const current = set?.frames[Math.min(frame, frameCount - 1)];

  const boxesA = useQuery({
    queryKey: ["model-compare", setId, modelA],
    queryFn: () => loadBoxes(setId, modelA),
    staleTime: Infinity,
  });
  const boxesB = useQuery({
    queryKey: ["model-compare", setId, modelB],
    queryFn: () => loadBoxes(setId, modelB),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!playing || frameCount === 0) return;
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % frameCount), PLAY_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [playing, frameCount]);

  const totals = useMemo(() => {
    const count = (frames: FrameBoxes[] | undefined) =>
      (frames ?? []).reduce((sum, boxes) => sum + boxes.filter((box) => box[4] >= threshold).length, 0);
    return { a: count(boxesA.data), b: count(boxesB.data) };
  }, [boxesA.data, boxesB.data, threshold]);

  if (!set || !current) return null;
  const frameUrl = `${COMPARE_ROOT}/${set.id}/frames/${current.file}`;
  const aspect = current.width / current.height;
  const label = (id: string) => data.models.find((model) => model.id === id)?.label ?? id;

  return (
    <>
      {data.verdict.length > 0 && (
        <Panel title="Verdict" subtitle={`From the runs below, ${data.generatedAt}`} icon="info">
          <div className="max-w-[78ch] space-y-2 text-[13px] leading-5 text-secondary">
            {data.verdict.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </Panel>
      )}

      {data.scorecard ? (
        <Scorecard
          scorecard={data.scorecard}
          titles={Object.fromEntries(data.sets.map((candidate) => [candidate.id, candidate.title]))}
        />
      ) : (
        <ResultsTable data={data} />
      )}

      <Panel
        icon="video"
        title="See it frame by frame"
        subtitle="Pick two models. Numbers on the boxes are confidence, in percent."
        bodyClassName="space-y-4"
      >
        <div className="flex flex-wrap gap-0.5 rounded-lg bg-fill p-1" role="tablist" aria-label="Test footage">
          {data.sets.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={candidate.id === set.id}
              onClick={() => {
                setSetId(candidate.id);
                setFrame(0);
              }}
              className={clsx(
                "h-8 rounded-md px-3 text-[13px] transition-colors duration-150",
                candidate.id === set.id
                  ? "bg-surface font-medium text-primary shadow-card"
                  : "text-secondary hover:text-primary",
              )}
            >
              {candidate.title}
            </button>
          ))}
        </div>
        <p className="max-w-[90ch] text-[13px] leading-5 text-secondary">
          {set.description} <span className="text-muted">Source: {set.source}.</span>
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_minmax(0,260px)]">
          <ModelSelect value={modelA} onChange={setModelA} models={data.models} colour={MODEL_A_COLOUR} label="Model A" />
          <ModelSelect value={modelB} onChange={setModelB} models={data.models} colour={MODEL_B_COLOUR} label="Model B" />
          <label className="text-[12px] text-secondary sm:col-span-2 lg:col-span-1">
            <span className="flex justify-between">
              Confidence threshold
              <span className="tabular font-mono text-primary">{threshold.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={0.1}
              max={0.9}
              step={0.05}
              value={threshold}
              onChange={(event) => setThreshold(Number(event.target.value))}
              className="mt-2 w-full accent-[#2563EB]"
            />
            <span className="text-[11px] text-muted">The product uses {config.vision.detection.confidenceThreshold}.</span>
          </label>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <FramePanel
            src={frameUrl}
            aspect={aspect}
            boxes={boxesA.data?.[frame]}
            threshold={threshold}
            colour={MODEL_A_COLOUR}
            title={label(modelA)}
            subtitle={`${totals.a} pothole boxes across all ${frameCount} frames at this threshold`}
            emptyNote="No pothole above the threshold"
          />
          <FramePanel
            src={frameUrl}
            aspect={aspect}
            boxes={boxesB.data?.[frame]}
            threshold={threshold}
            colour={MODEL_B_COLOUR}
            title={label(modelB)}
            subtitle={`${totals.b} pothole boxes across all ${frameCount} frames at this threshold`}
            emptyNote="No pothole above the threshold"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={() => setFrame((value) => (value - 1 + frameCount) % frameCount)} aria-label="Previous frame">
            Previous
          </Button>
          <Button variant="primary" onClick={() => setPlaying((value) => !value)}>
            {playing ? "Pause" : "Play"}
          </Button>
          <Button onClick={() => setFrame((value) => (value + 1) % frameCount)} aria-label="Next frame">
            Next
          </Button>
          <input
            type="range"
            min={0}
            max={frameCount - 1}
            value={frame}
            onChange={(event) => {
              setPlaying(false);
              setFrame(Number(event.target.value));
            }}
            aria-label="Frame"
            className="min-w-[160px] flex-1 accent-[#2563EB]"
          />
          <span className="tabular font-mono text-[12px] text-secondary">
            {frame + 1} / {frameCount}
          </span>
        </div>

        {set.notes.length > 0 && (
          <ul className="space-y-1 border-t border-border pt-3 text-[12px] leading-4 text-muted">
            {set.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </Panel>

      <LiveBrowserTest
        config={config}
        models={data.models}
        frameUrl={frameUrl}
        aspect={aspect}
        threshold={threshold}
      />

      <WebFitTable models={data.models} />
      {data.alsoTested && data.alsoTested.length > 0 && <AlsoTestedList items={data.alsoTested} />}
    </>
  );
}

function ModelSelect({
  value,
  onChange,
  models,
  colour,
  label,
}: {
  value: string;
  onChange: (id: string) => void;
  models: CompareModel[];
  colour: string;
  label: string;
}) {
  return (
    <label className="text-[12px] text-secondary">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: colour }} />
        {label}
      </span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 block h-9 w-full rounded-lg bg-fill px-2.5 text-[13px] text-primary"
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The headline numbers, one row per model, one column group per test set. */
function ResultsTable({ data }: { data: CompareIndex }) {
  return (
    <Panel
      icon="dashboard"
      title="Results"
      subtitle="Potholes found = unique potholes after our tracking pipeline. Frames = frames with at least one pothole at the product threshold."
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-secondary">
              <th scope="col" className="px-4 py-2 font-medium">Model</th>
              {data.sets.map((set) => (
                <th key={set.id} scope="col" className="px-4 py-2 font-medium">
                  {set.title}
                </th>
              ))}
              <th scope="col" className="px-4 py-2 font-medium">Published score</th>
              <th scope="col" className="px-4 py-2 font-medium">Speed here</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.models.map((model) => (
              <tr key={model.id} className="h-12 align-middle">
                <td className="px-4">
                  <div className="font-medium">{model.label}</div>
                  <div className="text-[12px] text-muted">{model.arch}</div>
                </td>
                {data.sets.map((set) => (
                  <SetCell key={set.id} set={set} modelId={model.id} />
                ))}
                <td className="px-4 text-[12px] text-secondary">{model.benchmark ?? "Not published"}</td>
                <td className="tabular px-4 font-mono text-[12px] text-secondary">
                  {data.sets[0]?.summaries[model.id]?.meanMs != null
                    ? `${data.sets[0].summaries[model.id]!.meanMs} ms`
                    : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border px-4 py-2.5 text-[12px] leading-4 text-muted">
        Speed is per frame on the Mac that ran the comparison (Apple GPU, PyTorch), not in a browser
        or on a phone. Published scores are each model&apos;s own test set and are not comparable
        with each other or with our footage.
      </p>
    </Panel>
  );
}

function SetCell({ set, modelId }: { set: CompareSet; modelId: string }) {
  const summary = set.summaries[modelId];
  const pipeline = set.pipeline[modelId];
  const metric = set.metrics[modelId];
  if (!summary) return <td className="px-4 text-muted">-</td>;
  const nothing = summary.boxesAt035 === 0;

  return (
    <td className="px-4">
      {metric?.ap50 != null ? (
        <div className="tabular font-mono">AP50 {metric.ap50.toFixed(2)}</div>
      ) : pipeline ? (
        <div className={clsx("tabular font-mono", nothing && "text-muted")}>
          {pipeline.potholes} found
        </div>
      ) : (
        <div className={clsx("tabular font-mono", nothing && "text-muted")}>
          {summary.boxesAt035} boxes
        </div>
      )}
      <div className="tabular text-[12px] text-muted">
        {metric?.recall != null && metric.precision != null
          ? // Scored over the whole labelled set; the frame count would be the viewer's sample.
            `P ${metric.precision.toFixed(2)} · R ${metric.recall.toFixed(2)}`
          : `${summary.framesWithPotholeAt035}/${summary.frames} frames`}
      </div>
    </td>
  );
}

/** Candidates measured and dropped, one line each, so the short list above is not a mystery. */
function AlsoTestedList({ items }: { items: AlsoTested[] }) {
  return (
    <Panel icon="models" title="Also tested" subtitle="Candidates we measured and dropped.">
      <ul className="max-w-[90ch] space-y-2 text-[13px] leading-5">
        {items.map((item) => (
          <li key={item.label}>
            <span className="font-medium text-primary">{item.label}</span>
            <span className="text-secondary">: {item.reason}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function WebFitTable({ models }: { models: CompareModel[] }) {
  return (
    <Panel
      icon="models"
      title="Which fits our web app"
      subtitle="What it takes to ship each model to the browser, where detection actually runs."
      bodyClassName="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[12px] text-secondary">
              <th scope="col" className="px-4 py-2 font-medium">Model</th>
              <th scope="col" className="px-4 py-2 font-medium">Status</th>
              <th scope="col" className="px-4 py-2 font-medium">Download</th>
              <th scope="col" className="px-4 py-2 font-medium">Input</th>
              <th scope="col" className="px-4 py-2 font-medium">Licence</th>
              <th scope="col" className="px-4 py-2 font-medium">What it takes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {models.map((model) => {
              const status = WEB_STATUS[model.web.status];
              return (
                <tr key={model.id} className="align-top">
                  <td className="px-4 py-3">
                    <a
                      href={model.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-blue-ink underline-offset-2 hover:underline"
                    >
                      {model.label}
                    </a>
                    <div className="text-[12px] leading-4 text-muted">{model.trainedOn}</div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </td>
                  <td className="tabular px-4 py-3 font-mono text-[12px]">{model.web.onnxMB} MB</td>
                  <td className="tabular px-4 py-3 font-mono text-[12px]">{model.inputSize}px</td>
                  <td className="px-4 py-3 text-[12px] text-secondary">{model.license}</td>
                  <td className="px-4 py-3 text-[12px] leading-4 text-secondary">{model.web.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
