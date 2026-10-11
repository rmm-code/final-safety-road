"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, PageHeader, Panel } from "@/components/ui";
import { createApiClient } from "@/lib/api-client";
import { safeNextPath, useAuthMode } from "@/lib/auth";
import type { AppConfig } from "@/lib/config";

const INPUT =
  "mt-1 h-11 w-full rounded-xl border border-border bg-surface shadow-card px-3 text-[15px] text-primary outline-none focus:border-border-strong";

/**
 * Operator sign-in.
 *
 * Sized for the phone that records the drives as much as for a desk: large fields, one
 * button, and `autoComplete` set so the phone's password manager can fill it - typing a
 * password on a windshield mount is exactly the interaction the drive page avoids.
 */
export function LoginView({ config }: { config: AppConfig }) {
  const api = useMemo(() => createApiClient(config.apiBaseUrl), [config.apiBaseUrl]);
  const mode = useAuthMode(config.apiBaseUrl);
  const next = safeNextPath(useSearchParams().get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      // A full load, not a router push: /drive and /analyze need a fresh, isolated
      // document, and a soft navigation would only reload it a second time.
      window.location.assign(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[420px] space-y-4">
      <PageHeader title="Sign in" description="Operators and drivers of this deployment." />

      {mode === "disabled" ? (
        <Panel title="Sign-in is off">
          <p className="text-[13px] leading-relaxed text-secondary">
            This server runs without accounts, so there is nothing to sign in to. Everything is
            already available.
          </p>
          <a href={next} className="mt-3 inline-block text-[13px] text-primary underline">
            Continue
          </a>
        </Panel>
      ) : (
        <Panel>
          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-[12px] font-medium text-secondary">
              Email
              <input
                className={INPUT}
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="block text-[12px] font-medium text-secondary">
              Password
              <input
                className={INPUT}
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {error && (
              <p role="alert" className="text-[13px] text-red-ink">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" className="h-11 w-full" disabled={busy}>
              {busy ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </Panel>
      )}
    </div>
  );
}
