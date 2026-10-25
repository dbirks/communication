/**
 * "Used in" (design 2a) — the read-only truth of where a library workflow
 * runs: one row per repo pin (ADR-0060 assignment), with the revision it
 * pins, its triggers as sentences, its last run, and a link to the repo page
 * where those triggers are actually edited.
 *
 * There is deliberately no Start-run control and no trigger editing here:
 * a library workflow is a template, and runs and triggers belong to the use
 * (the "Mental model" section of the Workflows Review handoff).
 *
 * The trigger sentences reuse the same assignment/schedule/issue-trigger
 * fan-out `Triggers.tsx` reads (shared query keys, read-only grouping in
 * `pages/workflow/useUsedIn.ts`) and the same Lucide 14px/stroke-2 icons the
 * trigger surfaces use — `GithubIcon` is the rebuilt brand glyph from
 * `TriggerDialog.tsx`, since lucide-react 1.x dropped brand icons.
 */
import { Clock, Play } from "lucide-react";
import { Link } from "react-router";
import { Panel } from "../ds/Panel";
import { problemOf } from "../../api/client";
import { usePatchAssignment, type Schedule } from "../../api/pipelines";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import { RUN_STATE, STATES, stateOf } from "../ds/states";
import { cronInWords } from "../../lib/cronText";
import { formatAge } from "../../lib/format";
import { routes } from "../../lib/routes";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import type { UsedInGroup } from "../../pages/workflow/useUsedIn";
import { GithubIcon } from "./TriggerDialog";

/** What the pipeline's revisions page gives the panel: enough to label a pin
 * with its `r<N>` and to know which revision counts as `latest`. */
export interface UsedInRevision {
  id: string;
  revision_number: number;
  revision_digest: string;
  version_label: string;
  status: string;
}

export interface UsedInPanelProps {
  pipelineId: string;
  groups: UsedInGroup[];
  loading: boolean;
  error: boolean;
  /** The pipeline's revision summaries, newest first (server order). */
  revisions: UsedInRevision[];
  /** The newest PUBLISHED revision — the pin an "Update to rN" moves to. Its
   * uuid arrives separately (the summary route has no id, ADR-0021 § 5). */
  newestPublished: UsedInRevision | null;
  newestPublishedId: string | null;
}

/** The cron's own plain-English reading, de-duplicated against the raw
 * expression (the same rule `Triggers.tsx`'s schedule row applies). */
export function scheduleWords(schedule: Schedule): string {
  const words = cronInWords(schedule.cron_expr).trim();
  const raw = schedule.cron_expr.trim();
  return words === raw ? raw : words;
}

/** One issue trigger in words: `issue labeled plan` / `issue opened`. */
export function issueTriggerWords(trigger: IssueTrigger): string {
  return trigger.event === "labeled" ? "issue labeled" : "issue opened";
}

/** The trigger sentences of one pin: icons + real words, or the honest
 * "started by hand" when the pin's arrived trigger lists hold nothing. A read
 * that failed says so instead of claiming a manual-only use. */
