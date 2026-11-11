/**
 * The brief's shared drawing rules (ADR-0081): the box a section renders in,
 * the 34px row every section list uses, the project chip, and the short age a
 * row's meta line prints.
 *
 * The frame is OpsPanel's, not `ds/Panel`'s: the brief is a scan surface, so a
 * section head is 32px of quiet mono label rather than a state bar, and the
 * section's OWN count carries the size of the list (`SHIPPED · 7`) with the
 * rows the window cap cut off named on the right (`and 4 more`).
 *
 * A row is a link when the API gave it a `link`: the whole 34px line is the
 * target, which is what a returning reader actually wants to click.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { IconGitCommit, IconGitPullRequest } from "@tabler/icons-react";
import type {
  CatchUpBriefBroke,
  CatchUpBriefChange,
  CatchUpBriefHeadsUp,
  CatchUpBriefRunning,
  CatchUpBriefShipped,
} from "../../api/catchup";
import { projectColor, projectSquareClasses, type ProjectChip } from "./importance";

/** Join the mono bits a row's meta line is made of, dropping the empty ones so
 * a row never prints a lone separator. */
function metaBits(bits: readonly (string | null | undefined)[]): string {
  return bits.filter((bit): bit is string => Boolean(bit && bit.trim().length > 0)).join(" · ");
}

/** The section box: a 32px mono head, its count, and the rows the cap left in. */
export function BriefSection({
  testid,
  title,
  count,
  omitted,
  children,
}: {
  testid: string;
  /** Uppercase label, e.g. `SHIPPED`. */
  title: string;
  /** Rows the brief holds for this section (the head's `· N`). */
  count: number;
  /** Rows the window cap cut (ADR-0081 § Caps): `and N more` on the right. */
  omitted: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section
      data-testid={testid}
      className="overflow-hidden rounded-[4px] border border-line bg-surface"
    >
      <h2 className="flex h-[32px] items-center gap-[8px] border-b border-line px-[10px] font-mono text-[10.5px] font-semibold tracking-[.06em] text-ink-2 uppercase">
        <span className="min-w-0 truncate whitespace-nowrap">
          {title} · {count}
        </span>
        {omitted > 0 ? (
          <span className="ml-auto shrink-0 font-normal text-faint normal-case">
            and {omitted} more
          </span>
        ) : null}
      </h2>
      <div>{children}</div>
    </section>
  );
}

/** The 34px row shell: an `<a>`-shaped link when the row names a destination. */
export function BriefRow({
  testid,
  link,
  children,
}: {
  testid: string;
  /** The in-app page this row opens; empty or absent renders a plain row. */
  link?: string;
  children: ReactNode;
}) {
  const row = (
    <div
      className="flex min-h-[34px] flex-wrap items-center gap-x-[8px] gap-y-[1px] border-b border-line px-[10px] py-[3px] last:border-b-0 md:h-[34px] md:flex-nowrap md:py-0"
      data-testid={testid}
    >
      {children}
    </div>
  );
  if (!link) return row;
  return (
    <Link
      to={link}
      className="block hover:bg-line-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
    >
      {row}
    </Link>
  );
}

/**
 * The project chip: the 8px colour square and the mono name, as the rest list
 * and the tour cards already draw it.
 *
 * `phoneHidden` is for a SECTION row: under `md` the row has to fit its title,
 * its project and its whole status sentence in 390px, and the square is the one
 * element whose absence hides no fact the row is trying to say (a needs-you row
 * keeps it — that panel is short enough to hold all three).
 */
export function BriefProjectChip({
  project,
  phoneHidden = false,
}: {
  project: ProjectChip;
  phoneHidden?: boolean;
}) {
  return (
    <span
      className={`flex shrink-0 items-center gap-[5px] ${phoneHidden ? "max-md:hidden" : ""}`.trim()}
    >
      <span
        className={projectSquareClasses()}
        style={{ background: projectColor(project.color) }}
        aria-hidden
      />
      <span className="font-mono text-[10.5px] whitespace-nowrap text-muted">{project.name}</span>
    </span>
  );
}

/**
 * The title cell every section row shares: 13px, one line, ellipsised.
 *
 * The title gives way first (it is the only cell with an ellipsis), and the meta
 * line takes a row of its own under `md` — see `BriefRowMeta`.
 */
export function BriefRowTitle({ children }: { children: ReactNode }) {
  return <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{children}</span>;
}

/**
 * The meta cell: mono 11px, quiet, right of the title.
 *
 * At desktop it is `shrink-0` — the title is the thing that gives way. Under
 * `md` it takes its OWN line (`basis-full`): a 390px row cannot hold a title, a
 * project and the sentence `3 failures · test · still failing`, and that
 * sentence — still true, or fixed when — is the fact the section exists to say.
 * It is never ellipsised away, and never clipped by the panel's
 * `overflow-hidden` either.
 */
export function BriefRowMeta({ children, testid }: { children: ReactNode; testid?: string }) {
  return (
    <span
      data-testid={testid}
      className="max-md:basis-full font-mono text-[11px] whitespace-nowrap text-faint md:shrink-0"
    >
      {children}
    </span>
  );
}

/** A row's stable test handle from the destination it names (a link has no
 * spaces, a title has too many). */
