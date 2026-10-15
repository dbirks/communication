import { useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
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
  useUsers,
} from "../api/queries";
import {
  describeTurn,
  interruptedCopy,
  projectTranscript,
  turnStatusText,
} from "../api/transcript";
import type { ConversationControl, PermissionOption } from "../api/types";
import Transcript from "../components/Transcript";
import { FormError, ProblemBanner, Spinner, fieldClass, submitClass } from "../components/Feedback";

const controlButtonClass =
  "rounded border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700 disabled:opacity-50";

const stopButtonClass =
  "rounded border border-red-300 bg-red-50 px-3 py-1.5 text-sm font-medium text-red-900 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-800 disabled:opacity-50";

/** Copy for the controller badge — ownership is always written in words. */
export function controllerCopy(control: ConversationControl, isController: boolean): string {
  if (isController) return "You are in control";
  if (control.kind === "run_attempt") return "Controlled by a pipeline run";
  if (control.kind === "human") {
    return `Controlled by ${control.display_name ?? "another member"}`;
  }
  return "No controller — take control to drive";
}

function shortId(id: string): string {
  return id ? `user ${id.slice(0, 8)}` : "unknown";
}

export default function ConversationPage() {
  const { projectId = "", conversationId = "" } = useParams<{
    projectId: string;
    conversationId: string;
  }>();
  const conversation = useConversation(conversationId);
  const me = useMe();
  const users = useUsers();
  const { events, status } = useConversationEvents(conversationId);
  const sendMessage = usePostConversationMessage(conversationId);
  const takeControl = useTakeConversationControl(conversationId);
  const returnControl = useReturnConversationControl(conversationId);
  const cancelTurn = useCancelConversationTurn(conversationId);
  const decide = useDecideConversationPermission(conversationId);
  const [prompt, setPrompt] = useState("");
  const [decidingRequestId, setDecidingRequestId] = useState<string | null>(null);

  const transcript = useMemo(() => projectTranscript(events), [events]);
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

  const names = useMemo(() => {
    const map = new Map<string, string>();
    if (me.data) map.set(me.data.id, me.data.display_name);
    for (const user of users.data?.items ?? []) map.set(user.id, user.display_name);
    if (data?.created_by_display_name) map.set(data.created_by, data.created_by_display_name);
    if (data?.control.display_name && data.control.user_id) {
      map.set(data.control.user_id, data.control.display_name);
    }
    return map;
  }, [me.data, users.data, data]);

  const nameOf = (userId: string) => names.get(userId) ?? shortId(userId);

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
        <h1 id="conversation-missing-heading" className="text-2xl font-semibold">
          Conversation
        </h1>
        <p className="mt-2 text-red-900" role="alert" data-testid="conversation-not-found">
          Conversation not found or you do not have access
        </p>
      </section>
    );
  }

  if (conversation.error || !data) {
    return (
      <section aria-labelledby="conversation-error-heading">
        <h1 id="conversation-error-heading" className="text-2xl font-semibold">
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
  const badgeText = controllerCopy(control, isController);
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
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-sm text-gray-600">
          <Link to={`/projects/${projectId}`} className="text-blue-800 hover:underline">
            Project
          </Link>
          <span aria-hidden="true"> / </span>
          <span>Conversations</span>
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 data-testid="conversation-title" className="text-2xl font-semibold">
            {data.title}
          </h1>
          <span
            data-testid="controller-badge"
            className="rounded border border-gray-300 px-2 py-0.5 text-sm"
          >
            {badgeText}
          </span>
        </div>
        <p className="text-sm text-gray-600" data-testid="conversation-meta">
          <span>profile: {data.agent_profile_name ?? data.agent_profile_id}</span>
          <span className="px-2" aria-hidden="true">
            ·
          </span>
          <span>status: {data.status}</span>
          <span className="px-2" aria-hidden="true">
            ·
          </span>
          <span>
            stream:{" "}
            <span data-testid="stream-status" role="status" aria-live="polite">
              {status}
            </span>
          </span>
          <span className="px-2" aria-hidden="true">
            ·
          </span>
          <span>
            turn: <span data-testid="turn-status">{turnStatus}</span>
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
              <button
                type="button"
                className={controlButtonClass}
                data-testid="return-control"
                disabled={returnControl.isPending || control.kind !== "human"}
                onClick={() => returnControl.mutate({ version: control.version })}
              >
                {returnControl.isPending ? "Returning…" : "Return control"}
              </button>
              {turnInProgress ? (
                <button
                  type="button"
                  className={stopButtonClass}
                  data-testid="stop-turn"
                  disabled={cancelTurn.isPending || Boolean(activeTurn?.cancel_requested_at)}
                  onClick={() => cancelTurn.mutate()}
                >
                  {cancelTurn.isPending
                    ? "Stopping…"
                    : activeTurn?.cancel_requested_at
                      ? "Stop requested"
                      : "Stop"}
                </button>
              ) : null}
            </>
          ) : (
            canRequestControl && (
              <button
                type="button"
                className={submitClass}
                data-testid="take-control"
                disabled={takeControl.isPending || !roleKnown}
                // The version we last read; a stale one is a 409 we adopt (§9).
                onClick={() => takeControl.mutate({ version: control.version })}
              >
                {takeControl.isPending ? "Taking…" : "Take control"}
              </button>
            )
          )}
          <span className="text-sm text-gray-600">control version: {control.version}</span>
        </div>
        {controlError ? <FormError error={controlError} /> : null}
        {cancelTurn.error ? <FormError error={cancelTurn.error} /> : null}
        {isController && takeControl.isSuccess ? (
          <p className="text-sm text-gray-700" role="status">
            You are driving this conversation.
          </p>
        ) : null}
      </header>

      {interrupted ? (
        <p
          data-testid="interrupted-notice"
          role="status"
          className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          {interruptedCopy(described.record?.interruptReason ?? null)}
        </p>
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

      <section aria-labelledby="composer-heading" className="space-y-2">
        <h2 id="composer-heading" className="text-lg font-semibold">
          Prompt
        </h2>
        <form onSubmit={onSend} className="space-y-2">
          <label className="sr-only" htmlFor="conversation-prompt">
            Prompt for the agent
          </label>
          <textarea
            id="conversation-prompt"
            data-testid="composer-input"
            className={fieldClass}
            rows={3}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={!isController}
            aria-describedby={turnInProgress || !isController ? "composer-explainer" : undefined}
            placeholder={
              isController ? "Ask the agent for something…" : "Only the controller can prompt."
            }
          />
          <button
            type="submit"
            className={submitClass}
            data-testid="composer-send"
            // Enabled for the controller only, and never while a turn is open:
            // the API refuses a second prompt into a running turn (01 invariant,
            // 06 "do not send competing prompts"), so we say so instead of failing.
            disabled={!isController || turnInProgress || sendMessage.isPending || !prompt.trim()}
          >
            {sendMessage.isPending ? "Sending…" : "Send"}
          </button>
        </form>
        {!isController ? (
          <p
            id="composer-explainer"
            className="text-sm text-gray-700"
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
            className="text-sm text-gray-700"
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
