import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ds/Button";
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
  onSend: (text: string) => void;
  /** Answer a follow-up question with the option's label verbatim. */
  onAnswerQuestion: (label: string) => void;
  /** `Retry` on a pending approval_request (names the message id). */
  onConfirmApproval: (messageId: string) => void;
  /** `Not now` on a pending approval_request (names the message id). */
  onDismissApproval: (messageId: string) => void;
  /** Navigate to a `Go ›` link row's route. */
  onGo: (route: string) => void;
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
  onConfirmApproval,
  onDismissApproval,
  onGo,
  onExpand,
  onShrink,
  onClose,
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

  const send = () => {
    const text = draft.trim();
    if (!text || busy) return;
    onSend(text);
    setDraft("");
  };

  const popover = variant === "popover";

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
          <span className="font-mono text-[10.5px] font-semibold tracking-wider text-ink">
            ASSISTANT
          </span>
          <TrustPill value={trustLevel} onChange={onTrustLevelChange} />
          <span style={{ flex: "1 1 auto" }} />
          {onExpand ? (
            <button
              type="button"
              data-testid="assistant-expand"
              style={headerButtonStyle}
              onClick={onExpand}
            >
              ⤢ expand
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
          <span style={{ flex: "1 1 auto" }} />
          {onShrink ? (
            <button
              type="button"
              data-testid="assistant-shrink"
              style={headerButtonStyle}
              onClick={onShrink}
            >
              Shrink to popover
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
        <EmptyState suggestions={suggestions.slice(0, 3)} onSuggestion={onSend} />
      ) : (
        <MessageList
          messages={messages}
          onAnswerQuestion={onAnswerQuestion}
          onFreeText={() => inputRef.current?.focus()}
          onConfirmApproval={onConfirmApproval}
          onDismissApproval={onDismissApproval}
          onGo={onGo}
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
