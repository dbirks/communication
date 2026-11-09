/**
 * Page — the ONE layout contract (finding 07). Every routed page declares
 * `reading`, `wide` or `canvas`, so the content's left edge and the title's
 * baseline stop moving between routes and the shell stops deciding width from
 * a regex list.
 *
 * - `reading` — prose pages (Today, Settings, approval detail, Agents): the
 *   body column is capped at 960px and LEFT-ALIGNED at the band's edge (never
 *   centred, so the title does not jump when you switch pages).
 * - `wide` — lists and tables (Projects, Workflows, Steps, Runs, the project
 *   tabs): the body runs the whole content column with the same inset.
 * - `canvas` — no padding, full height (run workbench, Studio, Threads, the
 *   repository lanes, the project frame): the page draws its own band when it
 *   has one, and draws it with `PAGE_BAND_PAD` so its title still sits at the
 *   shared left edge and baseline.
 *
 * A `reading`/`wide` page that draws its OWN header band (no `title` prop: the
 * repository page, the artifact/settings tabs) still gets the shared inset from
 * the shell — the page only owns the band's content, never its distance from
 * the sidebar. Only `canvas` is handed the bare column.
 *
 * The shared band: title 22px/600 (today's page titles), a mono subline
 * below, actions on the right, optional tab strip (`band`) sitting under the
 * title row, and an optional `breadcrumb` trail riding the band's TOP PADDING
 * (finding 11: trails read above titles — it is absolutely positioned, so the
 * title edge and baseline do not move). The inset is the value the project
 * frame already used (`22px` sides, `20px` above, `28px` from `md` up) — the
 * type scale is unchanged.
 */
import type { ReactNode } from "react";

/** The band's (and every page body's) shared inset. */
export const PAGE_BAND_PAD = "px-[22px] pt-[20px] md:px-[28px]";

/**
 * The band's own height at the shared geometry: `pt-[20px]` plus the single
 * 28px title line. A `canvas` page that fills the viewport under its band
 * subtracts this from the 100vh it already took off for the app strip.
 */
export const PAGE_BAND_HEIGHT_PX = 48;

/**
 * A band's breadcrumb line (finding 11: trails read ABOVE titles). It is
 * absolutely positioned inside the band's own `pt-[20px]` padding — `top:
 * 4px` over a 14px mono line leaves 2px above the title — so the H1 keeps the
 * ONE baseline every route measures at (finding 07) and a page that passes no
 * breadcrumb is laid out exactly as before. One line, ellipsised: a trail that
 * wrapped would sit on top of the title.
 *
 * A page that draws its OWN band (the workflow page) puts this as the band's
 * FIRST child and adds `relative` to the band element.
 */
export const PAGE_BREADCRUMB_CLASS =
  "absolute inset-x-[22px] top-[4px] truncate font-mono text-[11px] leading-[14px] text-muted md:inset-x-[28px]";

export interface PageBreadcrumbProps {
  /** Trail content: linked steps plus the current page, separated by `›`. */
  children: ReactNode;
  /** Root test handle. */
  testid?: string;
  className?: string;
}

/** The one `Breadcrumb` landmark every band draws (see `PAGE_BREADCRUMB_CLASS`). */
export function PageBreadcrumb({ children, testid, className = "" }: PageBreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={`${PAGE_BREADCRUMB_CLASS} ${className}`.trim()}
      data-testid={testid}
    >
      {children}
    </nav>
  );
}

/** One `›` between trail steps. The trail never ends in a separator: a dangling
 * `›`/`/` after the current page reads as a step that goes nowhere. */
export function CrumbSep() {
  return (
    <span aria-hidden="true" className="px-[6px]">
      ›
    </span>
  );
}

export interface PageBandProps {
  /** Band title — the page's one H1 (22px/600, `leading-[28px]`). */
  title: ReactNode;
  /** Trail above the title, riding the band's top padding (never moves the H1). */
  breadcrumb?: ReactNode;
  /** Mono subline under the title. */
  subtitle?: ReactNode;
  /** Right side of the title row. */
  actions?: ReactNode;
  /** Tab strip under the title row, inside the band. */
  band?: ReactNode;
  /** Extra classes on the band element (a `canvas` page's own rule/ground). */
  className?: string;
}

