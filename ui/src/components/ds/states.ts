/**
 * The eight state sets (STATES-J) and the single mapping table from every
 * status the app shows onto them. Color means state; each state always
 * carries its glyph and its word — never color alone
 * (`communication-spec/10-ui-design-handoff.md`, handoff rule 06).
 *
 * Class names come from the tokens in `ui/src/styles/tokens.css`; the colors
 * themselves are transcribed from `docs/design/handoff/design-system-handoff.dc.html`.
 */

export type StateName =
  | "running"
  | "waiting"
  | "failed"
  | "interrupted"
  | "retrying"
  | "done"
  | "queued"
  | "info";

export interface StateSpec {
  /** Handoff glyph: ● ! × ⊘ ↻ ✓ · i */
  glyph: string;
  /** Default word for the state when the caller has no more specific one. */
  word: string;
  /** Uppercase title-bar text from the handoff's state table. */
  bar: string;
  // STATUS-E tag chip.
  tagBg: string;
  tagFg: string;
  // CARD-L strong title bar (only when the panel needs action).
  strongBg: string;
  strongFg: string;
  strongEdge: string;
  // ALERT-K pale alert.
  paleBarBg: string;
  paleBodyBg: string;
  paleEdge: string;
  paleFg: string;
}

export const STATES: Record<StateName, StateSpec> = {
  running: {
    glyph: "●",
    word: "running",
    bar: "RUNNING",
    tagBg: "bg-st-running-tag",
    tagFg: "text-st-running-tag-fg",
    strongBg: "bg-st-running-strong",
    strongFg: "text-st-running-strong-fg",
    strongEdge: "border-st-running-strong",
    paleBarBg: "bg-st-running-pale-bar",
    paleBodyBg: "bg-st-running-pale-body",
    paleEdge: "border-st-running-pale-edge",
    paleFg: "text-st-running-pale-fg",
  },
  waiting: {
    glyph: "!",
    word: "waiting",
    bar: "NEEDS YOUR DECISION",
    tagBg: "bg-st-waiting-tag",
    tagFg: "text-st-waiting-tag-fg",
    strongBg: "bg-st-waiting-strong",
    strongFg: "text-st-waiting-strong-fg",
    strongEdge: "border-st-waiting-strong",
    paleBarBg: "bg-st-waiting-pale-bar",
    paleBodyBg: "bg-st-waiting-pale-body",
    paleEdge: "border-st-waiting-pale-edge",
    paleFg: "text-st-waiting-pale-fg",
  },
  failed: {
    glyph: "×",
    word: "failed",
    bar: "FAILED",
    tagBg: "bg-st-failed-tag",
    tagFg: "text-st-failed-tag-fg",
    strongBg: "bg-st-failed-strong",
    strongFg: "text-st-failed-strong-fg",
    strongEdge: "border-st-failed-strong",
    paleBarBg: "bg-st-failed-pale-bar",
    paleBodyBg: "bg-st-failed-pale-body",
    paleEdge: "border-st-failed-pale-edge",
    paleFg: "text-st-failed-pale-fg",
  },
  interrupted: {
    glyph: "⊘",
    word: "interrupted",
    bar: "INTERRUPTED",
    tagBg: "bg-st-interrupted-tag",
    tagFg: "text-st-interrupted-tag-fg",
    strongBg: "bg-st-interrupted-strong",
    strongFg: "text-st-interrupted-strong-fg",
    strongEdge: "border-st-interrupted-strong",
    paleBarBg: "bg-st-interrupted-pale-bar",
    paleBodyBg: "bg-st-interrupted-pale-body",
    paleEdge: "border-st-interrupted-pale-edge",
    paleFg: "text-st-interrupted-pale-fg",
  },
  retrying: {
    glyph: "↻",
    word: "retrying",
    bar: "RETRYING",
    tagBg: "bg-st-retrying-tag",
    tagFg: "text-st-retrying-tag-fg",
    strongBg: "bg-st-retrying-strong",
    strongFg: "text-st-retrying-strong-fg",
    strongEdge: "border-st-retrying-strong",
    paleBarBg: "bg-st-retrying-pale-bar",
    paleBodyBg: "bg-st-retrying-pale-body",
    paleEdge: "border-st-retrying-pale-edge",
    paleFg: "text-st-retrying-pale-fg",
  },
  done: {
    glyph: "✓",
    word: "done",
    bar: "PUBLISHED",
    tagBg: "bg-st-done-tag",
    tagFg: "text-st-done-tag-fg",
    strongBg: "bg-st-done-strong",
    strongFg: "text-st-done-strong-fg",
    strongEdge: "border-st-done-strong",
    paleBarBg: "bg-st-done-pale-bar",
    paleBodyBg: "bg-st-done-pale-body",
    paleEdge: "border-st-done-pale-edge",
    paleFg: "text-st-done-pale-fg",
  },
  queued: {
    glyph: "·",
    word: "queued",
    bar: "QUEUED",
    tagBg: "bg-st-queued-tag",
    tagFg: "text-st-queued-tag-fg",
    strongBg: "bg-st-queued-strong",
    strongFg: "text-st-queued-strong-fg",
    strongEdge: "border-st-queued-strong",
    paleBarBg: "bg-st-queued-pale-bar",
    paleBodyBg: "bg-st-queued-pale-body",
    paleEdge: "border-st-queued-pale-edge",
    paleFg: "text-st-queued-pale-fg",
  },
  info: {
    glyph: "i",
    word: "info",
    bar: "NOTE",
    tagBg: "bg-st-info-tag",
    tagFg: "text-st-info-tag-fg",
    strongBg: "bg-st-info-strong",
    strongFg: "text-st-info-strong-fg",
    strongEdge: "border-st-info-strong",
    paleBarBg: "bg-st-info-pale-bar",
    paleBodyBg: "bg-st-info-pale-body",
    paleEdge: "border-st-info-pale-edge",
    paleFg: "text-st-info-pale-fg",
  },
};

