/**
 * Manage — the app's configure surface (`/manage/:section?/:itemId?`,
 * redesign R7).
 *
 * A 230px sub-nav and a scrolling content column, exactly the shape
 * `docs/design/redesign/Prototype.dc.html` draws for the section: one title,
 * six destinations, and a content area that owns its own scroll (the shell
 * already scrolls `<main>`, and CONTRACT says each page scrolls itself).
 *
 * The sections are the destinations the old app spread across `/projects`,
 * `/p/:id/settings`, `/p/:id/members`, `/settings/operations`, `/profiles` and
 * the Workflows-side libraries; CONTRACT's "What happens to the old app" table
 * names where each went. The selected destination is a URL, not state:
 * `/manage` alone is Projects, an unknown section is the app's own `NotFound`.
 *
 * Below 768px (`useIsNarrow`, the shell's own question) the sub-nav stops being
 * a column: it becomes a horizontally scrolling row of pills above the content,
 * because a 230px rail eats a third of a 390px screen and CONTRACT forbids
 * horizontal page scroll at that width.
 *
 * Agents & models is loaded lazily: it is another brief's file, it owns the
 * largest tree in the section (profiles, skills, step templates, models,
 * assistant), and Manage should not pull it into the initial chunk.
 */
import { lazy, Suspense, useEffect, useRef } from "react";
import { Link, useParams } from "react-router";
import {
  IconFolders,
  IconGitBranch,
  IconKey,
  IconRobot,
  IconServer,
  IconUsers,
} from "@tabler/icons-react";
import { useIsNarrow } from "../components/Shell";
import { Spinner } from "../components/Feedback";
import { MANAGE_SECTIONS, routes } from "../lib/routes";
import type { ManageSection } from "../lib/routes";
import NotFound from "./NotFound";
import ProjectDetail from "./manage/ProjectDetail";
import ProjectsSection from "./manage/Projects";
import RepositoriesSection from "./manage/Repositories";
import PeopleSection from "./manage/People";
import RunnersSection from "./manage/Runners";
import SecretsSection from "./manage/Secrets";

const AgentsSection = lazy(() => import("./manage/Agents"));

/** The six destinations, in CONTRACT's order, with the icon the design names. */
const ITEMS: readonly {
  key: ManageSection;
  label: string;
  Icon: typeof IconFolders;
}[] = [
  { key: "projects", label: "Projects", Icon: IconFolders },
  { key: "repositories", label: "Repositories", Icon: IconGitBranch },
  { key: "people", label: "People & access", Icon: IconUsers },
  { key: "runners", label: "Runners", Icon: IconServer },
  { key: "agents", label: "Agents & models", Icon: IconRobot },
  { key: "secrets", label: "Secrets", Icon: IconKey },
];

export default function Manage() {
  const params = useParams<{ section?: string; itemId?: string }>();
  const section: string = params.section ?? "projects";
  const narrow = useIsNarrow();

  if (!(MANAGE_SECTIONS as readonly string[]).includes(section)) return <NotFound />;
  const active = section as ManageSection;

  return (
    <div
      className={
        narrow
          ? "flex h-full min-h-0 flex-col bg-surface"
          : "grid h-full min-h-0 grid-cols-[230px_minmax(0,1fr)] bg-surface"
      }
      data-testid="manage"
    >
      <SubNav active={active} narrow={narrow} />
      <div className="min-w-0 overflow-auto p-4 md:p-[26px_32px_40px]" data-testid="manage-content">
        <Content section={active} itemId={params.itemId} />
      </div>
    </div>
  );
}

function Content({ section, itemId }: { section: ManageSection; itemId?: string }) {
  switch (section) {
    case "projects":
      return itemId ? <ProjectDetail projectId={itemId} /> : <ProjectsSection />;
    case "repositories":
      return <RepositoriesSection />;
    case "people":
      return <PeopleSection />;
    case "runners":
      return <RunnersSection />;
    case "agents":
      return (
        <Suspense fallback={<Spinner label="Loading agents" />}>
          <AgentsSection />
        </Suspense>
      );
    case "secrets":
      return <SecretsSection />;
  }
}

/** The sub-nav: the column at desktop, the pill row on a phone. */
function SubNav({ active, narrow }: { active: ManageSection; narrow: boolean }) {
  const rowRef = useRef<HTMLDivElement>(null);

  // Review 15-390-2: the chip row scrolls sideways, so it must not open at
  // its start with the current section off-screen — the active chip is
  // scrolled into view whenever the row mounts or the section changes.
  useEffect(() => {
    if (!narrow) return;
    const chip = rowRef.current?.querySelector<HTMLElement>(`[data-testid="manage-nav-${active}"]`);
    chip?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [active, narrow]);

  const title = (
    <span
      className={
        narrow ? "px-[10px] text-[16px] font-bold" : "px-[10px] pb-[10px] text-[16px] font-bold"
      }
    >
      Manage
    </span>
  );

  if (narrow) {
    return (
      <nav
        aria-label="Manage"
        className="flex shrink-0 items-center gap-[6px] border-b border-line px-3 py-2"
        data-testid="manage-nav"
      >
        {title}
        {/* CONTRACT: phone touch targets ≥ 44px (review 15-390-1); the edge
            fade (15-390-2) says the row keeps scrolling sideways. */}
        <div
          ref={rowRef}
          className="flex min-w-0 flex-1 items-center gap-[6px] overflow-x-auto [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-12px),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {ITEMS.map((item) => (
            <NavPill key={item.key} item={item} active={active} pill />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav
      aria-label="Manage"
      className="flex min-h-0 flex-col gap-[2px] overflow-auto border-r border-line-soft p-[22px_12px]"
      data-testid="manage-nav"
    >
      {title}
      {ITEMS.map((item) => (
        <NavPill key={item.key} item={item} active={active} />
      ))}
    </nav>
  );
}

function NavPill({
  item,
  active,
  pill = false,
}: {
  item: (typeof ITEMS)[number];
  active: ManageSection;
  pill?: boolean;
}) {
  const selected = item.key === active;
  const { Icon } = item;
  const shape = pill
    ? `h-[44px] shrink-0 rounded-full border ${selected ? "border-ink bg-ink text-white" : "border-line"} px-[10px] text-[13.5px]`
    : `h-[34px] rounded-[8px] ${selected ? "bg-accent-wash font-semibold" : ""}`;
  return (
    <Link
      to={routes.manage(item.key)}
      aria-current={selected ? "page" : undefined}
      data-testid={`manage-nav-${item.key}`}
      className={`flex items-center gap-[9px] px-[10px] text-[13.5px] text-ink no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${shape}`}
    >
      <Icon
        size={16}
        stroke={1.5}
        aria-hidden
        className={selected && !pill ? "text-accent-edge" : "text-muted"}
      />
      {item.label}
    </Link>
  );
}
