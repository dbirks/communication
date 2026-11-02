/**
 * Assistant v2 container (ADR-0050; "Six Directions" 2a/2c/3d/4d, phase 7).
 *
 * Owns what the presentational AssistantPanel does not: the ⌘K open state
 * and the popover/expanded variants, the persisted conversation (the
 * caller's newest, or a new one — state lives HERE, mounted at the Shell, so
 * a page change never loses the transcript), the transcript and change-log
 * reads, and every mutation round-trip (send, answer, confirm/dismiss, undo).
 *
 * The ask surface opens three ways: ⌘K (this component's window listener),
 * the sidebar's `Ask ⌘K` row and the floating button (both press ⌘K), and
 * the command palette's Ask row (`openAssistantPopover` below, which also
 * carries the question it was typed with). While open, ⌘K opens the jump
 * palette instead — the assistant is already on screen.
 *
 * Failures are honest lines, not modals: a 503 `assistant_not_configured`
 * says so in one sentence, and nothing the server did not answer is shown.
 * Because a failed turn stores nothing (ADR-0034), the line also says the
 * question was not sent, and the person's words come back into the composer
 * — the popover, the expanded view and the palette's carried-over question
 * all behave the same way (assistant-lost-ask).
 *
 * Issue #63 changes where an ask lives while its turn is in flight: every
 * send (composer, suggestion chip, question option, palette carry-over)
 * lands in the transcript IMMEDIATELY as the person's own user bubble — the
 * empty-state suggestions disappear on the click, `thinking…` follows the
 * bubble, and the server's rows replace the local one when the turn
 * settles. A failed turn keeps the bubble and answers it in place: the
 * honest error line under the person's words, with a `Retry` that sends
 * them again (the row is retired by the next round-trip — it was never
 * stored, ADR-0034).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import AssistantPanel from "./AssistantPanel";
import { sectionOf } from "../Shell";
import { shortId } from "../../api/names";
import { useAssistantPrefs } from "../../lib/prefs";
import { assistantTransientErrorLine, problemOf } from "../../api/client";
import {
  assistantContextOf,
  assistantNotConfigured,
  degradedOf,
  useAssistantChanges,
  useAssistantConversations,
  useAssistantMessages,
  useCreateAssistantConversation,
  usePostAssistantMessage,
  useUndoAllAssistantChanges,
  useUndoAssistantChange,
} from "../../api/assistant";
import type { AssistantChange, AssistantMessage, AssistantMessageContext } from "./types";
import type { ComposerRestore } from "./AssistantPanel";

/** The palette's Ask row opens the popover (and carries its question). */
export const ASSISTANT_OPEN_EVENT = "communication:assistant-open";

/** The jump palette's open event; ⌘K while the assistant is up dispatches it. */
const PALETTE_OPEN_EVENT = "communication:palette-open";

/** One menu open at a time (issue #62): whenever the assistant opens over a
 * chord or the palette's Ask row, the shell's other menus (New) close now —
 * the keyboard paths have no outside pointerdown to close them. */
const CLOSE_OTHER_MENUS_EVENT = "communication:close-other-menus";

function closeOtherMenus(): void {
  window.dispatchEvent(new CustomEvent(CLOSE_OTHER_MENUS_EVENT));
}

/** Open the assistant popover; `text`, when given, is sent as a question. */
export function openAssistantPopover(text?: string): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail: text }));
}

/**
 * The structured form of an `ASSISTANT_OPEN_EVENT` detail (a bare string is
 * still the simple ask). `expanded` opens the full AssistantPanel instead of
 * the bottom-right popover; `entity` rides along as the ask's structured
 * context so ids travel as data, not as visible prose.
 */
export interface AssistantOpenRequest {
  text: string;
  expanded?: boolean;
  entity?: NonNullable<AssistantMessageContext["entity"]>;
}

