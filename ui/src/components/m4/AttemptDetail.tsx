/**
 * Attempt detail: one try at one node execution, and — the part a UI gets
 * wrong most often — *what the next attempt inherits*.
 *
 * The wording rules come from `communication-spec/10-ui-design-handoff.md` J7
 * and `docs/m4-contract.md` § 7.2 W5/W6: an interrupted attempt is "the worker
 * disappeared mid-node, outcome unknown", never "resumed", "restored" or "no
 * data lost"; a `workspace_lost` attempt says the edits are gone and offers no
 * automatic retry. `retry_context.mode` is the server's own answer
 * (ADR-0023 § 6) and each mode has fixed copy below, including the degraded
 * `resume_if_supported → new` case, which is stated rather than smoothed over.
 *
 * What a retry inherits is the **checkpoint**, so the boundary record is shown
 * beside the attempt rather than described: `repo_states` commits, digests, the
 * modified-paths artifact, and the volume id. Paths are never shown because the
 * API never serves them (route 27).
 */
import type {
  AttemptDetail as Attempt,
  NodeExecutionSummary,
  RunCheckpoint,
  RunEvent,
} from "../../lib/pipeline/contract";
import { Panel } from "../ds/Panel";
import { StatusChip } from "../ds/Row";
import { Alert } from "../ds/Alert";
import { ATTEMPT_STATE, stateOf } from "../ds/states";
import { formatTime, shortCommit, shortId } from "../../lib/format";
import { shortDigest } from "../../lib/pipeline/yamlPointer";

export interface AttemptDetailProps {
  attempt: Attempt;
  /** The node execution the attempt belongs to, when the caller has it. */
  node?: NodeExecutionSummary | null;
  /** The boundary this attempt saved (success) or the last one before it. */
  checkpoint?: RunCheckpoint | null;
  /** Events correlated on this attempt — the retry countdown lives here. */
  events?: RunEvent[];
  headingId?: string;
  className?: string;
}

