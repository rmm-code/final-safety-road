import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { StatisticsView } from "@/features/statistics/statistics-view";

export const metadata: Metadata = { title: "Statistics" };

export default function StatisticsPage() {
  return <StatisticsView config={getAppConfig()} />;
}
