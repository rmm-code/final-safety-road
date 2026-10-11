import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Scorecard as ScorecardData } from "../lib/compare-data";
import { Scorecard } from "./scorecard";

const scorecard: ScorecardData = {
  recommended: "current-t025",
  videos: ["video-1", "video-2"],
  setups: [
    {
      id: "current-t035",
      label: "Current model",
      detail: "Threshold 0.35, what the app runs today",
      modelId: "current_collabdoor_v8m",
      threshold: 0.35,
    },
    {
      id: "current-t025",
      label: "Current model, threshold 0.25",
      detail: "Same model, lower threshold",
      modelId: "current_collabdoor_v8m",
      threshold: 0.25,
    },
  ],
  reports: {
    "current-t035": {
      "video-1": { reported: 0, real: 0, falseAlarms: 0, unsure: 0 },
      "video-2": { reported: 3, real: 2, falseAlarms: 1, unsure: 0 },
    },
    "current-t025": {
      "video-1": { reported: 1, real: 1, falseAlarms: 0, unsure: 0 },
      "video-2": { reported: 5, real: 3, falseAlarms: 1, unsure: 1 },
    },
  },
  frames: {
    "current-t035": { precision: 0.84, recall: 0.37 },
    "current-t025": { precision: 0.9, recall: 0.62 },
  },
  method: "Two independent reviewers labelled every report without knowing which model made it.",
};

const titles = { "video-1": "Video 1", "video-2": "Video 2" };

function row(name: RegExp) {
  return screen.getByRole("row", { name });
}

describe("model scorecard", () => {
  it("marks the recommended setup and no other", () => {
    render(<Scorecard scorecard={scorecard} titles={titles} />);

    expect(within(row(/threshold 0\.25/i)).getByText("Recommended")).toBeInTheDocument();
    expect(within(row(/what the app runs today/i)).queryByText("Recommended")).toBeNull();
  });

  it("shows real potholes and false alarms per video, and totals across videos", () => {
    render(<Scorecard scorecard={scorecard} titles={titles} />);
    const recommended = within(row(/threshold 0\.25/i));

    // Video 2 on its own, then the total across both videos.
    expect(recommended.getByText("3 real")).toBeInTheDocument();
    expect(recommended.getByText("4 real")).toBeInTheDocument();
    expect(recommended.getAllByText("1 false")).toHaveLength(2);
    expect(recommended.getAllByText("1 unsure")).toHaveLength(2);
    expect(recommended.getByText("0 false")).toBeInTheDocument();
  });

  it("says plainly when a setup reported nothing on a video", () => {
    render(<Scorecard scorecard={scorecard} titles={titles} />);

    expect(within(row(/what the app runs today/i)).getByText("Nothing reported")).toBeInTheDocument();
  });

  it("shows frame-level precision and recall as percentages", () => {
    render(<Scorecard scorecard={scorecard} titles={titles} />);
    const today = within(row(/what the app runs today/i));

    expect(today.getByText("84%")).toBeInTheDocument();
    expect(today.getByText("37%")).toBeInTheDocument();
  });

  it("names the videos in the order given and states how the labels were made", () => {
    render(<Scorecard scorecard={scorecard} titles={titles} />);

    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.indexOf("Video 1")).toBeLessThan(headers.indexOf("Video 2"));
    expect(screen.getByText(/without knowing which model made it/)).toBeInTheDocument();
  });
});
