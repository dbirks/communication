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

/**
 * Park the strip on a WHOLE-LABEL boundary. Every candidate offset is a
 * tab edge (the only places a viewport edge can sit without cutting a label):
 * each tab's left, and each tab's right minus the viewport. Of those that
 * keep the ACTIVE tab fully visible, take the one with the fewest tabs
 * straddling either edge — ties broken toward not moving at all. A strip
 * where tabs simply cannot tile the viewport width takes the cleanest
 * compromise: whole at the left edge, the right edge clipped UNDER its fade
 * (which is what the fade is for). No layout, no snap — in jsdom every box
 * measures 0×0, so this is a no-op there by construction.
 */
function snapToWholeLabels(nav: HTMLElement): void {
  const w = nav.clientWidth;
  const max = nav.scrollWidth - w;
  if (w <= 0 || max <= 0) return;
  const tabs = Array.from(nav.querySelectorAll<HTMLElement>('[data-testid^="project-tab-"]'));
  const active = nav.querySelector<HTMLElement>('[aria-current="page"]');
  if (!active || !tabs.includes(active) || active.offsetWidth <= 0) return;
  const bounds = tabs.map((t) => ({ l: t.offsetLeft, r: t.offsetLeft + t.offsetWidth }));
  const a = bounds[tabs.indexOf(active)];
  const cuts = (x: number): number => {
    let cut = 0;
    for (const b of bounds) {
      if ((b.l < x - 1 && b.r > x + 1) || (b.l < x + w - 1 && b.r > x + w + 1)) cut += 1;
    }
    return cut;
  };
  const at = nav.scrollLeft;
  const candidates: number[] = [at, a.l, a.r - w];
  for (const b of bounds) candidates.push(b.l, b.r - w);
  let best: { x: number; cut: number; dist: number } | null = null;
  for (const raw of candidates) {
    if (!Number.isFinite(raw)) continue;
    const x = Math.min(Math.max(raw, 0), max);
    if (a.l < x - 1 || a.r > x + w + 1) continue; // the active tab must be whole
    const cut = cuts(x);
    const dist = Math.abs(x - at);
    if (!best || cut < best.cut || (cut === best.cut && dist < best.dist)) best = { x, cut, dist };
  }
  if (best && Math.abs(best.x - at) > 1) nav.scrollLeft = best.x;
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
  // (pass-2 review, made visible by pass-3 — see the markup at the bottom of
  // this component). The active tab is held fully in view — see
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
    // `inline: "nearest"` moves as little as it must, which is what leaves a
    // NEIGHBOUR half off at the other edge: pass-4 review again saw `Overview`
    // cut mid-word at 390 while `Workflows 3` sat fully in view. The rest of
    // the pull therefore re-reads the geometry and parks the strip on a
    // WHOLE-LABEL boundary: of all the offsets where the active tab stays
    // fully visible, pick one where no tab straddles the strip's left or
    // right edge (a clean exit when one exists — every tab whole, the fade
    // covering the rest), else the closest with only the LEFT edge whole;
    // the right edge then shows its fade as the honest “more”. (If even that
    // conflicts — a tab wider than the strip — the active tab wins.)
    snapToWholeLabels(nav);
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
    // `flex`, not a relative overlay box: the LEFT fade is an in-flow lane
    // beside the strip (see its markup), so its arrow can never sit on top of
    // a tab label.
    <div className="relative flex items-stretch" data-testid="project-tabs-wrap">
      {/* The cue that the strip continues. Pass-3 review: the earlier cap was a
          solid rectangle in the BAND'S OWN colour over a white band, so it
          existed in the DOM and inked nothing — the phone showed `Workflov`
          with no hint of a scroll. It is now a shadow that deepens toward the
          clipped edge plus a chevron pointing the way the strip still moves.
          The chevron is an SVG, not a text glyph: a printed character under the
          cap would sit on top of the clipped tab's own ink, which is the
          collision the emulator's overlap check reports. It is
          `pointer-events-none` and `aria-hidden` — every tab link stays in the
          accessibility tree and stays clickable under it — and it is a
          decoration only, never a control. */}
      {/* The cue that the strip continues past its LEFT edge. This one is an
          in-flow lane (`shrink-0`), not an overlay: the pass-1 review of this
          brief saw the absolute left arrow drawn on top of `Overview`
          (“‹verview”) at 390 — any tab that enters the strip's left edge
          crosses a 34px overlay, so an overlaid arrow cannot promise it never
          covers a label. A lane beside the strip pads the strip by the arrow's
          width instead: the arrow appears only once the strip has scrolled
          away from 0 (`fade.left`), and it occupies space the tabs never draw
          in. It is still `pointer-events-none` and `aria-hidden` — decoration,
          never a control. */}
      {fade.left ? (
        <span
          aria-hidden="true"
          data-testid="project-tabs-fade-left"
          className="pointer-events-none flex w-[34px] shrink-0 items-center"
          style={{
            // Pass-4 review, item 3: at 16% the shadow was barely inkable on
            // the white band — “make the edge fade visible enough to read as
            // ‘more’”. A deeper ramp and a dark chevron make the cue seen,
            // not just present.
            background:
              "linear-gradient(to right, transparent, color-mix(in srgb, var(--color-ink) 30%, transparent))",
          }}
        >
          <svg
            className="ml-[8px] text-ink-2"
            width="8"
            height="12"
            viewBox="0 0 8 12"
            aria-hidden="true"
          >
            <path
              d="M6.5 1.5l-4 4.5 4 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
      <nav
        ref={navRef}
        aria-label="Project sections"
        className="-mb-px flex min-w-0 flex-1 gap-[4px] overflow-x-auto overscroll-x-contain"
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
      {/* The right cue stays the pass-4 overlay: it darkens toward the strip's
          end and rides OVER the tab clipped at the edge, which is what that
          review asked the fade to do (“the right edge clipped UNDER its
          fade”). The left lane is the brief's fix for the arrow-on-a-label
          collision; the right cue was not reported, and its whole-label snap
          parks the edge between labels. */}
      {fade.right ? (
        <span
          aria-hidden="true"
          data-testid="project-tabs-fade-right"
          className="pointer-events-none absolute inset-y-0 right-0 flex w-[34px] items-center justify-end"
          style={{
            background:
              "linear-gradient(to right, transparent, color-mix(in srgb, var(--color-ink) 30%, transparent))",
          }}
        >
          <svg
            className="mr-[8px] text-ink-2"
            width="8"
            height="12"
            viewBox="0 0 8 12"
            aria-hidden="true"
          >
            <path
              d="M1.5 1.5l4 4.5-4 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      ) : null}
    </div>
  );
}
