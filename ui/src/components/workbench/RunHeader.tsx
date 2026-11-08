/**
 * The Run Workbench header (ADR-0043, design §6; gap U1/U5; redesign finding
 * 11): three rows, not one crowded line.
 *
 * - **Row 1 — where this run lives**: `{project} › Runs`. Both crumbs are
 *   routes (`lib/routes.ts`), so the reader can back out without the browser's
 *   back button. The run's own handle is not a crumb: it rides the title's
 *   `title` and the URL, where an internal id belongs.
 * - **Row 2 — what this run is and what to do about it**: the run's sentence
 *   (the 22px title), the state chip, and on the right ONE primary action
 *   chosen by the run's state — a waiting run gets Review plan, a failed run
 *   gets Retry step, a running run gets Pause. Everything else (Open pinned
 *   workflow, Fix the workflow…, and the remaining run verbs) rides the `⋯`
 *   menu, which is the ds `Menu` primitive, so Esc, click-away and ↑/↓/Enter
 *   behave like every other menu in the app. A header that says which button
 *   matters for this run is the whole point of the finding: up to five
 *   equal-weight buttons said nothing about which one the run was waiting on.
 * - **Row 3 — the labeled facts row**: the sentence the old header packed into
 *   one 11px mono line, split into four labelled facts: Workflow (name +
 *   `rev {n}` → the pinned revision), Repository, Started, Pinned digest. A
 *   label over a value is scannable; a ` · `-joined sentence is not.
 *
 * Stream status is a fact about the page's own liveness, not about the run, so
 * it is silent while the stream is live and speaks only when it is not
 * (`↻ reconnecting`, with the retrying state's glyph from `ds/states`).
 *
 * Honesty, unchanged by the redesign: `<repo>` is the project's repository only
 * when there is exactly one (several repositories make the run's own data
 * ambiguous, so the fact is left out rather than guessed); `by <name>` appears
 * only when a `run.created` / `run.started` frame in the journal buffer names
 * the actor (never a worker name — ADR-0016 § 8); the pin is the run's own
 * digest, and the revision NUMBER only rides the link once the revision read
 * can name it — never a guessed `r1`; and the digest is `shortDigest`'s full 12
 * hex chars, the same spelling the runs list, the newer-revision notice and the
 * diagnostics pin print (`docs/m4-contract.md` § 7.2 row W4: the reader has to
 * be able to compare it against the library's digests).
 *
 * The title is the run's own sentence, spoken once and unframed: no typographic
 * quotes around the goal (the h1 is already the page's only title), and it
 * WRAPS at every breakpoint — no `truncate`/`whitespace-nowrap` anywhere, with
 * `wrap-anywhere` keeping a long unbroken slug inside the box at a phone's 390.
 * The status chip is `RunStateChip`, the app's `SHORT_WORD` table, so the header
 * says **need you** where the wire says `waiting_human`.
 *
 * Width honesty: the header stacks its rows and each row wraps at the right
 * edge, so no fact's width is a property of a button's. The title column still
 * carries a 20rem flex-basis FLOOR (not `flex-1`'s zero basis) inside row 2:
 * below that floor the action column drops to its own line and `justify-end`
 * keeps it against the right edge where it already sat.
 *
 * The verbs themselves are not this file's business: `useRunActionsModel`
 * (`pages/RunInspector.tsx`) owns the four run writes, their refusals and the
 * retriability rule, and the `⋯` menu and the inspector's own header both read
 * it. The stable test ids (`run-pause`, `run-cancel`, `run-resume`, `run-retry`,
 * `run-retry-reason`, `run-action-error`) travel with the verbs, not the layout.
 */
