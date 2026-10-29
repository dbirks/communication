import { useMemo, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useProject, useTurnSandbox, useWorkspaces } from "../api/queries";
import {
  automationViaWords,
  interruptedCopy,
  runLinkOf,
  submitterCopy,
  turnStatusText,
} from "../api/transcript";
import { formatAge } from "../lib/format";
import { conversationRunHref, instanceLeaf } from "../components/Conversations";
import { shortId } from "../api/names";
import { useRun } from "../api/runs";
import type { TurnSandbox } from "../api/types";
import type { components } from "../api/schema";
import HandToWorkflowDialog from "../components/threads/HandToWorkflowDialog";
import {
  AgentConversationPanel,
  AgentConversationComposer,
  AgentConversationControls,
} from "../components/conversation/AgentConversationPanel";
import Transcript from "../components/Transcript";
import { ThreadListPane } from "../components/threads/ThreadListPane";
import { useConversationSession } from "../components/conversation/useConversationSession";
import { WorkspaceWidget } from "../components/Workspaces";
import { TurnSandboxPanel } from "../components/Sandbox";
import { ThreadArtifacts } from "../components/threads/ThreadArtifacts";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";
import { Panel } from "../components/ds/Panel";
import { Button } from "../components/ds/Button";
import { StatusChip } from "../components/ds/Row";
import { RUN_STATE, STATES, STREAM_STATE, TURN_STATE, stateOf } from "../components/ds/states";
import { routes } from "../lib/routes";

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

