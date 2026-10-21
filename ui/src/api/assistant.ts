/**
 * Assistant v1 — the read-only broker behind Ctrl K (ADR-0034,
 * `docs/design/assistant-v1.md`).
 *
 * Two contract facts shape this module:
 *  - **Nothing is stored.** There is no transcript endpoint, so an answer has
 *    no cache key to live under: this is a plain mutation whose result the
 *    caller holds in its own (unmounted-with-the-panel) state.
 *  - **The failure is a code, not a modal.** The problem body carries
 *    `degraded`, and `assistant_not_configured` means the feature is absent on
 *    this deployment — the palette must fall back to jump-only, quietly.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";
import { queryKeys } from "./queries";
import type {
  AssistantChangeList,
  AssistantMessageContext,
  AssistantLink as LocalLink,
  AssistantMessage as LocalMessage,
  AssistantMessagePayload,
  AssistantQuestionOption as LocalOption,
  AssistantToolCall as LocalToolCall,
  ChangeKind,
} from "../components/assistant/types";

export type AssistantAsk = components["schemas"]["AssistantAsk"];
export type AssistantAnswer = components["schemas"]["AssistantAnswer"];
export type AssistantLink = components["schemas"]["AssistantLink"];
export type AssistantToolCall = components["schemas"]["AssistantToolCall"];
export type AssistantProblem = components["schemas"]["AssistantProblem"];

/** The one route this module speaks. */
export const ASSISTANT_ASK_PATH = "/api/v1/assistant/ask";

/** The degraded cause that means "this server has no assistant at all". */
export const ASSISTANT_NOT_CONFIGURED = "assistant_not_configured";

