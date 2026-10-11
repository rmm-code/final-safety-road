import { AppShell } from "@/components/app-shell";

/**
 * The internal console: sidebar, navigation, operator tools.
 *
 * A route group, so the URLs are unchanged - `/`, `/map`, `/review` and the rest still
 * live here. What the group buys is a layout the public pages do not inherit.
 */
export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
