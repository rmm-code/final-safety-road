"use client";

import { usePathname } from "next/navigation";
import { Icon } from "./icons";
import { useShell } from "./shell-context";
import { NAV_ITEMS } from "./sidebar";

/** Pages without a menu entry still get a name in the breadcrumb. */
const OTHER_SECTIONS: { prefix: string; label: string }[] = [
  { prefix: "/videos/", label: "Dashboard" },
  { prefix: "/models", label: "Model comparison" },
  { prefix: "/about", label: "How it is built" },
  { prefix: "/dashboard", label: "Statistics" },
];

function sectionFor(pathname: string): string {
  const other = OTHER_SECTIONS.find((section) => pathname.startsWith(section.prefix));
  if (other) return other.label;
  const item = [...NAV_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((nav) => (nav.href === "/" ? pathname === "/" : pathname.startsWith(nav.href)));
  return item?.label ?? "Pitstop";
}

/** The breadcrumb bar at the top of the shell: section, then the page's own detail. */
export function Topbar({ actions }: { actions?: React.ReactNode }) {
  const pathname = usePathname();
  const { setMenuOpen, detail } = useShell();

  return (
    <header className="mx-2 mt-2 flex min-h-10 items-center justify-between gap-3 rounded-[7px] border border-[#e4e4e4] bg-[#f3f3f3] px-2 py-[5px] shadow-[inset_0_1px_#fff] md:mx-2.5 md:mt-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className="grid h-[25px] w-[25px] place-items-center rounded-md text-[#555] md:hidden"
        >
          <Icon name="menu" size={18} />
        </button>
        <div className="truncate text-[14px] font-medium leading-6 text-[#343434]">
          {sectionFor(pathname)}
          {detail && (
            <>
              <span className="text-[#9a9a9a]"> · </span>
              {detail}
            </>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