import { useRef, useState, type ReactNode } from "react";
import { Alert } from "../ds/Alert";
import { Button, VARIANT_CLASS } from "../ds/Button";
import { Menu, MENU_ITEM_CLASS } from "../ds/Menu";
import { ProblemBanner, Spinner } from "../Feedback";
import { RunNotFound } from "./RunNotFound";
import { useMe, useProject } from "../../api/queries";
import { useCreateDraft } from "../../api/pipelines";
import { problemOf } from "../../api/client";
import { hasLibraryRole } from "../../lib/pipeline/authoring";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import { formatAge, shortId } from "../../lib/format";
import { RUN_STATE, STATES, STREAM_STATE, stateOf } from "../ds/states";
import { RunStateChip } from "../../pages/ProjectRuns";
import { useRunActionsModel } from "../../pages/RunInspector";
import {
  attentionNode,
  parseWorkbenchUrl,
  workbenchSearch,
  type ScopeSelection,
} from "../../lib/pipeline/workbench";
import type { NodeExecutionSummary, RunDetail } from "../../lib/pipeline/contract";
import { Link, useLocation, useNavigate } from "react-router";
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

/** One fact of row 3: the label over the value, never a joined sentence. */
function Fact({
  label,
  testid,
  mono = false,
  children,
}: {
  label: string;
  testid: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0" data-testid={`run-fact-${testid}`}>
      <dt className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted">
        {label}
      </dt>
      <dd className={`mt-[2px] text-[13px] text-ink-2 ${mono ? "font-mono text-[12.5px]" : ""}`}>
        {children}
      </dd>
    </div>
  );
}

/**
 * The selection the `Review plan` affordance asks for: the gate's own node and
 * instance, with the scope indexes that show it, written onto the page's
 * current URL. The workbench's selection IS its query string (ADR-0043
 * decision 6), so a link is the whole wiring — the dock opens on the gate card
 * exactly as it does when the reader clicks the box, and this file issues no
 * request of its own. `view=artifacts` is the page's own vocabulary and rides
 * through, as every other selection rewrite carries it.
 */