export function TriggerSentences({ group }: { group: UsedInGroup }) {
  const hasAny = group.issueTriggers.length > 0 || group.schedules.length > 0;
  if (!hasAny && group.triggersError) {
    return (
      <span
        className="font-mono text-[11px] text-st-failed-tag-fg"
        data-testid={`used-in-triggers-error-${group.assignment.id}`}
      >
        the trigger reads failed — not counted
      </span>
    );
  }
  if (!hasAny && !group.triggersArrived) {
    return (
      <span
        className="font-mono text-[11px] text-faint"
        data-testid={`used-in-triggers-loading-${group.assignment.id}`}
      >
        checking…
      </span>
    );
  }
  if (!hasAny) {
    return (
      <span
        className="flex items-center gap-[6px] text-[12px] text-muted"
        data-testid={`used-in-manual-${group.assignment.id}`}
      >
        <Play size={14} strokeWidth={2} aria-hidden className="shrink-0 opacity-60" />
        started by hand
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1">
      {group.issueTriggers.map((trigger) => (
        <span
          key={trigger.id}
          className="flex items-center gap-[6px] text-[12px]"
          data-testid={`used-in-issue-${trigger.id}`}
        >
          <GithubIcon size={14} strokeWidth={2} aria-hidden className="shrink-0" />
          {issueTriggerWords(trigger)}
          {trigger.labels.map((label) => (
            <span
              key={label}
              className="rounded-[3px] border border-line bg-fill px-[5px] font-mono text-[11px] font-medium"
            >
              {label}
            </span>
          ))}
          {!trigger.enabled ? <em className="font-mono text-[10.5px] text-faint">paused</em> : null}
        </span>
      ))}
      {group.schedules.map((schedule) => (
        <span
          key={schedule.id}
          className="flex items-center gap-[6px] text-[12px]"
          data-testid={`used-in-schedule-${schedule.id}`}
        >
          <Clock size={14} strokeWidth={2} aria-hidden className="shrink-0" />
          {scheduleWords(schedule)}
          {!schedule.enabled ? (
            <em className="font-mono text-[10.5px] text-faint">paused</em>
          ) : null}
        </span>
      ))}
    </span>
  );
}

/** The `pinned r2 · latest` / `pinned r1` cell — the r-number resolved from
 * the pipeline's own revision summaries by digest, never invented. */
export function pinLabel(
  pinnedDigest: string,
  pinnedVersionLabel: string | null,
  revisions: UsedInRevision[],
  newestPublished: UsedInRevision | null,
): string {
  const row = revisions.find(
    (candidate) => candidate.revision_digest === pinnedDigest || candidate.id === pinnedDigest,
  );
  const number = row
    ? `r${row.revision_number}`
    : (pinnedVersionLabel ?? `@${shortDigest(pinnedDigest)}`);
  const latest = newestPublished !== null && newestPublished.revision_digest === pinnedDigest;
  return latest ? `pinned ${number} · latest` : `pinned ${number}`;
}

/**
 * The `USED IN n REPOS` panel: one row per repo pin, grid
 * `200px 120px 1fr 150px 56px` (stacking to one column below `md`, where the
 * fixed 686px of grid would otherwise scroll the page).
 */
export function UsedInPanel({
  pipelineId,
  groups,
  loading,
  error,
  revisions,
  newestPublished,
  newestPublishedId,
}: UsedInPanelProps) {
  return (
    <section className="space-y-[14px]" data-testid="used-in">
      <Panel title={`USED IN ${groups.length} REPOS`} headingId="used-in-heading" headingLevel={2}>
        {loading && groups.length === 0 ? (
          <p className="p-[10px] font-mono text-[11px] text-muted" data-testid="used-in-loading">
            checking which repos use this workflow…
          </p>
        ) : null}
        {error ? (
          <p
            className="p-[10px] font-mono text-[11px] text-st-failed-tag-fg"
            data-testid="used-in-error"
          >
            The projects could not all be read — this list may be missing a use.
          </p>
        ) : null}
        {groups.length === 0 && !loading && !error ? (
          <p className="p-[10px] text-[12.5px] text-muted" data-testid="used-in-empty">
            Not used in any repo yet — <span className="font-mono">Use in a repo…</span> pins the
            latest published revision, and triggers are set up there.
          </p>
        ) : null}
        <ul className="divide-y divide-line-soft" data-testid="used-in-list">
          {groups.map((group) => (
            <UsedInRow
              key={group.assignment.id}
              pipelineId={pipelineId}
              group={group}
              revisions={revisions}
              newestPublished={newestPublished}
              newestPublishedId={newestPublishedId}
            />
          ))}
        </ul>
      </Panel>
      <p
        className="font-mono text-[10.5px] leading-[16px] text-faint"
        data-testid="used-in-footnote"
      >
        Open › goes to the repo page, where its triggers are edited.
      </p>
    </section>
  );
}

function UsedInRow({
  pipelineId,
  group,
  revisions,
  newestPublished,
  newestPublishedId,
}: {
  pipelineId: string;
  group: UsedInGroup;
  revisions: UsedInRevision[];
  newestPublished: UsedInRevision | null;
  newestPublishedId: string | null;
}) {
  const patch = usePatchAssignment(group.project.id);
  const { assignment } = group;
  const isLatest =
    newestPublished !== null &&
    newestPublished.revision_digest === assignment.pinned_revision_digest;
  const behind = newestPublished !== null && !isLatest && newestPublished.status === "published";
  const lastRun = group.runs[0] ?? null;
  const openHref = assignment.repository_name
    ? routes.repository(group.project.id, assignment.repository_name)
    : routes.projectTab(group.project.id, "pipelines");

  function repin() {
    if (!newestPublishedId) return;
    patch.mutate({
      assignmentId: assignment.id,
      body: { pinned_revision_id: newestPublishedId },
    });
  }

  return (
    <li
      className="grid grid-cols-1 items-center gap-[10px] px-[12px] py-[12px] md:grid-cols-[200px_120px_minmax(0,1fr)_150px_56px] md:gap-[14px]"
      data-testid={`used-in-row-${assignment.id}`}
    >
      <span className="min-w-0">
        <span
          className="block truncate text-[13px] font-semibold"
          data-testid={`used-in-repo-${assignment.id}`}
        >
          {assignment.repository_name ?? "whole project"}
        </span>
        <span
          className="block truncate font-mono text-[10.5px] text-muted"
          data-testid={`used-in-project-${assignment.id}`}
        >
          {group.project.name}
        </span>
      </span>
      <span className="flex flex-col gap-[3px] font-mono text-[10.5px] text-ink-2">
        <span data-testid={`used-in-pin-${assignment.id}`}>
          {pinLabel(
            assignment.pinned_revision_digest,
            assignment.pinned_version_label ?? null,
            revisions,
            newestPublished,
          )}
        </span>
        {behind ? (
          <button
            type="button"
            onClick={repin}
            disabled={!newestPublishedId || patch.isPending}
            className="w-fit text-left text-[12px] font-semibold text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:text-faint"
            data-testid={`used-in-update-${assignment.id}`}
            title="Re-pin this use to the newest published revision — effective for new runs only"
          >
            {patch.isPending ? "updating…" : `Update to r${newestPublished?.revision_number ?? ""}`}
          </button>
        ) : null}
        {patch.isError ? (
          <span
            className="font-mono text-[10.5px] text-st-failed-tag-fg"
            data-testid={`used-in-update-error-${assignment.id}`}
          >
            {problemOf(patch.error).detail || problemOf(patch.error).title}
          </span>
        ) : null}
      </span>
      <span className="min-w-0" data-testid={`used-in-triggers-${assignment.id}`}>
        <TriggerSentences group={group} />
      </span>
      <span className="font-mono text-[10.5px]">
        {lastRun ? (
          <LastRunCell run={lastRun} />
        ) : (
          <span className="text-faint" data-testid={`used-in-last-run-${assignment.id}`}>
            no runs yet
          </span>
        )}
      </span>
      <Link
        to={openHref}
        className="text-right text-[12.5px] font-semibold text-accent-text hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        data-testid={`used-in-open-${assignment.id}`}
      >
        Open ›
      </Link>
      <span className="sr-only">{`workflow ${pipelineId}`}</span>
    </li>
  );
}

/** Last run: state glyph + word, the run's short id, its age — in the state's
 * own colour pair (glyph and word always travel together, identity rule 06). */
export function LastRunCell({ run }: { run: { id: string; status: string; created_at: string } }) {
  const state = stateOf(RUN_STATE[run.status] ?? "queued");
  const spec = STATES[state];
  return (
    <Link
      to={routes.run(run.id)}
      className="flex items-center gap-[4px] hover:underline"
      data-testid={`used-in-last-run-${run.id.slice(-8)}`}
    >
      <span aria-hidden className={spec.tagFg}>
        {spec.glyph}
      </span>
      <span className="truncate text-ink-2">
        {`#${run.id.slice(-4)} ${spec.word} · ${formatAge(run.created_at)}`}
      </span>
    </Link>
  );
}