/** The `/projects/{id}…` family — the only routes that carry a project scope. */
const PROJECT_ROUTE = /^\/projects\/([^/?#]+)/;

/** The project a route is about, when it is about one. */
export function projectIdFromRoute(route: string): string | undefined {
  const match = PROJECT_ROUTE.exec(route);
  if (!match) return undefined;
  // A trailing sub-page (`/projects/{id}/runs`) shares the id; an empty
  // segment is not an id.
  return match[1].length > 0 ? match[1] : undefined;
}

/** The body for `askAssistant`: the question plus where it was asked. */
export function assistantAskBody(question: string, route: string): AssistantAsk {
  const context: NonNullable<AssistantAsk["context"]> = { route };
  const projectId = projectIdFromRoute(route);
  if (projectId) context.project_id = projectId;
  return { question, context };
}

/** `degraded` off any problem body (assistant route or not), else null. */
export function degradedOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as Partial<AssistantProblem> | null;
  if (!body || typeof body !== "object") return null;
  return typeof body.degraded === "string" ? body.degraded : null;
}

/** True when the server said the assistant is simply not configured. */
export function assistantNotConfigured(error: unknown): boolean {
  return degradedOf(error) === ASSISTANT_NOT_CONFIGURED;
}

export interface AssistantAskInput {
  question: string;
  /** The UI's current route; `project_id` is read off it when it carries one. */
  route: string;
}

/**
 * `POST /api/v1/assistant/ask`. One turn, arriving whole (v1 has no stream);
 * the caller renders `isPending` as "thinking…" and keeps the panel editable.
 */
export function useAssistantAsk() {
  return useMutation<AssistantAnswer, Error, AssistantAskInput>({
    mutationFn: ({ question, route }) =>
      apiFetch<AssistantAnswer>(ASSISTANT_ASK_PATH, {
        method: "POST",
        json: assistantAskBody(question, route),
      }),
  });
}

// ---------------------------------------------------------------------------
// Assistant v2 (ADR-0050): the per-user persisted conversation — create/list,
// transcript pages, one turn per post, the change log and its undos. The
// multi-turn runner lands in parallel (be-as-loop); until then the replies
// are the part-1 broker's, shaped the same. A failed turn stores nothing and
// answers the ADR-0034 problem with `degraded` naming the cause — the caller
// renders that honestly (assistantNotConfigured above covers the 503).

export type AssistantConversation = components["schemas"]["AssistantConversation"];
export type AssistantConversationList = components["schemas"]["AssistantConversationList"];
export type AssistantMessageList = components["schemas"]["AssistantMessageList"];
export type AssistantChangeUndoResult = components["schemas"]["AssistantChangeUndoResult"];
export type AssistantChangeUndoAll = components["schemas"]["AssistantChangeUndoAll"];

export const ASSISTANT_CONVERSATIONS_PATH = "/api/v1/assistant/conversations";
export const assistantMessagesPath = (conversationId: string): string =>
  `${ASSISTANT_CONVERSATIONS_PATH}/${conversationId}/messages`;
export const assistantChangesPath = (conversationId: string): string =>
  `${ASSISTANT_CONVERSATIONS_PATH}/${conversationId}/changes`;
export const assistantUndoAllPath = (conversationId: string): string =>
  `${ASSISTANT_CONVERSATIONS_PATH}/${conversationId}/undo-all`;
export const assistantUndoPath = (changeId: string): string =>
  "/api/v1/assistant/changes" + `/${changeId}/undo`;

export const assistantQueryKeys = {
  conversations: (limit?: number) => ["assistant", "conversations", limit ?? 1] as const,
  messages: (conversationId: string | null) => ["assistant", "messages", conversationId] as const,
  changes: (conversationId: string | null) => ["assistant", "changes", conversationId] as const,
  /** The `changes` prefix: every conversation's change log at once (the
   * undo mutations answer with a change, not a conversation id, so they
   * invalidate by prefix — a trailing `null` segment would match nothing). */
  changesAll: ["assistant", "changes"] as const,
};

/**
 * The draft id a change's `target_ref` names (`draft:d-1`), or null when it
 * names nothing the draft cache is keyed on (`run:r-1`, `pipeline:p-1`). An
 * assistant change is a server-side write to that draft: any open Studio
 * draft must refetch, not wait for a remount (e2e-p789b).
 */
export function draftIdFromTargetRef(targetRef: string | null | undefined): string | null {
  const match = /^draft:(.+)$/.exec(targetRef ?? "");
  return match && match[1].length > 0 ? match[1] : null;
}

/** One page of the caller's conversations, newest `last_message_at` first. */
export function useAssistantConversations(limit = 1, enabled = true) {
  return useQuery<AssistantConversationList>({
    queryKey: assistantQueryKeys.conversations(limit),
    queryFn: () =>
      apiFetch<AssistantConversationList>(`${ASSISTANT_CONVERSATIONS_PATH}?limit=${limit}`),
    enabled,
    staleTime: 60_000,
  });
}

/** `POST /assistant/conversations` — a null title until the first message. */
export function useCreateAssistantConversation() {
  return useMutation<AssistantConversation, Error>({
    mutationFn: () =>
      apiFetch<AssistantConversation>(ASSISTANT_CONVERSATIONS_PATH, { method: "POST" }),
  });
}

/** The transcript, oldest first (the full 200-row page; the UI never pages).
 * Rows arrive mapped into the local kind-discriminated shape (below) — the
 * generated type's `payload` is an opaque object and its `kind` enum is the
 * part-1 set, so the mapping narrows at this boundary, not the caller. */
export function useAssistantMessages(conversationId: string | null) {
  return useQuery<LocalMessage[]>({
    queryKey: assistantQueryKeys.messages(conversationId),
    queryFn: async () =>
      mapAssistantMessageList(
        await apiFetch<AssistantMessageList>(
          `${assistantMessagesPath(conversationId as string)}?limit=200`,
        ),
      ),
    enabled: conversationId !== null,
  });
}

/** A new user message plus the turn's output rows (the `user` row first). */
export interface AssistantMessagePostBody {
  /** A plain turn's text; ABSENT on a confirm/dismiss post (the handler
   * rejects a decision post that carries text — "text must be empty"). */
  text?: string;
  context?: AssistantMessageContext;
  /** A pending `approval_request` message id to confirm (Retry). */
  confirm?: string | null;
  /** A pending `approval_request` message id to dismiss (Not now). */
  dismiss?: string | null;
}

export function usePostAssistantMessage() {
  const queryClient = useQueryClient();
  return useMutation<
    LocalMessage[],
    Error,
    { conversationId: string; body: AssistantMessagePostBody }
  >({
    mutationFn: async ({ conversationId, body }) =>
      mapAssistantMessageList(
        await apiFetch<AssistantMessageList>(assistantMessagesPath(conversationId), {
          method: "POST",
          json: body,
        }),
      ),
    // A turn can record a change the caller did not ask for by name: a
    // confirmed approval (Retry), a no_ask / ask_risky draft edit on a plain
    // post. The change log must not wait for a remount, and a draft edit
    // must refetch the draft it wrote (e2e-p789b).
    onSuccess: (rows, { conversationId }) => {
      void queryClient.invalidateQueries({
        queryKey: assistantQueryKeys.changes(conversationId),
      });
      for (const row of rows) {
        if (row.payload.kind !== "change") continue;
        const draftId = draftIdFromTargetRef(row.payload.target_ref);
        if (draftId) void queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
      }
    },
  });
}

/** The conversation's change log (ADR-0050 Decision 5), creation order. */
export function useAssistantChanges(conversationId: string | null) {
  return useQuery<AssistantChangeList>({
    queryKey: assistantQueryKeys.changes(conversationId),
    queryFn: () => apiFetch<AssistantChangeList>(assistantChangesPath(conversationId as string)),
    enabled: conversationId !== null,
  });
}

/** Apply one change's inverse op; the change comes back with `undone_at`. */
export function useUndoAssistantChange() {
  const queryClient = useQueryClient();
  return useMutation<components["schemas"]["AssistantChange"], Error, string>({
    mutationFn: (changeId) =>
      apiFetch<components["schemas"]["AssistantChange"]>(assistantUndoPath(changeId), {
        method: "POST",
      }),
    onSuccess: (change) => {
      void queryClient.invalidateQueries({ queryKey: assistantQueryKeys.changesAll });
      const draftId = draftIdFromTargetRef(change.target_ref);
      if (draftId) void queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
    },
  });
}

/** Every still-open undoable change, newest first; one result per attempt. */
export function useUndoAllAssistantChanges() {
  const queryClient = useQueryClient();
  return useMutation<AssistantChangeUndoAll, Error, { conversationId: string }>({
    mutationFn: ({ conversationId }) =>
      apiFetch<AssistantChangeUndoAll>(assistantUndoAllPath(conversationId), {
        method: "POST",
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantQueryKeys.changesAll });
      // The results carry only change ids, not targets: every open change
      // may have written a draft, so the whole draft subtree refetches.
      void queryClient.invalidateQueries({ queryKey: ["draft"] });
    },
  });
}

