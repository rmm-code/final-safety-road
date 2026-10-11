import type { Metadata } from "next";
import { CrossOriginIsolation } from "@/components/cross-origin-isolation";
import { getAppConfig } from "@/lib/config";
import { AnalyzeView } from "@/features/analyze/analyze-view";

export const metadata: Metadata = {
  title: "Live demo",
  description: "Upload a road video: the detector runs in your browser and finds, grades and maps its potholes.",
};

export default function AnalyzePage() {
  // Configuration is resolved on the server and handed to the client pipeline, so
  // thresholds live in one place instead of being read ad hoc inside components.
  return (
    <CrossOriginIsolation>
      <AnalyzeView config={getAppConfig()} variant="home" />
    </CrossOriginIsolation>
  );
}
