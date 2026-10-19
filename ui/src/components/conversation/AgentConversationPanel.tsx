/**
 * The shared "live ACP conversation with controls" surface.
 *
 * Two places used to implement it — the conversation page
 * (`pages/Conversation.tsx`) and the attempt pane's agent work
 * (`components/m4/AttemptDetail.tsx`) — with the same hooks, the same
 * controller badge, the same take / return / stop buttons, the same
 * transcript and the same composer. The Run Workbench dock needs exactly this
 * too, so it exists once here: the session logic lives in
 * `useConversationSession`, and this file renders it three ways:
 *
 * - `AgentConversationPanel` — the whole surface. `variant="dock"` draws a
 *   compact header with an "Open full conversation" link, the control banner,
 *   the transcript and the composer; `variant="page"` draws only the reading
 *   surface (transcript + composer) because the page keeps its two-column
 *   layout and renders the controls in its context rail itself.
 * - `AgentConversationControls` — the controller badge and the control
 *   buttons, for the page's rail.
 * - `AgentConversationComposer` — the prompt form.
 *
 * Callers that render a part and the panel from one session pass `session`
 * through; the panel computes its own session only when none is supplied.
 * Every historical `data-testid` is preserved via the `ids` overrides.
 */
import { type ReactNode } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import { Button } from "../ds/Button";
import { Textarea } from "../ds/Field";
import Transcript from "../Transcript";
import { useConversationSession, type ConversationSession } from "./useConversationSession";
import type { ConversationControl } from "../../api/types";
import type { TranscriptItem } from "../../api/transcript";

/**
 * Copy for the controller badge — ownership is always written in words.
 *
 * `control.display_name` is server-resolved and usually present, but the API may
 * omit it (an older replica, a member the projection did not name). The session
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
 * The stable hooks each surface wears. The page keeps the ids the browser QA
 * and vitest suites have always found — data-testid="controller-badge",
 * data-testid="take-control", data-testid="return-control",
 * data-testid="stop-turn", data-testid="composer-input",
 * data-testid="composer-send", data-testid="composer-explainer" — and the
 * attempt pane keeps its historical `attempt-*` ids via an override. New
 * surfaces may add ids freely — never rename or drop one.
 */
export interface ConversationPanelIds {
  /** The control-banner wrapper (the attempt pane); the page has no wrapper. */
  controlBanner: string | null;
  /** The inline stream-state readout (the attempt pane). */
  stream: string | null;
  /** The controller badge ("who is driving"). */
  badge: string;
  takeControl: string;
  returnControl: string;
  stopTurn: string;
  /** The composer form wrapper; null draws the form without a testid. */
  composerForm: string | null;
  composerInput: string;
  composerSend: string;
  composerExplainer: string;
}

const PAGE_PANEL_IDS: ConversationPanelIds = {
  controlBanner: null,
  stream: null,
  badge: "controller-badge",
  takeControl: "take-control",
  returnControl: "return-control",
  stopTurn: "stop-turn",
  composerForm: null,
  composerInput: "composer-input",
  composerSend: "composer-send",
  composerExplainer: "composer-explainer",
};

interface ControlsProps {
  session: ConversationSession;
  ids: Pick<ConversationPanelIds, "badge" | "takeControl" | "returnControl" | "stopTurn"> &
    Partial<Pick<ConversationPanelIds, "controlBanner" | "stream">>;
  /** Append "· you are watching" to the badge (the attempt pane). */
  watching?: boolean;
  /** A viewer gets a disabled button plus the composer's explainer, not none. */
  disabledTakeForViewer?: boolean;
  /** The page rail: "control version: N" under the buttons. */
  showVersionLine?: boolean;
  /** The page rail: the "You are driving this conversation." note. */
  showDrivingNote?: boolean;
}

