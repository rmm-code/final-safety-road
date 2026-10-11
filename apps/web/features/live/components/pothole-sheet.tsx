"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { createPublicApiClient } from "@/lib/public-api";
import { STATE_COLOUR, STATE_LABEL } from "../lib/state-style";

/**
 * Detail for one marker, as a sheet over the map.
 *
 * A sheet rather than a MapLibre popup: the photo is the point of opening it, and a popup
 * anchored to a dot near the edge of a phone screen puts the photo off-screen.
 */
export function PotholeSheet({
  apiBaseUrl,
  potholeId,
  onClose,
}: {
  apiBaseUrl: string;
  potholeId: string;
  onClose: () => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["public-pothole", apiBaseUrl, potholeId],
    queryFn: () => createPublicApiClient(apiBaseUrl).pothole(potholeId),
    retry: 1,
  });
  const [expanded, setExpanded] = useState(false);
  // A key can exist with no object behind it - an upload that failed after the row was
  // written. The API cannot know without a round trip to storage on every tap, but the
  // browser finds out for free, so a photo that will not load is treated as no photo
  // rather than shown as a broken-image icon.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const photoUrl = data?.image_url && data.image_url !== failedUrl ? data.image_url : null;

  // Escape closes the full-size photo first, then the sheet - the order a person expects
  // from layered things on a screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (expanded) setExpanded(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onClose]);

  return (
    <>
      {expanded && photoUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Фото ямы"
          onClick={() => setExpanded(false)}
          className="absolute inset-0 z-40 grid cursor-zoom-out place-items-center bg-[rgba(20,24,22,0.86)] p-4"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoUrl}
            alt="Фото ямы"
            className="max-h-full max-w-full rounded-md object-contain"
          />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 z-30 flex justify-center p-3 sm:justify-end sm:p-4">
        <section
          aria-label="Информация о яме"
          className="w-full max-w-[400px] rounded-xl bg-raised p-4 shadow-[0_2px_12px_rgba(20,28,24,0.14)]"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {data ? (
                <span className="inline-flex items-center gap-1.5 text-[13px] font-medium">
                  <span
                    aria-hidden
                    className="h-3 w-3 rounded-[3px]"
                    style={{ backgroundColor: STATE_COLOUR[data.state] }}
                  />
                  {STATE_LABEL[data.state]}
                </span>
              ) : (
                <span className="text-[13px] text-muted">Яма</span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Закрыть"
              className="-mr-1 -mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors duration-150 hover:bg-hover hover:text-primary"
            >
              <svg aria-hidden width="14" height="14" viewBox="0 0 14 14">
                <path
                  d="M3 3l8 8M11 3l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          {isLoading && (
            <p className="mt-3 text-[13px] text-muted">Загрузка…</p>
          )}

          {error && (
            <p role="alert" className="mt-3 text-[13px] text-red-ink">
              Не удалось загрузить информацию.
            </p>
          )}

          {data && (
            <>
              {photoUrl ? (
                // The photo is the reason anyone taps a dot, so it leads the sheet and is
                // large; tapping it opens the full image, uncropped.
                <button
                  type="button"
                  onClick={() => setExpanded(true)}
                  aria-label="Открыть фото полностью"
                  className="mt-3 block w-full overflow-hidden rounded-lg bg-subtle"
                >
                  {/* A pre-signed URL from our own object storage. Its signature lives in
                    the query string, which next/image's optimiser would strip. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={photoUrl}
                    alt="Фото ямы"
                    onError={() => setFailedUrl(photoUrl)}
                    className="h-[220px] w-full object-cover sm:h-[240px]"
                  />
                </button>
              ) : (
                // Not "awaiting moderation": a pothole our own detector found may simply
                // have no stored photo, and promising one that is never coming is worse
                // than saying there isn't one.
                <p className="mt-3 rounded-md bg-subtle px-3 py-2.5 text-[12px] leading-4 text-muted">
                  Фото пока нет.
                </p>
              )}

              {data.comment && (
                <p className="mt-3 text-[13px] leading-5 text-secondary">
                  {data.comment}
                </p>
              )}

              <dl className="mt-3 space-y-2 border-t border-border pt-3 text-[13px]">
                <Row label="Сообщений">
                  <span className="tabular font-mono">
                    {data.reported_count}
                  </span>
                </Row>
                <Row label="Первое сообщение">
                  <span className="tabular font-mono">
                    {formatDate(data.first_seen_at)}
                  </span>
                </Row>
                <Row label="Точность">
                  {/* Rounded, and never presented as a measurement of the pothole itself:
                    this is how well the LOCATION is known. */}
                  <span className="tabular font-mono">
                    ±{Math.round(data.location_accuracy_m)} м
                  </span>
                </Row>
              </dl>
            </>
          )}
        </section>
      </div>
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-secondary">{label}</dt>
      <dd className="min-w-0 truncate text-right text-primary">{children}</dd>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
