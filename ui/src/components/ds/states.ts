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

/**
 * The compact word a chip, a segment or a graph node can carry. `STATES[].word`
 * is the sentence-form default; this is the same state in the fewest characters
 * that still reads ("need you" for waiting, "stopped" for interrupted — a state
 * whose meaning is "we do not know", which must not be spelled as a failure).
 *
 * One table on purpose: a stage cell, a tree row and a graph node that disagree
 * about what a colour means break identity rule 06 at the only place a person
 * can check it.
 */
export const SHORT_WORD: Record<StateName, string> = {
  running: "running",
  waiting: "need you",
  failed: "failed",
  interrupted: "stopped",
  retrying: "retrying",
  done: "done",
  queued: "pending",
  info: "noted",
};

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

/**
 * Workspace state (`Workspace.state`) → state set. `quarantined` is a security
 * finding (a leftover materialized secret, an unestablishable exclusion), so it
 * takes the failed set; `lost` is ADR-017's honest arm — edits are gone — so it
 * is interrupted, never "resumed".
 */
export const WORKSPACE_STATE: Record<string, StateName> = {
  preparing: "queued",
  ready: "running",
  quarantined: "failed",
  released: "info",
  lost: "interrupted",
};

/** Artifact state (`Artifact.state`) → state set. `uploading` is never served. */
export const ARTIFACT_STATE: Record<string, StateName> = {
  uploading: "queued",
  ready: "done",
  orphan: "failed",
  deleted: "interrupted",
};

/**
 * Sensitivity label → state set. This is an *access* fact, not a status, so the
 * mapping exists only to keep `restricted`/`secret` from reading as ordinary:
 * standard/internal are informational, restricted needs attention, secret is a
 * row with no download path at all in M3.
 */
export const SENSITIVITY_STATE: Record<string, StateName> = {
  standard: "info",
  internal: "info",
  restricted: "waiting",
  secret: "failed",
};

/** SSE connection state (stream / activity feed) → state set. */
export const STREAM_STATE: Record<string, StateName> = {
  live: "running",
  reconnecting: "retrying",
};

/* ---------------------------------------------------------------- M4 run
 * The pipeline mappings below follow `docs/design/design-system.md`'s
 * "Status → state set" table, which extends *this* table rather than adding a
 * ninth state set. Where two domain states share a set the **word** carries the
 * difference (identity rule 06), so each of these is paired with the literal
 * status at the call site — a `skipped` node and a `queued` node are the same
 * colour and different words. */

/** Run status (`01`, contract § 1) → state set. */
export const RUN_STATE: Record<string, StateName> = {
  queued: "queued",
  preparing: "running",
  running: "running",
  waiting_human: "waiting",
  paused: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "interrupted",
  interrupted: "interrupted",
};

/** Node execution status → state set. `skipped` is neutral (nothing needs
 * anyone); `leased` is already claimed work, so it reads as running. */
export const NODE_EXECUTION_STATE: Record<string, StateName> = {
  pending: "queued",
  ready: "running",
  leased: "running",
  running: "running",
  succeeded: "done",
  failed: "failed",
  skipped: "queued",
  waiting: "waiting",
  cancelled: "interrupted",
  interrupted: "interrupted",
};

/** Attempt status → state set. An `interrupted` attempt is "stopped, outcome
 * unknown" — the same set a cancelled turn uses, never `failed`. */
export const ATTEMPT_STATE: Record<string, StateName> = {
  queued: "queued",
  leased: "running",
  running: "running",
  succeeded: "done",
  failed: "failed",
  cancelled: "interrupted",
  interrupted: "interrupted",
};

/** Approval state → state set. Pending is the one panel where royal means
 * "you can act"; `denied` (approver lost access) is a failure, not a decision. */
export const APPROVAL_STATE: Record<string, StateName> = {
  pending: "waiting",
  decided: "done",
  expired: "failed",
  cancelled: "interrupted",
  denied: "failed",
};

/** Draft status (`pipeline_drafts_status`, contract § 1) → state set. */
export const DRAFT_STATE: Record<string, StateName> = {
  draft: "queued",
  validating: "running",
  valid: "info",
  invalid: "failed",
  published: "done",
};

/** Revision status → state set (`· DEPRECATED` / `✓ PUBLISHED 8f2c1a…`). */
export const REVISION_STATE: Record<string, StateName> = {
  published: "done",
  deprecated: "queued",
};

/** Validation source → state set. Loader findings gate everything else, so they
 * read as failed; a schema finding is a failure of shape; a compiler finding may
 * be only a deferral, so it is info — the `hint` and code carry the weight. */
export const VALIDATION_SOURCE_STATE: Record<string, StateName> = {
  loader: "failed",
  schema: "failed",
  compiler: "info",
};

/** Assignment channel label → state set: royal beta means *you* chose it. */
export const CHANNEL_STATE: Record<string, StateName> = {
  stable: "info",
  beta: "waiting",
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
