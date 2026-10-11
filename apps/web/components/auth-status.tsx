"use client";

// import Link from "next/link"; // only the parked sign-in link used it
import { usePathname } from "next/navigation";
import { setToken } from "@/lib/api-client";
import { useAuthMode, useToken } from "@/lib/auth";

/**
 * Sign-in state, where every console page can see it.
 *
 * Renders nothing when the API runs without accounts: on a hackathon server a "Sign in"
 * link would be noise that implies something is missing.
 */
export function AuthStatus({ apiBaseUrl }: { apiBaseUrl: string }) {
  const mode = useAuthMode(apiBaseUrl);
  const token = useToken();
  const pathname = usePathname();

  if (mode !== "required" || pathname === "/login") return null;

  if (!token) {
    // The login page is parked (app/(console)/_login), so say why pages fail instead of
    // linking to a 404. Restore the link below when sign-in returns.
    return (
      <span
        title="The API requires accounts, and the login page is turned off. Run the API with AUTH_DISABLED=true."
        className="inline-flex h-8 items-center rounded-lg bg-fill px-3 text-[12px] font-medium text-muted"
      >
        Sign-in disabled
      </span>
    );
    // return (
    //   <Link
    //     href={`/login?next=${encodeURIComponent(pathname)}`}
    //     className="inline-flex h-8 items-center rounded-lg bg-fill px-3 text-[12px] font-medium text-primary"
    //   >
    //     Sign in
    //   </Link>
    // );
  }

  return (
    <button
      type="button"
      onClick={() => setToken(null)}
      className="text-[12px] text-muted underline-offset-2 hover:text-primary hover:underline"
    >
      Sign out
    </button>
  );
}
