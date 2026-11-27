/**
 * Quick chat panel — docked right under the top bar (redesign R6).
 *
 * Replaces the old floating bottom-right popover chrome while keeping the
 * underlying conversation engine (`AssistantPopover.tsx`), `MessageList`,
 * `ThreadsMenu`, `ContextButton`, `TrustPill` and `useDictation`.
 *
 * - Docked right: fixed, top 60px (52px on phone < 768px), right 0, bottom 0,
 *   width 400px (full width on phone), white, 1px left border `line`, shadow
 *   `-12px 0 30px rgba(30,29,26,.06)`, z-30 (above pages, below modals).
 * - Does NOT close on outside click or on navigation; closes only via its ×
 *   (`quick-chat-close`), Esc while focus is inside it, or ⌘J toggling it.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { IconArrowUp, IconMessages, IconSparkles, IconX } from "@tabler/icons-react";
import { ASSISTANT_PAGE_PATH } from "../Shell";
import type { ComposerSendOptions } from "./Composer";
import { ContextButton } from "./ContextButton";
import { announceListening } from "./askControl";
import ListeningCapsule from "./ListeningCapsule";
import MessageList from "./MessageList";
import MicButton from "./MicButton";
import { TrustPill } from "./TrustPill";
import {
  ThreadsMenu,
  type ComposerRestore,
  type RecentConversation,
  type SendResult,
} from "./AssistantPanel";
import { ChangeChip } from "./ChangeChip";
import { draftLinkOf } from "./draftSteps";
import { pageContextPayload, usePageContext, usePageContextOn } from "./pageContext";
import type { AssistantChange, AssistantMessage, TrustLevel } from "./types";
import {
  isSpeechAvailable,
  SPEECH_UNAVAILABLE_REASON,
  useDictation,
  useSpeechPrefs,
  useSpeechStatus,
} from "./useDictation";

export type VoiceCommandType = "hold-start" | "hold-stop" | "hold-cancel" | "voice-toggle";

export interface VoiceCommand {
  type: VoiceCommandType;
  seq: number;
}

export interface QuickChatProps {
  contextLabel: string;
  chatContext?: string | null;
  messages: AssistantMessage[];
  trustLevel: TrustLevel;
  onTrustLevelChange: (level: TrustLevel) => void;
  changes?: AssistantChange[];
  onUndoChange?: (changeId: string) => void;
  onUndoAll?: () => void;
  onSend: (text: string, options?: ComposerSendOptions) => SendResult;
  onAnswerQuestion: (label: string) => SendResult;
  composerRestore?: ComposerRestore | null;
  onConfirmApproval: (messageId: string) => void;
  onDismissApproval: (messageId: string) => void;
  onGo: (route: string) => void;
  onNewConversation?: () => void;
  pinSetup?: boolean;
  recentConversations?: RecentConversation[];
  activeConversationId?: string | null;
  onSwitchConversation?: (id: string) => void;
  threadsMenuOpen?: boolean;
  onThreadsMenuOpenChange?: (open: boolean) => void;
  onExpandPage: () => void;
  onClose: () => void;
  busy?: boolean;
  errorLine?: ReactNode;
  focusToken?: number;
  voiceCommand?: VoiceCommand | null;
  draft?: string;
  onDraftChange?: (text: string) => void;
}

const NEAR_BOTTOM_PX = 80;
const ROW_PX = 20;
const MIN_ROWS = 1;
const MAX_ROWS = 5;
const EMPTY_NOTICE_MS = 2000;

function commandKeyHint(): string {
  const platform =
    typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘K" : "Ctrl K";
}

export default function QuickChat({
  contextLabel,
  chatContext = null,
  messages,
  trustLevel,
  onTrustLevelChange,
  changes = [],
  onUndoChange,
  onUndoAll,
  onSend,
  onAnswerQuestion,
  composerRestore = null,
  onConfirmApproval,
  onDismissApproval,
  onGo,
  onNewConversation,
  pinSetup = false,
  recentConversations = [],
  activeConversationId = null,
  onSwitchConversation,
  threadsMenuOpen = false,
  onThreadsMenuOpenChange,
  onExpandPage,
  onClose,
  busy = false,
  errorLine = null,
  focusToken = 0,
  voiceCommand = null,
  draft: controlledDraft,
  onDraftChange,
}: QuickChatProps) {
  const [localDraft, setLocalDraft] = useState("");
  const draft = controlledDraft ?? localDraft;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const setDraft = useCallback(
    (next: string | ((current: string) => string)) => {
      if (onDraftChange) {
        const resolved = typeof next === "function" ? next(draftRef.current) : next;
        draftRef.current = resolved;
        onDraftChange(resolved);
      } else {
        setLocalDraft(next);
      }
    },
    [onDraftChange],
  );

  const [dictationError, setDictationError] = useState<string | null>(null);
  const [emptyNotice, setEmptyNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);
  const tailRef = useRef<string | null>(null);

  const page = usePageContext();
  const [contextOn, setContextOn] = usePageContextOn();
  const speechPrefs = useSpeechPrefs();
  const speech = useSpeechStatus();
  const speechAvailable = isSpeechAvailable(speech, speechPrefs);

  const spokenDraftRef = useRef(false);
  const sendOnStopRef = useRef(false);
  const emptyShowsNoticeRef = useRef(false);

  const clearEmptyNotice = useCallback(() => {
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
      noticeTimerRef.current = null;
    }
    setEmptyNotice(null);
  }, []);

  useEffect(() => () => clearEmptyNotice(), [clearEmptyNotice]);

  const restoreDraft = useCallback((text: string) => {
    setDraft((current) => (current.trim().length > 0 ? current : text));
  }, []);

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

  const submit = useCallback(
    (text: string, options?: ComposerSendOptions) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      spokenDraftRef.current = false;
      setDraft("");
      const resolvedOptions: ComposerSendOptions = options ?? {
        spoken: false,
        context: pageContextPayload(page, contextOn),
      };
      watchSend(onSend(trimmed, resolvedOptions), trimmed);
    },
    [busy, contextOn, onSend, page, watchSend],
  );

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

  const lastRestoreTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerRestore || composerRestore.token === lastRestoreTokenRef.current) return;
    lastRestoreTokenRef.current = composerRestore.token;
    restoreDraft(composerRestore.text);
  }, [composerRestore, restoreDraft]);

  const handleTranscript = useCallback(
    (text: string) => {
      const piece = text.trim();
      if (!piece) return;
      setDictationError(null);
      clearEmptyNotice();
      const shouldSend = sendOnStopRef.current || speechPrefs.autoSend;
      sendOnStopRef.current = false;
      emptyShowsNoticeRef.current = false;
      const current = draftRef.current.trim();
      const next = current ? `${current} ${piece}` : piece;
      if (shouldSend) {
        submit(next, { spoken: true, context: pageContextPayload(page, contextOn) });
        return;
      }
      spokenDraftRef.current = true;
      setDraft(next);
      textareaRef.current?.focus();
    },
    [clearEmptyNotice, contextOn, page, speechPrefs.autoSend, submit],
  );

  const handleEmptyTranscript = useCallback(() => {
    const showNotice = emptyShowsNoticeRef.current;
    sendOnStopRef.current = false;
    emptyShowsNoticeRef.current = false;
    if (showNotice) {
      clearEmptyNotice();
      setEmptyNotice("Didn't catch that.");
      noticeTimerRef.current = window.setTimeout(() => {
        noticeTimerRef.current = null;
        setEmptyNotice(null);
      }, EMPTY_NOTICE_MS);
    }
  }, [clearEmptyNotice]);

  const dictation = useDictation({
    onTranscript: handleTranscript,
    onEmpty: handleEmptyTranscript,
    onError: setDictationError,
    browserFallback: speechPrefs.browserFallback,
    serverSpeech: speech.configured,
  });

  const recording = dictation.phase === "recording";
  const transcribing = dictation.phase === "transcribing";

  // The capsule takes its own row above the footer when listening starts, so
  // the transcript loses that height: keep the newest line in view.
  useEffect(() => {
    if (!recording) return;
    const pin = () => {
      const box = bodyRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    };
    pin();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(pin);
  }, [recording]);

  // The top bar's mic mirrors this (it turns accent while we listen).
  useEffect(() => {
    announceListening(recording);
    return () => {
      if (recording) announceListening(false);
    };
  }, [recording]);

  // Execute voice commands sent from HoldToTalk / startVoiceAsk().
  const lastVoiceSeqRef = useRef<number | null>(null);
  useEffect(() => {
    if (!voiceCommand || voiceCommand.seq === lastVoiceSeqRef.current) return;
    lastVoiceSeqRef.current = voiceCommand.seq;
    switch (voiceCommand.type) {
      case "hold-start":
        sendOnStopRef.current = true;
        emptyShowsNoticeRef.current = true;
        clearEmptyNotice();
        setDictationError(null);
        dictation.start();
        break;
      case "hold-stop":
        sendOnStopRef.current = true;
        emptyShowsNoticeRef.current = true;
        dictation.stop();
        break;
      case "hold-cancel":
        sendOnStopRef.current = false;
        emptyShowsNoticeRef.current = false;
        clearEmptyNotice();
        dictation.cancel();
        break;
      case "voice-toggle":
        if (dictation.phase === "idle") {
          sendOnStopRef.current = true;
          emptyShowsNoticeRef.current = false;
          clearEmptyNotice();
          setDictationError(null);
          dictation.start();
        } else if (dictation.phase === "recording") {
          sendOnStopRef.current = true;
          dictation.stop();
        }
        break;
    }
  }, [clearEmptyNotice, dictation, voiceCommand]);

  // Focus reply field when opened via ⌘J / openAsk.
  const lastFocusTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusToken === 0 || focusToken === lastFocusTokenRef.current) return;
    lastFocusTokenRef.current = focusToken;
    textareaRef.current?.focus();
  }, [focusToken]);

  // Autogrow single-line reply field (1 to 5 rows).
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    const room = node.scrollHeight;
    node.style.height = `${Math.max(MIN_ROWS * ROW_PX, Math.min(room, MAX_ROWS * ROW_PX))}px`;
  }, [draft]);

  // Bottom-posting auto-scroll: stay pinned to newest message while streaming.
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  const tail = `${messages.length}|${last?.id ?? ""}|${
    last?.payload.kind === "approval_request" ? last.payload.state : ""
  }|${busy ? "busy" : ""}`;
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);
  useEffect(() => {
    const el = bodyRef.current;
    const previous = tailRef.current;
    tailRef.current = tail;
    if (!el || previous === tail) return;
    if (messages.length === 0) {
      stickRef.current = true;
      return;
    }
    if (previous === null) stickRef.current = true;
    if (!stickRef.current) return;
    const pin = () => {
      const box = bodyRef.current;
      if (box) box.scrollTop = box.scrollHeight;
    };
    pin();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(pin);
  }, [tail, messages.length]);

  const draftLink = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.payload.kind !== "assistant") continue;
      const link = draftLinkOf(message.payload.links);
      if (link !== null) return link;
    }
    return null;
  }, [messages]);

  const handleMicToggle = () => {
    if (dictation.phase === "idle") {
      sendOnStopRef.current = false;
      emptyShowsNoticeRef.current = false;
      clearEmptyNotice();
      setDictationError(null);
      dictation.start();
    } else if (dictation.phase === "recording") {
      dictation.stop();
    }
  };

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.repeat || event.defaultPrevented) return;
    if (threadsMenuOpen) {
      event.preventDefault();
      event.stopPropagation();
      onThreadsMenuOpenChange?.(false);
      return;
    }
    event.preventDefault();
    onClose();
  };

  const askLabel = chatContext ?? contextLabel;

  return (
    <aside
      data-testid="quick-chat"
      role="complementary"
      aria-label="Quick chat"
      onKeyDown={onPanelKeyDown}
      className="fixed top-[52px] right-0 bottom-0 left-0 z-[45] flex w-full flex-col border-l border-line bg-surface shadow-[-12px_0_30px_rgba(30,29,26,0.06)] md:top-[60px] md:left-auto md:w-[400px]"
    >
      {/* Header: 48px, padding 0 14, bottom border line-soft */}
      <div
        data-testid="assistant-panel-header"
        className="flex h-[48px] shrink-0 items-center gap-[8px] border-b border-line-soft px-[14px]"
      >
        <IconSparkles size={16} stroke={1.5} aria-hidden className="shrink-0 text-accent" />
        <span className="whitespace-nowrap text-[14px] font-bold text-ink">Quick chat</span>
        <span className="hidden min-w-0 truncate font-mono text-[10.5px] text-muted md:inline">
          stays open until you close it
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-[4px]">
          {onSwitchConversation && onNewConversation ? (
            <button
              type="button"
              data-testid="assistant-history"
              title="Threads"
              aria-label="Threads"
              aria-pressed={threadsMenuOpen}
              onClick={() => onThreadsMenuOpenChange?.(!threadsMenuOpen)}
              className={`icon-hit grid h-[28px] w-[28px] place-items-center rounded-[8px] border-none focus-visible:outline-2 focus-visible:outline-accent ${
                threadsMenuOpen
                  ? "bg-fill text-ink"
                  : "bg-transparent text-muted hover:bg-fill hover:text-ink"
              }`}
            >
              <IconMessages size={16} stroke={1.5} aria-hidden className="shrink-0" />
            </button>
          ) : null}
          <button
            type="button"
            data-testid="quick-chat-close"
            title="Close"
            aria-label="Close"
            onClick={onClose}
            className="icon-hit grid h-[28px] w-[28px] place-items-center rounded-[8px] border-none bg-transparent text-muted hover:bg-fill hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            <IconX size={16} stroke={1.5} aria-hidden className="shrink-0" />
          </button>
        </span>
      </div>

      {threadsMenuOpen && onSwitchConversation && onNewConversation ? (
        <ThreadsMenu
          variant="quick"
          headerHeightPx={48}
          conversations={recentConversations}
          activeId={activeConversationId}
          onSwitch={onSwitchConversation}
          onNewConversation={onNewConversation}
          onClose={() => onThreadsMenuOpenChange?.(false)}
        />
      ) : null}

      {/* Messages: bottom-posting, padding 14, gap 12 */}
      <div
        ref={bodyRef}
        data-testid="assistant-body"
        onScroll={onBodyScroll}
        className="min-h-0 flex-1 overflow-y-auto p-[14px]"
      >
        <div className="flex min-h-full flex-col justify-end gap-[12px]">
          <MessageList
            variant="quick"
            messages={messages}
            onAnswerQuestion={answerQuestion}
            onFreeText={() => textareaRef.current?.focus()}
            onConfirmApproval={onConfirmApproval}
            onDismissApproval={onDismissApproval}
            onGo={onGo}
            openDraftHref={draftLink?.route ?? null}
            onRetrySend={retrySend}
            showSetup={messages.length === 0 || pinSetup}
            onSendPrompt={(text) => submit(text)}
          />
          {busy ? (
            <div data-testid="assistant-thinking" className="font-mono text-[11px] text-muted">
              thinking…
            </div>
          ) : null}
          {errorLine}
        </div>
      </div>

      {changes.length > 0 ? (
        <div className="shrink-0 px-[12px] pb-[8px]">
          <ChangeChip
            variant="quick"
            changes={changes}
            onUndo={onUndoChange ?? (() => undefined)}
            onUndoAll={onUndoAll ?? (() => undefined)}
          />
        </div>
      ) : null}

      {/* Listening capsule above the footer */}
      <ListeningCapsule
        phase={dictation.phase}
        liveTranscript={dictation.liveTranscript}
        model={speech.model}
        notice={emptyNotice}
        onStop={() => dictation.stop()}
      />

      {/* Footer: padding 10 12 12, top border line-soft */}
      <div
        data-testid="assistant-composer-frame"
        className="shrink-0 border-t border-line-soft px-[12px] pt-[10px] pb-[12px]"
      >
        <div data-testid="assistant-composer" className="min-w-0">
          {askLabel ? (
            <span data-testid="assistant-context-chip" title={askLabel} className="sr-only">
              {askLabel}
            </span>
          ) : null}
          {/* Row 1: the reply field (flex-1, radius 12, 1px line-strong) with
              the 32px mic circle and the 32px accent send circle beside it. */}
          <div data-testid="quick-chat-reply-row" className="flex min-w-0 items-end gap-[8px]">
            <div
              data-testid="composer-box"
              className={`flex min-w-0 flex-1 items-start rounded-[12px] border px-[10px] py-[8px] ${
                recording ? "border-accent bg-accent-wash/40" : "border-line-strong bg-surface"
              }`}
            >
              <textarea
                ref={textareaRef}
                rows={MIN_ROWS}
                data-testid="assistant-composer-input"
                value={draft}
                placeholder={`Reply, or hold ${commandKeyHint()} to talk`}
                aria-label="Reply to Quick chat"
                disabled={busy || transcribing}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit(draft, {
                      spoken: spokenDraftRef.current,
                      context: pageContextPayload(page, contextOn),
                    });
                  }
                }}
                className="my-auto min-w-0 flex-1 resize-none overflow-y-auto border-none bg-transparent p-0 text-[13.5px] leading-[20px] text-ink outline-none placeholder:text-faint disabled:text-disabled-fg"
              />
            </div>
            <MicButton
              circle
              phase={dictation.phase}
              onToggle={handleMicToggle}
              disabled={busy || !speechAvailable}
              disabledReason={!speechAvailable ? SPEECH_UNAVAILABLE_REASON : undefined}
            />
            <button
              type="button"
              data-testid="assistant-send"
              aria-label="Send"
              title="Send"
              disabled={!draft.trim() || busy || recording || transcribing}
              onClick={() =>
                submit(draft, {
                  spoken: spokenDraftRef.current,
                  context: pageContextPayload(page, contextOn),
                })
              }
              className={`grid h-[32px] w-[32px] shrink-0 place-items-center rounded-full border-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring ${
                !draft.trim() || busy || recording || transcribing
                  ? "cursor-not-allowed bg-disabled-bg text-disabled-fg"
                  : "cursor-pointer bg-accent text-surface hover:brightness-95"
              }`}
            >
              <IconArrowUp size={16} stroke={2} aria-hidden className="shrink-0" />
            </button>
          </div>
          {dictationError ? (
            <p
              data-testid="composer-error"
              className="m-0 pt-[4px] font-mono text-[11px] text-st-failed-strong"
            >
              {dictationError}
            </p>
          ) : null}
          {/* Row 2: the two existing controls as quiet 26px chips, with
              "Open as chat" right-aligned on the same row. */}
          <div
            data-testid="quick-chat-controls-row"
            className="mt-[8px] flex min-w-0 items-center gap-[6px]"
          >
            <ContextButton chip page={page} on={contextOn} onToggle={setContextOn} />
            <TrustPill chip value={trustLevel} onChange={onTrustLevelChange} />
            <a
              href={ASSISTANT_PAGE_PATH}
              data-testid="quick-chat-open-as-chat"
              onClick={(event) => {
                event.preventDefault();
                onExpandPage();
              }}
              className="ml-auto shrink-0 text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Open as chat
            </a>
          </div>
        </div>
      </div>
    </aside>
  );
}
