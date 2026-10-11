"use client";

import { useCallback, useRef, useState } from "react";
import type { SaveState } from "../components/save-note";

const IDLE: SaveState = { kind: "idle" };

/**
 * Whether the shown analysis is saved, safe against saves that outlive their run.
 *
 * A save carries on after its analysis has finished, so a slow one could land after the
 * user has picked another video, or analysed a sample, and overwrite what that run shows.
 * Every selection and every analysis begins a new run; a state for any older run is dropped.
 */
export function useSaveState() {
  const [saveState, setSaveState] = useState<SaveState>(IDLE);
  const currentRun = useRef(0);

  /** Start a run, back at idle. Returns the token its later states must carry. */
  const beginRun = useCallback(() => {
    currentRun.current += 1;
    setSaveState(IDLE);
    return currentRun.current;
  }, []);

  const setSaveStateFor = useCallback((run: number, next: SaveState) => {
    if (run === currentRun.current) setSaveState(next);
  }, []);

  /** Run `save`, which resolves to the saved analysis's link, reporting into `run` only. */
  const saveFor = useCallback(
    async (run: number, save: () => Promise<string>) => {
      setSaveStateFor(run, { kind: "saving" });
      try {
        const href = await save();
        setSaveStateFor(run, { kind: "saved", href });
      } catch (cause) {
        setSaveStateFor(run, { kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [setSaveStateFor],
  );

  return { saveState, beginRun, setSaveStateFor, saveFor };
}
