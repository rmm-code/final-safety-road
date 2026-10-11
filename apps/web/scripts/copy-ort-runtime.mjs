#!/usr/bin/env node
/**
 * Copy the onnxruntime-web WebAssembly binaries into public/ort so the browser can
 * fetch them from our own origin.
 *
 * ONNX Runtime Web resolves its .wasm files relative to the bundled script by default,
 * which does not survive Next.js chunking. Serving them from a stable path and pointing
 * `ort.env.wasm.wasmPaths` at it (NEXT_PUBLIC_ORT_WASM_PATH) is the reliable option, and
 * it keeps inference working with no third-party CDN.
 *
 * Exits 0 when the runtime is absent: the app falls back to the synthetic engine and
 * says so, and a missing optional asset must not fail a build.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(webRoot, "public", "ort");

const candidates = [
  join(webRoot, "node_modules", "onnxruntime-web", "dist"),
  join(webRoot, "..", "..", "node_modules", "onnxruntime-web", "dist"),
  join(webRoot, "..", "..", "packages", "vision-web", "node_modules", "onnxruntime-web", "dist"),
];

const source = candidates.find((path) => existsSync(path));
if (!source) {
  console.warn("[ort] onnxruntime-web is not installed; skipping runtime copy.");
  process.exit(0);
}

const entries = await readdir(source);
const runtimeFiles = entries.filter((name) => name.endsWith(".wasm") || name.endsWith(".mjs"));

if (runtimeFiles.length === 0) {
  console.warn(`[ort] No runtime files found in ${source}; skipping.`);
  process.exit(0);
}

await mkdir(target, { recursive: true });
for (const name of runtimeFiles) {
  await cp(join(source, name), join(target, name));
}

console.log(`[ort] Copied ${runtimeFiles.length} runtime file(s) to public/ort.`);
