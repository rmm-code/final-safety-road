// PARKED (2026-10-10): the Telegram Mini App is off for now. The leading underscore keeps
// this folder out of the router; rename `_report` back to `report` and restore the
// ReportButton in features/live/live-map-view.tsx to bring it back.
import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { ReportView } from "@/features/live/report-view";

export const metadata: Metadata = {
  title: "Сообщить о яме",
  description: "Отправка сообщения о яме из Telegram.",
};

/** The Telegram Mini App form. Opened from inside Telegram, where `initData` exists. */
export default function ReportPage() {
  return <ReportView apiBaseUrl={getAppConfig().apiBaseUrl} />;
}
