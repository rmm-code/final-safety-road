import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { LiveMapView } from "@/features/live/live-map-view";

export const metadata: Metadata = {
  title: { absolute: "Карта ям" },
  description: "Ямы на дорогах города. Сообщите о яме через Telegram.",
};

/**
 * The public map.
 *
 * Unauthenticated, and the only page in this application a stranger is meant to open. It
 * reads from `/api/v1/public/*`, which speaks a three-state vocabulary instead of the
 * console's internal statuses - see `apps/api/app/schemas/public.py`.
 */
export default function LivePage() {
  const config = getAppConfig();
  return (
    <LiveMapView
      apiBaseUrl={config.apiBaseUrl}
      mapStyleUrl={config.mapStyleUrl}
      mapWorkerUrl={config.mapWorkerUrl}
    />
  );
}
