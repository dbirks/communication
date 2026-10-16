import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useActorNames, mergeLookups, nameLookup } from "../api/actors";
import { ApiError } from "../api/client";
import { useConversationEvents } from "../api/events";
import {
  useConversation,
  useTurnSandbox,
  useCancelConversationTurn,
  useDecideConversationPermission,
  useMe,
  useProject,
  useReturnConversationControl,
  useTakeConversationControl,
  usePostConversationMessage,
} from "../api/queries";
import {
  describeTurn,
  interruptedCopy,
  projectTranscript,
  runLinkOf,
  turnStatusText,
} from "../api/transcript";
import { shortId } from "../api/names";
import type { ConversationControl, PermissionOption, TurnSandbox } from "../api/types";
import Transcript from "../components/Transcript";
import { WorkspaceWidget } from "../components/Workspaces";
import { TurnSandboxPanel } from "../components/Sandbox";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Textarea } from "../components/ds/Field";
import { StatusChip } from "../components/ds/Row";
import { STREAM_STATE, TURN_STATE, stateOf } from "../components/ds/states";

/**
 * Copy for the controller badge — ownership is always written in words.
 *
 * `control.display_name` is server-resolved and usually present, but the API may
 * omit it (an older replica, a member the projection did not name). The page
 * already holds an actor directory, so a named member is named; "another member"
 * is the last resort, and a uuid is never offered as a label.
 */