export default function ConversationPage({
  projectId: projectIdProp,
}: {
  projectId?: string;
} = {}) {
  const params = useParams<{
    projectId: string;
    conversationId: string;
  }>();
  // The project-less deep link (`/threads/:id`) resolves the project from the
  // conversation itself and passes it here; the legacy path reads it from the
  // URL.
  const projectId = projectIdProp ?? params.projectId ?? "";
  const conversationId = params.conversationId ?? "";
  // Design 1g: `/threads/:id` is the canonical thread address, and there the
  // page renders inside the list pane (the 320px thread list on the left, the
  // thread on the right). The legacy `/p/:id/conversations/:id` page keeps its
  // own standalone two-column shape.
  const location = useLocation();
  const paneMode = location.pathname.startsWith("/threads/");
  // One session for the whole page: the transcript/composer surface below and
  // the controller line in the rail read the same hooks, and the SSE stream is
  // opened exactly once.
  const session = useConversationSession(conversationId, projectId);
  const { conversation, data, activeTurn, transcript, status, described } = session;
  // The header's meta line names the project in words (`thread · Widgets ·
  // Claude Code · 12m`); the deep link resolves the id from the conversation
  // itself, so the read is enabled only once a real id is in hand.
  const project = useProject(projectId);

  // "Part of" is read off the journal's own correlation columns (M4 contract
  // § 3): a conversation whose rows name no run shows no run link.
  const runLink = useMemo(() => runLinkOf(session.events), [session.events]);
  // The API's own answer (ADR-0043) outranks the journal read: it names the
  // node execution and attempt number the workbench deep link needs, which
  // the journal's correlation columns do not carry.
  const apiRunLink = data?.run_link ?? null;

  // The unit whose enforcement record is worth showing: the API's active turn if
  // there is one, else the newest turn the journal reported. The read is issued
  // with the page's other hooks — a hook below an early return is a different
  // hook order per render, which React refuses.
  const latestTurnId = activeTurn?.id ?? transcript.turns.at(-1)?.turnId ?? "";
  // The same cached read the rail's panel makes: the page asks it only to tell
  // an honest "nothing was recorded" apart from an unverified launch.
  const turnSandbox = useTurnSandbox(latestTurnId);
  // The pane header's `repo · branch · agent` line reads the conversation's own
  // workspace — the same cached list the rail's WorkspaceWidget already makes,
  // so this is one query with a second pair of eyes, never an invented ref.
  const workspaces = useWorkspaces(projectId);
  // The handoff dialog, the run it just started and the draft-PR confirmation
  // are page-local: the durable reads are the conversation refetch (whose
  // `linked_runs` is the run list) and the transcript, where the agent's reply
  // to a draft-PR prompt — the only proof of a PR — appears.
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [startedRunId, setStartedRunId] = useState<string | null>(null);
  const [draftPrConfirm, setDraftPrConfirm] = useState(false);
  const [draftPrError, setDraftPrError] = useState<string | null>(null);
  const [draftPrSent, setDraftPrSent] = useState(false);

  const sendDraftPrPrompt = () => {
    setDraftPrError(null);
    session.sendMessage.mutate(
      { prompt: DRAFT_PR_PROMPT },
      {
        onSuccess: () => {
          setDraftPrConfirm(false);
          setDraftPrSent(true);
        },
        onError: (error) => {
          setDraftPrConfirm(false);
          setDraftPrSent(false);
          setDraftPrError(error instanceof Error ? error.message : String(error));
        },
      },
    );
  };

  if (conversation.isPending) return <Spinner label="Loading conversation" />;

  if (conversation.error instanceof ApiError && conversation.error.status === 404) {
    return (
      <section aria-labelledby="conversation-missing-heading">
        <h1 id="conversation-missing-heading" className="text-title-l font-bold">
          Thread
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="conversation-not-found">
            Thread not found or you do not have access
          </span>
        </p>
      </section>
    );
  }

  if (conversation.error || !data) {
    return (
      <section aria-labelledby="conversation-error-heading">
        <h1 id="conversation-error-heading" className="text-title-l font-bold">
          Thread
        </h1>
        <ProblemBanner error={conversation.error} fallback="The thread could not be loaded." />
      </section>
    );
  }

  // One description of the turn drives the status line, the interrupted notice
  // and whether the composer may accept a prompt.
  const turnStatus = turnStatusText(transcript.turns, activeTurn);
  const interrupted = described.status === "interrupted";
  // ADR-0062: `active_turn.submitted_by` is the person who typed the prompt only
  // when the row says `submitted_via: human`. For a fired run's turn it is the
  // member who authorised the schedule or the issue trigger, and the meta line
  // says so — an unattended thread has no prompt row at all, so this is the one
  // place the page can be honest about who this turn is running for.
  const activeVia = activeTurn?.submitted_via;
  const turnOrigin = automationViaWords(activeVia)
    ? submitterCopy(
        activeTurn?.submitted_by_display_name || session.nameOf(activeTurn?.submitted_by ?? ""),
        activeVia,
      )
    : null;

  // The pane header's `repo · branch · agent` line, from the reads only: the
  // workspace row the worker wrote for this thread, never a guess. An absent
  // read says so ("workspace…", "no workspace yet") — the design's invented
  // `storefront · branch thread/fix-flaky-checkout-test` is what the wire can
  // serve when the thread has one.
  const threadWorkspace = (workspaces.data?.workspaces ?? []).find(
    (workspace) => workspace.conversation_id === conversationId,
  );
  const workspaceRepos = threadWorkspace?.repos ?? [];
  const repoLabel = workspaces.error
    ? "workspace unavailable"
    : !workspaces.data
      ? "workspace…"
      : !threadWorkspace
        ? "no workspace yet"
        : workspaceRepos.length === 0
          ? "no repository attached"
          : workspaceRepos.length === 1
            ? workspaceRepos[0].name
            : `${workspaceRepos[0].name} +${workspaceRepos.length - 1}`;
  const threadBranch = workspaceRepos[0]?.run_ref ?? "";

  const rail = (
    <aside className="min-w-0 space-y-3" aria-label="Thread context">
      {/* Where this transcript was opened (ADR-0043): a manual conversation
          never carries a run or graph link, and a run conversation deep-links
          into the Run Workbench — the API's run_link first, the journal's
          own correlation columns as the fallback the older rows rely on. */}
      {data.origin !== "manual" && apiRunLink ? (
        <Panel title="PART OF" headingId="part-of-heading" headingLevel={2}>
          <div className="space-y-[4px] p-[10px] font-mono text-[11px] text-ink">
            <Link
              to={conversationRunHref(apiRunLink)}
              className="text-accent-text hover:text-ink"
              data-testid="part-of-run-link"
            >
              run {apiRunLink.run_title || shortId(apiRunLink.run_id)}
            </Link>
            <span className="block text-faint" data-testid="part-of-node">
              node {apiRunLink.node_id || instanceLeaf(apiRunLink.node_instance_key)} · execution{" "}
              {shortId(apiRunLink.node_execution_id)} · attempt {apiRunLink.attempt_number}
            </span>
          </div>
        </Panel>
      ) : data.origin !== "manual" && runLink ? (
        <Panel title="PART OF" headingId="part-of-heading" headingLevel={2}>
          <div className="space-y-[4px] p-[10px] font-mono text-[11px] text-ink">
            <Link
              to={routes.run(runLink.runId)}
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
                    to={routes.run(runLink.runId)}
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
        {/* 4f: the sandbox verdict reads with the workspace — it is the
            enforcement the workspace ran under, so it stays in one place. */}
        <div aria-labelledby="sandbox-rail-heading">
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
        </div>
      </section>
      {/* 4f ARTIFACTS: the thread's own artifacts, up to a rail page of five —
          the project's artifact list filtered by conversation
          (`?conversation_id=`, which resolves the thread before filtering), via
          the shared ThreadArtifacts rail section. */}
      <section aria-labelledby="artifacts-rail-heading" className="space-y-2">
        <h2
          id="artifacts-rail-heading"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          Artifacts
        </h2>
        <ThreadArtifacts projectId={projectId} conversationId={conversationId} />
        <Link
          to={routes.projectTab(projectId, "artifacts")}
          className="inline-block font-mono text-[11px] text-accent-text hover:text-ink"
          data-testid="artifacts-project-link"
        >
          See the project's artifacts →
        </Link>
      </section>
      {/* 4f NEXT: the follow-ups a thread offers — handing it to a workflow
          (ADR-0053), the runs it already started, and (for the controller)
          asking the agent to open a draft PR (ADR-0045). */}
      <section aria-labelledby="next-rail-heading" className="space-y-2">
        <h2
          id="next-rail-heading"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          Next
        </h2>
        <div className="space-y-2" data-testid="thread-next-handoff">
          <Button
            variant="primary"
            onClick={() => setHandoffOpen(true)}
            data-testid="hand-to-workflow"
          >
            Hand to a workflow…
          </Button>
          <p className="font-mono text-[10.5px] text-faint" data-testid="hand-to-workflow-note">
            Starts a run from this thread's branch, fresh agent sessions — the thread stays open and
            links to the run.
          </p>
          {startedRunId ? (
            <p className="text-[12.5px] text-ink" role="status">
              <Link
                to={routes.run(startedRunId)}
                className="text-accent-text hover:text-ink"
                data-testid="thread-handoff-started"
              >
                Run #{shortId(startedRunId)} started
              </Link>
            </p>
          ) : null}
        </div>
        {/* The runs this thread started, straight from the API's own list
            (ADR-0053 `linked_runs`); the thread stays open, so this list
            grows without the transcript changing. Hidden while empty — and
            for an image of the API that predates the field, missing. */}
        {(data.linked_runs ?? []).length > 0 ? (
          <div className="space-y-1.5" data-testid="thread-linked-runs">
            <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
              Linked runs
            </span>
            {(data.linked_runs ?? []).map((linked, index) => (
              <LinkedRunRow key={linked.run_id} index={index} run={linked} />
            ))}
          </div>
        ) : null}
        {/* ADR-0045: the platform has no push code — this only sends the
            agent a prompt to push and open a draft PR with the token on its
            profile. Only the controller may ask; a reply with a URL in the
            transcript is the only proof a PR exists. */}
        {session.isController ? (
          <div className="space-y-2" data-testid="thread-draft-pr">
            <Button
              variant="secondary"
              onClick={() => {
                setDraftPrConfirm(true);
                setDraftPrError(null);
                setDraftPrSent(false);
              }}
              data-testid="thread-draft-pr-open"
            >
              Open a draft PR from this branch
            </Button>
            {draftPrConfirm ? (
              <div
                className="space-y-2 rounded-[3px] border border-line p-3"
                data-testid="thread-draft-pr-confirm"
                aria-label="Confirm the draft-PR prompt"
              >
                <p className="text-[12.5px] text-ink">
                  This asks the agent to push its branch and open a draft PR with the GitHub token
                  on its profile. It only works if the profile's account holds a token and the
                  worker's egress allows github.com.
                </p>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setDraftPrConfirm(false)}
                    data-testid="thread-draft-pr-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={sendDraftPrPrompt}
                    disabled={session.sendMessage.isPending}
                    data-testid="thread-draft-pr-send"
                  >
                    {session.sendMessage.isPending ? "Sending…" : "Send"}
                  </Button>
                </div>
              </div>
            ) : null}
            {draftPrSent ? (
              <p
                className="text-[12.5px] text-muted"
                role="status"
                data-testid="thread-draft-pr-sent"
              >
                Prompt sent — the agent's reply appears in the transcript. A draft PR exists only if
                its URL shows up there.
              </p>
            ) : null}
            {draftPrError ? (
              <p
                className="text-[12.5px] text-st-failed-tag-fg"
                role="alert"
                data-testid="thread-draft-pr-error"
              >
                The prompt was not sent: {draftPrError}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-[12.5px] text-muted" data-testid="thread-draft-pr">
            Open a draft PR from this branch — Take control to ask the agent.
          </p>
        )}
      </section>
      <HandToWorkflowDialog
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        conversation={{ id: conversationId, project_id: projectId, title: data.title }}
        onStarted={(runId) => {
          setStartedRunId(runId);
          // The thread stays open; the refetch is where its `linked_runs`
          // grows (ADR-0053), which is where the rail's list reads from.
          void session.conversation.refetch();
        }}
      />
    </aside>
  );

  // ------------------------------------------------------------- pane mode
  if (paneMode) {
    // Design 1g header: the title owns one full-width line with the mono
    // `repo · branch · agent` line under it, and the right holds only the
    // control pill and the control acts (Stop while a turn runs, else
    // Return / Take control). The stream state is a glyph — the word shows
    // only when the stream is not live — and the turn reads as one quiet
    // mono word, so no pile of chips squeezes the title any more. The
    // "One-off thread" chip is gone with the one-off-only default (the
    // legacy `/p/:id/conversations/:id` page keeps its full meta line).
    const turnSpec = STATES[stateOf(TURN_STATE[described.status])];
    const streamSpec = STATES[stateOf(STREAM_STATE[status])];
    // The shared controls stack their badge over their buttons (rail
    // styling); the pane header wears them as one pill-then-buttons row,
    // restyled from here because the component itself is shared.
    const pillRow =
      "[&>div:first-child]:flex [&>div:first-child]:flex-wrap [&>div:first-child]:items-center " +
      "[&>div:first-child]:justify-end [&>div:first-child]:gap-2 [&>div:first-child]:space-y-0! " +
      "[&>div:not(:first-child)]:basis-full";
    const pillSkin = session.isController
      ? "[&>div:first-child>span:first-child]:h-[24px] " +
        "[&>div:first-child>span:first-child]:border-accent-edge " +
        "[&>div:first-child>span:first-child]:bg-accent-wash " +
        "[&>div:first-child>span:first-child]:text-accent-text " +
        "[&>div:first-child>span:first-child]:before:mr-[6px] " +
        "[&>div:first-child>span:first-child]:before:content-['●']"
      : "";
    return (
      <div
        className="flex h-[calc(100vh-44px)] min-w-0 flex-col overflow-hidden bg-paper md:h-screen lg:flex-row"
        data-testid="thread-pane-page"
      >
        <div
          className="hidden w-[320px] shrink-0 border-r border-line-strong lg:block"
          data-testid="thread-list-pane"
        >
          <ThreadListPane selectedId={conversationId} />
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="shrink-0 border-b border-line-strong bg-surface px-5 pt-[10px] pb-[12px] lg:px-6">
            <Link
              to={routes.threads()}
              className="mb-2 inline-block font-mono text-[11px] text-accent-text hover:text-ink lg:hidden"
              data-testid="threads-back"
            >
              ← Threads
            </Link>
            {/* Below the pane's `lg` stack breakpoint the header is a
                column: title (full width, wrapping rather than truncating to
                a word), then the pill and the acts on their own row. At
                `lg+` they share one row again — the design's shape. */}
            <div className="flex flex-col gap-x-4 lg:flex-row lg:items-center">
              <h1
                data-testid="conversation-title"
                className="line-clamp-2 text-title-m font-semibold lg:min-w-0 lg:flex-1 lg:line-clamp-none lg:truncate"
              >
                {data.title}
              </h1>
              {/* The control line (1g): only the pill and the acts ride the
                  title row — `You are in control` keeps its exact wording for
                  the journey suites, and Stop (danger) appears only while a
                  turn runs. */}
              <div
                className={`${pillRow} ${pillSkin} mt-[6px] flex max-w-full flex-wrap items-center justify-end gap-2 lg:mt-0 lg:shrink-0`}
              >
                <AgentConversationControls
                  session={session}
                  ids={{
                    badge: "controller-badge",
                    takeControl: "take-control",
                    returnControl: "return-control",
                    stopTurn: "stop-turn",
                  }}
                />
              </div>
            </div>
            {/* The meta line is full width; the quiet state readout shares its
                flow below `lg` (one line after the other, never a floated
                narrow column) and sits at the line's right at `lg+`. */}
            <div className="mt-[2px] lg:flex lg:flex-wrap lg:items-baseline lg:justify-between lg:gap-x-4">
              <p
                className="font-mono text-[10.5px] leading-[1.6] text-muted lg:min-w-0 lg:flex-1"
                data-testid="conversation-meta"
              >
                <span>{repoLabel}</span>
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                <span data-testid="thread-branch">
                  {threadBranch ? `branch ${threadBranch}` : "no branch recorded"}
                </span>
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                <span>{data.agent_profile_name ?? "agent"}</span>
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                <span data-testid="thread-age">{formatAge(data.created_at)}</span>
                {turnOrigin ? (
                  <>
                    <span className="px-2" aria-hidden="true">
                      ·
                    </span>
                    <span data-testid="turn-origin">{turnOrigin}</span>
                  </>
                ) : null}
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
              {/* The quiet state readout (1g): the turn is one short mono word
                  with its glyph, and the stream is a glyph whose word appears
                  only when the connection is not live — never a chip row. */}
              <span className="mt-[3px] inline-flex items-center gap-[6px] font-mono text-[10.5px] lg:mt-0 lg:shrink-0">
                <span aria-hidden="true" className={turnSpec.tagFg}>
                  {turnSpec.glyph}
                </span>
                <span data-testid="turn-status" className="text-faint">
                  {turnStatus}
                </span>
                <span aria-hidden="true" className="px-1 text-faint">
                  ·
                </span>
                <span data-testid="stream-status" role="status" className={streamSpec.tagFg}>
                  <span aria-hidden="true">{streamSpec.glyph}</span>
                  {status === "live" ? (
                    <span className="sr-only">live</span>
                  ) : (
                    <span> {status}</span>
                  )}
                </span>
              </span>
            </div>
          </header>
          {/* The transcript column (max 720px) is the pane's only scroller;
              the thread context (workspace, artifacts, next) rides at the
              column's end, so it stays reachable without ever pushing the
              composer off the bottom of the pane. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6 lg:px-6">
            <div className="w-full min-w-0 max-w-[720px] space-y-3" data-testid="conversation-main">
              {interrupted ? (
                <Alert
                  state="interrupted"
                  testid="interrupted-notice"
                  meta="you can send a new prompt"
                >
                  {interruptedCopy(described.record?.interruptReason ?? null)}
                </Alert>
              ) : null}
              <Transcript
                items={session.transcript.items}
                agentName={data.agent_profile_name ?? "agent"}
                canDecide={session.isController}
                controllerName={
                  data.control.display_name ??
                  (data.control.user_id ? session.nameOf(data.control.user_id) : null)
                }
                nameOf={session.nameOf}
                onDecide={session.onDecide}
                decidingRequestId={session.decidingRequestId}
                decisionError={session.decide.error}
                decisionErrorRequestId={
                  session.decide.isError ? (session.decide.variables?.requestId ?? null) : null
                }
              />
            </div>
            <div className="mt-4 min-w-0 max-w-[720px]" data-testid="thread-context-block">
              {rail}
            </div>
          </div>
          {/* The composer pins to the bottom of the pane (1g): the last thing
              on the column, visible without scrolling at any width, the ink
              box with the hard shadow riding above the transcript. */}
          <div
            className="shrink-0 bg-paper px-5 pt-2 pb-4 lg:px-6 [&_form]:flex [&_form]:flex-wrap [&_form]:items-center [&_form]:gap-2 [&_form]:rounded-[3px] [&_form]:border [&_form]:border-ink [&_form]:bg-surface [&_form]:p-2 [&_form]:shadow-(--shadow-raised) [&_textarea]:min-w-[180px] [&_textarea]:flex-1 [&_textarea]:resize-none [&_textarea]:border-0 [&_textarea]:bg-transparent [&_textarea]:px-1"
            data-testid="thread-composer-pin"
          >
            <div className="w-full max-w-[720px]">
              <AgentConversationComposer
                session={session}
                ids={{
                  composerInput: "composer-input",
                  composerSend: "composer-send",
                  composerExplainer: "composer-explainer",
                }}
                inputId="conversation-prompt"
                rows={1}
                nonControllerPlaceholder="Only the controller can prompt."
              />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-w-0 gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      {/* 6d: the transcript is the reading surface and owns the column; the
          context that explains it sits in a narrow rail beside it. */}
      <div className="min-w-0 max-w-[820px] space-y-4" data-testid="conversation-main">
        <header className="space-y-2">
          <p className="font-mono text-[11px] text-muted">
            <Link to={routes.project(projectId)} className="text-accent-text hover:text-ink">
              Project
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Threads</span>
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 data-testid="conversation-title" className="text-title-l font-bold">
              {data.title}
            </h1>
            {/* 4f: the control line lives with the title — the "You are in
                control" pill and the danger Stop sit in the header, and the
                same shared controls (take / return / stop) render there with
                the page's historical testids. */}
            <AgentConversationControls
              session={session}
              ids={{
                badge: "controller-badge",
                takeControl: "take-control",
                returnControl: "return-control",
                stopTurn: "stop-turn",
              }}
              showVersionLine
            />
          </div>
          <p className="font-mono text-[11px] text-muted" data-testid="conversation-meta">
            <span>thread</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span>{project.data?.name ?? (project.isPending ? "…" : projectId)}</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span>{data.agent_profile_name ?? data.agent_profile_id}</span>
            <span className="px-2" aria-hidden="true">
              ·
            </span>
            <span data-testid="thread-age">{formatAge(data.created_at)}</span>
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
            {turnOrigin ? (
              <>
                <span className="px-2" aria-hidden="true">
                  ·
                </span>
                <span data-testid="turn-origin">{turnOrigin}</span>
              </>
            ) : null}
            {data.origin === "manual" ? (
              <span
                className="rounded-[2px] border border-line bg-surface px-[6px] py-[1px] font-mono text-[10.5px] text-muted"
                data-testid="conversation-manual-label"
              >
                One-off thread
              </span>
            ) : null}
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

      {rail}
    </div>
  );
}

/**
 * The exact prompt the "Open a draft PR" confirm card sends (ADR-0045):
 * the platform has no push code, so the ask rides the ordinary message path
 * and the only proof of a PR is a URL in the transcript.
 */
export const DRAFT_PR_PROMPT =
  "Please push your current branch to origin and open a DRAFT pull request against the default branch using the GitHub CLI or API with your configured token. Reply with the PR URL, or explain exactly why you couldn't.";

/**
 * One row of the LINKED RUNS list (ADR-0053 `linked_runs`): the run's status
 * read from `GET /runs/{id}` (the list row itself carries no status, only the
 * handoff moment), its age from `created_at`, and the workbench link. A failed
 * status read says so instead of guessing a colour.
 */
function LinkedRunRow({
  index,
  run,
}: {
  index: number;
  run: components["schemas"]["ConversationLinkedRun"];
}) {
  const detail = useRun(run.run_id);
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px]">
      {detail.data ? (
        <StatusChip
          state={stateOf(RUN_STATE[detail.data.status])}
          label={detail.data.status}
          labelProps={{ "data-testid": `thread-linked-run-status-${index}` }}
        />
      ) : detail.isError ? (
        <span className="text-muted" data-testid={`thread-linked-run-status-${index}`}>
          status unavailable
        </span>
      ) : (
        <span className="text-faint">status…</span>
      )}
      <span className="text-faint">{formatAge(run.created_at)}</span>
      <Link
        to={routes.run(run.run_id)}
        className="text-accent-text hover:text-ink"
        data-testid={`thread-linked-run-link-${index}`}
      >
        run {shortId(run.run_id)}
      </Link>
    </div>
  );
}