// ---------------------------------------------------------------------------
// The wire boundary: the generated `AssistantMessage` carries an opaque
// `payload` object and the part-1 `kind` enum, while the UI's local type
// (ADR-0050, `components/assistant/types.ts`) is kind-discriminated — the
// server's `question` and `change` rows ride the same list. Map and narrow
// HERE; a row that lacks the fields its kind promises is dropped (never
// shown half-shaped) rather than cast.

type WireMessage = components["schemas"]["AssistantMessage"];

const CHANGE_KINDS: readonly string[] = [
  "draft_edit",
  "navigate",
  "run_start",
  "run_retry",
  "approval_decision",
  "publish",
];

const APPROVAL_STATES: readonly string[] = ["pending", "confirmed", "dismissed"];

const CONTEXT_ENTITY_KINDS: readonly string[] = [
  "pipeline",
  "draft",
  "run",
  "node_template",
  "profile",
];

function strOrNone(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The entity kinds a stored page context can name. */
type ContextEntityKind = NonNullable<AssistantMessageContext["entity"]>["kind"];

function linksOf(value: unknown): LocalLink[] {
  if (!Array.isArray(value)) return [];
  const links: LocalLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const label = strOrNone(entry.label);
    // ADR-0050 stores `route`; pre-ADR-0050 transcripts (and the one-shot
    // ask's vocabulary) may carry `href` — tolerate it so old rows still
    // render.
    const route = strOrNone(entry.route) ?? strOrNone(entry.href);
    if (label !== null && route !== null) links.push({ label, route });
  }
  return links;
}

function toolCallsOf(value: unknown): LocalToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: LocalToolCall[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const name = strOrNone(entry.name);
    if (name === null || typeof entry.ok !== "boolean") continue;
    // ADR-0050: the server supplies the summary; tolerate a call that
    // lacks one (older turns) by falling back to the tool name so the
    // "used N tools" disclosure never drops a real call.
    const call: LocalToolCall = { name, summary: strOrNone(entry.summary) ?? name, ok: entry.ok };
    const reason = strOrNone(entry.reason);
    if (reason !== null) call.reason = reason;
    calls.push(call);
  }
  return calls;
}

function optionsOf(value: unknown): LocalOption[] {
  if (!Array.isArray(value)) return [];
  const options: LocalOption[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const label = strOrNone(entry.label);
    const optionValue = strOrNone(entry.value);
    if (label !== null && optionValue !== null) options.push({ label, value: optionValue });
  }
  return options;
}

/** A stored page context, narrowed; a context without a route keeps none. */
function contextOf(value: unknown): AssistantMessageContext | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const route = strOrNone(entry.route);
  if (route === null) return null;
  const context: AssistantMessageContext = { route };
  const projectId = strOrNone(entry.project_id);
  if (projectId !== null) context.project_id = projectId;
  const entity = entry.entity;
  if (entity && typeof entity === "object") {
    const e = entity as Record<string, unknown>;
    const entityKind = strOrNone(e.kind);
    const id = strOrNone(e.id);
    if (entityKind !== null && id !== null && CONTEXT_ENTITY_KINDS.includes(entityKind)) {
      context.entity = { kind: entityKind as ContextEntityKind, id };
    }
  }
  return context;
}

