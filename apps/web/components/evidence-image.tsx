"use client";

import { useState } from "react";
import clsx from "clsx";

/**
 * One evidence photo from object storage, or an honest "no photo".
 *
 * A sighting can exist without its image - the upload is allowed to fail so the pothole
 * is never lost - and a key can point at nothing (early uploads were rejected by storage
 * after the key was recorded). Both must read as "no photo", not as a broken image.
 *
 * `crossOrigin` because the detector pages are cross-origin isolated, and a document that
 * has been isolated keeps that policy across client-side navigation: an image without
 * CORS would be blocked on whichever console page came after them. Storage answers CORS.
 */
export function EvidenceImage({
  url,
  alt,
  className,
  fallbackLabel = "No photo for this sighting",
}: {
  url: string | null | undefined;
  alt: string;
  className?: string;
  /** Empty for thumbnails, where a sentence does not fit. */
  fallbackLabel?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  if (!url || failedUrl === url) {
    return (
      <div
        className={clsx(
          "grid place-items-center rounded-md bg-subtle text-[13px] text-muted",
          className,
        )}
      >
        {fallbackLabel}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived storage URLs; nothing to optimise
    <img
      src={url}
      alt={alt}
      crossOrigin="anonymous"
      loading="lazy"
      onError={() => setFailedUrl(url)}
      className={clsx("rounded-lg bg-subtle object-contain", className)}
    />
  );
}
