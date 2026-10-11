import clsx from "clsx";
import {
  Archive,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Car,
  ChartColumn,
  ChartLine,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  ClipboardCheck,
  Clock,
  Download,
  EyeOff,
  Film,
  House,
  Images,
  Info,
  LayoutGrid,
  Map as MapIcon,
  MapPin,
  Maximize2,
  Menu,
  Pause,
  Play,
  ScanSearch,
  Square,
  TriangleAlert,
  Upload,
  Video,
  X,
  type LucideIcon,
} from "lucide-react";

/**
 * The product's icon vocabulary, drawn with Lucide so every glyph shares one stroke
 * weight and optical size. Components ask for a name, never a Lucide import, so the set
 * stays small and consistent. DESIGN_SYSTEM.md rules out emoji entirely.
 */
const ICONS = {
  overview: LayoutGrid,
  dashboard: ChartColumn,
  map: MapIcon,
  potholes: MapPin,
  drive: Car,
  analyze: ScanSearch,
  models: Boxes,
  review: ClipboardCheck,
  download: Download,
  video: Video,
  alert: TriangleAlert,
  info: Info,
  stop: Square,
  chevron: ChevronRight,
  arrow: ArrowRight,
  check: CircleCheck,
  attention: CircleAlert,
  question: CircleHelp,
  clock: Clock,
  dismissed: CircleX,
  archive: Archive,
  hidden: EyeOff,
  home: House,
  upload: Upload,
  samples: Film,
  images: Images,
  back: ChevronLeft,
  menu: Menu,
  close: X,
  external: ArrowUpRight,
  chartLine: ChartLine,
  play: Play,
  pause: Pause,
  expand: Maximize2,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export type NavIconName = Extract<
  IconName,
  | "overview"
  | "analyze"
  | "drive"
  | "map"
  | "potholes"
  | "dashboard"
  | "review"
  | "models"
  | "home"
  | "upload"
  | "samples"
  | "images"
>;

export function Icon({
  name,
  size = 16,
  strokeWidth = 1.75,
  className,
  filled,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Fill the shape with this colour and draw the glyph in white, for status marks. */
  filled?: string;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      aria-hidden
      size={size}
      strokeWidth={strokeWidth}
      className={clsx("shrink-0", filled && "text-white", className)}
      {...(filled ? { style: { fill: filled } } : {})}
    />
  );
}

export function NavIcon({ name }: { name: NavIconName }) {
  // Inherits the nav item's colour so the icon tracks selected/idle state.
  return <Icon name={name} size={20} strokeWidth={1.8} />;
}