export function AttemptDetail({
  attempt,
  node = null,
  checkpoint = null,
  events = [],
  headingId = "attempt-detail-heading",
  className = "",
}: AttemptDetailProps) {
  const state = stateOf(ATTEMPT_STATE[attempt.status]);
  const retryScheduled = events.find(
    (event) => event.type === "node.attempt.retry_scheduled" && event.attempt_id === attempt.id,
  );
  const continuity = continuityCopy(attempt);

  return (
    <Panel
      title={`ATTEMPT ${attempt.attempt_number}`}
      headingId={headingId}
      headingLevel={3}
      state={state === "failed" || state === "interrupted" ? state : undefined}
      meta={
        <StatusChip
          state={state}
          label={attemptWord(attempt)}
          labelProps={{ "data-testid": "attempt-status" }}
        />
      }
      className={className}
    >
      <div className="space-y-[10px] p-[10px]">
        {attempt.error_class ? (
          <div className="flex flex-wrap items-center gap-[6px]">
            <span className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              error class
            </span>
            <ErrorClassChip errorClass={attempt.error_class} />
          </div>
        ) : null}

        {attempt.detail ? (
          <p className="text-[12.5px] leading-[18px]" data-testid="attempt-detail-text">
            {attempt.detail}
          </p>
        ) : null}

        {attempt.status === "interrupted" ? (
          // W5's assertion is about these words: the outcome is unknown, and
          // nothing here may imply the work carried on by itself.
          <Alert
            state="interrupted"
            label="OUTCOME UNKNOWN"
            testid="attempt-interrupted-note"
            barTone="pale"
          >
            interrupted — the worker disappeared mid-node. Nothing was finished on its side, and
            anything after the last completed boundary may be repeated by the next attempt.
          </Alert>
        ) : null}

        {attempt.error_class === "workspace_lost" ? (
          <Alert
            state="failed"
            label="EDITS LOST"
            testid="attempt-workspace-lost-note"
            barTone="pale"
          >
            prior edits lost, rerun required. No automatic retry is offered: there is no workspace
            to continue in, and pretending otherwise would hide work that has to be done twice.
          </Alert>
        ) : null}

        <dl className="grid gap-x-6 gap-y-1 font-mono text-[11px] text-ink-2 sm:grid-cols-2">
          <Fact
            label="scheduled"
            value={formatTime(attempt.scheduled_at)}
            testid="attempt-scheduled"
          />
          <Fact
            label="started"
            value={attempt.started_at ? formatTime(attempt.started_at) : "not started"}
          />
          <Fact
            label="finished"
            value={attempt.finished_at ? formatTime(attempt.finished_at) : "still open"}
          />
          <Fact
            label="deadline"
            value={attempt.deadline_at ? formatTime(attempt.deadline_at) : "none served"}
          />
          <Fact
            label="outputs"
            value={
              attempt.outputs_digest ? `digest ${shortDigest(attempt.outputs_digest)}` : "none"
            }
            testid="attempt-outputs-digest"
          />
          <Fact
            label="turn"
            value={attempt.turn_id ? shortId(attempt.turn_id) : "no turn"}
            testid="attempt-turn"
          />
        </dl>

        {attempt.output_errors.length > 0 ? (
          <div data-testid="attempt-output-errors">
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              output errors ({attempt.output_errors.length})
            </p>
            <ul className="mt-[4px] space-y-[2px]">
              {attempt.output_errors.map((error, index) => (
                <li key={index} className="font-mono text-[11px] text-st-failed-tag-fg">
                  {error.path ?? "document"}: {error.message ?? "rejected"}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {attempt.outputs ? (
          <div>
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              outputs
            </p>
            <pre
              data-testid="attempt-outputs"
              className="mt-[4px] overflow-auto rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px]"
            >
              {JSON.stringify(attempt.outputs, null, 2)}
            </pre>
          </div>
        ) : null}

        {attempt.artifact_refs.length > 0 ? (
          <div>
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              evidence
            </p>
            <ul className="mt-[4px] space-y-[4px]" data-testid="attempt-evidence">
              {attempt.artifact_refs.map((artifact) => (
                <li key={artifact.id} className="flex items-center gap-[8px]">
                  <span className="text-[12.5px] font-semibold">{artifact.name}</span>
                  <span className="font-mono text-[10.5px] text-muted">{artifact.kind}</span>
                  <span
                    className="font-mono text-[10.5px] text-faint"
                    data-testid={`attempt-evidence-${artifact.name}`}
                  >
                    {artifact.sha256 ? shortDigest(artifact.sha256) : shortId(artifact.id)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {continuity ? (
          <div
            className="rounded-[3px] border border-line bg-paper p-[8px]"
            data-testid="attempt-retry-context"
          >
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              what the next attempt inherits ({String(attempt.retry_context?.mode ?? "none")})
            </p>
            <p className="mt-[3px] text-[12.5px] leading-[18px]" data-testid="attempt-continuity">
              {continuity.body}
            </p>
            {continuity.degraded ? (
              <p
                className="mt-[3px] font-mono text-[10.5px] text-muted"
                data-testid="attempt-session-degraded"
              >
                session: asked for {String(continuity.degraded[0])}, got{" "}
                {String(continuity.degraded[1])} — this agent does not resume sessions, so the turn
                is new and the prompt carries the context instead.
              </p>
            ) : null}
          </div>
        ) : null}

        <CheckpointBlock checkpoint={checkpoint} nodeKey={node?.node_instance_key ?? null} />

        {retryScheduled ? (
          <p className="font-mono text-[11px] text-muted" data-testid="attempt-retry-countdown">
            ↻ next attempt scheduled {formatTime(String(retryScheduled.payload.scheduled_at ?? ""))}{" "}
            UTC
            {typeof retryScheduled.payload.delay_seconds === "number"
              ? ` · backoff ${retryScheduled.payload.delay_seconds}s`
              : ""}
          </p>
        ) : null}

        {events.length > 0 ? (
          <div>
            <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
              events on this attempt
            </p>
            <ul className="mt-[4px] space-y-[2px]" data-testid="attempt-events">
              {events.map((event) => (
                <li key={event.global_seq} className="flex gap-[8px] font-mono text-[10.5px]">
                  <span className="text-faint">{event.global_seq}</span>
                  <span className="text-muted">{formatTime(event.occurred_at)}</span>
                  <span data-testid={`attempt-event-${event.type}`}>{event.type}</span>
                  {event.payload.reason ? (
                    <span className="text-ink-2">{String(event.payload.reason)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------- fragments */

function Fact({ label, value, testid }: { label: string; value: string; testid?: string }) {
  return (
    <div className="flex gap-2" data-testid={testid}>
      <dt className="text-muted">{label}</dt>
      <dd className="break-all">{value}</dd>
    </div>
  );
}

/** The eleven `error_class` values, each with the word the copy voice uses.
 * `agent_error` is explicitly "not a model quality judgement" — the error's,
 * the agent's, or the node's, and the UI does not guess further. */
const ERROR_CLASS_COPY: Record<string, string> = {
  infra: "infra — the platform failed",
  interrupted: "interrupted — stopped, outcome unknown",
  timeout: "timeout — the deadline passed",
  agent_error: "agent_error — the agent's own error (not a model quality judgement)",
  invalid_output: "invalid_output — the reply did not satisfy the schema",
  predicate_error: "predicate_error — the expression could not be evaluated",
  sandbox_enforcement_failed: "sandbox_enforcement_failed — the sandbox refused the stage",
  workspace_lost: "workspace_lost — the workspace is gone",
  binding_error: "binding_error — an input binding could not be resolved",
  approval_expired: "approval_expired — the gate's deadline passed",
  cancelled: "cancelled — a person stopped it",
};

export function ErrorClassChip({ errorClass }: { errorClass: string }) {
  const copy = ERROR_CLASS_COPY[errorClass] ?? errorClass;
  return (
    <span
      className="inline-flex items-center gap-[4px] rounded-[2px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[6px] py-[1px] font-mono text-[10.5px] text-st-failed-tag-fg"
      data-testid={`error-class-${errorClass}`}
      title={copy}
    >
      <span aria-hidden>×</span>
      {errorClass}
      <span className="text-st-failed-pale-fg opacity-90">
        — {copy.split(" — ")[1] ?? "unclassified"}
      </span>
    </span>
  );
}

/**
 * A boundary record — the API's answer to "what does a retry inherit?". No
 * paths: `volume_id` and `workspace_id` are the locators the contract serves.
 */
export function CheckpointBlock({
  checkpoint,
  nodeKey,
}: {
  checkpoint: RunCheckpoint | null;
  nodeKey?: string | null;
}) {
  if (!checkpoint) {
    return (
      <p className="font-mono text-[10.5px] text-muted" data-testid="attempt-checkpoint-none">
        no checkpoint saved for {nodeKey ?? "this node"} — a retry starts from the node's inputs,
        not from a workspace state.
      </p>
    );
  }
  return (
    <div
      className="rounded-[3px] border border-line bg-surface p-[8px]"
      data-testid="attempt-checkpoint"
    >
      <p className="font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
        checkpoint boundary · {checkpoint.node_instance_key}
      </p>
      <dl className="mt-[4px] space-y-[2px] font-mono text-[11px] text-ink-2">
        <div className="flex gap-2">
          <dt className="text-muted">inputs</dt>
          <dd data-testid="attempt-checkpoint-inputs-digest">
            {shortDigest(checkpoint.inputs_digest)}
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">outputs</dt>
          <dd>{shortDigest(checkpoint.outputs_digest)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted">volume</dt>
          <dd data-testid="attempt-checkpoint-volume">{checkpoint.volume_id}</dd>
        </div>
        {checkpoint.repo_states.map((state) => (
          <div key={state.repository_id} className="flex flex-wrap gap-2">
            <dt className="text-muted">repo</dt>
            <dd data-testid={`attempt-checkpoint-repo-${state.repository_id}`}>
              {state.repository_id} {shortCommit(state.base_commit)} →{" "}
              {shortCommit(state.head_commit)}
              {state.head_commit === state.base_commit
                ? " (head equals base)"
                : " (head differs from base)"}
              {state.modified_paths_artifact
                ? ` · modified paths: ${state.modified_paths_artifact.name}`
                : ""}
            </dd>
          </div>
        ))}
        <div className="flex gap-2">
          <dt className="text-muted">saved</dt>
          <dd>{formatTime(checkpoint.created_at)}</dd>
        </div>
      </dl>
      <p className="mt-[4px] font-mono text-[10.5px] text-faint">
        a retry inherits this boundary, not the interrupted process.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------- wording */

/** The literal status always travels beside the state set's word: a `skipped`
 * node and a `queued` node share a colour and must not share a label. */
export function attemptWord(attempt: Attempt): string {
  if (attempt.status === "interrupted") return "interrupted";
  if (attempt.status === "succeeded") return "succeeded";
  if (attempt.status === "failed" && attempt.error_class) return `failed · ${attempt.error_class}`;
  return attempt.status;
}

interface ContinuityCopy {
  body: string;
  /** `[askedFor, got]` when a session mode degraded (ADR-0023 § 4). */
  degraded: [string, string] | null;
}

/**
 * `retry_context.mode` in the server's own words, from ADR-0023 § 6 and the
 * contract's D5. Unknown modes say they are unknown: inventing an explanation
 * for a value the UI has not seen would be the worst kind of confidence.
 */
function continuityCopy(attempt: Attempt): ContinuityCopy | null {
  const context = attempt.retry_context as
    | {
        mode?: string;
        session_mode?: string;
        resolved_session_mode?: string;
        workspace_policy?: string;
      }
    | null
    | undefined;
  if (!context?.mode) return null;
  const degraded =
    context.session_mode &&
    context.resolved_session_mode &&
    context.session_mode !== context.resolved_session_mode
      ? ([context.session_mode, context.resolved_session_mode] as [string, string])
      : null;
  switch (context.mode) {
    case "continue_workspace":
      return {
        body: "the worktree keeps the previous attempt's uncommitted edits, and the next attempt runs a new agent turn in that same workspace. The conversation is not continued — the agent starts fresh with what is on disk.",
        degraded,
      };
    case "restart_turn":
      return {
        body: "the workspace is kept, but the next attempt re-runs the whole turn from the node's inputs. Nothing from this attempt's reply is carried forward.",
        degraded,
      };
    case "restore_checkpoint":
      return {
        body: "the workspace is set back to the checkpoint's commits before the turn runs. Only legal when every repository was committed at that boundary — otherwise the API refuses with checkpoint_unavailable.",
        degraded,
      };
    case "none":
      return {
        body: "nothing is inherited: the next attempt starts from this node's inputs alone.",
        degraded,
      };
    default:
      return {
        body: `this attempt carried an inheritance mode the interface does not know ("${context.mode}"), so it is shown as named rather than explained.`,
        degraded,
      };
  }
}
