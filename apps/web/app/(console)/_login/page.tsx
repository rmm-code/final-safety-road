// PARKED (2026-10-10): sign-in is off for now. The leading underscore keeps this folder out
// of the router; rename `_login` back to `login` and restore the links in
// components/auth-status.tsx and features/drive/drive-view.tsx to bring it back.
import type { Metadata } from "next";
import { Suspense } from "react";
import { getAppConfig } from "@/lib/config";
import { LoginView } from "@/features/auth/login-view";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  // Suspense because the view reads `?next=`, which is only known in the browser.
  return (
    <Suspense>
      <LoginView config={getAppConfig()} />
    </Suspense>
  );
}
