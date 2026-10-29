/**
 * The Run Workbench header (ADR-0043, design §6; gap U1/U5): project
 * breadcrumb, the run's goal (the run's own `inputs` when the API serves
 * them, else the pipeline's slug and short id), the status chip, the meta
 * line `<workflow> #<short run id> · <repo> · revision r<n> <digest>
 * (pinned) · started <age>[ by <name>]`, the header verbs (Open pinned
 * workflow / Fix the workflow…) and the reused Pause/Resume/Cancel/Retry
 * actions. The "a newer revision was published" notice rides right under it,
 * worded exactly as the inspector always worded it.
 *
 * Honesty in the meta line: `<repo>` is the project's repository only when
 * there is exactly one (several repositories make the run's own data
 * ambiguous, so the segment is omitted); `by <name>` appears only when a
 * `run.created` / `run.started` frame in the journal buffer names the actor
 * (never a worker name — ADR-0016 § 8).
 *
 * Width honesty: the title/meta column is `grow` with a 20rem flex-basis FLOOR,
 * not `flex-1`'s zero basis, and the header wraps. A zero basis makes that
 * column whatever the actions column leaves, so its width was a property of
 * the buttons, not of the page: a completed run at 1280 with the `Retry` reason
 * sentence showing measured 930px of actions out of 1008px, which left the
 * title and the whole meta line a 66px column. The floor is the point where
 * the two columns stop fitting side by side (292px of verbs + actions observed
 * at 1280, 930px with the reason sentence): below it the actions column drops
 * to its own line, and `justify-end` keeps it against the right edge exactly
 * where it sat when it shared the line — so a run whose header already fits
 * renders pixel-identically at 390 and 1280, and one that did not gets its meta
 * line back at full width. The title's own length never enters into it: the
 * half-empty title case (a run that serves no `goal` at all) is the fallback
 * below, not a narrower column.
 *
 * The digest in that line is `shortDigest`'s full 12 hex chars — the same
 * spelling the runs list, the newer-revision notice and the diagnostics pin
 * all print. `docs/m4-contract.md` § 7.2 row W4 is the reason: the run page
 * owes the reader *the pinned digest it started with*, and a 6-char prefix
 * printed with no ellipsis is a truncated fact presented as a whole one — the
 * reader cannot compare it against the library's digests, which is exactly
 * what case 11 ("a library edit cannot reach the run") asks them to do.
 */
import { useState } from "react";
import { Alert } from "../ds/Alert";
import { Button } from "../ds/Button";
import { ProblemBanner, Spinner } from "../Feedback";
import { useMe, useProject } from "../../api/queries";
import { useCreateDraft } from "../../api/pipelines";
import { problemOf } from "../../api/client";
import { hasLibraryRole } from "../../lib/pipeline/authoring";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import { formatAge, shortId } from "../../lib/format";
import { RunActions } from "../../pages/RunInspector";
import { RunStatusChip } from "../../pages/ProjectRuns";
import type { NodeExecutionSummary, RunDetail } from "../../lib/pipeline/contract";
import { Link, useNavigate } from "react-router";
import { routes } from "../../lib/routes";

export interface RunHeaderProps {
  projectId: string;
  run: RunDetail;
  /** The run's `goal` input, from the raw run row — null when the API serves
   * no inputs or the run was started without one. */
  goal: string | null;
  /** The run's own served title (`RunSummary.title`, ADR-0064) — null exactly
   * when the run was never named, which is the case that must not leave the
   * header with no title at all. */
  runTitle: string | null;
  /** The pipeline's slug (the honest title half when no goal is served). */
  slug: string;
  streamStatus: string;
  /** The pinned revision's number + digest, or null while the read is in
   * flight (the digest is always on the run itself). */
  revision: { revision_number: number; revision_digest: string } | null;
  nodes: readonly NodeExecutionSummary[];
  /** The project's repository name, or null when the project holds several
   * (or none) and the run's data does not say which one it ran in. */
  repoName: string | null;
  /** The actor of the run's `run.created` / `run.started` frame, in words —
   * null when the journal buffer the page holds has no such frame. */
  startedBy: string | null;
}