/**
 * Thread → workflow (design 2f): `Make a workflow…` opens the assistant
 * PANEL (the full-size AssistantPanel, not the floating popover) with the
 * chat as context. The ask is one human sentence — `Turn the chat “title”
 * into a workflow` — and the conversation id travels as the message's
 * structured context entity, never in the visible text (the assistant
 * reads the transcript through its caller-checked `chat.transcript` tool;
 * the id alone authorizes nothing).
 */
export function openAssistantWorkflowDraft(chat: { id: string; title?: string | null }): void {
  const title = chat.title?.trim();
  const request: AssistantOpenRequest = {
    text: title
      ? `Turn the chat \u201C${title}\u201D into a workflow`
      : "Turn this chat into a workflow",
    expanded: true,
    entity: { kind: "conversation", id: chat.id },
  };
  window.dispatchEvent(
    new CustomEvent<AssistantOpenRequest>(ASSISTANT_OPEN_EVENT, {
      detail: request,
    }),
  );
}

/** The "FOR THIS PAGE" suggestions, keyed by the page section. Every one is
 * something the assistant really can do today (a read or a navigation). */
const SUGGESTIONS: Record<string, string[]> = {
  home: [
    "What needs me right now?",
    "Which of my runs are running or failed?",
    "Show the pending approvals.",
  ],
  inbox: [
    "Summarize my inbox.",
    "Which items need an approval from me?",
    "What failed most recently?",
  ],
  board: ["Which runs are stuck on me?", "Show the failed runs.", "What is running right now?"],
  threads: [
    "What is open in my threads?",
    "Which runs are running or failed?",
    "Show the pending approvals.",
  ],
  projects: [
    "Which projects have failed runs?",
    "Where do I have pending approvals?",
    "What is running right now?",
  ],
  runs: [
    "Why is this run stuck?",
    "Which steps failed on this run?",
    "What does the run's next step wait on?",
  ],
  pipelines: [
    "What revisions does this pipeline have?",
    "Which runs use this pipeline?",
    "What needs me in this project?",
  ],
  workflows: [
    "What revisions does this workflow have?",
    "Which runs use this workflow?",
    "What needs me right now?",
  ],
  artifacts: [
    "What artifacts does this project have?",
    "Which runs produced them?",
    "What needs me right now?",
  ],
  conversations: [
    "What is open in this project's conversations?",
    "Which runs are running or failed?",
    "What needs me right now?",
  ],
  settings: [
    "What needs me right now?",
    "Which of my runs are running or failed?",
    "Show the pending approvals.",
  ],
  ops: [
    "What is running on the workers right now?",
    "Which runs are failed or waiting?",
    "What needs me right now?",
  ],
};

const GENERIC_SUGGESTIONS = [
  "What needs me right now?",
  "Which of my runs are running or failed?",
  "Show the pending approvals.",
];

/** The composer chip label: the page section, or the entity when the page is
 * about one (`run <short id>`, `draft <short id>` — the shots' wording). */
