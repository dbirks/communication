/**
 * The workbench's right dock (ADR-0043 decision 3): the node detail, keyed
 * by the node's kind. `agent.acp` leads with the live conversation through
 * the shared `AgentConversationPanel` (dock variant — one chat surface, not
 * a fork); `human.approval` leads with the gate card and its decide verbs;
 * everything else reads the attempt's facts through `AttemptDetail`'s own
 * sections (exec facts, outputs, evidence, checkpoint). A failed or
 * interrupted node adds the honest failure block: error class, the engine's
 * cause, the attempt count, the retry verdict and the checkpoint
 * consequence — the inspector's words, never a paraphrase.
 *
 * Everything is live: the dock reads `useRunNode` for the selected
 * execution; the page's SSE stream invalidates that read, and nothing here
 * ever claims a state the backend did not report.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useMe, useProject } from "../../api/queries";
import { useRunNode } from "../../api/runs";
import {
  adoptApprovalConflict,
  approvalConflictOf,
  useDecideApproval,
  useProjectApprovals,
} from "../../api/approvals";
import { viewApproval, viewAttempt, viewRunCheckpoint } from "../../api/m4view";
import { problemOf } from "../../api/client";
import { AgentConversationPanel } from "../conversation/AgentConversationPanel";
import { ApprovalCard } from "../m4/ApprovalCard";
import { AttemptDetail, CheckpointBlock } from "../m4/AttemptDetail";
import { NodePaneHeader } from "../m4/NodePaneHeader";
import { ProblemBanner } from "../Feedback";
import { kindWord } from "../../lib/pipeline/definition";
import { iterationOf } from "../../lib/pipeline/runView";
import { toRunEvent } from "../../lib/pipeline/runEvents";
import { retryVerdict } from "../../pages/RunInspector";
import { childRunOf } from "../../lib/pipeline/workbench";
import { routes } from "../../lib/routes";
import type {
  AttemptDetail as AttemptView,
  NodeExecutionSummary,
  RunCheckpoint,
  RunDetail,
  RunEvent,
  RunTreeRoot,
} from "../../lib/pipeline/contract";
import type { EventEnvelope } from "../../api/types";

export interface WorkbenchDockProps {
  run: RunDetail;
  projectId: string;
  /** The selected definition node, from the pinned revision's document. */
  definitionNode: { id: string; kind: string } | null;
  /** The selected node execution (the URL's `instance=`), or null. */
  execution: NodeExecutionSummary | null;
  /** The URL's 1-based `attempt=`; null reads the newest attempt. */
  attemptNumber: number | null;
  onAttemptChange: (attempt: number | null) => void;
  /** The run's rows — the retry verdict reads them, never guesses. */
  nodes: readonly NodeExecutionSummary[];
  /** The run's frames — the retry countdown reads off them. */
  frames: readonly EventEnvelope[];
  /** The run's tree (child runs through `pipeline_invocations`) — the
   * `pipeline.invoke` dock links to the child run the invocation made. */
  tree: RunTreeRoot | null;
  /** Full-screen transcript mode (`?full=1`, design 5c). */
  fullScreen?: boolean;
  /** Toggles full screen (the page owns the `?full=` param). When present,
   * the dock's header carries the `⤢ full screen` button. */
  onToggleFullScreen?: () => void;
}

