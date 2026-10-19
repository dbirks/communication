import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useTurnSandbox } from "../api/queries";
import { interruptedCopy, runLinkOf, turnStatusText } from "../api/transcript";
import { shortId } from "../api/names";
import type { TurnSandbox } from "../api/types";
import {
  AgentConversationPanel,
  AgentConversationControls,
} from "../components/conversation/AgentConversationPanel";
import { useConversationSession } from "../components/conversation/useConversationSession";
import { WorkspaceWidget } from "../components/Workspaces";
import { TurnSandboxPanel } from "../components/Sandbox";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import { StatusChip } from "../components/ds/Row";
import { STREAM_STATE, TURN_STATE, stateOf } from "../components/ds/states";

/**
 * Whether what the wire returned is a verdict at all.
 *
 * `GET /api/v1/turns/{id}/sandbox` answers `200` for a turn whose journal holds
 * no sandbox event: the store's honest default is `stage: none`, `verified:
 * false`, no backend, no ids, no grants (`internal/store/postgres/m3api.go`).
 * That is an *absence*, and the shared panel's sentence for it — "Ran under
 * unknown enforcement WITHOUT a verified sandbox" — states a fact about how the
 * unit ran that nobody recorded. For a pipeline run's conversation it is a false
 * fact: the attempt's `sandbox.verified` row is journalled with an empty
 * `turn_id` (`AgentTurn.verifiedPayload`) and, because `sandbox.*` is not a
 * transcript type (`runTranscriptType`), with no `conversation_id` either — so
 * it reaches neither this page's stream nor the turn-keyed read. The page can
 * only say that no verdict was recorded here.
 */
export function sandboxVerdictRecorded(record: TurnSandbox | undefined): boolean {
  if (!record) return false;
  return (
    record.stage !== "none" ||
    record.verified ||
    record.enforcement != null ||
    record.workspace_id != null ||
    record.worker_id != null ||
    record.policy_digest != null ||
    (record.grants?.length ?? 0) > 0 ||
    (record.denied_what?.length ?? 0) > 0
  );
}

