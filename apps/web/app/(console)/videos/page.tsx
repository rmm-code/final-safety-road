import type { Metadata } from "next";
import { VideosView } from "@/features/videos/videos-view";

export const metadata: Metadata = {
  title: "Samples & insights",
  description: "The sample videos, every video analysed on the site, and the numbers across them.",
};

export default function VideosPage() {
  return <VideosView />;
}
