import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { VisionEngineInfo } from "@pothole/shared-types";
import { SyntheticEngineNotice } from "./engine-status";

const SYNTHETIC: VisionEngineInfo = {
  kind: "mock",
  modelVersion: "mock-synthetic-0.1.0",
  backend: "synthetic",
  isSynthetic: true,
  selectionReason: "No usable detector: No model manifest deployed at /models/model.json.",
};

const REAL: VisionEngineInfo = {
  kind: "onnx",
  modelVersion: "pothole-detector-0.1.0",
  backend: "webgpu",
  isSynthetic: false,
  selectionReason: "Deployed ONNX model detected; running inference in the browser.",
};

describe("synthetic engine warning", () => {
  it("warns whenever detections are fabricated", () => {
    render(<SyntheticEngineNotice engine={SYNTHETIC} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no trained model is installed/i);
    expect(screen.getByRole("status")).toHaveTextContent(/not a reading of this video/i);
  });

  it("explains why the synthetic engine was chosen", () => {
    render(<SyntheticEngineNotice engine={SYNTHETIC} />);
    expect(screen.getByText(/No model manifest deployed/)).toBeInTheDocument();
  });

  it("says nothing when a real model is running", () => {
    const { container } = render(<SyntheticEngineNotice engine={REAL} />);
    expect(container).toBeEmptyDOMElement();
  });
});
