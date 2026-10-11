"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";
import { Icon } from "@/components/icons";
import { formatBytes } from "@/lib/format";

export const ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];

/** Guard against files the browser cannot decode, before any pipeline work starts. */
export function isSupportedVideo(file: File): boolean {
  if (file.type.startsWith("video/")) return true;
  // Some systems report an empty MIME type; fall back to the extension.
  return /\.(mp4|mov|m4v|webm)$/i.test(file.name);
}

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

  return (
    <div className="flex flex-wrap items-center gap-3">
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
          if (!selected) return;
          if (!isSupportedVideo(selected)) {
            onError(`${selected.name} is not a video file. Choose an MP4, MOV or WebM recording.`);
            return;
          }
          onSelect(selected);
        }}
      />
      <Button disabled={disabled} onClick={() => inputRef.current?.click()}>
        <Icon name="video" />
        Choose video
      </Button>

      {file ? (
        <span className="min-w-0 truncate text-[13px] text-secondary">
          <span className="font-mono text-[12px] text-primary">{file.name}</span>
          <span className="tabular ml-2 text-muted">{formatBytes(file.size)}</span>
        </span>
      ) : (
        <span className="text-[13px] text-muted">MP4, MOV or WebM road footage</span>
      )}
    </div>
  );
}
