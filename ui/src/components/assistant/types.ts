/**
 * Assistant v2 wire types — mirror ADR-0050 exactly.
 *
 * Where the OpenAPI contract already carries a shape (the conversation rows,
 * the undo results), the GENERATED types (`ui/src/api/schema.d.ts`) are
 * re-exported below instead of a local copy. Where it does not — the
 * kind-discriminated message `payload` arrives as an opaque `object`, and the
 * `assistant_changes` kind CHECK lives in migration `00010` (draft_edit,
 * navigate, run_start, run_retry, approval_decision, publish) — the local
 * interfaces below are the wire truth and must not be renamed. No component
 * fetches: data flows in as props, callbacks out.
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

/** `assistant_changes.kind` (ADR-0050 migration + Decision 5). */
export type ChangeKind =
  | "draft_edit"
  | "navigate"
  | "run_start"
  | "run_retry"
  | "approval_decision"
  | "publish";

export type ApprovalRequestState = "pending" | "confirmed" | "dismissed";

/** Page context attached to a `user` message (ADR-0050 Decision 6). */
export interface AssistantMessageContext {
  route: string;
  project_id?: string | null;
  entity?: {
    kind: "pipeline" | "draft" | "run" | "node_template" | "profile";
    id: string;
  } | null;
}

/** `assistant.links[]` — server-validated same-origin route, not an href. */
export interface AssistantLink {
  label: string;
  route: string;
}

/** `assistant.tool_calls[]` — server-supplied summary, never raw tool output. */
export interface AssistantToolCall {
  name: string;
  summary: string;
  ok: boolean;
  reason?: string | null;
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
}

/** Payload for `kind: "assistant"`. */
export interface AssistantAnswerPayload {
  kind: "assistant";
  turn_id?: string | null;
  answer_markdown: string;
  links: AssistantLink[];
  tool_calls: AssistantToolCall[];
  degraded?: string | null;
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

/** One transcript row (`GET /assistant/conversations/{id}/messages`). */
export interface AssistantMessage {
  id: string;
  kind: AssistantMessageKind;
  payload: AssistantMessagePayload;
  created_at: string;
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

/** The three trust levels, in the order the pill menu lists them (4d). */
export const TRUST_LEVELS: ReadonlyArray<{
  value: TrustLevel;
  label: string;
  blurb: string;
}> = [
  {
    value: "ask_all",
    label: "Ask before everything",
    blurb: "It explains and proposes. You click every action, including navigation.",
  },
  {
    value: "ask_risky",
    label: "Ask for risky actions",
    blurb:
      "Reads, navigates, gives tours and edits drafts on its own. Asks before starting or retrying runs, approving, allowing commands or publishing.",
  },
  {
    value: "no_ask",
    label: "Don't ask",
    blurb:
      "Does what you ask, including runs, approvals and publishing. Each action is logged and can be undone where possible.",
  },
];

/** Default trust level (ADR-0050 Decision 4: `ask_risky` is the default). */
export const DEFAULT_TRUST_LEVEL: TrustLevel = "ask_risky";

/** Lowercase label shown on the header-strip pill (`ask for risky ▾`). */
export function trustPillLabel(level: TrustLevel): string {
  switch (level) {
    case "ask_all":
      return "ask before everything";
    case "ask_risky":
      return "ask for risky";
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
  }
}
