import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VISION_CONFIG } from "../config/vision-config";
import { createVisionEngine, loadModelManifest } from "./factory";

const MANIFEST_URL = "/models/model.json";

function respondWith(status: number, body?: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

describe("model manifest loading", () => {
  it("returns null when no model is deployed", async () => {
    expect(await loadModelManifest(MANIFEST_URL, respondWith(404))).toBeNull();
  });

  it("surfaces a server error rather than falling silent", async () => {
    await expect(loadModelManifest(MANIFEST_URL, respondWith(500, {}))).rejects.toThrow(/responded 500/);
  });

  it("surfaces a network failure", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(loadModelManifest(MANIFEST_URL, failing)).rejects.toThrow(/Could not reach/);
  });
});

describe("engine selection", () => {
  it("falls back to the synthetic engine when no model is deployed, and says why", async () => {
    const engine = await createVisionEngine({
      mode: "auto",
      config: DEFAULT_VISION_CONFIG,
      manifestUrl: MANIFEST_URL,
      fetchImpl: respondWith(404),
    });

    expect(engine.info.kind).toBe("mock");
    expect(engine.info.isSynthetic).toBe(true);
    expect(engine.info.selectionReason).toContain("No model manifest");
    expect(engine.info.selectionReason).toContain("SYNTHETIC");
  });

  it("falls back to the synthetic engine when the manifest is malformed", async () => {
    const engine = await createVisionEngine({
      mode: "auto",
      config: DEFAULT_VISION_CONFIG,
      manifestUrl: MANIFEST_URL,
      fetchImpl: respondWith(200, { name: "broken" }),
    });

    expect(engine.info.kind).toBe("mock");
    expect(engine.info.selectionReason).toContain("Invalid model manifest");
  });

  it("prefers the server adapter over synthetic output when an endpoint is configured", async () => {
    const engine = await createVisionEngine({
      mode: "auto",
      config: DEFAULT_VISION_CONFIG,
      manifestUrl: MANIFEST_URL,
      serverUrl: "https://inference.internal/v1/detect",
      fetchImpl: respondWith(404),
    });

    expect(engine.info.kind).toBe("server");
    expect(engine.info.isSynthetic).toBe(false);
    expect(engine.info.selectionReason).toContain("Browser inference unavailable");
  });

  it("fails loudly when ONNX is forced and no model is deployed", async () => {
    await expect(
      createVisionEngine({
        mode: "onnx",
        config: DEFAULT_VISION_CONFIG,
        manifestUrl: MANIFEST_URL,
        fetchImpl: respondWith(404),
      }),
    ).rejects.toThrow(/No model manifest deployed/);
  });

  it("returns an initialised synthetic engine when it is forced", async () => {
    const engine = await createVisionEngine({ mode: "mock", config: DEFAULT_VISION_CONFIG });
    expect(engine.info.kind).toBe("mock");
    await expect(engine.infer(null as unknown as CanvasImageSource)).resolves.toBeInstanceOf(Array);
  });

  it("refuses to build a server engine without an endpoint", async () => {
    await expect(
      createVisionEngine({ mode: "server", config: DEFAULT_VISION_CONFIG }),
    ).rejects.toThrow(/requires an endpoint/);
  });
});