function contextLabelOf(pathname: string): string {
  const run = /^\/runs\/([^/?#]+)/.exec(pathname);
  if (run) return `run ${shortId(decodeURIComponent(run[1]))}`;
  const draft = /^\/workflows\/[^/?#]+\/drafts\/([^/?#]+)/.exec(pathname);
  if (draft) return `draft ${shortId(decodeURIComponent(draft[1]))}`;
  const project = /^\/p\/[^/?#]+\/?([^/?#]*)/.exec(pathname);
  if (project) return project[1] || "projects";
  return sectionOf(pathname);
}

/** The degraded causes that mean “the turn ran out of its step budget”. */
const STEP_CAP_CAUSES: readonly string[] = ["model_call_cap_exceeded", "tool_cap_exceeded"];

/**
 * One honest line for a failed turn (no modal; the panel stays usable).
 *
 * assistant-lost-ask: a failed turn stores nothing (ADR-0034), so the line has
 * to say what actually happened to the person's words — the ask was not sent
 * and is back in the composer to send again. A step-limit turn is named by its
 * cause rather than the server's internal cap phrasing. `failed="decision"`
 * is an approval Retry/Not-now round-trip: the pending card stays put, so the
 * line names the API's reason and says nothing about a lost question.
 */
function failureLine(error: unknown, failed: "question" | "decision" = "question"): string {
  if (assistantNotConfigured(error)) {
    return "The assistant isn't configured on this server — your question was not sent.";
  }
  if (failed === "question" && STEP_CAP_CAUSES.includes(degradedOf(error) ?? "")) {
    return "The assistant hit its step limit before answering — nothing was saved; send again.";
  }
  const problem = problemOf(error);
  const base =
    assistantTransientErrorLine(error) ||
    problem.detail ||
    problem.title ||
    "The assistant could not answer.";
  if (failed === "decision") return base;
  // A failed turn stores nothing (ADR-0034): say so plainly, and that the ask
  // can go again — the composer holds it (assistant-lost-ask).
  return `${base}${/[.!?]$/.test(base) ? "" : "."} Your question was not sent — send it again.`;
}

/**
 * ui-convfix: the popover session's conversation choice, kept in
 * sessionStorage. The state is plain component state, so a remount (or a
 * page reload) would reset it and the adopt-newest effect below would
 * re-adopt the caller's newest conversation — over a `New conversation`
 * the user already started (the follow-up would land in the wrong
 * history). The choice — including a pending New — therefore survives a
 * remount until `New conversation` is pressed again.
 */
const SESSION_KEY = "communication.assistant.popover";

interface SessionChoice {
  conversationId: string | null;
  awaitingNew: boolean;
}

function readChoice(): SessionChoice | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<SessionChoice>;
    if (parsed.conversationId !== null && typeof parsed.conversationId !== "string") return null;
    return {
      conversationId: parsed.conversationId ?? null,
      awaitingNew: parsed.awaitingNew === true,
    };
  } catch {
    return null;
  }
}

function writeChoice(choice: SessionChoice): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(choice));
  } catch {
    // storage unavailable (private mode): the choice stays in memory only.
  }
}

