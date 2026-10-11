import { Suspense } from "react";
import { getAppConfig } from "@/lib/config";
import { AuthStatus } from "./auth-status";
import { ShellProvider } from "./shell-context";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

/**
 * Pitstop's chrome: a grey sidebar with the sections and the sample videos, and one softly
 * bordered shell holding a breadcrumb bar and the page.
 *
 * Below the md breakpoint the sidebar slides out from a menu button, so the console stays
 * usable on the phone that records the drives.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { apiBaseUrl } = getAppConfig();
  return (
    <ShellProvider>
      <div className="min-h-screen bg-app md:py-2.5 md:pr-2.5">
        {/* The sample list reads the selected video from the URL. */}
        <Suspense fallback={null}>
          <Sidebar />
        </Suspense>
        <div className="min-h-screen overflow-hidden bg-shell md:ml-[224px] md:min-h-[calc(100vh-20px)] md:rounded-xl md:border md:border-[#e0e0e0] md:shadow-[0_2px_7px_#00000004]">
          <Topbar actions={<AuthStatus apiBaseUrl={apiBaseUrl} />} />
          <main className="mx-auto w-full max-w-[1640px] p-2 md:p-2.5">{children}</main>
        </div>
      </div>
    </ShellProvider>
  );
}
