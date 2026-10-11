import Link from "next/link";
import clsx from "clsx";
import type { SeverityLevel } from "@pothole/shared-types";
import { Icon, type IconName } from "./icons";

/**
 * Shared surfaces and controls.
 *
 * Everything here follows DESIGN_SYSTEM.md: white cards on a cool canvas, separated by
 * fills and soft shadows rather than outlines; an icon + title + subtitle header where a
 * card needs one; severity and status as a coloured icon beside a word, never a tinted
 * pill or a dot; and colour that always means something.
 */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="max-w-3xl">
        <h1 className="text-[20px] font-semibold leading-7 tracking-[-0.02em] text-primary">
          {title}
        </h1>
        {description && <p className="mt-0.5 text-[13.5px] leading-5 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** The square that leads a card header, as in Pitstop: a white box with a hairline edge. */
export function IconTile({ name, className }: { name: IconName; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        "grid h-[38px] w-[38px] shrink-0 place-items-center rounded-lg border border-[#e6e6e6] bg-white text-[#5f5f5f] shadow-[0_1px_2px_#00000008]",
        className,
      )}
    >
      <Icon name={name} size={19} strokeWidth={1.6} />
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  icon,
  actions,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title?: string;
  subtitle?: string;
  icon?: IconName;
  actions?: React.ReactNode;
  /** A quiet strip under the content: a next step, or one line of context. */
  footer?: { label: string; href?: string };
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section
      className={clsx(
        "flex flex-col overflow-hidden rounded-[10px] border border-[#ebebeb] bg-surface shadow-card",
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex items-center justify-between gap-4 border-b border-[#f0f0f0] px-4 py-3.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            {icon && <IconTile name={icon} />}
            <div className="min-w-0">
              {title && (
                <h2 className="text-[16px] font-medium leading-5 tracking-[-0.01em] text-[#2a2a2a]">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-1 text-[13px] leading-[18px] text-muted">{subtitle}</p>
              )}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx("flex-1 p-4 sm:p-5", bodyClassName)}>{children}</div>
      {footer &&
        (footer.href ? (
          <Link
            href={footer.href}
            className="group flex items-center justify-between border-t border-[#f0f0f0] bg-[#fbfbfb] px-4 py-3 text-[13px] text-[#6a6a6a] transition-colors duration-150 hover:text-primary"
          >
            {footer.label}
            <Icon name="arrow" size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
          </Link>
        ) : (
          <div className="border-t border-[#f0f0f0] bg-[#fbfbfb] px-4 py-3 text-[12.5px] leading-[18px] text-[#6a6a6a]">
            {footer.label}
          </div>
        ))}
    </section>
  );
}

/** Label, then the number, then the one line of context that qualifies it. */
export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | SeverityLevel;
}) {
  return (
    <div className="rounded-xl bg-surface px-4 py-3.5 shadow-card">
      <div className="flex items-center gap-1.5 text-[12.5px] leading-[18px] text-secondary">
        {tone !== "default" && <SeverityIcon level={tone} />}
        {label}
      </div>
      <div className="tabular mt-1.5 text-[28px] font-semibold leading-[34px] tracking-[-0.02em] text-primary">
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[12px] leading-[18px] text-muted">{hint}</div>}
    </div>
  );
}

const SEVERITY_BARS: Record<SeverityLevel, { lit: number; color: string }> = {
  small: { lit: 1, color: "var(--color-severity-small)" },
  medium: { lit: 2, color: "var(--color-severity-medium)" },
  large: { lit: 3, color: "var(--color-severity-large)" },
  unknown: { lit: 0, color: "var(--color-severity-unknown)" },
};

/**
 * Three rising bars: as many lit as the pothole is bad, the rest grey. Reads at a glance,
 * survives colour blindness (the count of bars carries the level), and is never a dot.
 */
export function SeverityIcon({ level, size = 16 }: { level: SeverityLevel; size?: number }) {
  const { lit, color } = SEVERITY_BARS[level];
  const bars = [
    { x: 1.5, h: 6 },
    { x: 6.5, h: 10 },
    { x: 11.5, h: 14 },
  ];
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" className="shrink-0">
      {bars.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={15 - bar.h}
          width={3}
          height={bar.h}
          rx={1}
          style={{ fill: index < lit ? color : "var(--color-fill-strong)" }}
        />
      ))}
    </svg>
  );
}

export function SeverityBadge({
  level,
  className,
}: {
  level: SeverityLevel;
  className?: string;
}) {
  // The level string stays lower-case; capitalisation is presentational only.
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-medium text-primary",
        className,
      )}
    >
      <SeverityIcon level={level} />
      {level === "unknown" ? "Not graded" : <span className="capitalize">{level}</span>}
    </span>
  );
}

