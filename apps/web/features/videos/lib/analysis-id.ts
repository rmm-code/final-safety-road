/** What, besides the video itself, decides an analysis's result. */
export type AnalysisSettings = {
  modelVersion: string;
  confidenceThreshold: number;
  sampleFps: number;
};

/**
 * The id an analysis is saved under: a UUID derived from the video and the settings.
 *
 * The same video analysed again at the same settings produces the same result, so it lands
 * on the same record instead of filling the Videos page with copies. `source` identifies
 * the video: "demo:<id>" for a sample, "sha256:<hex>" for an uploaded file.
 */
export async function analysisId(source: string, settings: AnalysisSettings): Promise<string> {
  const text = [source, settings.modelVersion, settings.confidenceThreshold, settings.sampleFps].join("|");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const bytes = digest.slice(0, 16);
  // RFC 9562 version 8 (custom) and the variant bits, so it is a well-formed UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** "sha256:<hex>" for a file: identical bytes, identical id. */
export async function fileSource(file: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
