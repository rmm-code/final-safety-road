import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { isSupportedVideo, VideoPicker } from "./video-picker";

function makeFile(name: string, type: string): File {
  return new File(["binary"], name, { type });
}

describe("video file validation", () => {
  it.each([
    ["drive.mp4", "video/mp4"],
    ["drive.mov", "video/quicktime"],
    ["drive.webm", "video/webm"],
  ])("accepts %s", (name, type) => {
    expect(isSupportedVideo(makeFile(name, type))).toBe(true);
  });

  it("accepts a video whose MIME type the system did not report", () => {
    expect(isSupportedVideo(makeFile("drive.MOV", ""))).toBe(true);
  });

  it.each([
    ["notes.pdf", "application/pdf"],
    ["frame.png", "image/png"],
  ])("rejects %s", (name, type) => {
    expect(isSupportedVideo(makeFile(name, type))).toBe(false);
  });
});

describe("VideoPicker", () => {
  it("reports a clear error instead of failing silently on a non-video file", async () => {
    const onError = vi.fn();
    const onSelect = vi.fn();
    render(<VideoPicker file={null} disabled={false} onSelect={onSelect} onError={onError} />);

    // `accept` is only a hint: the OS picker can be switched to "all files", and
    // drag-and-drop ignores it entirely, so the component must guard as well.
    await userEvent.upload(
      screen.getByLabelText("Choose a road video"),
      makeFile("notes.pdf", "application/pdf"),
      { applyAccept: false },
    );

    expect(onSelect).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("not a video file"));
  });

  it("passes a valid recording through", async () => {
    const onSelect = vi.fn();
    render(<VideoPicker file={null} disabled={false} onSelect={onSelect} onError={vi.fn()} />);

    await userEvent.upload(
      screen.getByLabelText("Choose a road video"),
      makeFile("tashkent-drive.mp4", "video/mp4"),
    );

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({ name: "tashkent-drive.mp4" });
  });

  it("shows the chosen file and blocks re-selection while analysis runs", () => {
    render(
      <VideoPicker
        file={makeFile("tashkent-drive.mp4", "video/mp4")}
        disabled
        onSelect={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.getByText("tashkent-drive.mp4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose video" })).toBeDisabled();
  });
});
