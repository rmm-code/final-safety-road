import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { PotholesGallery } from "@/features/potholes/potholes-gallery";

export const metadata: Metadata = { title: "Potholes" };

export default function PotholesPage() {
  return <PotholesGallery config={getAppConfig()} />;
}
