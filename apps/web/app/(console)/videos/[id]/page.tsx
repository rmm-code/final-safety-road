import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { SavedDashboard } from "@/features/video-dashboard/saved-dashboard";

export const metadata: Metadata = { title: "Video dashboard" };

export default async function SavedVideoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SavedDashboard config={getAppConfig()} id={id} />;
}