export default function AssistantPopover() {
  const location = useLocation();
  const navigate = useNavigate();
  const { trustLevel, setTrustLevel } = useAssistantPrefs();

  // ui-convfix: the persisted choice seeds the session state — a fresh
  // mount resumes the conversation (or the pending New) instead of
  // re-adopting the caller's newest one.
  const [choice] = useState(readChoice);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(
    choice?.conversationId ?? null,
  );
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  /**
   * assistant-lost-ask: an ask the composer never held (the palette carries
   * its question straight to the POST) that failed to send — handed back to
   * the panel's composer as a one-shot request, so the person's words survive
   * the failure exactly like a typed ask does.
   */
  const [composerRestore, setComposerRestore] = useState<ComposerRestore | null>(null);
  const restoreSeq = useRef(0);
  const handBackToComposer = useCallback((text: string) => {
    restoreSeq.current += 1;
    setComposerRestore({ token: restoreSeq.current, text });
  }, []);
  /**
   * ui-newconv: the user pressed New conversation — the newest conversation
   * must NOT be re-adopted; the next send creates a fresh one and clears
   * the flag. The change chip resets automatically: it reads the
   * conversation's changes, and a fresh conversation has none.
   */
  const [awaitingNew, setAwaitingNew] = useState(choice?.awaitingNew ?? false);

  // ui-convfix: keep the choice in sessionStorage — a remount (or a page
  // reload) must not re-adopt the caller's newest conversation over it.
  useEffect(() => {
    writeChoice({ conversationId, awaitingNew });
  }, [conversationId, awaitingNew]);

  const conversations = useAssistantConversations(5, open);
  const createConversation = useCreateAssistantConversation();
  const messagesQuery = useAssistantMessages(conversationId);
  const post = usePostAssistantMessage();
  const changesQuery = useAssistantChanges(conversationId);
  const undoChange = useUndoAssistantChange();
  const undoAll = useUndoAllAssistantChanges();

  // The server's transcript is the source of truth; adopted while there is
  // nothing on screen for the current conversation (first open, a New
  // conversation, a Recent-menu switch — the switch handlers clear the
  // transcript state first). Once rows are on screen, a post appends its own
  // rows and a later refetch must not clobber them.
  useEffect(() => {
    if (conversationId !== null && messagesQuery.data && messages.length === 0) {
      setMessages(messagesQuery.data);
    }
  }, [conversationId, messagesQuery.data, messages.length]);

  /**
   * One plain-text turn (composer, suggestion chip, a question's option
   * label, or the palette's carried-over question). Resolves `true` when the
   * server took the turn and `false` when it did not — the panel puts a
   * rejected composer ask back in the composer (assistant-lost-ask).
   *
   * `carriedOver` marks the palette's question, which never lived in the
   * composer: on failure this container hands it back through `composerRestore`.
   *
  /**
   * Issue #63: the ask shows as the person's own bubble the moment it is
   * sent — an optimistic local row appended BEFORE the round-trip (so the
   * empty-state suggestions disappear on a chip click and `thinking…`
   * follows the words). On success the server's echoed rows replace the
   * local row; on failure the bubble stays, carries the honest line under
   * it, and offers `Retry` (see MessageList).
   *
   * 2f: `entity` names the ask's subject as STRUCTURED context (the chat a
   * workflow draft is about) — it rides the post body's context, never the
   * visible text.
   */
  const localSeq = useRef(0);

  /** Issue #63: drop failed optimistic rows from an earlier attempt — they
   * are not server rows (a failed turn stores nothing), and a fresh
   * round-trip supersedes them. */
  const retireFailedAsks = useCallback(() => {
    setMessages((current) =>
      current.some((message) => message.local?.state === "failed")
        ? current.filter((message) => message.local?.state !== "failed")
        : current,
    );
  }, []);

  const send = useCallback(
    (
      text: string,
      carriedOver = false,
      entity?: AssistantOpenRequest["entity"],
    ): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return Promise.resolve(false);
      setSendError(null);
      retireFailedAsks();
      localSeq.current += 1;
      const localId = `local-user-${localSeq.current}`;
      const optimistic: AssistantMessage = {
        id: localId,
        kind: "user",
        payload: { kind: "user", text: trimmed },
        created_at: new Date().toISOString(),
        local: { state: "pending" },
      };
      setMessages((current) => [...current, optimistic]);
      const context: AssistantMessageContext = assistantContextOf(location.pathname);
      if (entity) context.entity = entity;
      return (async () => {
        try {
          let id = conversationId;
          if (!id) {
            const created = await createConversation.mutateAsync();
            id = created.id;
            setConversationId(id);
            setAwaitingNew(false);
          }
          const result = await post.mutateAsync({
            conversationId: id,
            body: { text: trimmed, context },
          });
          setMessages((current) => {
            const rest = current.filter((message) => message.id !== localId);
            // The server echoes the user row first on success; if a turn
            // returned none, keep the local bubble as a plain row so the
            // ask that WAS sent never vanishes from the screen.
            const head = result.some((message) => message.kind === "user")
              ? []
              : [{ ...optimistic, local: undefined }];
            return [...rest, ...head, ...result];
          });
          return true;
        } catch (error) {
          // Issue #63: the person's words stay on screen — the honest line
          // answers them under the bubble, with a Retry. The composer
          // still takes a rejected ask back (assistant-lost-ask: the panel
          // restores the text when this resolves `false`, and carried-over
          // questions come back through `composerRestore`).
          const line = failureLine(error);
          setMessages((current) =>
            current.map((message) =>
              message.id === localId
                ? { ...message, local: { state: "failed", error: line } }
                : message,
            ),
          );
          if (carriedOver) handBackToComposer(trimmed);
          return false;
        }
      })();
    },
    [
      conversationId,
      createConversation,
      handBackToComposer,
      post,
      location.pathname,
      retireFailedAsks,
    ],
  );

  /** ui-newconv: `New conversation` — clear the panel; the next send
   * creates the fresh conversation (no transcript, no change chip). */
  const startNew = useCallback(() => {
    setConversationId(null);
    setMessages([]);
    setSendError(null);
    setAwaitingNew(true);
  }, []);

  /** ui-newconv: the Recent menu's switch — adopt that conversation's
   * transcript (and its change chip) once its rows load. */
  const switchConversation = useCallback(
    (id: string) => {
      if (id === conversationId) return;
      setMessages([]);
      setConversationId(id);
      setSendError(null);
      setAwaitingNew(false);
    },
    [conversationId],
  );

  // ⌘K: closed opens the popover; open (either size) hands the chord to the
  // jump palette — the assistant is already on screen. The listener runs in
  // the CAPTURE phase on purpose: the Studio draft footer (design 1g) listens
  // for the same chord with `stopImmediatePropagation`, and after one open→
  // close cycle this effect re-registers LAST, so in the bubble phase that
  // hijack would swallow every further ⌘K and the ask surface could never
  // reopen on the draft page (observed live: second ⌘K after Escape opened
  // neither popover nor palette). Capture makes the global chord order-invariant.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!open) {
          closeOtherMenus();
          setOpen(true);
        } else {
          window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // The palette's Ask row (a bare string) and the structured 2f draft ask
  // both open the surface here: the string opens the popover, an
  // `AssistantOpenRequest` may open the full panel and names its entity as
  // the ask's structured context. A panel opened expanded by the draft ask
  // closes completely on esc (it never falls back to the floating popover
  // over the chat's composer — the 2f review).
  const openedExpandedByAsk = useRef(false);
  useEffect(() => {
    const onOpen = (event: Event) => {
      closeOtherMenus();
      const detail = (event as CustomEvent<string | AssistantOpenRequest | undefined>).detail;
      const request: AssistantOpenRequest =
        typeof detail === "string" ? { text: detail } : (detail ?? { text: "" });
      if (request.expanded) {
        openedExpandedByAsk.current = true;
        setExpanded(true);
      }
      setOpen(true);
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (text.length > 0) void send(text, true, request.entity);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ASSISTANT_OPEN_EVENT, onOpen);
  }, [send]);

  // The conversation survives page changes: the newest one the caller has,
  // adopted while the popover is open; a fresh one is created on first send.
  // A pending New conversation suppresses the adoption (the user chose to
  // leave the old history behind — re-adopting it is the bug this fixes).
  // A persisted choice (ui-convfix) suppresses it the same way: both a
  // resumed conversation id and a resumed pending New guard the effect.
  useEffect(() => {
    if (!open || conversationId || awaitingNew) return;
    const latest = conversations.data?.conversations[0];
    if (latest) setConversationId(latest.id);
  }, [open, conversationId, awaitingNew, conversations.data]);

  /** `Retry` / `Not now` on a pending approval_request (ADR-0050 Decision 4).
   * The decision post carries ONLY the request id — `{confirm: <id>}` or
   * `{dismiss: <id>}` — never `text` (the handler 400s a decision post that
   * carries text); a failed decision shows the API's own message inline.
   * Part 1 answers `400 approval_requests_not_available` until the gate
   * lands; the honest line says so. */
  const answerApproval = (messageId: string, confirm: boolean) => {
    void (async () => {
      setSendError(null);
      // Issue #63: a decision round-trip supersedes any ask still sitting
      // failed on screen (it was never stored; the composer holds its text).
      retireFailedAsks();
      try {
        let id = conversationId;
        if (!id) {
          const created = await createConversation.mutateAsync();
          id = created.id;
          setConversationId(id);
          setAwaitingNew(false);
        }
        const result = await post.mutateAsync({
          conversationId: id,
          body: confirm ? { confirm: messageId } : { dismiss: messageId },
        });
        setMessages((current) => [...current, ...result]);
      } catch (error) {
        setSendError(failureLine(error, "decision"));
      }
    })();
  };

  /** The decision-failure line, identical in both sizes (assistant-lost-ask).
   * Issue #63 moved a failed QUESTION ask inline — its line now lives under
   * the person's own bubble with the Retry — so this row carries the
   * approval Round-Trip failures, which have no user bubble of their own. */
  const errorLine = sendError ? (
    <p
      data-testid="assistant-error"
      className="m-0 max-w-full rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-st-failed-pale-fg"
    >
      × {sendError}
    </p>
  ) : null;

  const close = useCallback(() => setOpen(false), []);
  const shrink = useCallback(() => setExpanded(false), []);
  /** esc / close on a panel the draft ask opened expanded: close the whole
   * surface (the 2f panel never shrinks back into the floating box). */
  const closeExpanded = useCallback(() => {
    if (openedExpandedByAsk.current) {
      openedExpandedByAsk.current = false;
      setOpen(false);
      setExpanded(false);
    } else {
      setExpanded(false);
    }
  }, []);

  /** ui-newconv: the Recent menu's rows, newest first (the API's order). */
  const recentConversations = (conversations.data?.conversations ?? []).map((c) => ({
    id: c.id,
    title: c.title,
    lastMessageAt: c.last_message_at,
  }));

  if (!open) return null;

  const contextLabel = contextLabelOf(location.pathname);
  const changes: AssistantChange[] = changesQuery.data?.changes ?? [];

  return (
    <>
      {expanded ? (
        // 2c: the expanded overlay over the content area; the conversation
        // column is centred at 680px inside the panel itself.
        <div
          className="fixed inset-0 z-40 flex flex-col bg-surface"
          data-testid="assistant-popover"
        >
          {sendError ? <div className="px-[10px] pt-[8px]">{errorLine}</div> : null}
          <AssistantPanel
            variant="expanded"
            contextLabel={contextLabel}
            messages={messages}
            trustLevel={trustLevel}
            onTrustLevelChange={(level) => setTrustLevel(level)}
            changes={changes}
            onUndoChange={(changeId) => undoChange.mutate(changeId)}
            onUndoAll={() => conversationId && undoAll.mutate({ conversationId })}
            suggestions={SUGGESTIONS[contextLabel] ?? GENERIC_SUGGESTIONS}
            onSend={(text) => send(text)}
            onAnswerQuestion={(label) => send(label)}
            composerRestore={composerRestore}
            onConfirmApproval={(messageId) => answerApproval(messageId, true)}
            onDismissApproval={(messageId) => answerApproval(messageId, false)}
            onGo={(route) => navigate(route)}
            onNewConversation={startNew}
            recentConversations={recentConversations}
            activeConversationId={conversationId}
            onSwitchConversation={switchConversation}
            onShrink={shrink}
            onClose={closeExpanded}
            busy={post.isPending || createConversation.isPending}
          />
        </div>
      ) : (
        // 2a/3d/4d: the 400px popover anchored at the content's bottom-right.
        <div
          className="fixed bottom-4 right-4 z-40 flex w-[min(400px,calc(100vw-32px))] flex-col items-end gap-[6px]"
          data-testid="assistant-popover"
        >
          {sendError ? errorLine : null}
          <AssistantPanel
            variant="popover"
            contextLabel={contextLabel}
            messages={messages}
            trustLevel={trustLevel}
            onTrustLevelChange={(level) => setTrustLevel(level)}
            changes={changes}
            onUndoChange={(changeId) => undoChange.mutate(changeId)}
            onUndoAll={() => conversationId && undoAll.mutate({ conversationId })}
            suggestions={SUGGESTIONS[contextLabel] ?? GENERIC_SUGGESTIONS}
            onSend={(text) => send(text)}
            onAnswerQuestion={(label) => send(label)}
            composerRestore={composerRestore}
            onConfirmApproval={(messageId) => answerApproval(messageId, true)}
            onDismissApproval={(messageId) => answerApproval(messageId, false)}
            onGo={(route) => navigate(route)}
            onNewConversation={startNew}
            recentConversations={recentConversations}
            activeConversationId={conversationId}
            onSwitchConversation={switchConversation}
            onExpand={() => setExpanded(true)}
            onClose={close}
            busy={post.isPending || createConversation.isPending}
          />
        </div>
      )}
    </>
  );
}