/** The controller badge and the only control acts: take, return, stop. */
export function AgentConversationControls({
  session,
  ids,
  watching = false,
  disabledTakeForViewer = false,
  showVersionLine = false,
  showDrivingNote = false,
}: ControlsProps) {
  const {
    data,
    control,
    isController,
    roleKnown,
    canRequestControl,
    turnInProgress,
    activeTurn,
    status,
    nameOf,
    takeControl,
    returnControl,
    cancelTurn,
  } = session;
  if (!data || !control) return null;

  const badge = (
    <span
      data-testid={ids.badge}
      className={
        ids.controlBanner
          ? "min-w-0 text-[12px] font-semibold"
          : "inline-flex h-[22px] items-center rounded-[3px] border border-line-strong bg-surface px-2 font-mono text-[10.5px] font-medium text-ink-2"
      }
    >
      {controllerCopy(control, isController, nameOf)}
      {watching ? <span className="ml-1 font-normal text-muted">· you are watching</span> : null}
    </span>
  );

  // The version we last read; a stale one is a 409 we adopt (§9).
  const takeButton = (
    <Button
      variant="primary"
      data-testid={ids.takeControl}
      disabled={takeControl.isPending || !roleKnown || !canRequestControl}
      onClick={() => takeControl.mutate({ version: control.version })}
    >
      {takeControl.isPending ? "Taking…" : "Take control"}
    </Button>
  );

  const actions = (
    <span className="flex flex-wrap items-center gap-2">
      {ids.stream ? (
        <span className="font-mono text-[10.5px] text-faint" data-testid={ids.stream}>
          {status}
        </span>
      ) : null}
      {isController ? (
        <>
          <Button
            variant="secondaryPlain"
            data-testid={ids.returnControl}
            disabled={returnControl.isPending || control.kind !== "human"}
            onClick={() => returnControl.mutate({ version: control.version })}
          >
            {returnControl.isPending ? "Returning…" : "Return control"}
          </Button>
          {turnInProgress ? (
            <Button
              variant="danger"
              data-testid={ids.stopTurn}
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
      ) : canRequestControl || disabledTakeForViewer ? (
        takeButton
      ) : null}
      {showVersionLine ? (
        <span className="font-mono text-[11px] text-faint">control version: {control.version}</span>
      ) : null}
    </span>
  );

  const controlError = takeControl.error ?? returnControl.error ?? null;

  return (
    <>
      {ids.controlBanner ? (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-[3px] border border-line-strong bg-surface px-[8px] py-[6px]"
          data-testid={ids.controlBanner}
        >
          {badge}
          {actions}
        </div>
      ) : (
        <div className="space-y-2">
          {badge}
          {actions}
        </div>
      )}
      {controlError ? <FormError error={controlError} /> : null}
      {cancelTurn.error ? <FormError error={cancelTurn.error} /> : null}
      {showDrivingNote && isController && takeControl.isSuccess ? (
        <p className="text-[12.5px] text-muted" role="status">
          You are driving this conversation.
        </p>
      ) : null}
    </>
  );
}

interface ComposerProps {
  session: ConversationSession;
  ids: Pick<ConversationPanelIds, "composerInput" | "composerSend" | "composerExplainer"> &
    Partial<Pick<ConversationPanelIds, "composerForm">>;
  inputId: string;
  rows: number;
  /** Placeholder a non-controller reads in the input. */
  nonControllerPlaceholder: string;
  /** The page's "Prompt" heading; the dock keeps the form compact. */
  heading?: boolean;
}

/** The prompt form: enabled for the controller only, with the explainer copy. */
export function AgentConversationComposer({
  session,
  ids,
  inputId,
  rows,
  nonControllerPlaceholder,
  heading = false,
}: ComposerProps) {
  const {
    control,
    isController,
    canRequestControl,
    turnInProgress,
    activeTurn,
    nameOf,
    prompt,
    setPrompt,
    onSend,
    sendMessage,
  } = session;
  const explainerId = `${ids.composerExplainer}-copy`;
  return (
    <section aria-labelledby={heading ? "composer-heading" : undefined} className="space-y-2">
      {heading ? (
        <h2
          id="composer-heading"
          className="font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted"
        >
          Prompt
        </h2>
      ) : null}
      <form onSubmit={onSend} className="space-y-2" data-testid={ids.composerForm ?? undefined}>
        <label className="sr-only" htmlFor={inputId}>
          Prompt for the agent
        </label>
        <Textarea
          id={inputId}
          data-testid={ids.composerInput}
          rows={rows}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          disabled={!isController}
          aria-describedby={turnInProgress || !isController ? explainerId : undefined}
          placeholder={isController ? "Ask the agent for something…" : nonControllerPlaceholder}
        />
        <Button
          type="submit"
          variant="primary"
          data-testid={ids.composerSend}
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
          id={explainerId}
          className="text-[12.5px] text-muted"
          data-testid={ids.composerExplainer}
        >
          {!canRequestControl
            ? "You can watch this conversation. Prompting and taking control need a project contributor role."
            : control?.kind === "human"
              ? `Only the controller (${control.display_name ?? nameOf(control.user_id ?? "")}) can send prompts. Take control to drive.`
              : "Nobody is driving. Take control to send a prompt."}
        </p>
      ) : turnInProgress ? (
        <p
          id={explainerId}
          className="text-[12.5px] text-muted"
          data-testid={ids.composerExplainer}
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
  );
}

export interface AgentConversationPanelProps {
  conversationId: string;
  projectId: string;
  variant: "page" | "dock";
  /** A session the caller already computed (the page renders the controls in
   *  its rail from the same one); the panel computes its own only if absent. */
  session?: ConversationSession;
  /** Show only the transcript items of this turn (the attempt pane). */
  turnFilter?: string;
  /**
   * The turn this surface's attempt ran (the Run Workbench dock). The
   * transcript still shows the WHOLE conversation — a takeover opens a new
   * turn in the same conversation — but a marker row is inserted where that
   * turn begins, and every turn a human started (a user message) is marked
   * with the person's name. `null` items keep journal order.
   */
  attemptTurnId?: string;
  /** Compact dock header content, next to "Open full conversation". */
  header?: ReactNode;
  /** Dock: the "Open full conversation" target (defaults to the page). */
  openFullHref?: string;
  /** Id/copy overrides; the attempt pane keeps its historical testids. */
  ids?: Partial<ConversationPanelIds>;
  /** Badge suffix "· you are watching" (the attempt pane). */
  watching?: boolean;
  /** Rendered instead of an empty transcript. */
  empty?: { testid: string; copy: string };
  /** Rendered while the conversation read is pending. */
  pending?: ReactNode;
  /** Rendered when the API answers 404 (the page's full not-found view). */
  notFound?: ReactNode;
  /** ProblemBanner fallback when the conversation cannot be read. */
  errorFallback?: string;
  composer?: {
    inputId: string;
    rows: number;
    nonControllerPlaceholder: string;
  };
}

/**
 * The whole-conversation transcript for a surface bound to one attempt turn.
 *
 * A takeover cancels the attempt's turn and opens a NEW one in the same
 * conversation, so the dock shows every turn; this inserts a marker row
 * before the first frame of (a) the attempt's own turn and (b) each turn a
 * human started — the journal only ever records `conversation.message.user`
 * for real members, so a user message is proof a human took over and
 * prompted. Markers are plain system rows, so they render through the same
 * journal styling as everything the stream itself wrote.
 */
function markTurns(
  items: TranscriptItem[],
  attemptTurnId: string | undefined,
  nameOf: (userId: string) => string,
): TranscriptItem[] {
  if (!attemptTurnId) return items;
  const authorByTurn = new Map<string, string>();
  for (const item of items) {
    if (item.kind === "user" && item.turnId) {
      authorByTurn.set(item.turnId, item.authorUserId);
    }
  }
  const out: TranscriptItem[] = [];
  let lastTurn: string | null = null;
  for (const item of items) {
    const turn = "turnId" in item ? item.turnId : null;
    if (turn !== null && turn !== lastTurn) {
      lastTurn = turn;
      const author = authorByTurn.get(turn);
      const labels: string[] = [];
      if (author) labels.push(`human turn — prompted by ${nameOf(author)}`);
      if (turn === attemptTurnId) labels.push("this attempt's turn starts here");
      if (labels.length > 0) {
        out.push({
          kind: "system",
          id: `mark-turn-${turn}`,
          text: labels.join(" · "),
          at: "at" in item ? item.at : "",
        });
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * The whole conversation surface: compact header and controls (dock only),
 * the transcript — permission cards included — and the composer.
 */
export function AgentConversationPanel(props: AgentConversationPanelProps) {
  if (props.session) {
    return <PanelInner {...props} session={props.session} />;
  }
  return <PanelWithOwnSession {...props} />;
}

/** Hook isolation: the session is computed here, not conditionally. */
function PanelWithOwnSession(props: Omit<AgentConversationPanelProps, "session">) {
  const session = useConversationSession(props.conversationId, props.projectId);
  return <PanelInner {...props} session={session} />;
}

function PanelInner({
  conversationId,
  projectId,
  variant,
  session,
  turnFilter,
  attemptTurnId,
  header,
  openFullHref,
  ids,
  watching = false,
  empty,
  pending,
  notFound,
  errorFallback,
  composer,
}: AgentConversationPanelProps & { session: ConversationSession }) {
  const merged: ConversationPanelIds = { ...PAGE_PANEL_IDS, ...ids };
  const { conversation, data } = session;

  if (conversation.isPending) {
    return pending ?? <Spinner label="Loading conversation" />;
  }
  if (conversation.error instanceof ApiError && conversation.error.status === 404) {
    return (
      notFound ?? (
        <ProblemBanner
          error={conversation.error}
          fallback="The conversation could not be loaded."
        />
      )
    );
  }
  if (conversation.error || !data) {
    return (
      <ProblemBanner
        error={conversation.error}
        fallback={errorFallback ?? "The conversation could not be loaded."}
      />
    );
  }

  // Fold the journal, then keep only the turn this surface is about — a turn
  // filter means this surface is one unit's (the attempt pane), not every
  // turn the conversation ever ran.
  const items = turnFilter
    ? session.transcript.items.filter((item) => "turnId" in item && item.turnId === turnFilter)
    : markTurns(session.transcript.items, attemptTurnId, session.nameOf);

  const transcriptBlock =
    empty && items.length === 0 ? (
      <p className="text-[12px] text-muted" data-testid={empty.testid}>
        {empty.copy}
      </p>
    ) : (
      <Transcript
        items={items}
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
    );

  const composerBlock = (
    <AgentConversationComposer
      session={session}
      ids={merged}
      inputId={composer?.inputId ?? `conversation-prompt-${conversationId}`}
      rows={composer?.rows ?? 2}
      nonControllerPlaceholder={
        composer?.nonControllerPlaceholder ?? "Only the controller can prompt."
      }
      heading={variant === "page"}
    />
  );

  if (variant === "dock") {
    return (
      <div className="space-y-[8px]">
        <div className="flex items-center justify-between gap-2">
          {header ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{header}</span>
          ) : null}
          <Link
            to={openFullHref ?? `/projects/${projectId}/conversations/${conversationId}`}
            className="text-accent-text hover:text-ink"
            data-testid="dock-open-conversation"
          >
            Open full conversation
          </Link>
        </div>
        <AgentConversationControls
          session={session}
          ids={merged}
          watching={watching}
          disabledTakeForViewer
        />
        {transcriptBlock}
        {composerBlock}
      </div>
    );
  }

  // The page composes this surface into its transcript column; its controls
  // live in the context rail, rendered from the same session.
  return (
    <>
      {transcriptBlock}
      {composerBlock}
    </>
  );
}