export default function ConversationPage() {
  const { projectId = "", conversationId = "" } = useParams<{
    projectId: string;
    conversationId: string;
  }>();
  // One session for the whole page: the transcript/composer surface below and
  // the controller line in the rail read the same hooks, and the SSE stream is
  // opened exactly once.
  const session = useConversationSession(conversationId, projectId);
  const { conversation, data, activeTurn, transcript, status, described } = session;

  // "Part of" is read off the journal's own correlation columns (M4 contract
  // § 3): a conversation whose rows name no run shows no run link.
  const runLink = useMemo(() => runLinkOf(session.events), [session.events]);

  // The unit whose enforcement record is worth showing: the API's active turn if
  // there is one, else the newest turn the journal reported. The read is issued
  // with the page's other hooks — a hook below an early return is a different
  // hook order per render, which React refuses.
  const latestTurnId = activeTurn?.id ?? transcript.turns.at(-1)?.turnId ?? "";
  // The same cached read the rail's panel makes: the page asks it only to tell
  // an honest "nothing was recorded" apart from an unverified launch.
  const turnSandbox = useTurnSandbox(latestTurnId);

  if (conversation.isPending) return <Spinner label="Loading conversation" />;

  if (conversation.error instanceof ApiError && conversation.error.status === 404) {
    return (
      <section aria-labelledby="conversation-missing-heading">
        <h1 id="conversation-missing-heading" className="text-title-l font-bold">
          Conversation
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="conversation-not-found">
            Conversation not found or you do not have access
          </span>
        </p>
      </section>
    );
  }

  if (conversation.error || !data) {
    return (
      <section aria-labelledby="conversation-error-heading">
        <h1 id="conversation-error-heading" className="text-title-l font-bold">
          Conversation
        </h1>
        <ProblemBanner
          error={conversation.error}
          fallback="The conversation could not be loaded."
        />
      </section>
    );
  }

  // One description of the turn drives the status line, the interrupted notice
  // and whether the composer may accept a prompt.
  const turnStatus = turnStatusText(transcript.turns, activeTurn);
  const interrupted = described.status === "interrupted";

  return (
    <div className="grid min-w-0 gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      {/* 6d: the transcript is the reading surface and owns the column; the
          context that explains it sits in a narrow rail beside it. */}
      <div className="min-w-0 max-w-[760px] space-y-4" data-testid="conversation-main">
        <header className="space-y-2">
          <p className="font-mono text-[11px] text-muted">
            <Link to={`/projects/${projectId}`} className="text-accent-text hover:text-ink">
              Project
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Conversations</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 data-testid="conversation-title" className="text-title-l font-bold">
              {data.title}
            </h1>
          </div>
          <p className="font-mono text-[11px] text-muted" data-testid="conversation-meta">
            <span>profile: {data.agent_profile_name ?? data.agent_profile_id}</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span>status: {data.status}</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5">
              stream:
              <StatusChip
                state={stateOf(STREAM_STATE[status])}
                label={status}
                labelProps={{ "data-testid": "stream-status", role: "status" }}
              />
            </span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span className="inline-flex items-center gap-1.5">
              turn:
              <StatusChip
                state={stateOf(TURN_STATE[described.status])}
                label={turnStatus}
                labelProps={{ "data-testid": "turn-status" }}
              />
            </span>
            {data.agent_session ? (
              <>
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                <span data-testid="agent-session">
                  agent: {data.agent_session.launcher_id} (
                  {data.agent_session.session_origin === "resumed"
                    ? "resumed session"
                    : "new session"}
                  )
                </span>
              </>
            ) : null}
          </p>
        </header>

        {interrupted ? (
          <Alert state="interrupted" testid="interrupted-notice" meta="you can send a new prompt">
            {interruptedCopy(described.record?.interruptReason ?? null)}
          </Alert>
        ) : null}

        {/* The shared surface: the transcript (permission cards included) and
            the composer. The controller line stays in the rail below. */}
        <AgentConversationPanel
          conversationId={conversationId}
          projectId={projectId}
          variant="page"
          session={session}
          composer={{
            inputId: "conversation-prompt",
            rows: 3,
            nonControllerPlaceholder: "Only the controller can prompt.",
          }}
        />
      </div>

      <aside className="min-w-0 space-y-3" aria-label="Conversation context">
        {runLink ? (
          <Panel title="PART OF" headingId="part-of-heading" headingLevel={2}>
            <div className="space-y-[4px] p-[10px] font-mono text-[11px] text-ink">
              <Link
                to={`/projects/${projectId}/runs/${runLink.runId}`}
                className="text-accent-text hover:text-ink"
                data-testid="part-of-run-link"
              >
                run {shortId(runLink.runId)}
              </Link>
              {runLink.nodeExecutionId ? (
                <span className="block text-faint" data-testid="part-of-node">
                  node execution {shortId(runLink.nodeExecutionId)}
                  {runLink.attemptId ? " · attempt " : ""}
                  {runLink.attemptId ? (
                    // The attempt is a row inside the run the panel already
                    // links, so its id is a link to that run, not a bare hex.
                    <Link
                      to={`/projects/${projectId}/runs/${runLink.runId}`}
                      className="text-accent-text hover:text-ink"
                      data-testid="part-of-attempt-link"
                    >
                      {shortId(runLink.attemptId)}
                    </Link>
                  ) : null}
                </span>
              ) : null}
              <span className="block text-faint">
                ids the journal carried — no run here was inferred
              </span>
            </div>
          </Panel>
        ) : null}
        {/* M3 context rail: what the agent is editing, and what it actually ran
            under. Both read server state — neither is inferred from the stream. */}
        <section aria-labelledby="workspace-rail-heading" className="space-y-2">
          <h2
            id="workspace-rail-heading"
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Workspace
          </h2>
          <div data-testid="workspace-widget">
            <WorkspaceWidget projectId={projectId} conversationId={conversationId} />
          </div>
        </section>
        <section aria-labelledby="sandbox-rail-heading" className="space-y-2">
          <h2
            id="sandbox-rail-heading"
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Sandbox
          </h2>
          {latestTurnId ? (
            turnSandbox.data && !sandboxVerdictRecorded(turnSandbox.data) ? (
              // Pending and unreadable answers stay with the panel, which words
              // them honestly; only the recorded-nothing 200 is rewritten here.
              <p className="text-[12.5px] text-muted" data-testid="sandbox-verdict">
                No sandbox verdict recorded for this conversation — its journal holds no sandbox
                event, so this page cannot say what the agent ran under.
              </p>
            ) : (
              <TurnSandboxPanel turnId={latestTurnId} />
            )
          ) : (
            <p className="text-[12.5px] text-muted" data-testid="sandbox-verdict">
              No turn yet, so nothing has launched and there is no enforcement to report.
            </p>
          )}
        </section>
        {/* The controller line, in words: who is driving, the version the CAS
            token is at, and the only control acts on the page. The shared
            controls read the page's own session. */}
        <section aria-labelledby="controller-rail-heading" className="space-y-2">
          <h2
            id="controller-rail-heading"
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Controller
          </h2>
          <AgentConversationControls
            session={session}
            ids={{
              badge: "controller-badge",
              takeControl: "take-control",
              returnControl: "return-control",
              stopTurn: "stop-turn",
            }}
            showVersionLine
            showDrivingNote
          />
        </section>
      </aside>
    </div>
  );
}
