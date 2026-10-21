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
import { useState, type ReactNode } from "react";
import { AgentConversationPanel } from "../conversation/AgentConversationPanel";
import { useConversationSession } from "../conversation/useConversationSession";
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
  /**
   * The agent's own work for this attempt — the transcript, its permission
   * prompts and the control surface (`run-view-3b/4a`, `docs/m4-contract.md`
   * § 4 step 6). It is passed in rather than fetched here because the pane is
   * also rendered by previews and tests that hold no query client; the caller
   * that owns the cache renders `AttemptAgentWork` into this slot.
   */
  work?: ReactNode;
  headingId?: string;
  className?: string;
}

export function AttemptDetail({
  attempt,
  node = null,
  checkpoint = null,
  events = [],
  work = null,
  headingId = "attempt-detail-heading",
  className = "",
}: AttemptDetailProps) {
  const state = stateOf(ATTEMPT_STATE[attempt.status]);
  const retryScheduled = events.find(
    (event) => event.type === "node.attempt.retry_scheduled" && event.attempt_id === attempt.id,
  );
  const continuity = continuityCopy(attempt);
  // § 7.2 W6 (and W5) grade the WORDS the operator reads: the canned sentences below.
  // The engine's own `detail` (`workspace.recovery_lost/volume_changed: …`) is a
  // machine sentence, so once a canned one is drawn it drops to a secondary line
  // rather than leading the pane with prose no contract asked for.
  const hasOperatorCopy =
    attempt.status === "interrupted" || attempt.error_class === "workspace_lost";

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

        {attempt.detail ? (
          <p
            className={
              hasOperatorCopy
                ? "font-mono text-[11px] leading-[16px] text-faint"
                : "text-[12.5px] leading-[18px]"
            }
            data-testid="attempt-detail-text"
          >
            {hasOperatorCopy ? (
              <span className="mr-[6px] font-semibold uppercase tracking-[.04em]">
                engine detail
              </span>
            ) : null}
            {attempt.detail}
          </p>
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

        <ProcessExecFacts attempt={attempt} node={node} />

        {work}

        <OutputsSection outputs={attempt.outputs} />

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

/**
 * The `outputs` block, collapsed by default. A successful agent node's output
 * is a machine document (`run-view-3b`): the reader came to see the agent's
 * work, not a JSON dump, so the JSON is one honest click away rather than the
 * pane itself. `aria-expanded` carries the state and the payload is only in
 * the DOM once it is asked for — a collapsed section that keeps its 32 KiB
 * mounted is not collapsed.
 */
function OutputsSection({ outputs }: { outputs: Record<string, unknown> | null }) {
  const [open, setOpen] = useState(false);
  if (!outputs) return null;
  return (
    <div data-testid="attempt-outputs-section">
      <button
        type="button"
        data-testid="attempt-outputs-toggle"
        aria-expanded={open}
        aria-controls="attempt-outputs"
        onClick={() => setOpen((previous) => !previous)}
        className="flex w-full items-center gap-[6px] font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted hover:text-ink"
      >
        <span aria-hidden="true">{open ? "\u25be" : "\u25b8"}</span>
        outputs ({Object.keys(outputs).length})
      </button>
      {open ? (
        <p className="mt-[2px] sr-only" data-testid="attempt-outputs-open-hint">
          Shown below: the output document exactly as the API served it.
        </p>
      ) : (
        <p className="mt-[2px] text-[11.5px] text-faint" data-testid="attempt-outputs-collapsed">
          Collapsed — the node&apos;s validated output document. Open to read it.
        </p>
      )}
      <pre
        id="attempt-outputs"
        data-testid="attempt-outputs"
        hidden={!open}
        role="region"
        tabIndex={0}
        aria-label="Node outputs document (JSON)"
        className="mt-[4px] max-h-64 overflow-auto rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[16px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {JSON.stringify(outputs, null, 2)}
      </pre>
    </div>
  );
}

/** A bounded preview string from the inline envelope (`§ 8`: ≤ 1 MiB, the rest
 * only as an artifact). Never guessed: absent means the worker served none. */
function previewOf(outputs: Record<string, unknown> | null, key: string): string | null {
  const value = outputs?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function countOf(outputs: Record<string, unknown> | null, key: string): number | null {
  const value = outputs?.[key];
  return typeof value === "number" ? value : null;
}

/**
 * `process.exec` facts: the exit code, and the captured stdout/stderr previews.
 *
 * The worker captures the bytes in full to the run workspace and puts bounded
 * previews plus the byte counts in the inline output document
 * (`docs/m4-contract.md` § 8); this block renders exactly that and says what it
 * is — a preview with a known byte count, not the whole log.
 */
function ProcessExecFacts({
  attempt,
  node,
}: {
  attempt: Attempt;
  node: NodeExecutionSummary | null;
}) {
  if (node?.kind !== "process.exec") return null;
  const outputs = attempt.outputs ?? null;
  const exitCode = countOf(outputs, "exit_code");
  const stdout = previewOf(outputs, "stdout_preview");
  const stderr = previewOf(outputs, "stderr_preview");
  const stdoutBytes = countOf(outputs, "stdout_bytes");
  const stderrBytes = countOf(outputs, "stderr_bytes");
  return (
    <div className="space-y-[6px]" data-testid="attempt-process-facts">
      <div className="flex flex-wrap items-center gap-[6px] font-mono text-[11px]">
        <span className="text-muted">exit code</span>
        <span
          className={`rounded-[2px] border px-[6px] py-[1px] ${
            exitCode === null
              ? "border-line text-faint"
              : exitCode === 0
                ? "border-line-strong text-ink"
                : "border-st-failed-pale-edge bg-st-failed-pale-body text-st-failed-tag-fg"
          }`}
          data-testid="attempt-exit-code"
        >
          {exitCode === null ? "not served" : String(exitCode)}
        </span>
        {stdoutBytes !== null || stderrBytes !== null ? (
          <span className="text-faint" data-testid="attempt-capture-bytes">
            captured {stdoutBytes ?? 0} / {stderrBytes ?? 0} bytes (stdout / stderr)
          </span>
        ) : null}
      </div>
      {stdout ? <Capture label="stdout" text={stdout} /> : null}
      {stderr ? <Capture label="stderr" text={stderr} /> : null}
    </div>
  );
}

function Capture({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-faint">
        {label} (preview)
      </p>
      <pre
        data-testid={`attempt-${label}`}
        role="region"
        tabIndex={0}
        aria-label={`${label} preview`}
        className="mt-[2px] max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-[3px] border border-line bg-paper p-[8px] font-mono text-[11px] leading-[15px] text-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        {text}
      </pre>
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
 * A locator a person may need to paste elsewhere — a checkpoint volume id is a
 * `sha256:` address, 71 characters, and the phone-width QA saw it forcing a
 * 469px line that scrolled the whole document sideways. So the value always
 * breaks (`break-all` + `min-w-0`, never a fixed nowrap) and a copy button
 * carries the exact text without selecting it.
 *
 * The `testid` sits on the value itself, not the wrapper: the tests read what
 * is shown, and the button's word is not part of the address.
 */
function CopyableValue({ value, testid, label }: { value: string; testid: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const hasClipboard = typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  // A short locator fits the line and is copyable by hand; the copy button is
  // the affordance for the long ones the page had to break in the first place.
  const long = value.length > 24;
  const copy = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  if (!long) {
    return (
      <span data-testid={testid} className="min-w-0 break-all">
        {value}
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-[6px]">
      <span data-testid={testid} className="min-w-0 break-all">
        {value}
      </span>
      <button
        type="button"
        data-testid={`${testid}-copy`}
        aria-label={`Copy the ${label}: ${value}`}
        disabled={!hasClipboard}
        onClick={copy}
        title={hasClipboard ? `Copy the ${label}` : "Clipboard is not available in this context"}
        className="shrink-0 rounded-[2px] border border-line px-[4px] py-[1px] font-mono text-[9.5px] text-muted hover:border-line-strong hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:text-faint disabled:hover:border-line"
      >
        {copied ? "copied" : "copy"}
      </button>
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
      <p className="break-all font-mono text-[10px] font-semibold tracking-[.04em] text-muted uppercase">
        checkpoint boundary · {checkpoint.node_instance_key}
      </p>
      <dl className="mt-[4px] space-y-[2px] font-mono text-[11px] text-ink-2">
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted">inputs</dt>
          <dd data-testid="attempt-checkpoint-inputs-digest" className="min-w-0 break-all">
            {shortDigest(checkpoint.inputs_digest)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted">outputs</dt>
          <dd className="min-w-0 break-all">{shortDigest(checkpoint.outputs_digest)}</dd>
        </div>
        <div className="flex flex-wrap gap-2">
          <dt className="text-muted">volume</dt>
          <dd className="min-w-0">
            <CopyableValue
              value={checkpoint.volume_id}
              testid="attempt-checkpoint-volume"
              label="checkpoint volume id"
            />
          </dd>
        </div>
        {checkpoint.repo_states.map((state) => (
          <div key={state.repository_id} className="flex flex-wrap gap-2">
            <dt className="text-muted">repo</dt>
            <dd
              data-testid={`attempt-checkpoint-repo-${state.repository_id}`}
              className="min-w-0 break-all"
            >
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

/**
 * The conversation title, minus what this line already says.
 *
 * An attempt conversation is named server-side —
 * `internal/store/postgres/agentturn_seams.go`'s `attemptConversationTitle`
 * writes `run <id[:8]> <node_instance_key> attempt <n>`, shortening the id from
 * the *head*. For a UUIDv7 the head is a millisecond timestamp, so every run
 * started in the same second renders the same `run 01a1454f` — the prefix the
 * phone-width QA read as a real identifier. The pane says the node and the
 * attempt itself, so that generated name is dropped rather than repeated; a
 * title a person wrote is shown verbatim, including one that merely starts
 * with the word "run".
 */
export function conversationTitleOf(
  title: string | null | undefined,
  nodeKey: string | null,
  attemptNumber: number,
): string | null {
  const text = (title ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (nodeKey) {
    const pattern = new RegExp(
      `^run\\s+\\S+\\s+${nodeKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+attempt\\s+${attemptNumber}$`,
      "i",
    );
    if (pattern.test(text)) return null;
  }
  return text;
}

/* ------------------------------------------------ the agent's own work */

export interface AttemptAgentWorkProps {
  attempt: Attempt;
  projectId: string;
  /** Names the node the pane's header line belongs to. */
  node?: NodeExecutionSummary | null;
}

/**
 * The attempt pane as the design draws it (`run-view-3b`, `run-view-4a`): the
 * agent's work, not its result document. An `agent.acp` attempt owns a
 * conversation and a turn (`docs/m4-contract.md` § 4 step 6,
 * `attempts.conversation_id` / `turn_id`), so everything below is that
 * conversation read through the same components the conversation page uses —
 * `Transcript` for messages, tool calls and permission prompts, and the same
 * control routes for take/return and prompting. Nothing is re-implemented and
 * nothing is invented: the watcher count, for instance, is not served by the
 * API, so the banner says who has control and that you are watching, never a
 * number.
 */
export function AttemptAgentWork({ attempt, projectId, node = null }: AttemptAgentWorkProps) {
  if (!attempt.conversation_id) {
    return (
      <p className="text-[12px] text-muted" data-testid="attempt-no-conversation">
        This attempt reports no conversation, so there is no agent work to read here — only its
        outputs and evidence below.
      </p>
    );
  }
  return <AttemptConversationWork attempt={attempt} projectId={projectId} node={node} />;
}

/** The conversation-backed half, one attempt's turn. Split out because the
 * reads below only make sense for a conversation that exists — a gate on the
 * hooks would be a conditional hook call. The surface itself is the shared
 * `AgentConversationPanel` (dock variant), wearing this pane's historical
 * `attempt-*` testids. */
function AttemptConversationWork({
  attempt,
  projectId,
  node,
}: Required<Omit<AttemptAgentWorkProps, "node">> & { node: NodeExecutionSummary | null }) {
  const conversationId = attempt.conversation_id ?? "";
  const session = useConversationSession(conversationId, projectId);
  const data = session.data;
  // The visible title says this node and this attempt already; the server's
  // generated conversation name is dropped rather than repeated (see
  // `conversationTitleOf`), so the line never reads
  // `/plan · attempt 1 · run 01a1454f /plan attempt 1`.
  const title = data
    ? conversationTitleOf(data.title, node?.node_instance_key ?? null, attempt.attempt_number)
    : null;

  return (
    <section className="space-y-[8px]" aria-label="Agent work" data-testid="attempt-agent-work">
      {session.conversation.isPending ? (
        <p className="font-mono text-[11px] text-muted" data-testid="attempt-work-pending">
          Reading the agent&apos;s turn…
        </p>
      ) : (
        <>
          {data ? (
            <p
              className="truncate font-mono text-[10.5px] text-muted"
              data-testid="attempt-work-title"
            >
              {node ? `${node.node_instance_key} · ` : ""}attempt {attempt.attempt_number}
              {title ? ` · ${title}` : ""}
            </p>
          ) : null}
          <AgentConversationPanel
            conversationId={conversationId}
            projectId={projectId}
            variant="dock"
            session={session}
            turnFilter={attempt.turn_id ?? undefined}
            // The pane keeps every test id it has always worn —
            // data-testid="attempt-control-banner", data-testid="attempt-work-stream",
            // data-testid="attempt-controller", data-testid="attempt-take-control",
            // data-testid="attempt-return-control", data-testid="attempt-stop-turn",
            // data-testid="attempt-composer", data-testid="attempt-composer-input",
            // data-testid="attempt-composer-send", data-testid="attempt-composer-explainer".
            ids={{
              controlBanner: "attempt-control-banner",
              stream: "attempt-work-stream",
              badge: "attempt-controller",
              takeControl: "attempt-take-control",
              returnControl: "attempt-return-control",
              stopTurn: "attempt-stop-turn",
              composerForm: "attempt-composer",
              composerInput: "attempt-composer-input",
              composerSend: "attempt-composer-send",
              composerExplainer: "attempt-composer-explainer",
            }}
            watching
            empty={{
              testid: "attempt-work-empty",
              copy: "No journal frames for this turn yet — the agent has not answered.",
            }}
            errorFallback="The agent's conversation for this attempt could not be read."
            composer={{
              inputId: `attempt-prompt-${attempt.id}`,
              rows: 2,
              nonControllerPlaceholder: "Take control to prompt this agent",
            }}
          />
        </>
      )}
    </section>
  );
}
