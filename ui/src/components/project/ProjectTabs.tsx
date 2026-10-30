/**
 * The project page's header tabs (Projects Review design 1b).
 *
 * They replace the 160px `ProjectSectionNav` rail on the project overview: one
 * navigation, drawn as links that sit *on* the header band's bottom border.
 * Items are ROUTES, not fragments, exactly like the workflow page's tabs
 * (`pages/Workflow.tsx`), so a tab change is a navigation and the URL stays the
 * honest answer to "where am I".
 *
 * Two labels are new words over old routes, which the handoff asks for
 * ("Conversations becomes Threads everywhere"; a library workflow is *used* by
 * a project, which is what the assignments page lists):
 *   Threads   → `/p/:id/conversations`  (rebuilt as its own screen by the
 *              Threads Review handoff; the project's list is still the
 *              conversations page)
 *   Workflows → `/p/:id/pipelines`      (the project's assignments)
 *
 * A count trails the label in mono only where the count means something, and
 * the Runs count carries the waiting glyph + color when it is a count of things
 * that ask something of a person (identity rule 06: never color alone).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../lib/routes";

export type ProjectTabKey =
  | "overview"
  | "runs"
  | "threads"
  | "workflows"
  | "artifacts"
  | "settings";

/** The tabs, in design order. */
export const PROJECT_TABS: readonly { key: ProjectTabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "runs", label: "Runs" },
  { key: "threads", label: "Threads" },
  { key: "workflows", label: "Workflows" },
  { key: "artifacts", label: "Artifacts" },
  { key: "settings", label: "Settings" },
];

/** The route one tab points at. */
export function projectTabHref(projectId: string, tab: ProjectTabKey): string {
  switch (tab) {
    case "overview":
      return routes.project(projectId);
    case "threads":
      return routes.projectTab(projectId, "conversations");
    case "workflows":
      return routes.projectTab(projectId, "pipelines");
    default:
      return routes.projectTab(projectId, tab);
  }
}

export interface ProjectTabFlags {
  /** Runs that ask something of a person (open gates + stalled runs). Shown as
   * `! n` in the waiting color; null = not known yet, so nothing is printed. */
  needsYou?: number | null;
  /** Project threads; null until the read arrives. */
  threads?: number | null;
  /** Workflows the project uses; null until the read arrives. */
  workflows?: number | null;
}

export interface ProjectTabsProps {
  projectId: string;
  active: ProjectTabKey | null;
  flags?: ProjectTabFlags;
}

/** One tab's mono count. */
function Count({ value, urgent }: { value: number | null | undefined; urgent?: boolean }) {
  if (value === null || value === undefined) return null;
  if (urgent) {
    if (value === 0) return null;
    return (
      <span className="font-mono text-[10.5px] font-semibold text-st-waiting-tag-fg" aria-hidden>
        ! {value}
      </span>
    );
  }
  return <span className="font-mono text-[10.5px]">{value}</span>;
}

