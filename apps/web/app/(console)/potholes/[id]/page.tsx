import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { PotholeDetailView } from "@/features/potholes/pothole-detail-view";

export const metadata: Metadata = { title: "Pothole" };

export default async function PotholePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PotholeDetailView config={getAppConfig()} potholeId={id} />;
}