export function WorkbenchDock({
  run,
  projectId,
  definitionNode,
  execution,
  attemptNumber,
  onAttemptChange,
  nodes,
  frames,
  tree,
  fullScreen = false,
  onToggleFullScreen,
}: WorkbenchDockProps) {
  const executionId = execution?.id ?? "";
  const detail = useRunNode(run.id, executionId);
  const approvalsQuery = useProjectApprovals(projectId);
  const decide = useDecideApproval(projectId);
  const queryClient = useQueryClient();
  const me = useMe();
  const project = useProject(projectId);
  const [conflict, setConflict] = useState<string | null>(null);

  const attempts = useMemo(
    () =>
      (detail.data?.attempts ?? [])
        .map(viewAttempt)
        .sort((a, b) => a.attempt_number - b.attempt_number),
    [detail.data],
  );
  const selectedAttempt =
    attempts.find((attempt) => attempt.attempt_number === attemptNumber) ?? attempts.at(-1) ?? null;
  // The selected attempt owes its conversation a stamp (stamped at claim
  // time): when an earlier attempt of the same node execution already opened
  // one, the re-run rides that same conversation — the dock reads it.
  const sharedConversation = useMemo(() => {
    if (!selectedAttempt || selectedAttempt.conversation_id) return null;
    const prior = attempts.filter(
      (attempt) => attempt.attempt_number < selectedAttempt.attempt_number,
    );
    for (let i = prior.length - 1; i >= 0; i -= 1) {
      const row = prior[i];
      if (row.conversation_id)
        return { conversationId: row.conversation_id, attemptNumber: row.attempt_number };
    }
    return null;
  }, [attempts, selectedAttempt]);
  const eventsByAttempt = useMemo(() => {
    const grouped = new Map<string, RunEvent[]>();
    for (const frame of frames) {
      const event = toRunEvent(frame);
      if (!event?.attempt_id) continue;
      const list = grouped.get(event.attempt_id);
      if (list) list.push(event);
      else grouped.set(event.attempt_id, [event]);
    }
    return grouped;
  }, [frames]);

  const gate =
    (approvalsQuery.data?.approvals ?? [])
      .map(viewApproval)
      .find((approval) => approval.node_execution_id === executionId) ?? null;

  // `pipeline.invoke` is a parent run's one-hop view of a whole child run —
  // the tree row keyed by this execution's own instance key names it.
  const childRun =
    execution && execution.kind === "pipeline.invoke"
      ? childRunOf(tree, execution.node_instance_key)
      : null;

  if (!execution) {
    return (
      <p className="font-mono text-[11px] text-muted" data-testid="workbench-dock-empty">
        Select a node on the graph — or a row on the timeline or the tree — to read its attempts,
        conversation and gates here.
      </p>
    );
  }

  const kind = execution.kind;
  const kindLabel = kindWord(definitionNode?.kind ?? kind);
  const iteration = iterationOf(execution.node_instance_key);
  const attemptTotal =
    execution.attempt_limit > 0 ? execution.attempt_limit : Math.max(attempts.length, 1);
  const lineAttempt = lineAttemptFor(selectedAttempt, execution.status, execution.attempt_count);
  const verdict = retryVerdict(run.status, nodes);
  const isGate = kind === "human.approval";
  const isAgent = kind === "agent.acp";
  const checkpoint =
    detail.data?.checkpoint && selectedAttempt && selectedAttempt.id === (attempts.at(-1)?.id ?? "")
      ? viewRunCheckpoint(detail.data.checkpoint)
      : null;

  if (detail.isError) {
    return <ProblemBanner error={detail.error} fallback="This node execution could not be read." />;
  }
  if (detail.isPending || (!selectedAttempt && approvalsQuery.isPending)) {
    return (
      <div className="space-y-[10px]">
        <DockTitle
          kindLabel={kindLabel}
          key_={execution.node_instance_key}
          instanceLine={instanceLine(iteration, lineAttempt, attemptTotal)}
        />
        <p className="font-mono text-[11px] text-muted" data-testid="workbench-dock-pending">
          Reading attempts for <code className="font-mono">{execution.node_instance_key}</code>…
        </p>
      </div>
    );
  }

  const decideGate = (input: {
    approvalId: string;
    decision: "approved" | "rejected";
    comments: string;
    version: number;
  }) => {
    decide.mutate(
      {
        approvalId: input.approvalId,
        body: {
          decision: input.decision,
          version: input.version,
          ...(input.comments ? { comments: input.comments } : {}),
        },
      },
      {
        onSuccess: () => setConflict(null),
        onError: (error: unknown) => {
          if (approvalConflictOf(error)) {
            adoptApprovalConflict(queryClient, error);
            setConflict("someone decided this gate first — what you see now is the winner's");
          } else {
            setConflict(problemOf(error).title);
          }
        },
      },
    );
  };

  return (
    <div className="space-y-[10px]" data-testid="workbench-dock">
      {/* The transcript dock's own full-screen control (design 5c): `⤢ full
       * screen` folds the graph into the step strip; the page's strip row owns
       * the `⤡ show graph` restore, so the header offers only what it can do
       * from here. */}
      {onToggleFullScreen && !fullScreen ? (
        <div className="flex justify-end">
          <button
            type="button"
            data-testid="workbench-fullscreen"
            onClick={onToggleFullScreen}
            className="rounded-[3px] border border-line px-2.5 py-[5px] text-[12px] font-semibold text-ink hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            ⤢ full screen
          </button>
        </div>
      ) : null}
      <NodePaneHeader
        node={execution}
        nodes={[execution]}
        attemptNumber={selectedAttempt?.attempt_number ?? null}
      />
      <DockTitle
        kindLabel={kindLabel}
        key_={execution.node_instance_key}
        instanceLine={instanceLine(iteration, lineAttempt, attemptTotal)}
      />
      {attempts.length > 1 ? (
        <div className="flex flex-wrap gap-[6px]" role="tablist" aria-label="Attempts">
          {attempts.map((attempt) => (
            <button
              key={attempt.id}
              type="button"
              role="tab"
              aria-selected={attempt.id === selectedAttempt?.id}
              data-testid={`dock-attempt-${attempt.attempt_number}`}
              onClick={() => onAttemptChange(attempt.attempt_number)}
              className={`rounded-[3px] border px-2 py-[3px] font-mono text-[11px] ${
                attempt.id === selectedAttempt?.id
                  ? "border-ink bg-ink text-paper"
                  : "border-line text-ink-2 hover:border-line-strong hover:text-ink"
              } focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent`}
            >
              attempt {attempt.attempt_number}
            </button>
          ))}
        </div>
      ) : null}

      {childRun ? (
        <div
          className="rounded-[3px] border border-line bg-surface p-[8px]"
          data-testid="dock-child-run"
        >
          <p className="font-mono text-[11px] text-ink-2" data-testid="dock-child-run-line">
            child run <code className="font-mono">{childRun.pipeline_slug}</code> ·{" "}
            {childRun.status}
          </p>
          <Link
            to={routes.run(childRun.child_run_id)}
            data-testid="dock-child-run-link"
            className="mt-[6px] inline-block rounded-[3px] border border-line px-2.5 py-[5px] text-[12px] font-semibold text-ink hover:border-line-strong focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            Open child run
          </Link>
        </div>
      ) : execution.kind === "pipeline.invoke" ? (
        <p className="font-mono text-[11px] text-muted" data-testid="dock-no-child-run">
          The invocation has no child run yet — it has not answered.
        </p>
      ) : null}
      {isAgent ? (
        <AgentDock
          attempt={selectedAttempt}
          fallback={sharedConversation}
          projectId={projectId}
          stepName={execution.node_instance_key}
        />
      ) : null}
      {isGate ? (
        gate ? (
          <ApprovalCard
            approval={gate}
            canDecide={canDecide(gate, me.data?.id, project.data?.my_role)}
            pending={decide.isPending}
            conflictError={conflict}
            onDecide={decideGate}
            headingId={`workbench-approval-heading-${gate.id}`}
          />
        ) : (
          <p className="font-mono text-[11px] text-muted" data-testid="dock-no-approval">
            No approval row for this gate yet — status {execution.status}.
          </p>
        )
      ) : null}
      {!isGate || gate ? (
        selectedAttempt ? (
          <AttemptDetail
            attempt={selectedAttempt}
            node={execution}
            checkpoint={checkpoint}
            events={eventsByAttempt.get(selectedAttempt.id) ?? []}
            headingId={`workbench-attempt-heading-${selectedAttempt.attempt_number}`}
          />
        ) : null
      ) : null}

      {isFailure(execution.status) &&
      (selectedAttempt !== null || execution.attempt_count === 0) ? (
        <FailureBlock
          errorClass={selectedAttempt?.error_class ?? execution.error_class}
          failedCause={execution.failed_cause}
          attemptNumber={selectedAttempt?.attempt_number ?? execution.attempt_count}
          attemptTotal={attemptTotal}
          verdictReason={verdict.show && verdict.reason ? verdict.reason : null}
          checkpoint={checkpoint}
          nodeKey={execution.node_instance_key}
        />
      ) : null}
    </div>
  );
}