export function ProjectTabs({ projectId, active, flags = {} }: ProjectTabsProps) {
  // At 390 the six tabs do not all fit the band. They scroll *inside* the strip
  // (never dragging the page sideways — `overscroll-x-contain`) and two edge
  // fades appear on whichever side still has tabs hidden, so the phone strip
  // says "there is more" instead of cutting Artifacts/Settings off with no cue
  // (pass-2 review). The active tab is held fully in view — see
  // `pullActiveIntoView` for why once is not enough.
  const navRef = useRef<HTMLElement | null>(null);
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({
    left: false,
    right: false,
  });

  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const max = nav.scrollWidth - nav.clientWidth;
    const x = nav.scrollLeft;
    // A pixel of slop each side so the fade never flashes at a rounded edge.
    setFade({ left: x > 1, right: x < max - 1 });
  }, []);

  // The active tab's promise, kept past the first paint: the counts trail the
  // labels (the `threads 1`, `workflows 3` of design 1b), so a tab GROWS after
  // its read lands, and a strip that had scrolled the tab exactly into view is
  // cut again ("Workflov" at 390 — pass-2 review). Every re-layout therefore
  // pulls the active tab back fully into view: on arrival, whenever a count
  // arrives (the effects below), and whenever the strip or window resizes.
  const pullActiveIntoView = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const tab = nav.querySelector<HTMLElement>('[aria-current="page"]');
    // Scrolls the nearest scrollable ancestor — this `overflow-x-auto` nav —
    // not the page. Guarded because jsdom has no `scrollIntoView`.
    tab?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    measure();
  }, [measure]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    measure();
    nav.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => pullActiveIntoView()) : null;
    observer?.observe(nav);
    window.addEventListener("resize", pullActiveIntoView);
    return () => {
      nav.removeEventListener("scroll", measure);
      observer?.disconnect();
      window.removeEventListener("resize", pullActiveIntoView);
    };
  }, [measure, pullActiveIntoView]);

  useEffect(() => {
    if (!active) return;
    // The active tab already marks itself with `aria-current="page"` — that is
    // the element to bring into view, and querying it by its own semantics
    // avoids rebuilding the test id as a dynamic string here.
    pullActiveIntoView();
    // `active` on arrival, and again whenever a tab count lands and changes
    // the strip's widths — the deep-link case and the late-count case alike.
  }, [active, flags.needsYou, flags.threads, flags.workflows, pullActiveIntoView]);

  return (
    <div className="relative" data-testid="project-tabs-wrap">
      <nav
        ref={navRef}
        aria-label="Project sections"
        className="-mb-px flex min-w-0 gap-[4px] overflow-x-auto overscroll-x-contain"
        data-testid="project-tabs"
      >
        {PROJECT_TABS.map(({ key, label }) => {
          const isActive = active === key;
          // Only the urgent Runs count changes color, and only when it is
          // non-zero; the plain counts print whatever the read served, zero
          // included (an empty project's "0" is a fact, not a gap).
          const count =
            key === "runs"
              ? { value: flags.needsYou ?? null, urgent: true }
              : key === "threads"
                ? { value: flags.threads ?? null, urgent: false }
                : key === "workflows"
                  ? { value: flags.workflows ?? null, urgent: false }
                  : null;
          return (
            <Link
              key={key}
              to={projectTabHref(projectId, key)}
              aria-current={isActive ? "page" : undefined}
              className={`flex shrink-0 items-center gap-[6px] whitespace-nowrap rounded-t-[3px] border px-[12px] pt-[6px] pb-[7px] text-[13px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                isActive
                  ? "border-ink border-b-paper bg-paper font-semibold text-ink"
                  : "border-transparent text-muted"
              }`}
              data-testid={`project-tab-${key}`}
            >
              {label}
              {count ? (
                <>
                  <Count {...count} />
                  {/* The urgent count's glyph is decorative, so the count is
                    spelled out for anyone not reading the color. */}
                  {count.urgent && (count.value ?? 0) > 0 ? (
                    <span className="sr-only">{`${count.value} need you`}</span>
                  ) : null}
                </>
              ) : null}
            </Link>
          );
        })}
      </nav>
      {/* The cue that the strip continues: a solid edge cap in the band's own
          colour over the last few pixels, painted only while that side still
          has a tab off-strip. It is `pointer-events-none` and `aria-hidden` —
          the tab links are all in the accessibility tree either way — and it is
          a decoration only, never a control. */}
      {fade.left ? (
        <span
          aria-hidden="true"
          data-testid="project-tabs-fade-left"
          className="pointer-events-none absolute inset-y-0 left-0 w-[18px]"
          style={{ background: "var(--color-surface)" }}
        />
      ) : null}
      {fade.right ? (
        <span
          aria-hidden="true"
          data-testid="project-tabs-fade-right"
          className="pointer-events-none absolute inset-y-0 right-0 w-[18px]"
          style={{ background: "var(--color-surface)" }}
        />
      ) : null}
    </div>
  );
}
