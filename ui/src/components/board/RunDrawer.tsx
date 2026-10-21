/**
 * The board's 440px right-hand run drawer (artboard 3c) — a board card click
 * puts `?run=<id>` on the board URL and this renders over the board.
 *
 * Data is live and run-scoped: `useRun` (status, timestamps, failed_cause),
 * the board's own row (step progress and project name — the cross-project
 * list is where the step states are embedded, so no N+1), the project's
 * approvals (the pending gate's own summary text when waiting — never
 * labelled "written by the model"), the run's journal stream (the latest
 * three events) and, when failed, the root node executions (the retry
 * target). The "Ask about this run…" composer is the one-shot assistant
 * broker (ADR-0034) with the run's route as context; a 503
 * `assistant_not_configured` disables it with that reason, not a fake answer.
 *
 * Accessible-modal contract (the same one the other dialogs keep):
 * `role="dialog"` + `aria-modal`, labelled by its own title, focus trapped
 * while open, Escape / the backdrop / the × all close (the board removes
 * `?run`) and focus returns to the opener card.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { assistantNotConfigured, useAssistantAsk, type AssistantAnswer } from "../../api/assistant";
import { useDecideApproval, useProjectApprovals } from "../../api/approvals";
import { problemOf } from "../../api/client";
import { viewArtifactRefs } from "../../api/m4view";
import { useCreateDraft } from "../../api/pipelines";
import { useRunEvents } from "../../api/runEvents";
import { useRun, useRunNodes, useRetryRun } from "../../api/runs";
import type { EventEnvelope } from "../../api/types";
import { routes } from "../../lib/routes";
import { Button, VARIANT_CLASS } from "../ds/Button";
import { Input } from "../ds/Field";
import { RUN_STATE, STATES, stateOf } from "../ds/states";
import {
  formatAge,
  shortId,
  stepGlyph,
  STEP_SEGMENT_CLASS,
  runTitle,
  type CrossProjectRun,
} from "./columns";

export interface RunDrawerProps {
  /** The run `?run=` names. */
  runId: string;
  /**
   * The board row that opened the drawer, when the board's list holds it:
   * the embedded step states and the project name live there, and the run
   * detail does not repeat them.
   */
  boardRun?: CrossProjectRun;
  /** Close — the board removes `?run` from its URL. */
  onClose: () => void;
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `14:03:22` — the local wall-clock time for an event line. */
function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toTimeString().slice(0, 8);
}

/**
 * The one-line detail an event line may carry: the payload's `status` (or
 * `outcome`, or `reason`) when the frame states one — the event type itself
 * already says what happened, so a line without these is never padded.
 */