/**
 * The shared title band on its own (finding 07). `<Page title=…>` mounts it;
 * a `canvas` page that owns the whole column mounts THIS instead of drawing a
 * header of its own, so its title keeps the ONE left edge and the ONE baseline
 * every other route measures at (`page-band`, H1 22px/600 under
 * `PAGE_BAND_PAD`). Pages that need a richer band than the four slots (the
 * workflow page, with its breadcrumb and tab strip) still use `PAGE_BAND_PAD`
 * and keep the H1 first in the column — the ruler is the contract, not the
 * prop list, and a page with more than the slots carries `PageBreadcrumb` as
 * the band's FIRST child plus `relative` on the band element.
 */
export function PageBand({
  title,
  subtitle,
  actions,
  band,
  breadcrumb,
  className = "",
}: PageBandProps) {
  return (
    <header
      className={`${PAGE_BAND_PAD} ${breadcrumb == null ? "" : "relative"} ${className}`.trim()}
      data-testid="page-band"
    >
      {breadcrumb != null ? <PageBreadcrumb>{breadcrumb}</PageBreadcrumb> : null}
      <div className="flex flex-wrap items-start justify-between gap-x-[14px] gap-y-2">
        <div className="min-w-0 space-y-1">
          <h1 className="text-[22px] leading-[28px] font-semibold">{title}</h1>
          {subtitle != null ? (
            <div className="font-mono text-[11px] text-muted">{subtitle}</div>
          ) : null}
        </div>
        {actions != null ? (
          <div className="flex shrink-0 flex-wrap items-center gap-[10px]">{actions}</div>
        ) : null}
      </div>
      {band != null ? <div className="pt-[12px]">{band}</div> : null}
    </header>
  );
}

export type PageLayout = "reading" | "wide" | "canvas";

export interface PageProps {
  layout: PageLayout;
  /** Band title (22px/600). Pages that draw their own band (`canvas`, or a
   * `wide` page whose header carries breadcrumbs) omit it. */
  title?: ReactNode;
  /** Trail above the title (rides the band's top padding; no layout shift). */
  breadcrumb?: ReactNode;
  /** Mono subline under the title. */
  subtitle?: ReactNode;
  /** Right side of the title row. */
  actions?: ReactNode;
  /** Tab strip under the title row, inside the band. */
  band?: ReactNode;
  /** Root test handle, so converted pages keep their `data-testid`. */
  testid?: string;
  className?: string;
  children: ReactNode;
}

export function Page({
  layout,
  title,
  subtitle,
  actions,
  band,
  breadcrumb,
  testid,
  className = "",
  children,
}: PageProps) {
  const root = `flex min-h-full flex-col bg-paper ${className}`.trim();

  if (layout === "canvas") {
    // Canvas: the shell gives the bare column; the page owns its band inside
    // `PAGE_BAND_PAD`.
    return (
      <div className={root} data-page-layout={layout} data-testid={testid}>
        {children}
      </div>
    );
  }

  // A page with no `title` draws its own band, so the band's own inset is the
  // body's inset (`PAGE_BAND_PAD`) rather than band + 16px of breathing room.
  const bodyPad =
    title == null ? `${PAGE_BAND_PAD} pb-[28px]` : "px-[22px] pb-[28px] pt-[16px] md:px-[28px]";

  return (
    <div className={root} data-page-layout={layout} data-testid={testid}>
      {title == null ? null : (
        <PageBand
          title={title}
          subtitle={subtitle}
          actions={actions}
          band={band}
          breadcrumb={breadcrumb}
        />
      )}
      <div className={`flex flex-1 flex-col ${bodyPad}`}>
        {layout === "reading" && title != null ? (
          <div className="max-w-[960px]">{children}</div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default Page;
