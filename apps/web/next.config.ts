import type { NextConfig } from "next";

/**
 * Where this server reaches the API. Server-side only, and read when the config loads:
 * rewrites are compiled into the build, so a production image must be BUILT with the
 * value it will run with (see apps/web/Dockerfile).
 */
const apiOrigin = (process.env.API_INTERNAL_URL || "http://localhost:8000").replace(/\/$/, "");

/**
 * Pages that run the detector in the browser.
 *
 * Cross-origin isolation is what lets ONNX Runtime's WebAssembly backend use more than
 * one thread (it needs SharedArrayBuffer). Without it the WASM fallback runs a 640 px
 * model on one core, which is not a usable frame rate on a phone. WebGPU does not need
 * it, but which backend a phone gets is the browser's decision, not ours.
 *
 * Only these routes: `require-corp` blocks any cross-origin resource that does not
 * opt in, and the map pages load third-party tiles and the Mini App loads Telegram's
 * script. Isolation is also decided per DOCUMENT, so a client-side navigation into these
 * pages does not get it - `CrossOriginIsolation` reloads once to fix that.
 */
// /models runs candidate detectors live in the browser, so it needs the same. The dashboard
// (/) is not isolated: it opens published analyses, and only analyses in the browser, single
// threaded, when one is missing.
const ISOLATED_ROUTES = ["/analyze", "/drive", "/models"];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source, so Next compiles them.
  transpilePackages: ["@pothole/shared-types", "@pothole/vision-web"],

  /**
   * The API, served from this origin.
   *
   * A phone reaches exactly one address - the one it opened. Calling the API on another
   * origin meant "localhost:8000", which on a phone is the phone, plus a CORS list to keep
   * in step with every tunnel or domain the app is ever served from.
   */
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${apiOrigin}/api/v1/:path*` },
      { source: "/api/health", destination: `${apiOrigin}/health` },
    ];
  },

  async headers() {
    const isolation = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
    ];
    return [
      ...ISOLATED_ROUTES.map((source) => ({ source, headers: isolation })),
      // ONNX Runtime's threads are workers started from these scripts. An isolated page
      // may only start a worker whose own response is isolated too; without this the
      // browser blocks the script and the detector waits forever, with no error at all.
      { source: "/ort/:path*", headers: isolation },
      // The same for MapLibre's worker. Isolation belongs to the document and survives a
      // client-side navigation, so /map reached from /analyze, /drive or /models is still
      // isolated - and without this its worker is refused and the map renders blank.
      { source: "/maplibre/:path*", headers: isolation },
    ];
  },
};

export default nextConfig;
