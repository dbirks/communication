import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useActorNames, mergeLookups, nameLookup } from "../api/actors";
import { ApiError } from "../api/client";
import { useConversationEvents } from "../api/events";
import {
  useConversation,
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
  turnStatusText,
} from "../api/transcript";
import type { ConversationControl, PermissionOption } from "../api/types";
import Transcript from "../components/Transcript";
import { WorkspaceWidget } from "../components/Workspaces";
import { TurnSandboxPanel } from "../components/Sandbox";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { Alert } from "../components/ds/Alert";
import { Button } from "../components/ds/Button";
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
  // The unit whose enforcement record is worth showing: the API's active turn if
  // there is one, else the newest turn the journal reported.
  const latestTurnId = activeTurn?.id ?? transcript.turns.at(-1)?.turnId ?? "";
  const controlError = takeControl.error ?? returnControl.error ?? null;

  return (
    <div className="space-y-4">
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
          <span
            data-testid="controller-badge"
            className="inline-flex h-[22px] items-center rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[10.5px] font-medium text-ink-2"
          >
            {badgeText}
          </span>
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
      </header>

      {interrupted ? (
        <Alert state="interrupted" testid="interrupted-notice" meta="you can send a new prompt">
          {interruptedCopy(described.record?.interruptReason ?? null)}
        </Alert>
      ) : null}

      <Transcript
        items={transcript.items}
        canDecide={isController}
        controllerName={control.display_name ?? (control.user_id ? nameOf(control.user_id) : null)}
        nameOf={nameOf}
        onDecide={onDecide}
        decidingRequestId={decidingRequestId}
        decisionError={decide.error}
        decisionErrorRequestId={decide.isError ? (decide.variables?.requestId ?? null) : null}
      />

      {/* M3 context rail: what the agent is editing, and what it actually ran
          under. Both read server state — neither is inferred from the stream. */}
      <div className="grid gap-4 lg:grid-cols-2">
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
            <TurnSandboxPanel turnId={latestTurnId} />
          ) : (
            <p className="text-[12.5px] text-muted" data-testid="sandbox-verdict">
              No turn yet, so nothing has launched and there is no enforcement to report.
            </p>
          )}
        </section>
      </div>

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
  );
}
