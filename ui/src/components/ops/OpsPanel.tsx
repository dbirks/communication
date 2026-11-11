/**
 * OPS panel — the one frame the Operations page's sections draw in.
 *
 * It replaces the `Panel` title-bar treatment on this page only: the ops page
 * is a scan surface, so its heads are 36px of quiet label rather than a state
 * bar, and the state itself has already been said by the tile strip above. The
 * strong-colored bar of `ds/Panel` shouts on a page whose whole job is to be
 * read at a glance; here it would sit above every section at once.
 *
 * A section is `<section id aria-labelledby>`: the stat tiles scroll to that id,
 * so the id is part of the contract, not a styling hook.
 */
import type { ReactNode } from "react";

export interface OpsPanelProps {
  /** Stable in-page target: `ops-workers`, `ops-queue`, … */
  id: string;
  /** Mono label, e.g. `WORKERS`. Rendered as the section heading. */
  title: string;
  /** Right slot of the head: the count or host that sizes the section. */
  meta?: ReactNode;
  children: ReactNode;
}

export function OpsPanel({ id, title, meta, children }: OpsPanelProps) {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="overflow-hidden rounded-[4px] border border-line bg-surface"
      data-testid={id}
    >
      <div className="flex h-[36px] items-center gap-2 border-b border-line bg-paper px-[12px]">
        <h2
          id={headingId}
          className="min-w-0 truncate font-mono text-[10.5px] font-semibold tracking-[.06em] text-ink-2 uppercase"
        >
          {title}
        </h2>
        {meta !== undefined && meta !== null ? (
          <span className="ml-auto shrink-0 font-mono text-[10.5px] text-faint">{meta}</span>
        ) : null}
      </div>
      <div className="p-[12px]">{children}</div>
    </section>
  );
}

/**
 * The loading body: three skeleton lines, so a section reads as "something is
 * coming here" at the height it will land at, not as an empty box.
 */
export function OpsSkeleton({ testid = "ops-skeleton" }: { testid?: string }) {
  return (
    <div className="space-y-[8px]" data-testid={testid} aria-hidden="true">
      <div className="h-[12px] w-[70%] rounded-[2px] bg-fill" />
      <div className="h-[12px] w-[92%] rounded-[2px] bg-fill" />
      <div className="h-[12px] w-[46%] rounded-[2px] bg-fill" />
    </div>
  );
}

export interface OpsErrorProps {
  /** What could not be read, in the sentence's own words: `workers`, `the queue`. */
  thing: string;
  detail?: string | null;
  onRetry?: () => void;
  testid?: string;
}

/**
 * The failed-read body. Naming the thing that failed is the minimum a status
 * page owes the reader — `Couldn't load the queue.` plus the server's own
 * detail when there is one, and a retry that re-opens the read.
 */
export function OpsError({ thing, detail, onRetry, testid = "ops-error" }: OpsErrorProps) {
  return (
    <p
      className="flex flex-wrap items-baseline gap-x-2 text-[12.5px] text-st-failed-tag-fg"
      role="alert"
      data-testid={testid}
    >
      Couldn&apos;t load {thing}.
      {detail ? <span className="font-mono text-[11px] break-all">{detail}</span> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="text-accent-text underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          data-testid={`${testid}-retry`}
        >
          Retry
        </button>
      ) : null}
    </p>
  );
}