function eventDetail(event: EventEnvelope): string {
  const payload = event.payload as Record<string, unknown>;
  for (const key of ["status", "outcome", "reason"]) {
    const value = payload[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return "";
}

export function RunDrawer({ runId, boardRun, onClose }: RunDrawerProps) {
  const run = useRun(runId);
  const projectId = run.data?.project_id ?? boardRun?.project_id ?? "";
  const approvals = useProjectApprovals(projectId);
  const events = useRunEvents(runId, projectId);
  const nodes = useRunNodes(runId);
  const decide = useDecideApproval(projectId);
  const retry = useRetryRun(runId);
  const pipelineId = run.data?.pipeline_id ?? boardRun?.pipeline_id ?? "";
  const createDraft = useCreateDraft(pipelineId);
  const navigate = useNavigate();

  const [confirming, setConfirming] = useState<"approve" | "retry" | "fix" | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [askError, setAskError] = useState<string | null>(null);
  const [assistantUnavailable, setAssistantUnavailable] = useState(false);
  const ask = useAssistantAsk();

  const containerRef = useRef<HTMLElement | null>(null);

  // Focus in and out: the mount is the moment the opener (the clicked board
  // card) still holds focus, so capture it, move focus to the drawer's first
  // control, and hand it back on unmount — the other dialogs' contract.
  useLayoutEffect(() => {
    const opener = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /* ------------------------------------------------------------- derived */

  // Live status: the detail read wins when it has arrived, the board row
  // stands in until it does — the board list refetches on every run frame,
  // so the row is never more than a frame stale.
  const status = run.data?.status ?? boardRun?.status ?? "queued";
  const state = stateOf(RUN_STATE[status]);
  const spec = STATES[state];
  const waiting = state === "waiting";
  const failed = state === "failed";
  const steps = boardRun?.steps ?? [];
  const now = useMemo(() => new Date(), [run.data, boardRun]);

  const pendingApproval = useMemo(
    () =>
      approvals.data?.approvals.find(
        (approval) => approval.run_id === runId && approval.state === "pending",
      ),
    [approvals.data, runId],
  );

  // The retry target: a root-scope failed node execution when the nodes read
  // has arrived; the run's `failed_cause` names the node the engine gave up
  // on when it has not.
  const failedStepKey = useMemo(() => {
    const row = nodes.data?.node_executions.find(
      (node) => node.scope_key === "/" && node.status === "failed",
    );
    if (row) return row.node_instance_key;
    const cause = run.data?.failed_cause;
    if (cause?.startsWith("node_execution_failed:"))
      return cause.slice("node_execution_failed:".length);
    return null;
  }, [nodes.data, run.data]);

  const title = boardRun ? runTitle(boardRun) : `run #${shortId(runId)}`;
  const startedIso = run.data?.started_at ?? boardRun?.started_at ?? null;
  const createdIso = run.data?.created_at ?? boardRun?.created_at ?? "";
  const age = createdIso ? formatAge(startedIso ?? createdIso, now) : "";
  const meta = [`workflow #${shortId(runId)}`];
  if (boardRun?.project_name) meta.push(boardRun.project_name);
  if (age) meta.push(startedIso ? `started ${age}` : `queued ${age}`);

  // “Read the full plan” follows the gate's first artifact reference when it
  // carries an id; otherwise the run itself is the honest destination.
  const planArtifact = pendingApproval
    ? viewArtifactRefs(pendingApproval.artifact_refs)[0]
    : undefined;
  const planHref = planArtifact
    ? `/artifacts/${encodeURIComponent(planArtifact.id)}`
    : routes.run(runId);

  const latestEvents = useMemo(() => events.events.slice(-3).reverse(), [events.events]);

  /* ------------------------------------------------------------- actions */

  const doApprove = () => {
    if (!pendingApproval) return;
    decide.mutate(
      {
        approvalId: pendingApproval.id,
        body: { decision: "approved", version: pendingApproval.version },
      },
      { onSuccess: () => setConfirming(null) },
    );
  };
  const doRetry = () => {
    retry.mutate(failedStepKey ? { node_instance_keys: [failedStepKey] } : {});
  };
  const doFix = () => {
    const revisionId = run.data?.pipeline_revision_id ?? boardRun?.pipeline_revision_id ?? "";
    if (!revisionId || !pipelineId) return;
    createDraft.mutate(
      { from_revision_id: revisionId },
      {
        onSuccess: (draft) => navigate(routes.draft(pipelineId, draft.id)),
      },
    );
  };
  const submitAsk = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = question.trim();
    if (!trimmed || assistantUnavailable) return;
    setAnswer(null);
    setAskError(null);
    ask.mutate(
      { question: trimmed, route: routes.run(runId) },
      {
        onSuccess: (sent) => setAnswer(sent),
        onError: (error) => {
          // 503 assistant_not_configured is a deployment fact, not a
          // failure of the question: the composer says so and stays shut.
          if (assistantNotConfigured(error)) setAssistantUnavailable(true);
          else setAskError(problemOf(error).title ?? "The question could not be answered.");
        },
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close run drawer"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-ink/25"
      />
      <aside
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-label={`run #${shortId(runId)} — ${spec.bar}`}
        data-testid="run-drawer"
        className="absolute top-0 right-0 flex h-full w-full flex-col overflow-y-auto border-l border-line bg-paper md:w-[440px]"
      >
        {/* Header strip in the state colour: glyph + state word, never
            colour alone (rule 06). */}
        <header className={`flex items-center gap-2 px-3 py-2 ${spec.strongBg} ${spec.strongFg}`}>
          <span aria-hidden="true">{spec.glyph}</span>
          <span
            data-testid="run-drawer-state"
            className="font-mono text-[11px] font-semibold tracking-wide"
          >
            {spec.bar}
          </span>
          <button
            type="button"
            data-testid="run-drawer-close"
            aria-label="Close"
            onClick={onClose}
            className="ml-auto rounded-[3px] px-1 text-[13px] font-semibold leading-5"
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">esc to close</span>
          </button>
        </header>

        <div className="border-b border-line px-3 py-2.5">
          <h2
            data-testid="run-drawer-title"
            className="truncate text-[14px] font-semibold text-ink"
          >
            {title}
          </h2>
          <p className="mt-0.5 truncate font-mono text-[10.5px] text-faint">{meta.join(" · ")}</p>
        </div>

        {/* The step strip: one cell per top-level step of the pinned
            revision, coloured by the step's state, each labelled for
            screen readers. */}
        {steps.length > 0 ? (
          <div
            data-testid="run-drawer-steps"
            className="grid gap-[3px] px-3 pt-3"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
          >
            {steps.map((step) => (
              <div
                key={step.node_id}
                data-testid={`run-drawer-step-${step.node_id}`}
                aria-label={`step ${step.node_id}: ${step.state}`}
                title={`${step.node_id} — ${step.state}`}
                className={`flex h-[26px] items-center justify-center rounded-[3px] ${STEP_SEGMENT_CLASS[step.state]}`}
              >
                <span className="text-[11px] font-semibold text-ink">
                  <span aria-hidden="true">{stepGlyph(step.state)}</span>
                  <span className="sr-only">{step.state}</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-3 pt-3 font-mono text-[10.5px] text-faint">
            step progress not available
          </p>
        )}

        {/* The pending gate's own summary when the run waits on it —
            the author-written gate text, labelled as such. */}
        {pendingApproval ? (
          <section className="border-b border-line px-3 py-2.5" data-testid="run-drawer-summary">
            <h3 className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              plan summary <span className="font-normal normal-case">· from the workflow</span>
            </h3>
            <p className="mt-1 whitespace-pre-wrap text-[12.5px] text-ink-2">
              {pendingApproval.summary}
            </p>
            <Link
              to={planHref}
              data-testid="run-drawer-plan-link"
              className="mt-1.5 inline-flex text-[12px] text-accent-text underline decoration-line"
            >
              Read the full plan ›
            </Link>
          </section>
        ) : null}

        {/* The latest three events from the run's journal stream. */}
        <section className="border-b border-line px-3 py-2.5" aria-label="Latest events">
          <h3 className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
            latest events
          </h3>
          {latestEvents.length === 0 ? (
            <p className="mt-1 text-[12px] text-muted">No events for this run yet.</p>
          ) : (
            <ol className="mt-1 flex flex-col gap-1" data-testid="run-drawer-events">
              {latestEvents.map((event) => {
                const detail = eventDetail(event);
                return (
                  <li
                    key={event.global_seq}
                    data-testid="run-drawer-event-item"
                    className="flex flex-wrap items-baseline gap-x-2 text-[12px]"
                  >
                    <time dateTime={event.occurred_at} className="font-mono text-[10px] text-faint">
                      {formatTime(event.occurred_at)}
                    </time>
                    <span className="font-mono text-[11px] text-ink">{event.type}</span>
                    {detail ? (
                      <span className="text-ink-2">
                        <span aria-hidden="true">→ </span>
                        {detail}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {/* Actions by state. Every mutation gets a confirm step; the run
            itself is always one `Open run ›` away. */}
        <section
          className="flex flex-col gap-1.5 border-b border-line px-3 py-2.5"
          data-testid="run-drawer-actions"
        >
          {waiting && confirming === "approve" ? (
            <>
              <p className="text-[12px] text-ink-2">
                Approve this gate? The run continues from where it waited.
              </p>
              <Button
                variant="primary"
                data-testid="run-drawer-approve-confirm"
                disabled={decide.isPending}
                onClick={doApprove}
              >
                {decide.isPending ? "Approving…" : "Approve"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              {decide.error ? (
                <p className="text-[12px] text-failed" data-testid="run-drawer-decide-error">
                  {problemOf(decide.error).title ?? "The decision could not be recorded."}
                </p>
              ) : null}
            </>
          ) : waiting ? (
            <>
              <Button
                variant="primary"
                data-testid="run-drawer-approve"
                disabled={!pendingApproval || decide.isPending}
                onClick={() => setConfirming("approve")}
              >
                Approve
              </Button>
              {!pendingApproval && !approvals.isPending ? (
                <p className="text-[11px] text-muted">
                  No approval is pending — the run is paused; resume it from the run.
                </p>
              ) : null}
            </>
          ) : null}

          {failed && confirming === "retry" ? (
            <>
              <p className="text-[12px] text-ink-2">
                Retry this run from{" "}
                <code className="font-mono">{failedStepKey ?? "the failed step"}</code>? The failed
                work runs again as a new attempt.
              </p>
              <Button
                variant="primary"
                data-testid="run-drawer-retry-confirm"
                disabled={retry.isPending}
                onClick={doRetry}
              >
                {retry.isPending ? "Retrying…" : "Retry"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              {retry.error ? (
                <p className="text-[12px] text-failed" data-testid="run-drawer-retry-error">
                  {problemOf(retry.error).title ?? "The retry could not be requested."}
                </p>
              ) : null}
            </>
          ) : failed ? (
            <>
              <Button
                variant="primary"
                data-testid="run-drawer-retry"
                disabled={retry.isPending}
                onClick={() => setConfirming("retry")}
              >
                Retry from {failedStepKey ?? "the failed step"}
              </Button>
              <Button
                variant="secondary"
                data-testid="run-drawer-fix"
                disabled={!pipelineId || createDraft.isPending}
                onClick={() => setConfirming("fix")}
              >
                Fix the workflow
              </Button>
            </>
          ) : null}

          {failed && confirming === "fix" ? (
            <>
              <p className="text-[12px] text-ink-2">
                Start a new draft from this run's pinned revision? The published workflow stays
                untouched.
              </p>
              <Button
                variant="primary"
                data-testid="run-drawer-fix-confirm"
                disabled={createDraft.isPending}
                onClick={doFix}
              >
                {createDraft.isPending ? "Creating…" : "Create draft"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
              {createDraft.error ? (
                <p className="text-[12px] text-failed" data-testid="run-drawer-fix-error">
                  {problemOf(createDraft.error).title ?? "The draft could not be created."}
                </p>
              ) : null}
            </>
          ) : null}

          <Link
            to={routes.run(runId)}
            data-testid="run-drawer-open-run"
            className={`ds-btn ${VARIANT_CLASS.ghost} inline-flex h-[28px] items-center rounded-[4px] px-3 text-[12px]`}
          >
            Open run ›
          </Link>
        </section>

        {/* “Ask about this run…”: the one-shot assistant broker with the run
            as context. A 503 assistant_not_configured keeps the composer
            disabled with that reason — never a fake answer. */}
        <form onSubmit={submitAsk} className="px-3 py-2.5" data-testid="run-drawer-ask">
          <h3 className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
            ask about this run
          </h3>
          <div className="mt-1.5 flex gap-1.5">
            <Input
              data-testid="run-drawer-ask-input"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask about this run…"
              disabled={assistantUnavailable}
              aria-label="Ask about this run"
              className="min-w-0 flex-1"
            />
            <Button
              variant="primary"
              data-testid="run-drawer-ask-submit"
              disabled={!question.trim() || assistantUnavailable || ask.isPending}
            >
              Ask
            </Button>
          </div>
          {assistantUnavailable ? (
            <p className="mt-1 text-[11px] text-muted" data-testid="run-drawer-ask-unavailable">
              The assistant is not configured on this server (503 assistant_not_configured) —
              questions can't be asked here yet.
            </p>
          ) : null}
          {ask.isPending ? (
            <p className="mt-1 text-[11px] text-muted" data-testid="run-drawer-ask-thinking">
              Thinking…
            </p>
          ) : null}
          {askError ? (
            <p className="mt-1 text-[11px] text-failed" data-testid="run-drawer-ask-error">
              {askError}
            </p>
          ) : null}
          {answer ? (
            <div className="mt-1.5 border-t border-line pt-1.5" data-testid="run-drawer-ask-answer">
              <p className="whitespace-pre-wrap text-[12.5px] text-ink-2">
                {answer.answer_markdown}
              </p>
              {answer.links.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5">
                  {answer.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        to={link.href}
                        className="text-[12px] text-accent-text underline decoration-line"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </form>
      </aside>
    </div>
  );
}
