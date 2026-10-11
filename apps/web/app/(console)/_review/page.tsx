// PARKED (2026-10-11): the review queue is off for now. The leading underscore keeps this
// folder out of the router; rename `_review` back to `review` and restore its entry in
// components/nav-links.tsx to bring it back.
import type { Metadata } from "next";
import { getAppConfig } from "@/lib/config";
import { ReviewView } from "@/features/review/review-view";

export const metadata: Metadata = { title: "Review" };

export default function ReviewPage() {
  return <ReviewView config={getAppConfig()} />;
}
