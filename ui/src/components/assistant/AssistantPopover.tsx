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
 */
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import AssistantPanel from "./AssistantPanel";
import { sectionOf } from "../Shell";
import { shortId } from "../../api/names";
import { useAssistantPrefs } from "../../lib/prefs";
import { assistantTransientErrorLine, problemOf } from "../../api/client";
import {
  assistantContextOf,
  assistantNotConfigured,
  useAssistantChanges,
  useAssistantConversations,
  useAssistantMessages,
  useCreateAssistantConversation,
  usePostAssistantMessage,
  useUndoAllAssistantChanges,
  useUndoAssistantChange,
} from "../../api/assistant";
import type { AssistantChange, AssistantMessage } from "./types";

/** The palette's Ask row opens the popover (and carries its question). */
const ASSISTANT_OPEN_EVENT = "communication:assistant-open";

/** The jump palette's open event; ⌘K while the assistant is up dispatches it. */
const PALETTE_OPEN_EVENT = "communication:palette-open";

/** Open the assistant popover; `text`, when given, is sent as a question. */
export function openAssistantPopover(text?: string): void {
  window.dispatchEvent(new CustomEvent(ASSISTANT_OPEN_EVENT, { detail: text }));
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

/** One honest line for a failed turn (no modal; the panel stays usable). */
function failureLine(error: unknown): string {
  if (assistantNotConfigured(error)) {
    return "The assistant isn't configured on this server — your question was not sent.";
  }
  const transient = assistantTransientErrorLine(error);
  if (transient) return transient;
  const problem = problemOf(error);
  return problem.detail || problem.title;
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

  /** One plain-text turn (composer, suggestion chip, a question's option
   * label, or the palette's carried-over question). */
  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      setSendError(null);
      void (async () => {
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
            body: { text: trimmed, context: assistantContextOf(location.pathname) },
          });
          setMessages((current) => [...current, ...result]);
        } catch (error) {
          setSendError(failureLine(error));
        }
      })();
    },
    [conversationId, createConversation, post, location.pathname],
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
        if (!open) setOpen(true);
        else window.dispatchEvent(new CustomEvent(PALETTE_OPEN_EVENT));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  // The palette's Ask row: open (and, with a question carried over, send it).
  useEffect(() => {
    const onOpen = (event: Event) => {
      setOpen(true);
      const text = (event as CustomEvent<string | undefined>).detail;
      if (typeof text === "string" && text.trim().length > 0) send(text);
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
        setSendError(failureLine(error));
      }
    })();
  };

  const close = useCallback(() => setOpen(false), []);
  const shrink = useCallback(() => setExpanded(false), []);

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
            onSend={(text) => void send(text)}
            onAnswerQuestion={(label) => void send(label)}
            onConfirmApproval={(messageId) => answerApproval(messageId, true)}
            onDismissApproval={(messageId) => answerApproval(messageId, false)}
            onGo={(route) => navigate(route)}
            onNewConversation={startNew}
            recentConversations={recentConversations}
            activeConversationId={conversationId}
            onSwitchConversation={switchConversation}
            onShrink={shrink}
            onClose={shrink}
            busy={post.isPending || createConversation.isPending}
          />
        </div>
      ) : (
        // 2a/3d/4d: the 400px popover anchored at the content's bottom-right.
        <div
          className="fixed bottom-4 right-4 z-40 flex w-[min(400px,calc(100vw-32px))] flex-col items-end gap-[6px]"
          data-testid="assistant-popover"
        >
          {sendError ? (
            <p
              data-testid="assistant-error"
              className="m-0 max-w-full rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-st-failed-pale-fg"
            >
              × {sendError}
            </p>
          ) : null}
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
            onSend={(text) => void send(text)}
            onAnswerQuestion={(label) => void send(label)}
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
