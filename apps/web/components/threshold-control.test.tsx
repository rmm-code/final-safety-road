import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThresholdControl } from "./threshold-control";

function setup(value = 0.35, defaultValue = 0.35) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <ThresholdControl
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  return { onChange, onReset };
}

describe("confidence threshold control", () => {
  it("shows the current value", () => {
    setup(0.45);
    expect(screen.getByText("0.45")).toBeInTheDocument();
  });

  it("reports a new value when moved", () => {
    const { onChange } = setup();
    // A range input reports through change, not click; jsdom does not synthesise drags.
    fireEvent.change(screen.getByRole("slider", { name: /confidence threshold/i }), {
      target: { value: "0.6" },
    });
    expect(onChange).toHaveBeenCalledWith(0.6);
  });

  it("names the configured default so the value is never mistaken for a hard-coded one", () => {
    setup(0.45, 0.35);
    expect(screen.getByText(/Default 0\.35 from ai\/configs\/vision\.yaml/)).toBeInTheDocument();
  });

  it("offers a reset only once the value has been moved", () => {
    setup(0.35, 0.35);
    expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
  });

  it("resets back to the configured default", async () => {
    const { onReset } = setup(0.6, 0.35);
    await userEvent.click(screen.getByRole("button", { name: /reset/i }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("explains the trade-off rather than just showing a number", () => {
    setup();
    // An operator moving this needs to know what they are trading away.
    expect(screen.getByText(/Lower finds more and reports more mistakes/i)).toBeInTheDocument();
  });

  it("can be locked while a run is in progress", () => {
    render(
      <ThresholdControl
        value={0.35}
        defaultValue={0.35}
        disabled
        onChange={vi.fn()}
        onReset={vi.fn()}
      />,
    );
    expect(screen.getByRole("slider", { name: /confidence threshold/i })).toBeDisabled();
  });
});
