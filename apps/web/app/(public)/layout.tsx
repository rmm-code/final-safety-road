import type { Metadata } from "next";

/**
 * The public surface: the citizen map, and the Telegram Mini App that reports to it.
 *
 * No sidebar, no console navigation, nothing that assumes an account. The page fills the
 * viewport because the map IS the page - everything else floats over it.
 */
export const metadata: Metadata = {
  title: {
    default: "Карта ям",
    template: "%s - Карта ям",
  },
  description: "Карта ям на дорогах. Сообщите о яме через Telegram.",
};

export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-dvh w-full overflow-hidden">{children}</div>;
}
