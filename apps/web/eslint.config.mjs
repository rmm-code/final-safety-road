import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/**
 * eslint-config-next 16 ships flat configs directly, so no eslintrc compatibility
 * layer is needed.
 */
const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "next-env.d.ts",
      // Vendored ONNX Runtime binaries, copied in by scripts/copy-ort-runtime.mjs.
      "public/ort/**",
      // Vendored MapLibre worker, copied in by scripts/copy-maplibre-worker.mjs.
      "public/maplibre/**",
    ],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
