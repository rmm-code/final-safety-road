/**
 * Evidence-image encoding that works in every browser the driver might use.
 *
 * `toDataURL("image/webp")` is a request, not a guarantee: a browser that cannot encode
 * WebP silently returns a PNG instead. The upload is signed for one content type, so
 * trusting the request would sign "webp" and send a PNG - and storage rejects it. The
 * encoder therefore reads back what it actually got, and falls back to JPEG, which every
 * browser encodes and which is a fraction of a PNG's size.
 */
export type ImageContentType = "image/webp" | "image/jpeg" | "image/png";

const TYPES: ImageContentType[] = ["image/webp", "image/jpeg", "image/png"];

/** The content type a data URL really holds, whatever was asked for. */
export function imageContentType(dataUrl: string): ImageContentType | undefined {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  const type = match?.[1]?.toLowerCase();
  return TYPES.find((candidate) => candidate === type);
}

export function encodeCanvas(canvas: HTMLCanvasElement, quality: number): string {
  const webp = canvas.toDataURL("image/webp", quality);
  if (imageContentType(webp) === "image/webp") return webp;
  return canvas.toDataURL("image/jpeg", quality);
}