export function briefRowKey(prefix: string, link: string): string {
  return `${prefix}-${link.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

/** `3m` / `2h` / `3d` — the age a row prints, in the one unit it reads at. */
export function shortAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.max(0, Math.floor((now.getTime() - then) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/* ------------------------------------------------------------- section rows */

/** RUNNING NOW: `step implement · 6m` — an empty step is "queued", never a
 * step the UI guessed (ADR-0081 § running_now). */
export function BriefRunningRow({ row, now }: { row: CatchUpBriefRunning; now?: Date }) {
  const step = row.step.trim().length > 0 ? `step ${row.step}` : "queued";
  return (
    <BriefRow testid={`catchup-brief-running-${row.run_id}`} link={row.link}>
      <BriefRowTitle>{row.title}</BriefRowTitle>
      <BriefProjectChip project={row.project} />
      <BriefRowMeta>{metaBits([step, shortAge(row.started_at, now)])}</BriefRowMeta>
    </BriefRow>
  );
}

/** The shipped row's ref label: `PR #412`, `commit abc1234`, or the revision's
 * own word — a workflow revision has no ref, its identity IS its title. */
export function shippedRefLabel(row: CatchUpBriefShipped): string {
  if (row.kind === "pr") return `PR #${row.ref.number ?? "?"}`;
  if (row.kind === "commit") return `commit ${(row.ref.sha ?? "?").slice(0, 7)}`;
  return "workflow";
}

/**
 * SHIPPED: kind chip + ref + `by ravi · 9m`.
 *
 * A PR row says OPENED, never merged: the ref is labelled data harvested from
 * the run's own outputs, not reconciled state, and nothing in this deployment
 * has spoken to GitHub (ADR-0081 § shipped).
 */
export function BriefShippedRow({ row, now }: { row: CatchUpBriefShipped; now?: Date }) {
  const pr = row.kind === "pr";
  const commit = row.kind === "commit";
  // "opened" is the PR row's own verb — a commit and a published revision claim
  // nothing about a review, so they carry no verb at all. The actor is drawn
  // only when one is named: a scheduled run has no human behind it.
  const actor = row.by.length > 0 ? `${pr ? "opened by" : "by"} ${row.by}` : pr ? "opened" : null;
  return (
    <BriefRow testid={briefRowKey("catchup-brief-shipped", row.link)} link={row.link}>
      <span className="flex shrink-0 items-center gap-[4px] font-mono text-[10.5px] whitespace-nowrap text-ink-2">
        {pr ? (
          <IconGitPullRequest size={12} aria-hidden />
        ) : commit ? (
          <IconGitCommit size={12} aria-hidden />
        ) : null}
        {shippedRefLabel(row)}
      </span>
      <BriefRowTitle>{row.title}</BriefRowTitle>
      <BriefProjectChip project={row.project} />
      <BriefRowMeta>{metaBits([actor, shortAge(row.at, now)])}</BriefRowMeta>
    </BriefRow>
  );
}

/**
 * BROKE & FIXED: the dot says whether it is STILL true (seg-failed) or history
 * (st-done-strong, green) — and the words say it too, because colour never carries meaning
 * alone.
 */
export function BriefBrokeRow({ row, now }: { row: CatchUpBriefBroke; now?: Date }) {
  const when = row.still_failing
    ? "still failing"
    : row.fixed_at
      ? `fixed ${shortAge(row.fixed_at, now)} ago`
      : null;
  return (
    <BriefRow testid={briefRowKey("catchup-brief-broke", row.link)} link={row.link}>
      <span
        className={`h-[8px] w-[8px] shrink-0 rounded-full ${
          row.still_failing ? "bg-seg-failed" : "bg-st-done-strong"
        }`}
        aria-hidden
      />
      <BriefRowTitle>{row.title}</BriefRowTitle>
      <BriefProjectChip project={row.project} />
      <BriefRowMeta>
        {metaBits([
          `${row.failures} ${row.failures === 1 ? "failure" : "failures"}`,
          row.error_class,
          when,
        ])}
      </BriefRowMeta>
    </BriefRow>
  );
}

/** The signal chip: uppercase mono 10px in a line border. */
const SIGNAL_WORD: Record<CatchUpBriefHeadsUp["signal"], string> = {
  migration: "MIGRATION",
  auth: "AUTH",
  deps: "DEPS",
  push_to_main: "PUSH TO MAIN",
  skipped_test: "SKIPPED TEST",
  public_api: "PUBLIC API",
};

export function BriefHeadsUpRow({ row }: { row: CatchUpBriefHeadsUp }) {
  return (
    <BriefRow testid={briefRowKey("catchup-brief-heads-up", row.link)} link={row.link}>
      <span className="shrink-0 rounded-[3px] border border-line px-[5px] py-[1px] font-mono text-[10px] whitespace-nowrap text-ink-2">
        {SIGNAL_WORD[row.signal] ?? row.signal}
      </span>
      <BriefRowTitle>{row.title}</BriefRowTitle>
      <BriefProjectChip project={row.project} />
    </BriefRow>
  );
}

/** The verb a CHANGES row leads with — what the row actually records. */
const CHANGE_WORD: Record<CatchUpBriefChange["kind"], string> = {
  workflow_published: "Published",
  profile_created: "Created",
  profile_updated: "Updated",
  member_added: "Added",
};

/** CHANGES: `Published "Issue to draft PR v3" · ravi · 25m` — the actor is
 * omitted when the row records none (a membership has no inviter). */
export function BriefChangeRow({ row, now }: { row: CatchUpBriefChange; now?: Date }) {
  return (
    <BriefRow testid={briefRowKey("catchup-brief-change", row.link)} link={row.link}>
      <BriefRowTitle>
        <span className="text-ink-2">{CHANGE_WORD[row.kind] ?? row.kind}</span>{" "}
        <span className="text-ink">&quot;{row.title}&quot;</span>
      </BriefRowTitle>
      <BriefRowMeta>
        {metaBits([row.by.length > 0 ? row.by : null, shortAge(row.at, now)])}
      </BriefRowMeta>
    </BriefRow>
  );
}
