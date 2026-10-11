"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import clsx from "clsx";
import { DEFAULT_SAMPLE_ID, SAMPLES } from "@/features/videos/lib/samples";
import { Icon, NavIcon, type NavIconName } from "./icons";
import { useShell } from "./shell-context";

type NavItem = { href: string; label: string; icon: NavIconName };

/** The Pitstop sections. Model comparison and how it is built stay reachable by link. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "home" },
  { href: "/analyze", label: "Live demo", icon: "upload" },
  { href: "/videos", label: "Samples & insights", icon: "samples" },
  { href: "/potholes", label: "Potholes", icon: "images" },
  { href: "/map", label: "Map", icon: "map" },
  { href: "/drive", label: "Live drive", icon: "drive" },
];

/** One colour per sample, as in Pitstop, so a video is recognisable at a glance. */
const SAMPLE_COLOURS = ["#76a6da", "#62bda9", "#d9a76a", "#44474f"];

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar() {
  const pathname = usePathname();
  const params = useSearchParams();
  const { menuOpen, setMenuOpen } = useShell();
  const selectedSample = pathname === "/" ? (params.get("video") ?? DEFAULT_SAMPLE_ID) : null;
  const close = () => setMenuOpen(false);

  return (
    <>
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={close}
          className="fixed inset-0 z-[29] bg-[#22222266] md:hidden"
        />
      )}
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col overflow-y-auto bg-sidebar px-3 pb-4 pt-6 transition-transform duration-200 md:w-[224px] md:translate-x-0",
          menuOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="mb-6 flex items-center justify-between">
          <Link href="/" onClick={close} className="flex items-center px-2.5" aria-label="Pitstop, dashboard">
            <span className="mr-2.5 grid h-8 w-8 place-items-center rounded-[9px] border border-[#353535] bg-accent text-white shadow-[0_2px_4px_#00000012]">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden>
                <path d="M7 3.5 4.5 20.5M17 3.5l2.5 17" />
                <ellipse cx="12" cy="13" rx="3.4" ry="2" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <span className="text-[22px] font-semibold tracking-[-1px] text-primary">Pitstop</span>
          </Link>
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            className="grid h-7 w-7 place-items-center rounded-md text-[#777] md:hidden"
          >
            <Icon name="close" size={18} />
          </button>
        </div>

        <nav aria-label="Primary">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={close}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "mb-[3px] flex min-h-[38px] items-center gap-2.5 whitespace-nowrap rounded-lg border px-2.5 py-2 text-[14px] transition-colors duration-150",
                  active
                    ? "border-[#dedede] bg-[#fafafa] text-[#252525] shadow-[0_2px_3px_#0000000a,inset_0_0_0_2px_#ffffff]"
                    : "border-transparent text-[#515151] hover:bg-[#e7e7e7] hover:text-[#292929]",
                )}
              >
                <span className={active ? "text-[#34343b]" : "text-[#767676]"}>
                  <NavIcon name={item.icon} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mx-2 mb-2 mt-7 flex items-center justify-between border-b border-white pb-1.5 shadow-[0_1px_#e8e8e8]">
          <span className="text-[12px] text-[#666]">Sample videos</span>
          <span className="tabular text-[11px] text-[#666]">{String(SAMPLES.length).padStart(2, "0")}</span>
        </div>
        <ul>
          {SAMPLES.map((demo, index) => (
            <li key={demo.id}>
              <Link
                href={`/?video=${demo.id}`}
                onClick={close}
                aria-current={selectedSample === demo.id ? "page" : undefined}
                className={clsx(
                  "flex min-h-[46px] items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[13px] transition-colors duration-150 hover:bg-[#e4e4e4]",
                  selectedSample === demo.id && "bg-[#e4e4e4]",
                )}
              >
                <span
                  className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-md text-white shadow-[inset_0_0_0_1px_#ffffff55]"
                  style={{ backgroundColor: SAMPLE_COLOURS[index % SAMPLE_COLOURS.length] }}
                >
                  <Icon name="video" size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[#454545]">{demo.title}</span>
                  <span className="block truncate text-[11px] text-[#7a7a7a]">{demo.description}</span>
                </span>
                <span className="tabular rounded-[5px] border border-[#e6e6e6] bg-[#f9f9f9] px-1 py-[5px] text-[10px] text-[#666] shadow-[0_1px_2px_#00000005]">
                  {demo.durationLabel}
                </span>
                <Icon name="chevron" size={14} className="text-[#929292]" />
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-auto pt-6">
          <a
            href="https://github.com/rmm-code/final-safety-road"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Pitstop · CV track on GitHub (opens in a new tab)"
            className="flex items-center gap-2 rounded-lg border border-[#e2e2e2] bg-[#fafafa] p-2.5 transition-colors hover:bg-[#f0f0f0] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#22A06B]"
          >
            <Icon name="analyze" size={18} className="text-[#555]" />
            <span className="flex-1 text-[12px] leading-4 text-[#444]">Pitstop · CV track</span>
            <Icon name="external" size={14} className="text-[#929292]" />
          </a>
        </div>
      </aside>
    </>
  );
}
