import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowUp } from "@tabler/icons-react";
import { ContextButton, KEEP_COMPOSER_SIZE_PX } from "./ContextButton";
import ListeningBar, { TranscribingRow } from "./ListeningBar";
import MicButton from "./MicButton";
import { pageContextPayload, usePageContext, usePageContextOn } from "./pageContext";
import { TrustPill } from "./TrustPill";
import { useDictation, useSpeechPrefs, useSpeechStatus } from "./useDictation";
import type { TrustLevel } from "./types";
import type { AssistantMessageContext } from "./types";

/**
 * The composer — one bordered box, textarea on top, controls beneath (handoff
 * §1; mock L341–380). Everything the old footer spread over a row now lives in
 * here: the page-context button, the trust pill, a spacer, the mic and Send —
 * 26px squares/pills in the row, 30px for the two on the right.
 *
 * Draft text belongs to the caller (`AssistantPanel` restores a lost ask and a
 * retry into it), so this is controlled. What it owns itself:
 *
 *  - the textarea's autogrow (2 rows visible, ~6 rows tall at most);
 *  - Enter sends, Shift+Enter is a newline;
 *  - dictation: the mic is present even when the box already holds text, and
 *    the transcript APPENDS to it (`draft ? draft + " " + text : text`) and
 *    marks the draft spoken. `speech_auto_send` sends that text straight
 *    away; otherwise focus returns to the textarea to be edited first;
 *  - page context: what the person is looking at rides in every send unless
 *    they uncheck "Send with my messages" (per tab), in which case the
 *    `context` member is left out of the POST body entirely (CONTRACT §2).
 */
export interface ComposerSendOptions {
  /** The text arrived by dictation (the thread tags the bubble "spoken"). */
  spoken: boolean;
  /** The page context attached to this ask; absent = send none. */
  context?: AssistantMessageContext;
}

export interface ComposerProps {
  draft: string;
  onDraftChange: (text: string) => void;
  /** One turn's text plus what came with it. The caller owns the round-trip. */
  onSend: (text: string, options: ComposerSendOptions) => void;
  /** A turn is in flight: the box cannot send or record over it. */
  busy?: boolean;
  trustLevel: TrustLevel;
  onTrustLevelChange: (level: TrustLevel) => void;
  /** The caller's handle on the textarea (a question card focuses it). */
  inputRef?: { current: HTMLTextAreaElement | null };
  /** What the ask is ABOUT when the surface was opened from something (the
   * tour player's current stop, the 2f chat), else the page section. The
   * composer's visible row is the handoff's five controls, so this names the
   * subject to assistive tech (and the tour player's own proof) rather than
   * drawing a sixth chip inside the box. `null` renders nothing. */
  askLabel?: string | null;
  className?: string;
}

/** 13px/1.45 line box: 2 rows at rest, 6 rows tall at most (handoff §1). */
const ROW_PX = 19;
const MIN_ROWS = 2;
const MAX_ROWS = 6;

export function Composer({
  draft,
  onDraftChange,
  onSend,
  busy = false,
  trustLevel,
  onTrustLevelChange,
  inputRef,
  askLabel = null,
  className = "",
}: ComposerProps) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const textarea = (node: HTMLTextAreaElement | null) => {
    innerRef.current = node;
    if (inputRef) inputRef.current = node;
  };
  const [error, setError] = useState<string | null>(null);

  const page = usePageContext();
  const [contextOn, setContextOn] = usePageContextOn();
  const speechPrefs = useSpeechPrefs();
  const speech = useSpeechStatus();

  /** The draft, tagged with whether dictation touched it. */
  const spokenDraftRef = useRef(false);

  const sendNow = useCallback(
    (text: string, spoken: boolean) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      spokenDraftRef.current = false;
      onSend(trimmed, { spoken, context: pageContextPayload(page, contextOn) });
    },
    [contextOn, onSend, page],
  );

  const appendTranscript = useCallback(
    (text: string) => {
      const piece = text.trim();
      if (!piece) return;
      setError(null);
      spokenDraftRef.current = true;
      // Appends to whatever is already in the box (handoff §5): the person's
      // own typing is never replaced by what the mic heard.
      const next = draft.trim() ? `${draft.trim()} ${piece}` : piece;
      onDraftChange(next);
      if (speechPrefs.autoSend) {
        sendNow(next, true);
        return;
      }
      innerRef.current?.focus();
    },
    [draft, onDraftChange, sendNow, speechPrefs.autoSend],
  );

  const dictation = useDictation({
    onTranscript: appendTranscript,
    onError: setError,
    browserFallback: speechPrefs.browserFallback,
    serverSpeech: speech.configured,
  });
  const recording = dictation.phase === "recording";
  const transcribing = dictation.phase === "transcribing";

  // Autogrow: content height, clamped between 2 and ~6 rows.
  useEffect(() => {
    const node = innerRef.current;
    if (!node) return;
    node.style.height = "auto";
    const room = node.scrollHeight;
    node.style.height = `${Math.max(MIN_ROWS * ROW_PX, Math.min(room, MAX_ROWS * ROW_PX))}px`;
  }, [draft]);

  return (
    <div data-testid="assistant-composer" className={`min-w-0 ${className}`}>
      {askLabel ? (
        <span data-testid="assistant-context-chip" title={askLabel} className="sr-only">
          {askLabel}
        </span>
      ) : null}
      <div
        data-testid="composer-box"
        className={`flex min-w-0 flex-col gap-[6px] rounded-[4px] border p-2 ${
          recording
            ? "border-dashed border-accent-mid bg-accent-wash"
            : "border-line-strong bg-surface"
        }`}
      >
        {recording ? <ListeningBar seconds={dictation.seconds} /> : null}
        {transcribing ? <TranscribingRow model={speech.model} /> : null}
        <textarea
          ref={textarea}
          rows={MIN_ROWS}
          data-testid="assistant-composer-input"
          value={draft}
          placeholder="Ask anything, or use the mic…"
          aria-label="Ask the assistant"
          disabled={busy || transcribing}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendNow(draft, spokenDraftRef.current);
            }
          }}
          className="w-full min-w-0 resize-none overflow-y-auto border-none bg-transparent p-[2px] text-[13px] leading-[1.45] text-ink outline-none placeholder:text-faint disabled:text-disabled-fg"
        />
        <div className="flex min-w-0 items-center gap-[6px]">
          <ContextButton page={page} on={contextOn} onToggle={setContextOn} />
          <TrustPill value={trustLevel} onChange={onTrustLevelChange} />
          <span className="min-w-0 grow" aria-hidden="true" />
          <MicButton phase={dictation.phase} onToggle={dictation.toggle} disabled={busy} />
          <button
            type="button"
            data-testid="assistant-send"
            aria-label="Send"
            title="Send"
            disabled={!draft.trim() || busy || recording || transcribing}
            onClick={() => sendNow(draft, spokenDraftRef.current)}
            className={`grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[4px] border ${KEEP_COMPOSER_SIZE_PX} ${
              !draft.trim() || busy || recording || transcribing
                ? "cursor-not-allowed border-line bg-disabled-bg text-disabled-fg"
                : "cursor-pointer border-accent-edge bg-accent text-surface shadow-[2px_2px_0_var(--color-accent-shadow)] hover:brightness-95 active:translate-[2px_2px] active:shadow-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring"
            }`}
          >
            <IconArrowUp size={15} stroke={2} aria-hidden className="shrink-0" />
          </button>
        </div>
      </div>
      {error ? (
        <p
          data-testid="composer-error"
          className="pt-[4px] font-mono text-[10.5px] text-st-failed-strong"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export default Composer;
