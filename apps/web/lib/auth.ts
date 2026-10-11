"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getToken } from "./api-client";

/**
 * Whether this API wants a sign-in at all.
 *
 * A hackathon server runs with AUTH_DISABLED, and a sign-in screen there would be a
 * screen nobody needs that suggests something is broken. `/health` reports the mode, so
 * the console shows sign-in only where it means something.
 */
export type AuthMode = "required" | "disabled";

export const AUTH_CHANGED = "pothole:auth-changed";

/** `/health` sits outside /api/v1, so it has its own forwarded path on this origin. */
export function healthUrl(apiBaseUrl: string): string {
  return apiBaseUrl ? `${apiBaseUrl.replace(/\/$/, "")}/health` : "/api/health";
}

export function useAuthMode(apiBaseUrl: string): AuthMode | undefined {
  const query = useQuery({
    queryKey: ["auth-mode", apiBaseUrl],
    queryFn: async (): Promise<AuthMode> => {
      const response = await fetch(healthUrl(apiBaseUrl));
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const body = (await response.json()) as { auth?: string };
      // An API from before the flag existed always required a sign-in.
      return body.auth === "disabled" ? "disabled" : "required";
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
  return query.data;
}

/** The current token, kept in step with sign-in and sign-out anywhere in the tab. */
export function useToken(): string | null {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const read = () => setToken(getToken());
    read();
    window.addEventListener(AUTH_CHANGED, read);
    return () => window.removeEventListener(AUTH_CHANGED, read);
  }, []);
  return token;
}

/**
 * Where to go after signing in. Only a path on this site: an absolute or
 * protocol-relative `next` would turn the sign-in page into an open redirect.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}
