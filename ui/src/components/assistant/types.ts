/**
 * Assistant v2 wire types — mirror ADR-0050 exactly.
 *
 * Where the OpenAPI contract already carries a shape (the conversation rows,
 * the undo results), the GENERATED types (`ui/src/api/schema.d.ts`) are
 * re-exported below instead of a local copy. Where it does not — the
 * kind-discriminated message `payload` arrives as an opaque `object`, and the
 * `assistant_changes` kind CHECK (migration `00010`, extended forward-only by
 * `00030`) allows draft_edit, navigate, run_start, run_retry,
 * approval_decision, publish and the five setup kinds of handoff §6
 * (project_create, repo_add, assignment_set, run_cancel, schedule_create) —
 * the local interfaces below are the wire truth and must not be renamed. No
 * component fetches: data flows in as props, callbacks out.
 */
import type { components } from "../../api/schema";

/** Generated (api/openapi.yaml): the caller's persisted conversation row. */
export type AssistantConversation = components["schemas"]["AssistantConversation"];
/** Generated: one page of conversations, newest `last_message_at` first. */
export type AssistantConversationList = components["schemas"]["AssistantConversationList"];
/** Generated: one independent outcome of an undo attempt. */
export type AssistantChangeUndoResult = components["schemas"]["AssistantChangeUndoResult"];
/** Generated: the undo-all result (newest first, one result per attempt). */
export type AssistantChangeUndoAll = components["schemas"]["AssistantChangeUndoAll"];

/** `user_preferences.assistant.trust_level` (ADR-0046, C2; ADR-0050 §4). */
export type TrustLevel = "ask_all" | "ask_risky" | "no_ask";

export type AssistantMessageKind =
  | "user"
  | "assistant"
  | "question"
  | "change"
  | "approval_request"
  /** The part-2 ack the server appends once a gated action ran (ADR-0050 §4); rendered as nothing. */
  | "approval_response";

/** `assistant_changes.kind` (ADR-0050 migration + Decision 5, extended by the
 * handoff §6 setup tools — CONTRACT §5: none of the five new kinds is
 * undoable). */
export type ChangeKind =
  | "draft_edit"
  | "navigate"
  | "run_start"
  | "run_retry"
  | "approval_decision"
  | "publish"
  | "project_create"
  | "repo_add"
  | "assignment_set"
  | "run_cancel"
  | "schedule_create";

export type ApprovalRequestState = "pending" | "confirmed" | "dismissed";

/** Page context attached to a `user` message (ADR-0050 Decision 6; the
 * `page` member is the handoff §3 addition, CONTRACT §2). */
export interface AssistantMessageContext {
  route: string;
  project_id?: string | null;
  /** What the person is looking at, as data: a label, an optional status and
   * the project slug. The server bounds each member to 80 characters and
   * strips control characters and `<` `>` — they are never instructions. */
  page?: {
    label: string;
    status?: string;
    project?: string;
  };
  entity?: {
    /** `conversation` (thread → workflow, design 2f) names the chat the ask
     * is about: its id rides as structured context, never in the visible
     * text; chat.transcript still re-authorizes the read as the caller. */
    kind: "pipeline" | "draft" | "run" | "node_template" | "profile" | "conversation";
    id: string;
  } | null;
}

/** `assistant.links[]` — server-validated same-origin route, not an href. */
export interface AssistantLink {
  label: string;
  route: string;
}

/** What the judge made of one call (CONTRACT §3); absent = never consulted. */
export type AssistantToolCallJudge = "allowed" | "asked" | "unavailable";

/** `assistant.tool_calls[]` — server-supplied summary, never raw tool output. */
export interface AssistantToolCall {
  name: string;
  summary: string;
  ok: boolean;
  reason?: string | null;
  /** CONTRACT §3: the judge's verdict on THIS call, absent when the trust
   * level never consulted it. */
  judge?: AssistantToolCallJudge;
}

/** `question.options[]` — 2–4 of them, `allow_free_text` always true. */
export interface AssistantQuestionOption {
  label: string;
  value: string;
}

/** Payload for `kind: "user"`. */
export interface AssistantUserPayload {
  kind: "user";
  text: string;
  context?: AssistantMessageContext | null;
  /** True when the text arrived by dictation (the bubble carries a small
   * "spoken" tag); absent on a typed ask (CONTRACT §4). */
  spoken?: boolean;
}

/** Payload for `kind: "assistant"`. */
export interface AssistantAnswerPayload {
  kind: "assistant";
  turn_id?: string | null;
  answer_markdown: string;
  links: AssistantLink[];
  tool_calls: AssistantToolCall[];
  degraded?: string | null;
  /** CONTRACT §2: the item the answer used the page for, already stripped of
   * its `Assumed:` line. */
  assumed?: string | null;
}

/** Payload for `kind: "question"`. The reply sent back is always plain text. */
export interface AssistantQuestionPayload {
  kind: "question";
  turn_id?: string | null;
  prompt: string;
  options: AssistantQuestionOption[];
  allow_free_text?: boolean;
  /** Set to the replying user message's id once the user answered. */
  answered_by?: string | null;
}

/** Payload for `kind: "change"` (transcript echo of one change-log row). */
export interface AssistantChangePayload {
  kind: "change";
  change_id: string;
  change_kind: ChangeKind;
  target_ref: string;
  summary: string;
  undoable: boolean;
}

