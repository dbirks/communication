import { useCallback, useEffect, useRef, useState } from "react";
import { Minimize2, Plus } from "lucide-react";
import { Button } from "../ds/Button";
import { formatAge } from "../../lib/format";
import { useSpeechToText } from "../../lib/speech";
import { ChangeChip } from "./ChangeChip";
import ListeningBar from "./ListeningBar";
import MessageList from "./MessageList";
import MicButton from "./MicButton";
import { TrustPill } from "./TrustPill";
import type { AssistantChange, AssistantMessage, TrustLevel } from "./types";

/**
 * The assistant surface in both sizes (2a/3d/4d popover, 2c expanded) —
 * the "Six Directions" app-shell assistant. Purely presentational: the
 * conversation, changes and trust level flow in as props (the caller owns
 * the ADR-0050 conversation routes), and every action (send, answer,
 * confirm/dismiss, navigation, undo, expand/shrink/close) comes back
 * through a callback.
 *
 * What this component owns itself: the composer draft, the mic
 * (Web Speech API, via useSpeechToText — hidden where unsupported), the
 * esc-to-close behaviour and the empty-state suggestion chips.
 *
 * `variant="popover"` is the 400px bottom-right panel (1px ink border,
 * radius 4, hard 2px shadow); `variant="expanded"` is the full content
 * area with the conversation column centred at max 680px.
 */
/**
 * What an ask round-trip may report back (assistant-lost-ask): a send that
 * the server never took (`false`, or a throw) must put the person's text back
 * into the composer, because a failed turn stores nothing (ADR-0034). Any
 * other return — `undefined`, `true`, a void sync call — counts as accepted
 * and leaves the composer cleared. Sync callers that cannot report anything
 * keep working unchanged.
 */
export type SendResult = boolean | void | Promise<boolean | void>;

/**
 * A one-shot request from the caller to put `text` back into the composer.
 * `token` must change for the panel to apply it again (the palette's
 * carried-over ask never lived in the draft, so only the caller can hand it
 * back after a failed send).
 */
export interface ComposerRestore {
  token: number;
  text: string;
}

/**
 * One of the caller's recent conversations for the "Recent" menu — the
 * newest `last_message_at` first (up to 5), straight off the list API.
 */
export interface RecentConversation {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
}

export interface AssistantPanelProps {
  variant: "popover" | "expanded";
  /**
   * Popover: the page-context chip label (`home`, `feature-delivery`,
   * `run 9c1e`…) shown in the composer; it updates on navigation while
   * the conversation stays. Expanded: the `opened from …` chip.
   */
  contextLabel: string;
  /** Transcript, oldest first; `change` rows are rendered by the chip. */
  messages: AssistantMessage[];
  trustLevel: TrustLevel;
  onTrustLevelChange: (level: TrustLevel) => void;
  /** Change log for the conversation (ADR-0050); drives the change chip. */
  changes?: AssistantChange[];
  onUndoChange?: (changeId: string) => void;
  onUndoAll?: () => void;
  /**
   * Empty-state "FOR THIS PAGE" chips — at most 3 are rendered, each
   * sends its text as a plain question through onSend.
   */
  suggestions?: string[];
  /** Send one plain-text message (composer, free text, suggestion chip). */
  onSend: (text: string) => SendResult;
  /** Answer a follow-up question with the option's label verbatim. */
  onAnswerQuestion: (label: string) => SendResult;
  /**
   * assistant-lost-ask: hand text back to the composer from outside it — the
   * caller's carried-over ask (the palette) that failed to send. Applied once
   * per `token`, and only while the composer is empty, so a draft the person
   * has typed in the meantime is never clobbered.
   */
  composerRestore?: ComposerRestore | null;
  /** `Retry` on a pending approval_request (names the message id). */
  onConfirmApproval: (messageId: string) => void;
  /** `Not now` on a pending approval_request (names the message id). */
  onDismissApproval: (messageId: string) => void;
  /** Navigate to a `Go ›` link row's route. */
  onGo: (route: string) => void;
  /**
   * `New conversation` header control: clears the panel so the next send
   * starts a fresh conversation (the caller creates it and reports the id
   * back through the normal send round-trip).
   */
  onNewConversation?: () => void;
  /** Caller's last 5 conversations (newest first) for the Recent menu. */
  recentConversations?: RecentConversation[];
  /** The conversation currently displayed, if any (the Recent menu's ✓). */
  activeConversationId?: string | null;
  /** Switch the panel back to an existing conversation (Recent menu). */
  onSwitchConversation?: (id: string) => void;
  /** Popover only: grow into the expanded view (⤢). */
  onExpand?: () => void;
  /** Expanded only: back to the 400px popover. */
  onShrink?: () => void;
  /** esc closes whatever the user opened (the panel itself or its page). */
  onClose: () => void;
  /** A turn is in flight: shows `thinking…` and locks the composer. */
  busy?: boolean;
}

