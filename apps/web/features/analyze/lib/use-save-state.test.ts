import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSaveState } from "./use-save-state";

/** An upload the test finishes when it chooses, like a slow save. */
function slowUpload() {
  let resolve!: (href: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { task: () => promise, resolve, reject };
}

function startSave(upload: ReturnType<typeof slowUpload>) {
  const hook = renderHook(() => useSaveState());
  let saving: Promise<void> = Promise.resolve();
  act(() => {
    saving = hook.result.current.saveFor(hook.result.current.beginRun(), upload.task);
  });
  return { result: hook.result, saving: () => saving };
}

describe("save state across runs", () => {
  it("shows a save through to its outcome", async () => {
    const upload = slowUpload();
    const { result, saving } = startSave(upload);
    expect(result.current.saveState).toEqual({ kind: "saving" });

    await act(async () => {
      upload.resolve("/videos/1");
      await saving();
    });
    expect(result.current.saveState).toEqual({ kind: "saved", href: "/videos/1" });
  });

  it("ignores a slow save that finishes after another video was picked", async () => {
    const upload = slowUpload();
    const { result, saving } = startSave(upload);

    act(() => {
      result.current.beginRun();
    });
    expect(result.current.saveState).toEqual({ kind: "idle" });

    await act(async () => {
      upload.resolve("/videos/previous");
      await saving();
    });
    expect(result.current.saveState).toEqual({ kind: "idle" });
  });

  it("ignores a failed save that finishes after a newer video was saved", async () => {
    const upload = slowUpload();
    const { result, saving } = startSave(upload);

    act(() => {
      result.current.setSaveStateFor(result.current.beginRun(), { kind: "saved", href: "/videos/newer" });
    });

    await act(async () => {
      upload.reject(new Error("network down"));
      await saving();
    });
    expect(result.current.saveState).toEqual({ kind: "saved", href: "/videos/newer" });
  });

  it("reports a failed save of the current run", async () => {
    const upload = slowUpload();
    const { result, saving } = startSave(upload);

    await act(async () => {
      upload.reject(new Error("network down"));
      await saving();
    });
    expect(result.current.saveState).toEqual({ kind: "error", message: "network down" });
  });
});
