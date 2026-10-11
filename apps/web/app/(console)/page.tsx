import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { SampleDashboard } from "@/features/video-dashboard/sample-dashboard";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Potholes found in a road video: an overview, detection activity, the annotated video and a timeline.",
};

/** The dashboard for the sample chosen in the sidebar (?video=). */
export default async function HomePage({ searchParams }: { searchParams: Promise<{ video?: string }> }) {
  const { video } = await searchParams;
  return <SampleDashboard config={getAppConfig()} sampleId={video ?? null} />;
}
