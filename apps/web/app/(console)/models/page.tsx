import type { Metadata } from "next";
import { CrossOriginIsolation } from "@/components/cross-origin-isolation";
import { getAppConfig } from "@/lib/config";
import { ModelCompareView } from "@/features/models/model-compare-view";

export const metadata: Metadata = {
  title: "Model comparison",
  description: "Candidate pothole detectors side by side on the same footage.",
};

export default function ModelsPage() {
  // Isolated like /analyze: the live test runs the detector, and its WebAssembly fallback
  // needs cross-origin isolation to use more than one thread.
  return (
    <CrossOriginIsolation>
      <ModelCompareView config={getAppConfig()} />
    </CrossOriginIsolation>
  );
}