const STATUS_MARK: Record<string, { icon: IconName; fill?: string; color?: string }> = {
  reported: { icon: "question", fill: "var(--color-state-unverified)" },
  active: { icon: "attention", fill: "var(--color-state-confirmed)" },
  suspected_repaired: { icon: "clock", fill: "var(--color-yellow)" },
  repaired: { icon: "check", fill: "var(--color-state-fixed)" },
  false_positive: { icon: "dismissed", fill: "var(--color-severity-unknown)" },
  ignored: { icon: "hidden", color: "text-muted" },
  archived: { icon: "archive", color: "text-muted" },
};

/**
 * A pothole's lifecycle status: a filled mark beside a word, like a checked task. Colours
 * follow the public map: purple is a claim nobody has corroborated, red a confirmed open
 * defect, green repaired.
 */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const mark = STATUS_MARK[status] ?? { icon: "question" as IconName, color: "text-muted" };
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] capitalize text-secondary",
        className,
      )}
    >
      <Icon
        name={mark.icon}
        size={17}
        strokeWidth={2}
        {...(mark.fill ? { filled: mark.fill } : { className: mark.color })}
      />
      {status.replaceAll("_", " ")}
    </span>
  );
}

const BADGE_TONES = {
  neutral: "bg-fill text-secondary",
  warn: "bg-yellow-soft text-yellow-ink",
  ok: "bg-green-soft text-green-ink",
  danger: "bg-red-soft text-red-ink",
  info: "bg-blue-soft text-blue-ink",
  // Unverified: a claim nobody has corroborated. Its own tone, so it can never be
  // mistaken for a severity or for a healthy state.
  unverified: "bg-purple-soft text-purple-ink",
} as const;

/** A small flat label, for counts and short facts. No outline, no dot. */
export function Badge({
  children,
  tone = "neutral",
  icon,
  className,
}: {
  children: React.ReactNode;
  tone?: keyof typeof BADGE_TONES;
  icon?: IconName;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-2 py-0.5 text-[12.5px] font-medium leading-[18px]",
        BADGE_TONES[tone],
        className,
      )}
    >
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/**
 * A flat two-or-more-way switch: a filled track, the chosen option lifted onto white.
 * Used for filters; every option carries its word, optionally with an icon.
 */
export function FilterTabs<T extends string>({
  label,
  options,
  isActive,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  isActive: (value: T) => boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-0.5 rounded-lg bg-fill p-1">
      {options.map((option) => {
        const active = isActive(option.value);
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(option.value)}
            className={clsx(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-[13px] transition-colors duration-150",
              active
                ? "bg-surface font-medium text-primary shadow-card"
                : "text-secondary hover:text-primary",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * One bar split by share, with a legend that carries the numbers. Colour is never the
 * only cue: every segment is named in the legend beside its count.
 */
export function SegmentedBar({
  segments,
  label,
}: {
  segments: { label: string; value: number; color: string }[];
  label: string;
}) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  return (
    <div>
      <div
        role="img"
        aria-label={`${label}: ${segments.map((s) => `${s.label} ${s.value}`).join(", ")}`}
        className="flex h-3 gap-1"
      >
        {total === 0 ? (
          <span className="h-full w-full rounded-[4px] bg-fill" />
        ) : (
          segments
            .filter((s) => s.value > 0)
            .map((s) => (
              <span
                key={s.label}
                className={clsx("h-full rounded-[4px]", s.color)}
                style={{ width: `${(s.value / total) * 100}%` }}
              />
            ))
        )}
      </div>
      <ul className="mt-4 space-y-2.5">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-secondary">
              <span aria-hidden className={clsx("h-3 w-3 rounded-[3px]", s.color)} />
              {s.label}
            </span>
            <span className="tabular text-secondary">
              <span className="font-semibold text-primary">{s.value}</span> potholes
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Pitstop's buttons: near-black for the one action, white with a hairline for the rest. */
const BUTTON_VARIANTS = {
  primary:
    "border border-[#202020] bg-accent text-white shadow-[0_1px_2px_#00000020] hover:bg-accent-hover disabled:hover:bg-accent",
  secondary:
    "border border-[#e4e4e4] bg-white text-[#313131] shadow-[0_1px_2px_#25252505] hover:border-[#cdcdcd] hover:bg-[#f6f6f6] disabled:hover:bg-white",
  destructive: "border border-[#c96666] bg-red text-white hover:bg-red-ink disabled:hover:bg-red",
} as const;

export function Button({
  variant = "secondary",
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
}) {
  return (
    <button
      type={type}
      className={clsx(
        "inline-flex h-[37px] items-center justify-center gap-[7px] whitespace-nowrap rounded-[7px] px-3 text-[13px] font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-45",
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
}

/**
 * Table styling shared by every data table, so a row reads the same on every page:
 * a quiet header band, sentence-case column names, generous rows, a hover tint.
 */
export const TABLE = {
  wrap: "overflow-x-auto",
  table: "w-full text-[13.5px]",
  headRow: "bg-subtle text-left text-[12.5px] text-muted",
  th: "px-4 py-2.5 font-medium sm:px-5",
  body: "divide-y divide-divider",
  row: "transition-colors duration-150 hover:bg-hover",
  td: "px-4 py-3 sm:px-5",
} as const;