/** Payload for `kind: "approval_request"` (ADR-0050 Decision 4 gate). */
export interface AssistantApprovalRequestPayload {
  kind: "approval_request";
  turn_id?: string | null;
  action: string;
  summary: string;
  risk?: string | null;
  state: ApprovalRequestState;
  /** CONTRACT §3: why the gate stopped, in the server's own words. */
  reason?: string | null;
  /** CONTRACT §5: the bounded args the proposal card rows are built from (the
   * same strings Retry re-runs). */
  args?: Record<string, string>;
}

/** Payload for `kind: "approval_response"` — the part-2 ack; renders as nothing. */
export interface AssistantApprovalResponsePayload {
  kind: "approval_response";
  turn_id?: string | null;
}

export type AssistantMessagePayload =
  | AssistantUserPayload
  | AssistantAnswerPayload
  | AssistantQuestionPayload
  | AssistantChangePayload
  | AssistantApprovalRequestPayload
  | AssistantApprovalResponsePayload;

/**
 * Client-only marker for an optimistic row (issue #63): a send shows the
 * person's ask as their own bubble the moment they click, BEFORE the POST
 * settles. `pending` = in flight (the server has not taken the turn yet);
 * `failed` = the turn was rejected — the bubble stays on screen with the
 * honest error line under it and a Retry (a failed turn stores nothing
 * server-side, ADR-0034, so the row is retired the next round-trip).
 * Never present on server data.
 */
export interface AssistantMessageLocal {
  state: "pending" | "failed";
  /** The honest failure line, shown under the bubble when `failed`. */
  error?: string | null;
}

/** One transcript row (`GET /assistant/conversations/{id}/messages`). */
export interface AssistantMessage {
  id: string;
  kind: AssistantMessageKind;
  payload: AssistantMessagePayload;
  created_at: string;
  /** Present only on the container's own optimistic rows (issue #63). */
  local?: AssistantMessageLocal;
}

/**
 * One change-log row (`GET /assistant/conversations/{id}/changes`).
 * `undoable` is `undo_payload IS NOT NULL` — the payload itself is never
 * returned. `undone_at` is set once the inverse op has been applied.
 */
export interface AssistantChange {
  id: string;
  kind: ChangeKind;
  target_ref: string;
  summary: string;
  undoable: boolean;
  undone_at: string | null;
  created_at: string;
}

/** The conversation's change log (`GET /assistant/conversations/{id}/changes`). */
export interface AssistantChangeList {
  changes: AssistantChange[];
}

/**
 * The three trust levels, in the order the pill menu lists them (handoff §4).
 *
 * The blurbs say what each level DOES — one line each. No level promises that
 * an action can be undone: only draft edits are reversible, and the change
 * list is where that is stated (with "can't be undone" on everything else).
 */
export const TRUST_LEVELS: ReadonlyArray<{
  value: TrustLevel;
  label: string;
  blurb: string;
}> = [
  {
    value: "ask_all",
    label: "Ask before every change",
    blurb: "You confirm every change.",
  },
  {
    value: "ask_risky",
    label: "Ask when it looks risky",
    blurb: "A decision model checks each call. Flagged ones wait for you.",
  },
  {
    value: "no_ask",
    label: "Don't ask",
    blurb: "Everything runs. Each action is listed in the thread.",
  },
];

/** Default trust level (ADR-0050 Decision 4: `ask_risky` is the default). */
export const DEFAULT_TRUST_LEVEL: TrustLevel = "ask_risky";

/** Lowercase label shown on the composer pill (`ask when risky ▾`). */
export function trustPillLabel(level: TrustLevel): string {
  switch (level) {
    case "ask_all":
      return "ask every change";
    case "ask_risky":
      return "ask when risky";
    case "no_ask":
      return "don't ask";
  }
}

/** Short mono glyph per change kind for the change-list rows (4d §3). */
export function changeKindGlyph(kind: ChangeKind): string {
  switch (kind) {
    case "draft_edit":
      return "~";
    case "navigate":
      return "→";
    case "run_start":
      return "●";
    case "run_retry":
      return "↻";
    case "approval_decision":
      return "!";
    case "publish":
      return "↑";
    case "project_create":
      return "+";
    case "repo_add":
      return "◈";
    case "assignment_set":
      return "=";
    case "run_cancel":
      return "×";
    case "schedule_create":
      return "◷";
  }
}

/**
 * The short past-tense name of one change kind (CONTRACT §5, handoff §6). The
 * change rows show the server's own summary; this is the kind's own words for
 * anywhere a row needs to say what it was without the summary.
 */
export function changeKindLabel(kind: ChangeKind): string {
  switch (kind) {
    case "draft_edit":
      return "Edited draft";
    case "navigate":
      return "Navigated";
    case "run_start":
      return "Started run";
    case "run_retry":
      return "Retried run";
    case "approval_decision":
      return "Recorded decision";
    case "publish":
      return "Published";
    case "project_create":
      return "Created project";
    case "repo_add":
      return "Connected repository";
    case "assignment_set":
      return "Assigned workflow";
    case "run_cancel":
      return "Cancelled run";
    case "schedule_create":
      return "Created schedule";
  }
}