/** Unknown statuses degrade to the neutral queued set, never to color-guessing. */
export function stateOf(name: StateName | undefined | null): StateName {
  return name && name in STATES ? name : "queued";
}

/* ------------------------------------------------------------- mappings */

/** Conversation turn status (`ConversationTurnStatus`) → state set. A
 * cancelled turn is shown with the interrupted set: it stopped, outcome
 * unknown — not a failure of the work. */
export const TURN_STATE: Record<string, StateName> = {
  queued: "queued",
  leased: "running",
  running: "running",
  completed: "done",
  cancelled: "interrupted",
  failed: "failed",
  interrupted: "interrupted",
};

/** Worker liveness (`Worker.status`) → state set. */
export const WORKER_STATE: Record<string, StateName> = {
  online: "running",
  draining: "waiting",
  offline: "interrupted",
};

/** Conversation status (`Conversation.status`) → state set. */
export const CONVERSATION_STATE: Record<string, StateName> = {
  active: "running",
  idle: "queued",
  disconnected: "interrupted",
  archived: "info",
};

/** Permission request status → state set. Pending needs a decision (waiting);
 * decided is closed (done); expired failed; cancelled was stopped. */
export const PERMISSION_STATE: Record<string, StateName> = {
  pending: "waiting",
  decided: "done",
  expired: "failed",
  cancelled: "interrupted",
};

/** Tool-call status (ACP free-form, observed values) → state set. */
export const TOOL_STATE: Record<string, StateName> = {
  pending: "queued",
  in_progress: "running",
  completed: "done",
  failed: "failed",
};

/** SSE connection state (stream / activity feed) → state set. */
export const STREAM_STATE: Record<string, StateName> = {
  live: "running",
  reconnecting: "retrying",
};

/** Color for a PROGRESS-J/K segment: flat colors, never texture. */
export const SEGMENT_COLOR: Record<string, string> = {
  done: "bg-seg-done",
  running: "bg-seg-running",
  waiting: "bg-seg-waiting",
  failed: "bg-seg-failed",
  interrupted: "bg-st-interrupted-strong",
  open: "bg-seg-open",
};
