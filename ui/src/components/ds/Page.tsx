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
 * The shared band: title 22px/600 (today's page titles), a mono subline
 * below, actions on the right, optional tab strip (`band`) sitting under the
 * title row. The inset is the value the project frame already used
 * (`22px` sides, `20px` above, `28px` from `md` up) — the type scale is
 * unchanged.
 */
import type { ReactNode } from "react";

/** The band's (and every page body's) shared inset. */
export const PAGE_BAND_PAD = "px-[22px] pt-[20px] md:px-[28px]";

export type PageLayout = "reading" | "wide" | "canvas";

export interface PageProps {
  layout: PageLayout;
  /** Band title (22px/600). Pages that draw their own band (`canvas`, or a
   * `wide` page whose header carries breadcrumbs) omit it. */
  title?: ReactNode;
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
  testid,
  className = "",
  children,
}: PageProps) {
  const root = `flex min-h-full flex-col bg-paper ${className}`.trim();

  if (layout === "canvas" || title == null) {
    // Canvas (and a wide/reading page that keeps its own header): the shell
    // gives the bare column; the page owns its band inside `PAGE_BAND_PAD`.
    return (
      <div className={root} data-page-layout={layout} data-testid={testid}>
        {children}
      </div>
    );
  }

  return (
    <div className={root} data-page-layout={layout} data-testid={testid}>
      <header className={PAGE_BAND_PAD} data-testid="page-band">
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
      <div className={`flex flex-1 flex-col px-[22px] pb-[28px] pt-[16px] md:px-[28px]`.trim()}>
        {layout === "reading" ? <div className="max-w-[960px]">{children}</div> : children}
      </div>
    </div>
  );
}

export default Page;
