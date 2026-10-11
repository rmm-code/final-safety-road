"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createPublicApiClient } from "@/lib/public-api";

/**
 * The one action on the page, bottom centre.
 *
 * Where it leads depends on where the page is running, and the difference is deliberate:
 *
 * - Inside Telegram, it opens the Mini App form, which submits with a signed identity.
 * - In a browser, it opens the bot. Not a web form: an anonymous public POST endpoint is
 *   a spam vector with nobody to rate-limit or ban, and the confirmation mechanic rests
 *   on reporters being distinguishable people. Telegram supplies that for free.
 *
 * Hidden entirely when no bot is configured, rather than rendering a button that goes
 * nowhere.
 */
export function ReportButton({
  apiBaseUrl,
  inTelegram,
}: {
  apiBaseUrl: string;
  inTelegram: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["public-config", apiBaseUrl],
    queryFn: () => createPublicApiClient(apiBaseUrl).config(),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  if (!data?.telegram_enabled) return null;

  const label = "Сообщить о яме";
  const className =
    "pointer-events-auto inline-flex h-11 items-center gap-2 rounded-full bg-blue-strong px-5 text-[14px] font-medium text-white shadow-[0_2px_8px_rgba(16,24,40,0.16)] transition-colors duration-150 hover:bg-blue-ink focus-visible:outline-2 focus-visible:outline-offset-2";

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 -translate-x-1/2">
      {inTelegram ? (
        <Link href="/live/report" className={className}>
          <PinIcon />
          {label}
        </Link>
      ) : (
        <a href={data.report_url} target="_blank" rel="noopener noreferrer" className={className}>
          <PinIcon />
          {label}
        </a>
      )}
    </div>
  );
}

function PinIcon() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1.5c-2.5 0-4.5 2-4.5 4.5 0 3.2 4.5 8.5 4.5 8.5s4.5-5.3 4.5-8.5c0-2.5-2-4.5-4.5-4.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
