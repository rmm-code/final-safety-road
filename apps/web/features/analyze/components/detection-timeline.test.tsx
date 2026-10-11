import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SeverityLevel } from "@pothole/shared-types";
import type { AnalysedPothole } from "../lib/analyse-video";
import { DetectionTimeline } from "./detection-timeline";

function pothole(
  trackId: string,
  seconds: number,
  level: SeverityLevel,
  confidence: number,
): AnalysedPothole {
  return {
    trackId,
    firstSeenSeconds: seconds,
    lastSeenSeconds: seconds + 0.9,
    bestFrameSeconds: seconds + 0.5,
    confidence,
    severity: { level, score: 0.5, confidence: 0.8, rationale: "test" },
    observationCount: 7,
    maxArea: 0.02,
    cropImage: null,
    fullImage: null,
  };
}

const POTHOLES = [
  pothole("track-001", 4, "medium", 0.91),
  pothole("track-002", 11, "large", 0.95),
  pothole("track-003", 24, "small", 0.83),
];

describe("DetectionTimeline", () => {
  it("lists one row per unique pothole with time, severity and confidence", () => {
    render(<DetectionTimeline potholes={POTHOLES} selectedTrackId={null} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(3);
    const row = screen.getByRole("button", { name: /track-001/ });
    expect(row).toHaveTextContent("00:04");
    expect(row).toHaveTextContent("medium");
    expect(row).toHaveTextContent("91%");
  });

  it("reports the number of sightings behind each pothole", () => {
    render(<DetectionTimeline potholes={POTHOLES} selectedTrackId={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("button", { name: /track-002/ })).toHaveTextContent("7 sightings");
  });

  it("hands the selected pothole back so the video can seek to it", async () => {
    const onSelect = vi.fn();
    render(<DetectionTimeline potholes={POTHOLES} selectedTrackId={null} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("button", { name: /track-002/ }));
    expect(onSelect).toHaveBeenCalledWith(POTHOLES[1]);
  });

  it("marks the current selection for assistive technology", () => {
    render(
      <DetectionTimeline potholes={POTHOLES} selectedTrackId="track-003" onSelect={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: /track-003/ })).toHaveAttribute("aria-current", "true");
  });

  it("says plainly when nothing met the confirmation rules", () => {
    render(<DetectionTimeline potholes={[]} selectedTrackId={null} onSelect={vi.fn()} />);
    expect(screen.getByText(/No potholes met the confirmation rules/i)).toBeInTheDocument();
  });
});