function canDecide(
  gate: { approver_roles: string[]; approver_user_ids: string[] },
  myId: string | undefined,
  myRole: string | null | undefined,
): boolean {
  if (!myId) return false;
  if (gate.approver_user_ids.includes(myId)) return true;
  return myRole !== null && myRole !== undefined && gate.approver_roles.includes(myRole);
}

function isFailure(status: string): boolean {
  return status === "failed" || status === "interrupted" || status === "cancelled";
}

/** A node execution that has finished and never opened an attempt (a
 * control-plane decision — a failed `pipeline.invoke` reads this way) still
 * owes the reader its attempt count: `attempt 0 of 1`, never "no attempts
 * yet" on a terminal row. */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "interrupted", "skipped"]);

function lineAttemptFor(
  selected: { attempt_number: number } | null,
  status: string,
  attemptCount: number,
): { attempt_number: number } | null {
  if (selected) return selected;
  return attemptCount === 0 && TERMINAL_STATUSES.has(status) ? { attempt_number: 0 } : null;
}

function instanceLine(
  iteration: number | null,
  attempt: { attempt_number: number } | null,
  attemptTotal: number,
): string {
  const parts: string[] = [];
  if (iteration !== null) parts.push(`iteration ${iteration}`);
  if (attempt) parts.push(`attempt ${attempt.attempt_number} of ${attemptTotal}`);
  if (parts.length === 0) return "no attempts yet";
  return parts.join(" · ");
}