function selectionHref(
  search: string,
  pick: { definitionNodeId: string; executionId: string; selection: ScopeSelection },
): string {
  const current = new URLSearchParams(search);
  const state = parseWorkbenchUrl(current);
  state.node = pick.definitionNodeId;
  state.instance = pick.executionId;
  state.attempt = null;
  Object.assign(state.scopes, pick.selection);
  const next = new URLSearchParams(current);
  for (const key of ["node", "instance", "attempt", "view", "scope"]) next.delete(key);
  if (current.get("view") === "artifacts") next.set("view", "artifacts");
  const query = workbenchSearch(state);
  if (query !== "") {
    for (const [key, value] of new URLSearchParams(query)) next.set(key, value);
  }
  const query2 = next.toString();
  return query2 === "" ? "" : `?${query2}`;
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
  const location = useLocation();
  // The one role rule, in the one place the UI states it: only an org admin
  // (the library role) starts a draft from a revision.
  const canAuthor = hasLibraryRole(me.data);
  const createDraft = useCreateDraft(run.pipeline_id);
  // `formatAge` returns a bare age ("14s", "3m", "2h") or "unknown". In the
  // fact the age needs its "ago" ("14s ago by the system"); "unknown" is
  // already the whole honest answer, so it stands alone.
  const startedAge = formatAge(run.started_at ?? run.created_at);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const actions = useRunActionsModel(run.id, run.status, nodes);

  // The gate this run is waiting on, by the app's own attention rule: the
  // node whose card answers it. `Review plan` selects it (the dock then holds
  // the approval card with Approve/Reject), which is where the review
  // affordance has always lived — the header does not decide the gate.
  const gatePick = attentionNode([...nodes]);
  const gateRow = gatePick ? nodes.find((node) => node.id === gatePick.executionId) : undefined;
  const awaitingReview =
    run.status === "waiting_human" &&
    gatePick !== null &&
    gateRow !== undefined &&
    gateRow.status === "waiting" &&
    (gateRow.kind === "human.approval" || gateRow.waiting_reason === "approval");

  const retryVerb = actions.verbs.find((verb) => verb.id === "retry") ?? null;
  const pauseVerb = actions.verbs.find((verb) => verb.id === "pause") ?? null;
  // One primary, chosen by the run's own state (finding 11). `preparing` reads
  // as running in the state table, so it gets the running run's verb; `paused`
  // gets no primary at all — its verb (Resume) is in the menu, and a primary
  // that answers 409 (pausing a paused run, retrying a run with no target) is
  // not a verb.
  const runState = stateOf(RUN_STATE[run.status]);
  const primaryVerb =
    run.status === "failed" ? retryVerb : runState === "running" ? pauseVerb : null;
  const menuVerbs =
    awaitingReview || primaryVerb === null
      ? actions.verbs
      : actions.verbs.filter((verb) => verb.id !== primaryVerb.id);
  const digest = shortDigest(revision?.revision_digest ?? run.revision_digest);

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
  const closeMenu = () => {
    setMenuOpen(false);
    menuRef.current?.focus();
  };

  return (
    <header className="flex flex-col gap-2 border-b border-line pb-3">
      {/* Row 1 — the way back. */}
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
        <span aria-hidden>›</span>
        <Link
          to={routes.projectTab(projectId, "runs")}
          className="underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        >
          Runs
        </Link>
      </nav>

      {/* Row 2 — the run's sentence, its state, and the one verb that matters. */}
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <div
          className="flex min-w-0 grow basis-[20rem] flex-wrap items-center gap-2"
          data-testid="run-header-title"
        >
          {/* The run's own title is NEVER the thing that gives way: the e2e
              contract is `scrollWidth - clientWidth <= 0` at every width, so it
              WRAPS (acceptance 46, run-gate-waiting at 1280 and at 390). The
              `title` attribute still carries the whole sentence plus the short
              id handle, which round-2 review item 3 keeps out of the visible
              copy. */}
          <h1
            className="min-w-0 wrap-anywhere text-[22px] leading-[28px] font-bold"
            title={`${goal ?? runTitle ?? `Run #${shortId(run.id)}`} · run ${shortId(run.id)}`}
            data-testid="run-title"
          >
            {goal ?? runTitle ?? `Run #${shortId(run.id)}`}
          </h1>
          <RunStateChip status={run.status} testid="run-header-status" />
          {streamStatus === "live" ? null : (
            /* Liveness is a fact about this page, not the run: it stays quiet
               while the stream is live and says so, with the retrying glyph,
               the moment it is not. */
            <span className="font-mono text-[11px] text-faint" data-testid="run-stream-status">
              {STATES[stateOf(STREAM_STATE[streamStatus])].glyph} {streamStatus}
            </span>
          )}
        </div>

        <div className="flex min-w-0 items-center gap-2" data-testid="run-header-actions">
          {awaitingReview && gatePick ? (
            <Link
              to={`${location.pathname}${selectionHref(location.search, gatePick)}`}
              data-testid="run-review-plan"
              data-primary="true"
              className={`ds-btn ${VARIANT_CLASS.primary}`}
            >
              Review plan
            </Link>
          ) : primaryVerb ? (
            <Button
              variant="primary"
              data-primary="true"
              disabled={primaryVerb.disabled}
              title={primaryVerb.title}
              data-testid={primaryVerb.testid}
              onClick={() => primaryVerb.onSelect()}
            >
              {primaryVerb.id === "retry" && primaryVerb.label === "Retry"
                ? "Retry step"
                : primaryVerb.label}
            </Button>
          ) : null}

          <div className="relative">
            {/* A plain button (not the ds `Button`): the menu holds the ref
                Escape returns focus to. Same BTN-I secondary box as every
                other `⋯` trigger in the app. */}
            <button
              ref={menuRef}
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label="More run actions"
              data-testid="run-more-actions"
              className={`ds-btn ${VARIANT_CLASS.secondary} ds-btn--compact icon-hit relative`}
              onClick={() => setMenuOpen((current) => !current)}
            >
              ⋯
            </button>
            <Menu
              open={menuOpen}
              onClose={() => setMenuOpen(false)}
              triggerRef={menuRef}
              data-testid="run-more-menu"
              ariaLabel="More run actions"
              side="bottom"
              align="end"
              width={210}
            >
              {/* Items are drawn here, not passed as `items`, so every e2e id
                  stays a literal `data-testid` attribute — the guard script
                  never follows a string through a prop. */}
              <Link
                to={routes.workflow(run.pipeline_id)}
                role="menuitem"
                className={MENU_ITEM_CLASS}
                data-testid="run-open-workflow"
                onClick={closeMenu}
              >
                Open pinned workflow
              </Link>
              {canAuthor ? (
                <button
                  type="button"
                  role="menuitem"
                  disabled={createDraft.isPending}
                  className={MENU_ITEM_CLASS}
                  data-testid="run-new-draft"
                  onClick={() => {
                    closeMenu();
                    startDraftFromRevision();
                  }}
                >
                  {createDraft.isPending ? "Starting draft…" : "Fix the workflow…"}
                </button>
              ) : null}
              {menuVerbs.length > 0 ? <div role="separator" className="my-1 h-px bg-line" /> : null}
              {menuVerbs.map((verb) => (
                <button
                  key={verb.id}
                  type="button"
                  role="menuitem"
                  disabled={verb.disabled}
                  title={verb.title}
                  className={MENU_ITEM_CLASS}
                  data-testid={verb.testid}
                  onClick={() => {
                    closeMenu();
                    verb.onSelect();
                  }}
                >
                  {verb.label}
                </button>
              ))}
            </Menu>
          </div>
        </div>
      </div>

      {/* The two sentences the verbs can produce. They ride under the action
          column's own line, so neither one is ever measured before the wrap
          decision the way the old ~930px Retry explainer was. */}
      {actions.note || actions.conflict || draftError ? (
        <div className="flex flex-col items-end gap-1">
          {draftError ? (
            <p
              role="alert"
              className="font-mono text-[11px] text-st-failed-pale-fg"
              data-testid="run-draft-error"
            >
              New draft: {draftError}
            </p>
          ) : null}
          {actions.conflict ? (
            <p className="font-mono text-[11px] text-failed" data-testid="run-action-error">
              {actions.conflict}
            </p>
          ) : null}
          {actions.note ? (
            <p
              className="font-mono text-[10.5px] text-faint"
              title={actions.note.reason}
              data-testid="run-retry-reason"
            >
              — {actions.note.short}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Row 3 — the facts the old meta line spelled as one sentence. */}
      <dl
        className="flex flex-wrap gap-x-7 gap-y-2 border-t border-line pt-2"
        data-testid="run-header-meta"
        title={`run ${shortId(run.id)}`}
      >
        <Fact label="Workflow" testid="workflow">
          {slug}
          {revision ? (
            <>
              {" · "}
              <Link
                to={routes.workflow(run.pipeline_id)}
                data-testid="run-pinned-revision"
                className="underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                rev {revision.revision_number}
              </Link>
            </>
          ) : null}
        </Fact>
        {repoName ? (
          <Fact label="Repository" testid="repository" mono>
            {repoName}
          </Fact>
        ) : null}
        <Fact label="Started" testid="started">
          {startedAge === "unknown" ? "unknown" : `${startedAge} ago`}
          {startedBy ? <> by {startedBy}</> : null}
        </Fact>
        <Fact label="Pinned digest" testid="digest" mono>
          {digest}
        </Fact>
      </dl>
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
  projectId,
}: {
  runError: unknown;
  nodesError: unknown;
  pending: boolean;
  runId: string;
  /** A project-scoped run page knows where its runs tab and members page are;
   * the project-less deep link cannot — a 404 means no project resolved. */
  projectId?: string;
}) {
  if (runError) {
    const problem = problemOf(runError);
    if (problem.status === 404) return <RunNotFound runId={runId} projectId={projectId} />;
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