const POPOVER_WIDTH = 400;

const headerButtonStyle: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10.5,
  border: "none",
  background: "transparent",
  color: "var(--color-ink-2)",
  cursor: "pointer",
  padding: "2px 4px",
};

function ContextChip({ label }: { label: string }) {
  return (
    <span
      data-testid="assistant-context-chip"
      title={label}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        border: "1px solid var(--color-line-strong)",
        borderRadius: 4,
        background: "var(--color-fill)",
        color: "var(--color-ink-2)",
        padding: "2px 7px",
        flexShrink: 0,
        maxWidth: 140,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/**
 * The header's "Recent" menu (ui-newconv; ADR-0050 part 1): the caller's
 * last 5 conversations by title + age, newest first. Purely presentational
 * — switching reports the id back through onSwitch. Same interaction
 * contract as TrustPill: esc closes only the menu (stopPropagation keeps
 * the panel open), arrows + Enter pick an item, tabbing away closes it.
 */
function RecentMenu({
  conversations,
  activeId,
  onSwitch,
  compact = false,
}: {
  conversations: RecentConversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  /** Popover: the word `Recent` is kept for assistive tech and the DOM but
   * hidden on screen — the 400px header cannot fit it whole (2f review:
   * the header controls wrapped onto two lines at 390). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const handleBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget;
    if (
      next &&
      !menuRef.current?.contains(next as Node) &&
      !triggerRef.current?.contains(next as Node)
    ) {
      setOpen(false);
    }
  };

  const moveFocus = (to: number) => {
    const count = conversations.length;
    if (count === 0) return;
    itemRefs.current[(to + count) % count]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = itemRefs.current;
    const focused = items.findIndex((item) => item === document.activeElement);
    switch (event.key) {
      case "Escape":
        // Close the menu, not the panel (same contract as the trust pill).
        event.stopPropagation();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        moveFocus(focused === -1 ? 0 : focused + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(focused === -1 ? items.length - 1 : focused - 1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0);
        break;
      case "End":
        event.preventDefault();
        moveFocus(items.length - 1);
        break;
      case "Enter":
      case " ":
        if (focused !== -1) {
          event.preventDefault();
          onSwitch(conversations[focused].id);
          close(true);
        }
        break;
    }
  };

  return (
    <div onBlur={handleBlur} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="assistant-history"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Recent conversations"
        onClick={() => {
          setOpen((nextOpen) => !nextOpen);
          if (open) return;
          requestAnimationFrame(() => itemRefs.current[0]?.focus());
        }}
        style={{ ...headerButtonStyle, whiteSpace: "nowrap" }}
      >
        {compact ? <span className="sr-only">Recent </span> : "Recent "}
        {open ? "▴" : "▾"}
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Recent conversations"
          data-testid="assistant-history-menu"
          onKeyDown={onMenuKeyDown}
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 4px)",
            zIndex: 30,
            width: 300,
            background: "var(--color-surface)",
            border: "1px solid var(--color-ink)",
            borderRadius: 4,
            boxShadow: "2px 2px 0 var(--color-ink)",
            padding: 8,
          }}
        >
          {conversations.length === 0 ? (
            <p className="m-0 px-[6px] py-[4px] text-[12px] text-muted">
              No conversations yet — the next answer starts one.
            </p>
          ) : (
            conversations.map((conversation, index) => {
              const active = conversation.id === activeId;
              return (
                <button
                  key={conversation.id}
                  ref={(node) => {
                    itemRefs.current[index] = node;
                  }}
                  type="button"
                  role="menuitem"
                  data-testid="assistant-history-item"
                  onClick={() => {
                    onSwitch(conversation.id);
                    close(true);
                  }}
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 6,
                    width: "100%",
                    textAlign: "left",
                    padding: "5px 8px",
                    borderRadius: 4,
                    border: "none",
                    background: active ? "var(--color-accent-wash)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <span
                    className="min-w-0 flex-1 truncate text-[12.5px] text-ink"
                    style={{ fontWeight: active ? 600 : 400 }}
                  >
                    {active ? "✓ " : ""}
                    {conversation.title ?? "Untitled"}
                  </span>
                  <span className="font-mono text-[9.5px] text-faint">
                    {formatAge(conversation.lastMessageAt)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({
  suggestions,
  onSuggestion,
}: {
  suggestions: string[];
  onSuggestion: (text: string) => void;
}) {
  return (
    <div data-testid="assistant-empty" style={{ padding: "14px 10px" }}>
      {suggestions.length > 0 ? (
        <>
          <p className="m-0 font-mono text-[10px] tracking-wider text-faint">FOR THIS PAGE</p>
          <div className="mt-[8px] flex flex-wrap gap-[6px]">
            {suggestions.map((text) => (
              <button
                key={text}
                type="button"
                data-testid="assistant-suggest"
                onClick={() => onSuggestion(text)}
                style={{
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: "var(--color-line-strong)",
                  borderRadius: 4,
                  background: "transparent",
                  padding: "6px 9px",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--color-ink-2)",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                {text}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="m-0 text-[12.5px] leading-[1.45] text-muted">
          Nothing to suggest on this page yet — ask, or tell it what to change.
        </p>
      )}
    </div>
  );
}

export function AssistantPanel({
  variant,
  contextLabel,
  messages,
  trustLevel,
  onTrustLevelChange,
  changes = [],
  onUndoChange,
  onUndoAll,
  suggestions = [],
  onSend,
  onAnswerQuestion,
  composerRestore = null,
  onConfirmApproval,
  onDismissApproval,
  onGo,
  onExpand,
  onShrink,
  onClose,
  onNewConversation,
  recentConversations = [],
  activeConversationId = null,
  onSwitchConversation,
  busy = false,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const speech = useSpeechToText();

  // esc closes the panel. The trust pill's menu handles its own esc and
  // stops propagation, so it closes the menu without closing the panel.
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat) return;
      handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // The dictation transcript stays editable text in the input (design:
  // "edit before sending"): final fragments are appended to the draft as
  // they arrive; the interim fragment is previewed by the ListeningBar.
  const lastFinalRef = useRef("");
  useEffect(() => {
    if (!speech.listening) return;
    const prev = lastFinalRef.current;
    if (speech.final !== prev && speech.final.startsWith(prev)) {
      const grown = speech.final.slice(prev.length).trim();
      if (grown) setDraft((d) => (d ? `${d} ${grown}` : grown));
    }
    lastFinalRef.current = speech.final;
  }, [speech.final, speech.listening]);

  const startListening = () => {
    speech.reset();
    lastFinalRef.current = "";
    speech.start();
  };

  const finishListening = () => {
    speech.stop();
    inputRef.current?.focus();
  };

  /**
   * assistant-lost-ask: put an unsent ask back where it can be sent again —
   * but never over text the person has typed since.
   */
  const restoreDraft = useCallback((text: string) => {
    setDraft((current) => (current.trim().length > 0 ? current : text));
  }, []);

  /** Report one round-trip back: `false`/throw means nothing was stored. */
  const watchSend = useCallback(
    (result: SendResult, text: string) => {
      void Promise.resolve(result).then(
        (accepted) => {
          if (accepted === false) restoreDraft(text);
        },
        () => restoreDraft(text),
      );
    },
    [restoreDraft],
  );

  /** The one send path: composer, Enter, and the suggestion chips. */
  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setDraft("");
      watchSend(onSend(trimmed), trimmed);
    },
    [busy, onSend, watchSend],
  );

  const send = () => submit(draft);

  /**
   * Issue #63: `Retry` under a failed ask re-sends those SAME words. The
   * composer's duplicate copy (the assistant-lost-ask restore) leaves with
   * the ask; a draft typed since is never clobbered — it stays put while
   * the retry travels, and the failed bubble (still holding the words) is
   * only re-marked `failed` if the retry fails too.
   */
  const retrySend = useCallback(
    (messageId: string) => {
      if (busy) return;
      const message = messages.find((candidate) => candidate.id === messageId);
      if (!message || message.payload.kind !== "user") return;
      const text = message.payload.text.trim();
      if (text.length === 0) return;
      if (draft.trim() === text) {
        submit(text);
      } else {
        watchSend(onSend(text), text);
      }
    },
    [busy, draft, messages, onSend, submit, watchSend],
  );

  const answerQuestion = useCallback(
    (label: string) => watchSend(onAnswerQuestion(label), label),
    [onAnswerQuestion, watchSend],
  );

  // A carried-over ask the caller lost (the palette's question): back into
  // the composer, once per token.
  const lastRestoreTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerRestore || composerRestore.token === lastRestoreTokenRef.current) return;
    lastRestoreTokenRef.current = composerRestore.token;
    restoreDraft(composerRestore.text);
  }, [composerRestore, restoreDraft]);

  const popover = variant === "popover";

  // ui-newconv: the header's New conversation / Recent controls. The
  // popover's 400px header is tight (ASSISTANT + trust pill + expand +
  // esc hint), so the popover shortens the labels; the expanded header
  // shows the full wording — until phone width, where the expanded header
  // has the same problem the popover's has (review 2f: `Shrink to popover`
  // clipped to `S`/`po` and the chip wrapped onto three lines, so the row
  // ran off the right edge of the screen). Below 640px both header buttons
  // are icon-only with their wording in the accessible name and the tooltip.
  const newConversationButton = onNewConversation ? (
    <Button
      variant="ghost"
      compact
      data-testid="assistant-new-conversation"
      title="New conversation"
      aria-label="New conversation"
      className="shrink-0"
      onClick={onNewConversation}
    >
      {/* 2f review: the 400px (or 358px on a phone) popover header cannot fit
        the full wording next to the trust pill, and the row must never break
        onto two lines — the popover keeps just the ＋ on screen, with the
        wording in the accessible name and the tooltip. */}
      {popover ? (
        <>
          ＋<span className="sr-only"> New</span>
        </>
      ) : (
        <>
          <Plus size={13} strokeWidth={2} aria-hidden className="shrink-0 min-[640px]:hidden" />
          <span className="hidden min-[640px]:inline">New conversation</span>
        </>
      )}
    </Button>
  ) : null;

  const recentButton = onSwitchConversation ? (
    <RecentMenu
      conversations={recentConversations.slice(0, 5)}
      activeId={activeConversationId}
      onSwitch={onSwitchConversation}
      compact={popover}
    />
  ) : null;

  const header = (
    <div
      data-testid="assistant-panel-header"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        background: "var(--color-fill)",
        borderBottom: "1px solid var(--color-line)",
      }}
    >
      {popover ? (
        <>
          <span className="shrink-0 font-mono text-[10.5px] font-semibold tracking-wider text-ink whitespace-nowrap">
            ASSISTANT
          </span>
          <TrustPill value={trustLevel} onChange={onTrustLevelChange} />
          <span style={{ flex: "1 1 auto" }} />
          {newConversationButton}
          {recentButton}
          {onExpand ? (
            <button
              type="button"
              data-testid="assistant-expand"
              title="Expand"
              style={headerButtonStyle}
              onClick={onExpand}
            >
              ⤢
            </button>
          ) : null}
          <span className="font-mono text-[10px] text-faint">esc</span>
        </>
      ) : (
        <>
          <span className="text-[14px] text-ink" style={{ fontWeight: 600 }}>
            Assistant
          </span>
          {contextLabel ? (
            <span
              data-testid="assistant-opened-from"
              title={`opened from ${contextLabel}`}
              // The chip truncates (review 2f: `opened from threads` wrapped
              // onto three lines and pushed the row off the screen). `min-w-0`
              // is what lets a flex item give its width back.
              className="min-w-0 max-w-[42%] truncate"
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                border: "1px solid var(--color-line-strong)",
                borderRadius: 4,
                background: "var(--color-fill)",
                color: "var(--color-ink-2)",
                padding: "2px 7px",
              }}
            >
              {`opened from ${contextLabel}`}
            </span>
          ) : null}
          <span className="min-w-0 basis-0 grow" />
          {newConversationButton}
          {recentButton}
          {onShrink ? (
            <button
              type="button"
              data-testid="assistant-shrink"
              aria-label="Shrink to popover"
              title="Shrink to popover"
              className="inline-flex shrink-0 items-center"
              style={headerButtonStyle}
              onClick={onShrink}
            >
              <Minimize2
                size={13}
                strokeWidth={2}
                aria-hidden
                className="shrink-0 min-[640px]:hidden"
              />
              <span className="hidden min-[640px]:inline">Shrink to popover</span>
            </button>
          ) : null}
          <span className="font-mono text-[10px] text-faint">esc</span>
        </>
      )}
    </div>
  );

  const body = (
    <div data-testid="assistant-body" style={{ flex: "1 1 auto", overflowY: "auto", minHeight: 0 }}>
      {messages.length === 0 ? (
        <EmptyState suggestions={suggestions.slice(0, 3)} onSuggestion={submit} />
      ) : (
        <MessageList
          messages={messages}
          onAnswerQuestion={answerQuestion}
          onFreeText={() => inputRef.current?.focus()}
          onConfirmApproval={onConfirmApproval}
          onDismissApproval={onDismissApproval}
          onGo={onGo}
          onRetrySend={retrySend}
        />
      )}
      {busy ? (
        <div
          data-testid="assistant-thinking"
          className="px-[10px] py-[4px] font-mono text-[10.5px] text-muted"
        >
          thinking…
        </div>
      ) : null}
    </div>
  );

  const footer = (
    <>
      {changes.length > 0 ? (
        <div style={{ padding: "0 10px 6px" }}>
          <ChangeChip
            changes={changes}
            onUndo={onUndoChange ?? (() => undefined)}
            onUndoAll={onUndoAll ?? (() => undefined)}
          />
        </div>
      ) : null}
      {speech.listening ? (
        <div style={{ padding: "0 10px 6px" }}>
          <ListeningBar interim={speech.interim} final={speech.final} onDone={finishListening} />
        </div>
      ) : null}
      <div
        data-testid="assistant-composer"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          borderTop: "1px solid var(--color-line)",
        }}
      >
        {popover && contextLabel ? <ContextChip label={contextLabel} /> : null}
        <input
          ref={inputRef}
          type="text"
          data-testid="assistant-composer-input"
          value={draft}
          placeholder="Ask, or tell it what to change…"
          aria-label="Ask the assistant"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            border: "1px solid var(--color-line-strong)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 13,
            background: "var(--color-surface)",
            color: "var(--color-ink)",
          }}
        />
        {speech.supported ? (
          <MicButton
            listening={speech.listening}
            onToggle={() => (speech.listening ? finishListening() : startListening())}
            disabled={busy}
          />
        ) : null}
        <Button
          variant="primary"
          compact
          data-testid="assistant-send"
          onClick={send}
          disabled={!draft.trim() || busy}
        >
          Send
        </Button>
      </div>
    </>
  );

  if (popover) {
    return (
      <div
        data-testid="assistant-panel"
        data-variant="popover"
        style={{
          width: POPOVER_WIDTH,
          // On a phone the anchor is narrower than 400px — cap to the
          // container so the panel never clips off-screen (ui-newconv probe).
          maxWidth: "100%",
          alignSelf: "flex-end",
          maxHeight: "min(70vh, 560px)",
          border: "1px solid var(--color-ink)",
          borderRadius: 4,
          boxShadow: "2px 2px 0 var(--color-ink)",
          background: "var(--color-surface)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {header}
        {body}
        {footer}
      </div>
    );
  }

  // Expanded (2c): full content area; the conversation column is centred
  // at max 680px.
  return (
    <div
      data-testid="assistant-panel"
      data-variant="expanded"
      style={{
        width: "100%",
        background: "var(--color-surface)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 680,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          flex: "1 1 auto",
          minHeight: 0,
        }}
      >
        {header}
        {body}
        {footer}
      </div>
    </div>
  );
}

export default AssistantPanel;