/** One local transcript row, narrowed; null when the payload is too thin. */
export function mapAssistantMessage(message: WireMessage): LocalMessage | null {
  const raw: Record<string, unknown> =
    message.payload && typeof message.payload === "object"
      ? (message.payload as Record<string, unknown>)
      : {};
  // The payload carries its own discriminator; fall back to the row's `kind`
  // when it does not (the part-1 broker's rows). A kind the UI does not name
  // is dropped — the transcript renders nothing it cannot render.
  const kind = strOrNone(raw.kind) ?? message.kind;
  let payload: AssistantMessagePayload | null = null;
  switch (kind) {
    case "user": {
      const text = strOrNone(raw.text);
      if (text === null) return null;
      payload = { kind: "user", text, context: contextOf(raw.context) };
      break;
    }
    case "assistant": {
      const answer = strOrNone(raw.answer_markdown);
      if (answer === null) return null;
      payload = {
        kind: "assistant",
        turn_id: strOrNone(raw.turn_id),
        answer_markdown: answer,
        links: linksOf(raw.links),
        tool_calls: toolCallsOf(raw.tool_calls),
        degraded: strOrNone(raw.degraded),
      };
      break;
    }
    case "question": {
      const prompt = strOrNone(raw.prompt);
      if (prompt === null || !Array.isArray(raw.options)) return null;
      payload = {
        kind: "question",
        turn_id: strOrNone(raw.turn_id),
        prompt,
        options: optionsOf(raw.options),
        allow_free_text: raw.allow_free_text === true ? true : undefined,
        answered_by: strOrNone(raw.answered_by),
      };
      break;
    }
    case "change": {
      const changeId = strOrNone(raw.change_id);
      const changeKind = strOrNone(raw.change_kind);
      const targetRef = strOrNone(raw.target_ref);
      const summary = strOrNone(raw.summary);
      if (
        changeId === null ||
        changeKind === null ||
        targetRef === null ||
        summary === null ||
        typeof raw.undoable !== "boolean" ||
        !CHANGE_KINDS.includes(changeKind)
      )
        return null;
      payload = {
        kind: "change",
        change_id: changeId,
        change_kind: changeKind as ChangeKind,
        target_ref: targetRef,
        summary,
        undoable: raw.undoable,
      };
      break;
    }
    case "approval_request": {
      const action = strOrNone(raw.action);
      const summary = strOrNone(raw.summary);
      const state = strOrNone(raw.state);
      if (action === null || summary === null || state === null || !APPROVAL_STATES.includes(state))
        return null;
      payload = {
        kind: "approval_request",
        turn_id: strOrNone(raw.turn_id),
        action,
        summary,
        risk: strOrNone(raw.risk),
        state: state as "pending" | "confirmed" | "dismissed",
      };
      break;
    }
    default:
      return null;
  }
  if (payload === null) return null;
  return { id: message.id, kind: payload.kind, payload, created_at: message.created_at };
}

/** The list endpoint's page, row by row; unrenderable rows drop out. */
export function mapAssistantMessageList(
  list: components["schemas"]["AssistantMessageList"],
): LocalMessage[] {
  return list.messages
    .map((message) => mapAssistantMessage(message))
    .filter((message): message is LocalMessage => message !== null);
}

/**
 * The page context a turn runs in (ADR-0050 Decision 6): the route, the
 * project when the route carries one, and the entity when the route is about
 * one — a run workbench (`/runs/:runId`) or a draft (`/workflows/:id/drafts/:draftId`).
 * Kinds outside the ADR's list (pipeline, draft, run, node_template, profile)
 * contribute nothing rather than guessing.
 */
export function assistantContextOf(pathname: string): AssistantMessageContext {
  const context: AssistantMessageContext = { route: pathname };
  const project = /^\/p\/([^/?#]+)/.exec(pathname);
  if (project && project[1].length > 0) context.project_id = decodeURIComponent(project[1]);
  const run = /^\/runs\/([^/?#]+)/.exec(pathname);
  if (run && run[1].length > 0) {
    context.entity = { kind: "run", id: decodeURIComponent(run[1]) };
    return context;
  }
  const draft = /^\/workflows\/[^/?#]+\/drafts\/([^/?#]+)/.exec(pathname);
  if (draft && draft[1].length > 0) {
    context.entity = { kind: "draft", id: decodeURIComponent(draft[1]) };
  }
  return context;
}