export function RunHeader({
  projectId,
  run,
  goal,
  runTitle,
  slug,
  streamStatus,
  revision,
  nodes,
  repoName,
  startedBy,
}: RunHeaderProps) {
  const project = useProject(projectId);
  const me = useMe();
  const navigate = useNavigate();
  // The one role rule, in the one place the UI states it: only an org admin
  // (the library role) starts a draft from a revision.
  const canAuthor = hasLibraryRole(me.data);
  const createDraft = useCreateDraft(run.pipeline_id);
  const [draftError, setDraftError] = useState<string | null>(null);

  const startDraftFromRevision = () => {
    setDraftError(null);
    createDraft.mutate(
      { from_revision_id: run.pipeline_revision_id },
      {
        onSuccess: (draft) => navigate(routes.draft(run.pipeline_id, draft.id)),
        onError: (error: unknown) => setDraftError(problemOf(error).title),
      },
    );
  };

  return (
    <header className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-b border-line pb-3">
      <div className="min-w-0 grow basis-[20rem]" data-testid="run-header-title">
        <nav
          aria-label="Breadcrumb"
          data-testid="run-breadcrumb"
          className="flex items-center gap-[6px] font-mono text-[11px] text-muted"
        >
          <Link
            to={routes.project(projectId)}
            className="underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {project.data?.name ?? projectId}
          </Link>
          <span aria-hidden>/</span>
          <Link
            to={routes.projectTab(projectId, "runs")}
            className="underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Runs
          </Link>
          <span aria-hidden>/</span>
          <span className="text-ink-2">run</span>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-[19px] font-bold" data-testid="run-title">
            {goal ? `“${goal}”` : (runTitle ?? `Run #${shortId(run.id)}`)}
          </h1>
          <RunStatusChip status={run.status} testid="run-header-status" />
          <span className="font-mono text-[11px] text-faint" data-testid="run-stream-status">
            {streamStatus}
          </span>
        </div>
        <p className="min-w-0 font-mono text-[11px] text-muted" data-testid="run-header-meta">
          {slug} #{shortId(run.id)}
          {repoName ? <> · {repoName}</> : null} · revision{" "}
          <Link
            to={routes.workflow(run.pipeline_id)}
            data-testid="run-pinned-revision"
            className="underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            {revision
              ? `r${revision.revision_number} ${shortDigest(revision.revision_digest)}`
              : shortDigest(run.revision_digest)}
          </Link>{" "}
          (pinned) · started {formatAge(run.started_at ?? run.created_at)}
          {startedBy ? <> by {startedBy}</> : null}
        </p>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link
            to={routes.workflow(run.pipeline_id)}
            data-testid="run-open-workflow"
            className="rounded-[3px] border border-line px-2.5 py-[5px] text-[12px] font-semibold text-ink hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Open pinned workflow
          </Link>
          {canAuthor ? (
            <Button
              variant="secondary"
              disabled={createDraft.isPending}
              data-testid="run-new-draft"
              onClick={startDraftFromRevision}
            >
              {createDraft.isPending ? "Starting draft…" : "Fix the workflow…"}
            </Button>
          ) : null}
        </div>
        {draftError ? (
          <p
            role="alert"
            className="font-mono text-[11px] text-st-failed-pale-fg"
            data-testid="run-draft-error"
          >
            New draft: {draftError}
          </p>
        ) : null}
        <RunActions runId={run.id} status={run.status} nodes={nodes} />
      </div>
    </header>
  );
}

/** The notice body, lifted so the workbench header and the embedded
 * diagnostics tab word the same sentence identically.
 *
 * Width honesty (390 reflow): the chip is NOT Alert's `action` slot — that
 * row pins the action `shrink-0` beside a zero-basis text column, so at a
 * phone's ~338px body a ~230px chip left the sentence a ~101px box reading
 * one word per line. Inside the body it is a wrapping flex row instead: the
 * text carries a 20rem flex-basis FLOOR, so the pair sits side by side
 * whenever both fit (pixel-identical to the old layout at 1280), and below
 * that floor + chip the chip drops to its own line and the text keeps the
 * full width — where `max-w-full` caps the chip at the body box so its own
 * long mono slug wraps inside it instead of hanging past the border (a
 * 390px viewport with the 354px `feature-development-deterministic in the
 * library` chip measured exactly that bleed). Stacking is never wrong;
 * one word per line is. */
export function NewRevisionNotice({
  notice,
  slug,
  pipelineId,
  revisionDigest,
}: {
  notice: { newest: number; pinned: number };
  slug: string;
  pipelineId: string;
  revisionDigest: string;
}) {
  return (
    <div className="pt-3">
      <Alert state="info" label="NEW REVISION PUBLISHED" testid="run-new-revision-notice">
        <div className="flex flex-wrap items-center gap-[10px]">
          <span className="min-w-0 flex-1 basis-[20rem] text-[12.5px]">
            revision {notice.newest} published since this run started — this run is pinned to{" "}
            {notice.pinned} ({shortDigest(revisionDigest)}). The run stays on the revision it
            started with.
          </span>
          <Link
            to={routes.workflow(pipelineId)}
            className="max-w-full shrink-0 rounded-[3px] border border-line px-2 py-[3px] font-mono text-[11px] text-ink-2 underline-offset-2 hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="run-new-revision-link"
          >
            {slug} in the library
          </Link>
        </div>
      </Alert>
    </div>
  );
}

/** The header's 404 / error / loading answers — the honest ones: a run the
 * reader cannot see renders a 404, not an empty workbench. */
export function RunHeaderLoading({
  runError,
  nodesError,
  pending,
  runId,
}: {
  runError: unknown;
  nodesError: unknown;
  pending: boolean;
  runId: string;
}) {
  if (runError) {
    const problem = problemOf(runError);
    if (problem.status === 404) {
      return (
        <div className="px-4 py-6" data-testid="run-not-found">
          <Alert state="info" label="NOT FOUND" barTone="neutral" role="status">
            Run <code className="font-mono">{runId}</code> is not visible to you, or does not exist.
            The control plane answered 404 — this page shows no scaffold for a run it cannot see.
          </Alert>
        </div>
      );
    }
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={runError} fallback="This run could not be loaded." />
      </div>
    );
  }
  if (nodesError) {
    return (
      <div className="px-4 py-6">
        <ProblemBanner error={nodesError} fallback="Node executions could not be loaded." />
      </div>
    );
  }
  if (pending) {
    return (
      <div className="px-4 py-6">
        <Spinner label="Loading run" />
      </div>
    );
  }
  return null;
}