function DockTitle({
  kindLabel,
  key_,
  instanceLine: line,
}: {
  kindLabel: string;
  key_: string;
  instanceLine: string;
}) {
  return (
    <div>
      <p className="text-[14px] font-bold" data-testid="dock-title">
        {kindLabel} <span className="font-mono text-[11px] font-normal text-muted">{key_}</span>
      </p>
      <p className="font-mono text-[11px] text-muted" data-testid="dock-instance-line">
        {line}
      </p>
    </div>
  );
}

/** The `agent.acp` dock: the conversation is the main content.
 * `stepName` names the step on the dock's take-control card — the node's
 * instance key, the one label the run's own data always carries. */
function AgentDock({
  attempt,
  fallback,
  projectId,
  stepName,
}: {
  attempt: AttemptView | null;
  stepName: string;
  /** When the selected attempt has not been stamped with the conversation
   * yet (a retry or a takeover re-run, stamped at claim time), the
   * conversation its predecessor opened — the re-run rides that same row.
   */
  fallback: { conversationId: string; attemptNumber: number } | null;
  projectId: string;
}) {
  if (!attempt) return null;
  if (!attempt.conversation_id) {
    if (!fallback) {
      return (
        <p className="text-[12px] text-muted" data-testid="dock-no-conversation">
          The agent has not started yet.
        </p>
      );
    }
    // The factory re-ran this node while the dock selected the new attempt:
    // its conversation is stamped on claim, so the row holds none for a few
    // seconds. "The agent has not started yet" is wrong then — the node
    // already spoke, and the re-run rides the SAME conversation (a retry of
    // the same node execution rides the conversation its previous attempt
    // opened). Show that conversation now: its control badge already names
    // the pipeline run, and the new turn will continue in it.
    const tookBack = (attempt.retry_context as { human_takeover?: unknown } | null)?.human_takeover;
    return (
      <div className="space-y-[10px]" data-testid="dock-conversation">
        <p className="text-[12px] text-muted" data-testid="dock-attempt-restarting">
          {tookBack
            ? `Attempt ${attempt.attempt_number} is starting — the factory took the conversation back; its new turn continues in the conversation attempt ${fallback.attemptNumber} opened.`
            : `Attempt ${attempt.attempt_number} is starting — the factory re-ran this node; its new turn continues in the conversation attempt ${fallback.attemptNumber} opened.`}
        </p>
        <AgentConversationPanel
          conversationId={fallback.conversationId}
          projectId={projectId}
          variant="dock"
          stepName={stepName}
          attemptTurnId={undefined}
          ids={{
            controlBanner: "dock-control-banner",
            stream: "dock-work-stream",
            badge: "dock-controller",
            takeControl: "dock-take-control",
            returnControl: "dock-return-control",
            stopTurn: "dock-stop-turn",
            composerForm: "dock-composer",
            composerInput: "dock-composer-input",
            composerSend: "dock-composer-send",
            composerExplainer: "dock-composer-explainer",
          }}
          watching
          empty={{
            testid: "dock-work-empty",
            copy: "No journal frames yet — the agent has not answered.",
          }}
          errorFallback="The agent's conversation for this attempt could not be read."
          composer={{
            inputId: `workbench-prompt-${attempt.id}`,
            rows: 3,
            nonControllerPlaceholder: "Take control to prompt this agent",
          }}
        />
      </div>
    );
  }
  const conversationId = attempt.conversation_id;
  return (
    <div data-testid="dock-conversation">
      <AgentConversationPanel
        conversationId={conversationId}
        projectId={projectId}
        variant="dock"
        stepName={stepName}
        // No `turnFilter`: the dock is the live surface, and a takeover opens a
        // NEW turn in the same conversation. Scoping to the attempt's original
        // turn hid the human's prompt and the agent's reply — the transcript
        // must stay in sync with the whole conversation, not just the first turn.
        // `attemptTurnId` marks where this attempt's turn begins (and which
        // turns were human) without hiding anything.
        attemptTurnId={attempt.turn_id ?? undefined}
        ids={{
          controlBanner: "dock-control-banner",
          stream: "dock-work-stream",
          badge: "dock-controller",
          takeControl: "dock-take-control",
          returnControl: "dock-return-control",
          stopTurn: "dock-stop-turn",
          composerForm: "dock-composer",
          composerInput: "dock-composer-input",
          composerSend: "dock-composer-send",
          composerExplainer: "dock-composer-explainer",
        }}
        watching
        empty={{
          testid: "dock-work-empty",
          copy: "No journal frames yet — the agent has not answered.",
        }}
        errorFallback="The agent's conversation for this attempt could not be read."
        composer={{
          inputId: `workbench-prompt-${attempt.id}`,
          rows: 3,
          nonControllerPlaceholder: "Take control to prompt this agent",
        }}
      />
    </div>
  );
}

