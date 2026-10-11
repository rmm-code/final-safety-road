"use client";

import { useRef, useState } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import { formatBytes } from "@/lib/format";
import { MAX_VIDEO_BYTES } from "@/features/videos/lib/video-api";

export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

/** The largest upload, as people read it: about 2.5 minutes of 1080p dashcam video. */
const LIMIT_MB = Math.round(MAX_VIDEO_BYTES / (1024 * 1024));

/** Guard against files the browser cannot decode, before any pipeline work starts. */
export function isSupportedVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  // Some systems report an empty MIME type; fall back to the extension.
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

/**
 * The empty area itself is the picker: a centered button, and a drop target. Once a video
 * is chosen it shrinks to one line with a link to choose another.
 */
export function VideoPicker({
  file,
  disabled,
  onSelect,
  onError,
}: {
  file: File | null;
  disabled: boolean;
  onSelect: (file: File) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const take = (selected: File | undefined) => {
    if (!selected) return;
    if (!isSupportedVideo(selected)) {
      onError(`${selected.name} is not a video file. Choose an MP4, MOV or WebM recording.`);
      return;
    }
    if (selected.size > MAX_VIDEO_BYTES) {
      onError(`${selected.name} is ${formatBytes(selected.size)}; the limit is ${LIMIT_MB} MB. Trim it or export it at a lower quality.`);
      return;
    }
    onSelect(selected);
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      accept="video/mp4,video/quicktime,video/webm,video/*"
      className="sr-only"
      aria-label="Choose a road video"
      disabled={disabled}
      onChange={(event) => {
        const selected = event.target.files?.[0];
        event.target.value = "";
        take(selected);
      }}
    />
  );

  if (file) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        {input}
        <span className="min-w-0 truncate">
          <span className="font-mono text-[12px] text-primary">{file.name}</span>
          <span className="tabular ml-2 text-muted">{formatBytes(file.size)}</span>
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="font-medium text-primary underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Choose another video
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="video-drop"
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) take(event.dataTransfer.files?.[0]);
      }}
      className={clsx(
        "grid h-64 place-items-center rounded-lg border bg-subtle px-6 text-center transition-colors duration-150",
        dragging ? "border-[#9a9a9a] bg-[#ececec]" : "border-transparent",
      )}
    >
      {input}
      <div className="flex flex-col items-center gap-3">
        <Button variant="primary" disabled={disabled} onClick={() => inputRef.current?.click()}>
          <Icon name="video" />
          Choose video
        </Button>
        <p className="text-[13px] text-muted">MP4, MOV or WebM, up to {LIMIT_MB} MB. Or drop it here.</p>
      </div>
    </div>
  );
}
