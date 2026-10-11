import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { MapView } from "@/features/map/map-view";

export const metadata: Metadata = {
  title: "Map",
  description: "Physical potholes on an internal map.",
};

export default function MapPage() {
  return <MapView config={getAppConfig()} />;
}