export function controllerCopy(
  control: ConversationControl,
  isController: boolean,
  nameOf?: (userId: string) => string,
): string {
  if (isController) return "You are in control";
  if (control.kind === "run_attempt") return "Controlled by a pipeline run";
  if (control.kind === "human") {
    const named = control.display_name ?? (control.user_id ? nameOf?.(control.user_id) : undefined);
    // `nameOf` degrades to "someone (abc12345)", which is not a label a badge
    // should wear — the directory either knows this person or says it does not.
    return named && !named.startsWith("someone (")
      ? `Controlled by ${named}`
      : "Controlled by another member";
  }
  return "No controller — take control to drive";
}

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
  const conversation = useConversation(conversationId);
  const me = useMe();
  const { events, status } = useConversationEvents(conversationId);
  const sendMessage = usePostConversationMessage(conversationId);
  const takeControl = useTakeConversationControl(conversationId);
  const returnControl = useReturnConversationControl(conversationId);
  const cancelTurn = useCancelConversationTurn(conversationId);
  const decide = useDecideConversationPermission(conversationId);
  const [prompt, setPrompt] = useState("");
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);

  const data = conversation.data;
  const activeTurn = data?.active_turn;
  const isController = Boolean(
    data && me.data && data.control.kind === "human" && data.control.user_id === me.data.id,
  );
  // Conversation routes do not report the caller's project role, so ask the
  // project (already cached by the page this one was reached from): a viewer may
  // watch but may not take control (`06`, ADR-0016 §8).
  const project = useProject(projectId);
  // While the role is still loading the button renders disabled rather than
  // appearing and vanishing; a viewer never gets an enabled one.
  const roleKnown = project.data !== undefined;
  const canRequestControl = roleKnown ? project.data.my_role !== "viewer" : true;

  // Names come from the shared actor directory (me, users, members) merged
  // with the hints this page holds locally (creator, controller). The last
  // resort is "someone (short-id)", never a bare uuid.
  const actors = useActorNames(projectId);
  const nameOf = useMemo(() => {
    const local = nameLookup([
      ...(data?.created_by_display_name
        ? ([[data.created_by, data.created_by_display_name]] as const)
        : []),
      ...(data?.control.display_name && data.control.user_id
        ? ([[data.control.user_id, data.control.display_name]] as const)
        : []),
    ]);
    const merged = mergeLookups(local, actors.lookup);
    return (userId: string) => merged(userId) ?? actors.nameOf(userId);
  }, [actors, data]);

  // The fold names the people it mentions, so it re-projects when the actor
  // directory lands — an id in a sentence nobody can act on is not information.
  const transcript = useMemo(() => projectTranscript(events, nameOf), [events, nameOf]);
  // "Part of" is read off the journal's own correlation columns (M4 contract
  // § 3): a conversation whose rows name no run shows no run link.
  const runLink = useMemo(() => runLinkOf(events), [events]);

  // The unit whose enforcement record is worth showing: the API's active turn if
  // there is one, else the newest turn the journal reported. The read is issued
  // with the page's other hooks — a hook below an early return is a different
  // hook order per render, which React refuses.
  const latestTurnId = activeTurn?.id ?? transcript.turns.at(-1)?.turnId ?? "";
  // The same cached read the rail's panel makes: the page asks it only to tell
  // an honest "nothing was recorded" apart from an unverified launch.
  const turnSandbox = useTurnSandbox(latestTurnId);

  const onSend = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) return;
    sendMessage.mutate(
      { prompt: trimmed },
      { onSuccess: () => setPrompt("") }, // the reply arrives on the stream, not here
    );
  };

  const onDecide = (requestId: string, option: PermissionOption) => {
    setDecidingRequestId(requestId);
    decide.mutate(
      { requestId, body: { option_id: option.option_id } },
      {
        // The transcript card closes when `conversation.permission.decided`
        // arrives; keeping the id lets a failure name the prompt it belongs to.
        onSuccess: () => setDecidingRequestId(null),
        onError: () => setDecidingRequestId(null),
      },
    );
  };

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

  const control = data.control;
  const badgeText = controllerCopy(control, isController, nameOf);
  // One description of the turn drives the status line, the interrupted notice
  // and whether the composer may accept a prompt.
  const described = describeTurn(transcript.turns, activeTurn);
  const turnStatus = turnStatusText(transcript.turns, activeTurn);
  const interrupted = described.status === "interrupted";
  // `active` is set only while nobody has proved the turn is over: a terminal
  // journal record clears it immediately (the DB would refuse a competing
  // prompt anyway — one active turn per conversation, migration 00003).
  const turnInProgress = Boolean(described.active);
  const controlError = takeControl.error ?? returnControl.error ?? null;

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

        <Transcript
          items={transcript.items}
          agentName={data.agent_profile_name ?? "agent"}
          canDecide={isController}
          controllerName={
            control.display_name ?? (control.user_id ? nameOf(control.user_id) : null)
          }
          nameOf={nameOf}
          onDecide={onDecide}
          decidingRequestId={decidingRequestId}
          decisionError={decide.error}
          decisionErrorRequestId={decide.isError ? (decide.variables?.requestId ?? null) : null}
        />

        <section aria-labelledby="composer-heading" className="space-y-2">
          <h2
            id="composer-heading"
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Prompt
          </h2>
          <form onSubmit={onSend} className="space-y-2">
            <label className="sr-only" htmlFor="conversation-prompt">
              Prompt for the agent
            </label>
            <Textarea
              id="conversation-prompt"
              data-testid="composer-input"
              rows={3}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              disabled={!isController}
              aria-describedby={turnInProgress || !isController ? "composer-explainer" : undefined}
              placeholder={
                isController ? "Ask the agent for something…" : "Only the controller can prompt."
              }
            />
            <Button
              type="submit"
              variant="primary"
              data-testid="composer-send"
              // Enabled for the controller only, and never while a turn is open:
              // the API refuses a second prompt into a running turn (01 invariant,
              // 06 "do not send competing prompts"), so we say so instead of failing.
              disabled={!isController || turnInProgress || sendMessage.isPending || !prompt.trim()}
            >
              {sendMessage.isPending ? "Sending…" : "Send"}
            </Button>
          </form>
          {!isController ? (
            <p
              id="composer-explainer"
              className="text-[12.5px] text-muted"
              data-testid="composer-explainer"
            >
              {!canRequestControl
                ? "You can watch this conversation. Prompting and taking control need a project contributor role."
                : control.kind === "human"
                  ? `Only the controller (${control.display_name ?? nameOf(control.user_id ?? "")}) can send prompts. Take control to drive.`
                  : "Nobody is driving. Take control to send a prompt."}
            </p>
          ) : turnInProgress ? (
            <p
              id="composer-explainer"
              className="text-[12.5px] text-muted"
              data-testid="composer-explainer"
            >
              A turn is already open (status: {activeTurn?.status}). Wait for it to finish, or press
              Stop — a second prompt into the same turn is refused.
            </p>
          ) : null}
          {sendMessage.error ? (
            <FormError error={sendMessage.error} />
          ) : (
            <p className="sr-only" aria-live="polite">
              {sendMessage.isSuccess ? "Prompt queued." : ""}
            </p>
          )}
        </section>
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
            token is at, and the only control acts on the page. */}
        <section aria-labelledby="controller-rail-heading" className="space-y-2">
          <h2
            id="controller-rail-heading"
            className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
          >
            Controller
          </h2>
          <span
            data-testid="controller-badge"
            className="inline-flex h-[22px] items-center rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[10.5px] font-medium text-ink-2"
          >
            {badgeText}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {isController ? (
              <>
                <Button
                  variant="secondaryPlain"
                  data-testid="return-control"
                  disabled={returnControl.isPending || control.kind !== "human"}
                  onClick={() => returnControl.mutate({ version: control.version })}
                >
                  {returnControl.isPending ? "Returning…" : "Return control"}
                </Button>
                {turnInProgress ? (
                  <Button
                    variant="danger"
                    data-testid="stop-turn"
                    disabled={cancelTurn.isPending || Boolean(activeTurn?.cancel_requested_at)}
                    onClick={() => cancelTurn.mutate()}
                  >
                    {cancelTurn.isPending
                      ? "Stopping…"
                      : activeTurn?.cancel_requested_at
                        ? "Stop requested"
                        : "Stop"}
                  </Button>
                ) : null}
              </>
            ) : (
              canRequestControl && (
                <Button
                  variant="primary"
                  data-testid="take-control"
                  disabled={takeControl.isPending || !roleKnown}
                  // The version we last read; a stale one is a 409 we adopt (§9).
                  onClick={() => takeControl.mutate({ version: control.version })}
                >
                  {takeControl.isPending ? "Taking…" : "Take control"}
                </Button>
              )
            )}
            <span className="font-mono text-[11px] text-faint">
              control version: {control.version}
            </span>
          </div>
          {controlError ? <FormError error={controlError} /> : null}
          {cancelTurn.error ? <FormError error={cancelTurn.error} /> : null}
          {isController && takeControl.isSuccess ? (
            <p className="text-[12.5px] text-muted" role="status">
              You are driving this conversation.
            </p>
          ) : null}
        </section>
      </aside>
    </div>
  );
}
