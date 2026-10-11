import Link from "next/link";
import { Icon, type IconName } from "@/components/icons";
import { IconTile, PageHeader, Panel, TABLE } from "@/components/ui";

type Milestone = {
  id: string;
  title: string;
  detail: string;
  /**
   * "built" means the code exists, is tested and runs. It does NOT mean the detector has
   * been measured on a real route - that distinction is why "unverified" exists.
   */
  state: "built" | "unverified" | "planned";
  href?: string;
};

const MILESTONES: Milestone[] = [
  {
    id: "M0",
    title: "Video analysis",
    detail: "Detect, track and grade recorded footage",
    state: "built",
    href: "/",
  },
  {
    id: "M1",
    title: "Live camera",
    detail: "Rear camera, live inference, overlay, FPS and latency",
    state: "built",
    href: "/drive",
  },
  {
    id: "M2",
    title: "GPS",
    detail: "Location buffer, accuracy readout, nearest-sample lookup",
    state: "built",
    href: "/drive",
  },
  {
    id: "M3",
    title: "Tracking and capture",
    detail: "Trigger region, event builder, offline queue and upload",
    state: "built",
    href: "/drive",
  },
  {
    id: "M4",
    title: "Backend",
    detail: "FastAPI, PostGIS, object storage, auth and drive sessions",
    state: "built",
  },
  {
    id: "M5",
    title: "Map",
    detail: "MapLibre map of stored potholes, clustered",
    state: "built",
    href: "/map",
  },
  {
    id: "M6",
    title: "Deduplication",
    detail: "Merge repeated sightings into one physical pothole",
    state: "built",
    href: "/potholes",
  },
  {
    id: "M7",
    title: "Review and dashboard",
    detail: "Operational dashboard and pothole detail (review queue parked)",
    state: "built",
    href: "/dashboard",
  },
  {
    id: "—",
    title: "Detection accuracy",
    detail: "Precision and recall on a driven route with human ground truth",
    state: "unverified",
  },
  {
    id: "—",
    title: "Local fine-tuning",
    detail: "Train on Tashkent footage once enough is labelled",
    state: "planned",
  },
];

const STATE_MARK = {
  built: { icon: "check", fill: "var(--color-green)", label: "Built" },
  unverified: { icon: "attention", fill: "var(--color-yellow)", label: "Unverified" },
  planned: { icon: "clock", fill: "var(--color-severity-unknown)", label: "Planned" },
} as const;

/** What happens between a pothole on the road and a marker on the map, in order. */
const STEPS: { icon: IconName; title: string; detail: string }[] = [
  { icon: "drive", title: "Capture", detail: "A phone on the windshield records the road with GPS." },
  { icon: "analyze", title: "Detect and track", detail: "The model finds potholes; each one is followed across frames." },
  { icon: "potholes", title: "Grade and locate", detail: "Visual severity, the clearest photo and the GPS point near the car." },
  { icon: "map", title: "Merge and map", detail: "Repeated sightings join one physical pothole on the map." },
];

const START: { href: string; icon: IconName; title: string; detail: string }[] = [
  { href: "/dashboard", icon: "dashboard", title: "Dashboard", detail: "Road condition at a glance" },
  { href: "/map", icon: "map", title: "Map", detail: "Every physical pothole" },
  { href: "/drive", icon: "drive", title: "Live drive", detail: "Detect from a moving car" },
  { href: "/", icon: "analyze", title: "Analyze a video", detail: "Upload footage or try ours" },
  { href: "/models", icon: "models", title: "Model comparison", detail: "How the detectors score" },
];

export default function AboutPage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Road damage intelligence"
        description="A phone on the windshield finds potholes, grades how bad they look, and puts each one on the map once."
        actions={
          <Link
            href="/"
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-strong px-3.5 text-[13.5px] font-medium text-white shadow-card transition-colors duration-150 hover:bg-blue-ink"
          >
            <Icon name="analyze" size={16} />
            Analyze a video
          </Link>
        }
      />

      <Panel title="How it works" subtitle="From the road to the map, in four steps" icon="overview">
        <ol className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="rounded-lg bg-subtle p-4">
              <div className="flex items-center gap-3">
                <IconTile name={step.icon} className="bg-surface" />
                <span className="tabular text-[12px] font-medium text-muted">Step {index + 1}</span>
              </div>
              <div className="mt-3 text-[14px] font-semibold text-primary">{step.title}</div>
              <p className="mt-1 text-[13px] leading-5 text-secondary">{step.detail}</p>
            </li>
          ))}
        </ol>
      </Panel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title="What is built"
          subtitle="Built means the code runs and is tested, not that accuracy has been measured on a real road."
          icon="review"
          bodyClassName="p-0 sm:p-0"
        >
          <div className={TABLE.wrap}>
            <table className={TABLE.table}>
              <thead>
                <tr className={TABLE.headRow}>
                  <th scope="col" className={TABLE.th}>
                    Capability
                  </th>
                  <th scope="col" className={`${TABLE.th} hidden md:table-cell`}>
                    Scope
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.body}>
                {MILESTONES.map((milestone) => {
                  const mark = STATE_MARK[milestone.state];
                  return (
                    // By title: `id` is a display label, and the unnumbered rows all show "—".
                    <tr key={milestone.title} className={TABLE.row}>
                      <td className={`${TABLE.td} font-medium`}>
                        {milestone.href ? (
                          <Link href={milestone.href} className="text-primary hover:text-blue-strong">
                            {milestone.title}
                          </Link>
                        ) : (
                          <span className={milestone.state === "planned" ? "text-secondary" : "text-primary"}>
                            {milestone.title}
                          </span>
                        )}
                      </td>
                      <td className={`${TABLE.td} hidden text-secondary md:table-cell`}>{milestone.detail}</td>
                      <td className={TABLE.td}>
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-secondary">
                          <Icon name={mark.icon} size={17} strokeWidth={2} filled={mark.fill} />
                          {mark.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        <div className="space-y-4">
          <Panel title="Get started" subtitle="Jump to a task" icon="chevron" bodyClassName="p-2 sm:p-2">
            <ul>
              {START.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="group flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors duration-150 hover:bg-hover"
                  >
                    <IconTile name={item.icon} className="group-hover:bg-blue-soft group-hover:text-blue-strong" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13.5px] font-medium text-primary">{item.title}</span>
                      <span className="block text-[12.5px] text-muted">{item.detail}</span>
                    </span>
                    <Icon name="chevron" size={16} className="text-muted group-hover:text-primary" />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="About severity" icon="info">
            <p className="text-[13px] leading-5 text-secondary">
              Severity is visual: it comes from how large a pothole looks as the car reaches it. One
              phone camera cannot measure width, length or depth, and nothing here claims to.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}