/** The failed/interrupted block — the inspector's words, kept verbatim. */
function FailureBlock({
  errorClass,
  failedCause,
  attemptNumber,
  attemptTotal,
  verdictReason,
  checkpoint,
  nodeKey,
}: {
  errorClass: string | null;
  failedCause: string | null;
  attemptNumber: number;
  attemptTotal: number;
  verdictReason: string | null;
  checkpoint: RunCheckpoint | null;
  nodeKey: string;
}) {
  return (
    <div className="rounded-[3px] border border-line bg-surface p-[8px]" data-testid="dock-failure">
      <dl className="space-y-[4px] font-mono text-[11px] text-ink-2">
        {errorClass ? (
          <div>
            <dt className="text-muted">error class</dt>
            <dd data-testid="dock-error-class">{errorClass}</dd>
          </div>
        ) : null}
        {failedCause ? (
          <div>
            <dt className="text-muted">cause</dt>
            <dd data-testid="dock-failed-cause">{failedCause}</dd>
          </div>
        ) : null}
        <div>
          <dt className="text-muted">attempt</dt>
          <dd data-testid="dock-attempt-count">
            attempt {attemptNumber} of {attemptTotal}
          </dd>
        </div>
      </dl>
      {attemptNumber === 0 ? (
        <p className="mt-[6px] font-mono text-[11px] text-muted" data-testid="dock-no-attempt">
          no worker attempt — the engine recorded this failure on the control plane
        </p>
      ) : null}
      {verdictReason ? (
        <p className="mt-[6px] font-mono text-[11px] text-muted" data-testid="dock-retry-verdict">
          {verdictReason}
        </p>
      ) : null}
      <p className="mt-[6px] font-mono text-[10.5px] text-faint">
        {checkpoint ? (
          <>
            Retrying re-runs this step from the last checkpoint — a retry inherits the boundary, not
            the interrupted process.
          </>
        ) : (
          <>
            Retrying re-runs this step from the node&apos;s inputs — no checkpoint was saved for{" "}
            {nodeKey}, so there is no workspace state to inherit.
          </>
        )}
      </p>
      <div className="mt-[6px]">
        <CheckpointBlock checkpoint={checkpoint} nodeKey={nodeKey} />
      </div>
    </div>
  );
}
