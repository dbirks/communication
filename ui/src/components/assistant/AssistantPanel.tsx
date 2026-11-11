import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconArrowsDiagonal,
  IconArrowsDiagonalMinimize2,
  IconCheck,
  IconEdit,
  IconLayoutSidebarRight,
  IconMessages,
  IconPlus,
  IconSearch,
  IconX,
} from "@tabler/icons-react";
import { MenuArrow } from "../ds/Menu";
import { formatAge } from "../../lib/format";
import { ChangeChip } from "./ChangeChip";
import Composer, { type ComposerSendOptions } from "./Composer";
import { draftLinkOf } from "./draftSteps";
import MessageList from "./MessageList";
import { TRUST_LEVELS } from "./types";
import type { AssistantChange, AssistantMessage, TrustLevel } from "./types";

/**
 * The assistant surface in its three sizes (handoff §1): the 400px bottom-right
 * popover, the 450px side panel the page narrows beside, and the full page at
 * `/assistant`. Purely presentational: the conversation, threads and trust
 * level flow in as props (the caller owns the ADR-0050 conversation routes),
 * and every action (send, answer, confirm/dismiss, navigation, undo, dock,
 * full page, close) comes back through a callback.
 *
 * What this component owns itself: the composer draft, the esc-to-close
 * behaviour, and the header's Threads menu box (whose OPEN state the caller
 * holds, because the threads read widens to 30 rows while the menu stands).
 *
 * The three old-structure pieces this replaces:
 *  - the old Recent-menu and expand/collapse text controls — the header is five
 *    26px Tabler icon buttons now (new thread, threads, side panel, full page,
 *    close), with the wording in `title` and the accessible name;
 *  - the static "FOR THIS PAGE" suggestion chips — an empty thread is the
 *    setup checklist's (`MessageList`'s `showSetup`), not a chip table;
 *  - a menu INSIDE the panel — handoff §1 requires menus that leave the panel
 *    to render as SIBLINGS of it (the panel clips with `overflow: hidden`), so
 *    the threads box is a sibling of the panel element, not a descendant.
 *
 * When a turn's answer links the library draft the assistant saved (design 2f:
 * the server's `Open draft → /workflows/…` link rides the answer's `links[]`),
 * the wide variants carry that link back into the footer as the `Open draft`
 * action the design draws beside the composer. It is hidden until such a turn
 * exists — the panel never offers a door to a draft nobody saved.
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
 * One of the caller's threads for the header's Threads menu and the full
 * page's thread column — newest `last_message_at` first, straight off the
 * list API.
 */
export interface RecentConversation {
  id: string;
  title: string | null;
  lastMessageAt: string | null;
}

export interface AssistantPanelProps {
  /**
   * `popover`: the 400px floating box (ink border, clipped corners).
   * `dock`: the 450px panel the page narrows beside. `page`: the conversation
   * column of the full `/assistant` route (its content centred at 720px).
   */
  variant: "popover" | "dock" | "page";
  /**
   * The page-context chip label (`today`, `feature-delivery`, `run 9c1e`…):
   * what the ask is ABOUT when the surface was opened from a page. The header
   * names the thread; this names the subject to assistive tech (the composer's
   * `askLabel`) and, on a thread with no title yet, stands in for one.
   */
  contextLabel: string;
  /**
   * The chat the panel was opened FROM (the 2f thread → workflow draft ask).
   * A thread that has no title of its own reads as `“<this>”` rather than the
   * generic "New thread" (rcn-6 review).
   */
  chatContext?: string | null;
  /**
   * The conversation's OWN title, when the caller knows it (null until the
   * first message gives the thread one). The header names the thread with it;
   * absent, the panel reads the title off `recentConversations` itself.
   */
  threadTitle?: string | null;
  /** Transcript, oldest first; `change` rows are rendered by the chip. */
  messages: AssistantMessage[];
  trustLevel: TrustLevel;
  onTrustLevelChange: (level: TrustLevel) => void;
  /** Change log for the conversation (ADR-0050); drives the change chip. */
  changes?: AssistantChange[];
  onUndoChange?: (changeId: string) => void;
  onUndoAll?: () => void;
  /** Send one plain-text message (composer, free text, checklist starter).
   * `options` rides the composer's own extras: whether the text arrived by
   * dictation, and the page context attached to it (CONTRACT §2). A caller
   * that ignores it still receives the plain ask. */
  onSend: (text: string, options?: ComposerSendOptions) => SendResult;
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
  /** Navigate to a `Go` link row's route. */
  onGo: (route: string) => void;
  /**
   * `New thread` header control: clears the panel so the next send
   * starts a fresh conversation (the caller creates it and reports the id
   * back through the normal send round-trip).
   */
  onNewConversation?: () => void;
  /** Keep the setup checklist as the thread's first message after sends (a
   * thread that started empty, design `push({ kind: 'setup' })`). */
  pinSetup?: boolean;
  /** Caller's threads (newest first) for the Threads menu. */
  recentConversations?: RecentConversation[];
  /** The conversation currently displayed, if any (the menu's check mark). */
  activeConversationId?: string | null;
  /** Switch the panel back to an existing conversation (Threads menu). */
  onSwitchConversation?: (id: string) => void;
  /**
   * The Threads menu's open state. The CALLER holds it, because the threads
   * read raises its limit to 30 rows while the menu (or the full page) stands.
   */
  threadsMenuOpen?: boolean;
  onThreadsMenuOpenChange?: (open: boolean) => void;
  /** Side-panel toggle (popover ⇄ dock). Absent = no button. */
  onDock?: () => void;
  /** Full-page toggle (⇄ `/assistant`). Absent = no button. */
  onExpandPage?: () => void;
  /** Whether the header draws New thread / Threads at all. */
  showThreadControls?: boolean;
  /** esc closes whatever the user opened (the panel itself or its page). */
  onClose: () => void;
  /** A turn is in flight: shows `thinking…` and locks the composer. */
  busy?: boolean;
}

/** The header's height in the popover and the side panel (padding 6/6 + 26 + border). */
const HEADER_HEIGHT_PX = 39;
/** The inset the menu box keeps from the panel's own edges. */
const MENU_INSET_PX = 8;
/** The Threads button's centre, measured from the header's right edge. */
const THREADS_BUTTON_CENTRE_PX = 111;

/** The header's wording for a thread that has no title of its own (finding 2:
 * never the page section — that label belongs to the page-context button). */
const NEW_THREAD_TITLE = "New thread";

/** How far off the newest row still counts as "reading the newest row" — the
 * chat transcript's own pin band (`conversation/useTranscriptScroll`). */
const NEAR_BOTTOM_PX = 80;

/** A 26px header icon button (handoff §1): wording in `title` + name. */
function HeaderIconButton({
  testid,
  title,
  pressed = false,
  onClick,
  children,
}: {
  testid: string;
  title: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={title}
      aria-label={title}
      aria-pressed={pressed || undefined}
      onClick={onClick}
      className={`grid h-[26px] w-[26px] shrink-0 cursor-pointer place-items-center rounded-[4px] border-none max-[559px]:[main_&]:min-h-[44px] max-[559px]:[main_&]:min-w-[44px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-ring ${
        pressed ? "bg-line text-ink" : "bg-transparent text-ink-2 hover:bg-fill"
      }`}
    >
      {children}
    </button>
  );
}

/** One thread row: title + honest age, the current one on the accent wash. */
function ThreadRow({
  conversation,
  active,
  showCheck = true,
  onSelect,
  rowRef,
}: {
  conversation: RecentConversation;
  active: boolean;
  onSelect: (id: string) => void;
  rowRef?: { current: HTMLButtonElement | null } | ((node: HTMLButtonElement | null) => void);
  showCheck?: boolean;
}) {
  return (
    <button
      type="button"
      ref={rowRef}
      role="menuitem"
      data-testid="assistant-history-item"
      data-conversation-id={conversation.id}
      onClick={() => onSelect(conversation.id)}
      className={`flex w-full cursor-pointer items-baseline gap-[6px] rounded-[4px] border-none p-[6px_8px] text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
        active ? "bg-accent-wash" : "bg-transparent hover:bg-accent-wash"
      }`}
    >
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] text-ink ${active ? "font-semibold" : ""}`}
      >
        {conversation.title ?? "New thread"}
      </span>
      <span className="shrink-0 font-mono text-[11px] text-faint">
        {/* A thread nobody has written in yet is the new one (prototype: "now"). */}
        {conversation.lastMessageAt ? formatAge(conversation.lastMessageAt) : "now"}
      </span>
      {/* The threads MENU marks the open thread with a check (prototype L401);
          the full page's THREADS column does not (prototype threadRows). */}
      {showCheck ? (
        <span className="grid w-[13px] shrink-0 place-items-center">
          {active ? <IconCheck size={12} stroke={2} aria-hidden className="shrink-0" /> : null}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The ONE head row the wide assistant surfaces share (redesign: "one header
 * row"). Exactly 48px tall, 16px of horizontal padding, content vertically
 * centred, and a `border-line` bottom edge — so the full page's three columns
 * and the docked side panel all draw their bottom border on the SAME line at
 * y=48 (and, for the dock, y=0 + 48 from the top of the viewport).
 */
export const COLUMN_HEAD_CLASS =
  "flex h-[48px] shrink-0 items-center border-b border-line px-[16px]";

/** The "Search threads" field both thread lists draw. */
function ThreadSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <span className="flex items-center gap-[6px] rounded-[4px] border border-line-strong px-[8px] py-[5px] text-[12.5px] text-faint">
      <IconSearch size={13} stroke={2} aria-hidden className="shrink-0" />
      <input
        type="search"
        data-testid="assistant-history-search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search threads"
        aria-label="Search threads"
        className="min-w-0 flex-1 border-none bg-transparent text-[12.5px] text-ink outline-none placeholder:text-faint"
      />
    </span>
  );
}

/** Threads filtered by the search box's text (title match, case-insensitive). */
function filterThreads(rows: RecentConversation[], query: string): RecentConversation[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter((row) => (row.title ?? "untitled").toLowerCase().includes(needle));
}

/**
 * The header's Threads menu (handoff §1, mock L381–410). A SIBLING of the
 * panel element — the popover clips with `overflow: hidden`, so a menu that
 * lives inside it would be cut off. The ds box (white, 1px ink border, radius
 * 4, 2px ink shadow, 8px padding) with a 9px rotated-square arrow on the
 * Threads button, the search field, a New thread row and one row per thread.
 */
export function ThreadsMenu({
  conversations,
  activeId,
  onSwitch,
  onNewConversation,
  headerHeightPx = HEADER_HEIGHT_PX,
  onClose,
}: {
  conversations: RecentConversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  onNewConversation: () => void;
  headerHeightPx?: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const rows = filterThreads(conversations, query);

  // Esc closes the menu, not the panel behind it (the panel listens on the
  // window; stopping here keeps both gestures distinct).
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    box.addEventListener("keydown", onKey);
    return () => box.removeEventListener("keydown", onKey);
  }, [onClose]);

  const moveFocus = (to: number) => {
    const count = rows.length;
    if (count === 0) return;
    itemRefs.current[(to + count) % count]?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = itemRefs.current;
    const focused = items.findIndex((item) => item === document.activeElement);
    switch (event.key) {
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
          onSwitch(items[focused]?.getAttribute("data-conversation-id") ?? "");
        }
        break;
    }
  };

  return (
    <div
      ref={boxRef}
      role="menu"
      aria-label="Threads"
      data-testid="assistant-history-menu"
      onKeyDown={onMenuKeyDown}
      className="absolute z-30 flex w-[300px] flex-col gap-[2px] rounded-[4px] border border-ink bg-surface p-2 shadow-raised"
      style={{ top: headerHeightPx + 5, right: MENU_INSET_PX }}
    >
      {/* The ds pointer arrow (9px rotated square) centred on the Threads
          button: 111px from the header's right edge, less the box's own 8px
          inset and half the square. `MenuArrow` takes the placement a surface
          that positions its own box computes (as `ComposerMenu` does). */}
      <MenuArrow
        side="bottom"
        className="z-40"
        style={{
          left: "auto",
          right: THREADS_BUTTON_CENTRE_PX - MENU_INSET_PX - 4.5,
          top: -5,
          transform: "rotate(45deg)",
        }}
      />
      <ThreadSearch value={query} onChange={setQuery} />
      <button
        type="button"
        role="menuitem"
        data-testid="assistant-menu-new-thread"
        onClick={() => {
          onNewConversation();
          onClose();
        }}
        className="flex w-full cursor-pointer items-center gap-[6px] rounded-[4px] border-none bg-transparent p-[6px_8px] text-left text-[12.5px] font-semibold text-accent-text hover:bg-accent-wash focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <IconPlus size={13} stroke={2} aria-hidden className="shrink-0" />
        New thread
      </button>
      <span className="my-[4px] block h-px bg-line" aria-hidden="true" />
      {rows.length === 0 ? (
        <p className="m-0 px-[6px] py-[4px] text-[12px] text-muted">
          {conversations.length === 0
            ? "No threads yet — the next answer starts one."
            : "No thread matches that search."}
        </p>
      ) : (
        rows.map((conversation, index) => (
          <ThreadRow
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeId}
            rowRef={(node) => {
              itemRefs.current[index] = node;
            }}
            onSelect={(id) => {
              if (id.length === 0) return;
              onSwitch(id);
              onClose();
            }}
          />
        ))
      )}
    </div>
  );
}

/**
 * The full page's left thread column (handoff §1, mock L100–125): the Assistant
 * title with its New thread button, the search field, and the rows.
 */
export function AssistantThreadColumn({
  conversations,
  activeId,
  currentThread = null,
  onSwitch,
  onNewConversation,
}: {
  conversations: RecentConversation[];
  activeId: string | null;
  /**
   * The thread open RIGHT NOW, saved or not (handoff §1, §2 review fix: the
   * prototype's `threadRows` always contains the current thread). A new thread
   * with nothing persisted yet is the unsaved row `{ id: "" }`, which
   * `ThreadRow` draws as the selected `New thread · now` — so the column never
   * claims “no threads yet” while a thread is on screen. `null` = no thread
   * open (the empty state then belongs to the column).
   */
  currentThread?: RecentConversation | null;
  onSwitch: (id: string) => void;
  onNewConversation: () => void;
}) {
  const [query, setQuery] = useState("");
  // The current thread leads the list; a saved one is never listed twice.
  const rows = filterThreads(
    currentThread
      ? [currentThread, ...conversations.filter((row) => row.id !== currentThread.id)]
      : conversations,
    query,
  );
  const selectedId = currentThread ? currentThread.id : (activeId ?? "");
  return (
    <aside
      data-testid="assistant-page-threads"
      className="flex h-full min-h-0 w-[240px] shrink-0 flex-col overflow-hidden border-r border-line bg-surface"
    >
      {/* §2: the column's head is the SAME 48px row as the thread's and the
          context column's, so the three bottom borders are one line. */}
      <span data-testid="assistant-page-threads-head" className={COLUMN_HEAD_CLASS}>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">
          Assistant
        </span>
        <HeaderIconButton
          testid="assistant-page-new-thread"
          title="New thread"
          onClick={onNewConversation}
        >
          <IconEdit size={15} stroke={2} aria-hidden className="shrink-0" />
        </HeaderIconButton>
      </span>
      <span className="flex min-h-0 flex-1 flex-col gap-[6px] overflow-hidden px-[10px] py-3">
        <ThreadSearch value={query} onChange={setQuery} />
        <span className="px-1 pb-[2px] font-mono text-[10px] tracking-[0.06em] text-faint">
          THREADS
        </span>
        <span className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto">
          {rows.length === 0 &&
          (query.trim().length > 0 || (currentThread === null && activeId === null)) ? (
            <p className="m-0 px-[6px] py-[4px] text-[12px] text-muted">
              {query.trim().length > 0
                ? "No thread matches that search."
                : "No threads yet — the next answer starts one."}
            </p>
          ) : (
            rows.map((conversation) => (
              <ThreadRow
                key={conversation.id.length === 0 ? "current-unsaved" : conversation.id}
                showCheck={false}
                conversation={conversation}
                active={conversation.id === selectedId}
                onSelect={(id) => {
                  // The unsaved row IS the thread already open: selecting it
                  // switches to nothing.
                  if (id.length === 0) return;
                  onSwitch(id);
                }}
              />
            ))
          )}
        </span>
      </span>
    </aside>
  );
}

/**
 * The full page's right column (handoff §1, mock L456–480): LOOKING AT, the
 * thread's changes, and the trust level in one line each.
 */
export function AssistantPageSideColumn({
  pageContextOn,
  pageLabel,
  pageRoute,
  changes,
  trustLevel,
}: {
  pageContextOn: boolean;
  pageLabel: string;
  pageRoute: string;
  changes: AssistantChange[];
  trustLevel: TrustLevel;
}) {
  const trust = TRUST_LEVELS.find((level) => level.value === trustLevel);
  return (
    <aside
      data-testid="assistant-page-side"
      className="flex h-full min-h-0 w-[260px] shrink-0 flex-col overflow-hidden border-l border-line bg-paper"
    >
      {/* §2: this column had no head at all; it now opens with the same 48px
          row as the other two, and the LOOKING AT / CHANGES / TRUST sections
          follow below it unchanged. */}
      <span
        data-testid="assistant-page-side-head"
        className={`${COLUMN_HEAD_CLASS} font-mono text-[10.5px] uppercase tracking-[.06em] text-faint`}
      >
        CONTEXT
      </span>
      <span className="flex min-h-0 flex-1 flex-col gap-[8px] overflow-y-auto px-[12px] py-[14px]">
        <span className="font-mono text-[10px] tracking-[0.06em] text-muted">LOOKING AT</span>
        <span className="flex flex-col gap-[2px] rounded-[3px] border border-line bg-surface px-[10px] py-2">
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
            {pageContextOn ? pageLabel : "Page context off"}
          </span>
          {pageContextOn ? (
            <span className="min-w-0 truncate font-mono text-[10.5px] text-muted">{pageRoute}</span>
          ) : null}
        </span>
        <span className="mt-[8px] font-mono text-[10px] tracking-[0.06em] text-muted">
          CHANGES IN THIS THREAD
        </span>
        {changes.length === 0 ? (
          <p className="m-0 px-[2px] text-[12px] text-faint">Nothing changed yet.</p>
        ) : (
          changes.map((change) => (
            <span
              key={change.id}
              data-testid="assistant-page-change"
              className="flex flex-col gap-[2px] rounded-[3px] border border-line bg-surface px-[10px] py-2"
            >
              <span className="min-w-0 text-[12.5px] text-ink">{change.summary}</span>
              <span className="min-w-0 font-mono text-[10px] text-faint">
                {change.undone_at !== null ? "undone" : `you confirmed · ${changeUndoWord(change)}`}
              </span>
            </span>
          ))
        )}
        <span className="mt-[8px] font-mono text-[10px] tracking-[0.06em] text-muted">TRUST</span>
        <p className="m-0 px-[2px] text-[12px] leading-[1.45] text-ink-2">{trust?.label ?? ""}</p>
      </span>
    </aside>
  );
}

/** What a change row says about being reversible (A5: only draft edits are). */
function changeUndoWord(change: AssistantChange): string {
  return change.kind === "draft_edit" && change.undoable ? "can be undone" : "can't be undone here";
}

/**
 * The full page's frame (handoff §1): the thread column, the conversation
 * column in the middle, and the context column on the right. The columns that
 * the viewport is too narrow for are simply not passed (the caller answers the
 * media query; handoff: below ~1240px the right column hides, below ~1000px
 * the thread list hides and the thread buttons return to the header).
 *
 * Height (the lab walk-through's finding 1): the frame FILLS the host it is
 * portalled into — `h-full`, with `min-h-0` on every column that holds a
 * scroll box — so the three columns run the length of the viewport under the
 * shell instead of stopping where their content happens to end. The host
 * (`pages/AssistantPage.tsx`) owns the viewport height; `flex-1` + `min-h-0`
 * is what carries it down, and `overflow-hidden` is what stops a column's own
 * content from stretching the frame past it.
 */
export function AssistantPageFrame({
  threadColumn,
  sideColumn,
  children,
}: {
  threadColumn?: React.ReactNode;
  sideColumn?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid="assistant-page"
      className="flex h-full min-h-0 w-full flex-1 flex-row overflow-hidden bg-surface"
    >
      {threadColumn}
      <span className="flex h-full min-h-0 min-w-0 flex-1 flex-col">{children}</span>
      {sideColumn}
    </div>
  );
}

export function AssistantPanel({
  variant,
  contextLabel,
  chatContext = null,
  threadTitle = null,
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
  onDock,
  onExpandPage,
  showThreadControls = true,
  onClose,
  busy = false,
}: AssistantPanelProps) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // esc closes the panel. The Threads menu handles its own esc and stops it,
  // so it closes without taking the panel with it.
  const handleClose = useCallback(() => onClose(), [onClose]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat) return;
      handleClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

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

  /** The one send path: composer, Enter, and the setup checklist's starters. */
  const submit = useCallback(
    (text: string, options?: ComposerSendOptions) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      setDraft("");
      watchSend(options ? onSend(trimmed, options) : onSend(trimmed), trimmed);
    },
    [busy, onSend, watchSend],
  );

  /**
   * Issue #63: `Retry` under a failed ask re-sends those SAME words. The
   * composer's duplicate copy (the assistant-lost-ask restore) leaves with
   * the ask; a draft typed since is never clobbered.
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

  /**
   * Design 2f (rcn-2f round 7): the draft route the FOOTER offers as
   * `Open draft` — the wide variants only, and only once a turn has saved a
   * draft. Recognised by its TARGET (a route pointing at the library draft
   * page), not by the label's wording (rcn-review13-2f).
   */
  const draftLink = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.payload.kind !== "assistant") continue;
      const link = draftLinkOf(message.payload.links);
      if (link !== null) return link;
    }
    return null;
  }, [messages]);

  // A carried-over ask the caller lost (the palette's question): back into
  // the composer, once per token.
  const lastRestoreTokenRef = useRef<number | null>(null);
  useEffect(() => {
    if (!composerRestore || composerRestore.token === lastRestoreTokenRef.current) return;
    lastRestoreTokenRef.current = composerRestore.token;
    restoreDraft(composerRestore.text);
  }, [composerRestore, restoreDraft]);

  const popover = variant === "popover";
  const docked = variant === "dock";
  const pageMode = variant === "page";
  /**
   * The header names the THREAD (finding 2): the conversation's own title, or
   * the chat a docked draft ask was opened FROM (rcn-6). A thread with no
   * title of its own — a fresh one, an empty one, one the person has not
   * spoken to — is "New thread". The page section (`today`, `run 029e1a20`) is
   * the page-context button's words — the composer's ctx row and the full
   * page's LOOKING AT column — and never stands in for a thread title.
   */
  const headerTitle =
    threadTitle ??
    recentConversations.find((row) => row.id === activeConversationId)?.title ??
    chatContext ??
    NEW_THREAD_TITLE;

  /**
   * The transcript's auto-scroll (prototype `componentDidUpdate`): a new row —
   * an answer, a question card, an approval card, the `thinking…` line — lands
   * at the bottom of the body, and a reader who was AT the bottom stays there.
   * A reader who has scrolled up to read (> `NEAR_BOTTOM_PX` off the bottom)
   * is never yanked: their place holds until they come back down.
   *
   * The signature is the transcript's tail, not its length: an optimistic
   * bubble is REPLACED by the server's rows for the same ask (same count), and
   * an approval card moving to CONFIRMED changes no row count at all.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const tailRef = useRef<string | null>(null);
  const last = messages.length > 0 ? messages[messages.length - 1] : null;
  const tail = `${variant}|${messages.length}|${last?.id ?? ""}|${
    last?.payload.kind === "approval_request" ? last.payload.state : ""
  }|${busy ? "busy" : ""}`;
  const onBodyScroll = useCallback(() => {
    const el = bodyRef.current;
    if (el === null) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);
  useEffect(() => {
    const el = bodyRef.current;
    const previous = tailRef.current;
    tailRef.current = tail;
    if (el === null || previous === tail) return;
    // A thread switched out from under the surface: its empty journal starts
    // the pin again, at the newest row it is about to get.
    if (messages.length === 0) {
      stickRef.current = true;
      return;
    }
    // A transcript coming into view (an open, a reload, a size change) starts
    // AT the newest row, the way every chat does.
    if (previous === null) stickRef.current = true;
    // A reader who has climbed away from the newest row keeps their place;
    // nothing here moves the view out from under them.
    if (!stickRef.current) return;
    const pin = () => {
      const box = bodyRef.current;
      if (box !== null) box.scrollTop = box.scrollHeight;
    };
    // The row's own layout (a card's grid, a markdown table) settles after this
    // commit; the rAF pass is what lands the pin BELOW it, as the browser paints.
    pin();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(pin);
  }, [tail, messages.length]);

  /**
   * Round-17 (rcn-review17-2f): the FOOTER's `Open draft` door — the wide
   * variants only. The transcript hides its own row for that same draft, so
   * the door exists once; the popover keeps the transcript row instead.
   */
  const openDraftHref = popover || draftLink === null ? null : draftLink.route;

  const header = (
    <div
      data-testid="assistant-panel-header"
      className={`flex shrink-0 items-center gap-[4px] ${
        // §2/§3: the full page's thread column and the docked side panel both
        // open with the SAME 48px head as the page's other columns — the popover
        // keeps its compact box header.
        popover
          ? "border-b border-line bg-fill pb-[6px] pl-[10px] pr-[8px] pt-[6px]"
          : `${COLUMN_HEAD_CLASS} ${pageMode ? "bg-surface" : "bg-fill"}`
      }`}
    >
      {/* Design L131–137: the POPOVER header shows only the mono ASSISTANT
          label; the side panel and the full page show only the thread title
          (14px/600, ellipsized, "New thread" when empty) in the 48px head. */}
      {popover ? (
        <>
          <span className="shrink-0 whitespace-nowrap font-mono text-[10.5px] font-semibold tracking-wider text-ink">
            ASSISTANT
          </span>
          <span className="min-w-0 flex-1" aria-hidden="true" />
        </>
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink"
          data-testid="assistant-thread-title"
          title={headerTitle}
        >
          {headerTitle}
        </span>
      )}
      {showThreadControls ? (
        <>
          {onNewConversation ? (
            <HeaderIconButton
              testid="assistant-new-conversation"
              title="New thread"
              onClick={onNewConversation}
            >
              <IconEdit size={15} stroke={2} aria-hidden className="shrink-0" />
            </HeaderIconButton>
          ) : null}
          {onSwitchConversation ? (
            <HeaderIconButton
              testid="assistant-history"
              title="Threads"
              pressed={threadsMenuOpen}
              onClick={() => onThreadsMenuOpenChange?.(!threadsMenuOpen)}
            >
              <IconMessages size={15} stroke={2} aria-hidden className="shrink-0" />
            </HeaderIconButton>
          ) : null}
        </>
      ) : null}
      {onDock ? (
        <HeaderIconButton
          testid="assistant-dock"
          title={docked ? "Back to popover" : "Open as side panel"}
          pressed={docked}
          onClick={onDock}
        >
          <IconLayoutSidebarRight size={15} stroke={2} aria-hidden className="shrink-0" />
        </HeaderIconButton>
      ) : null}
      {onExpandPage ? (
        <HeaderIconButton
          testid="assistant-expand"
          title={pageMode ? "Exit full page" : "Open full page"}
          onClick={onExpandPage}
        >
          {pageMode ? (
            <IconArrowsDiagonalMinimize2 size={14} stroke={2} aria-hidden className="shrink-0" />
          ) : (
            <IconArrowsDiagonal size={14} stroke={2} aria-hidden className="shrink-0" />
          )}
        </HeaderIconButton>
      ) : null}
      <HeaderIconButton testid="assistant-close" title="Close" onClick={onClose}>
        <IconX size={15} stroke={2} aria-hidden className="shrink-0" />
      </HeaderIconButton>
    </div>
  );

  const body = (
    <div
      ref={bodyRef}
      data-testid="assistant-body"
      onScroll={onBodyScroll}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <div className={pageMode ? "mx-auto w-full max-w-[720px] px-[16px] py-[8px]" : "w-full"}>
        <MessageList
          messages={messages}
          onAnswerQuestion={answerQuestion}
          onFreeText={() => inputRef.current?.focus()}
          onConfirmApproval={onConfirmApproval}
          onDismissApproval={onDismissApproval}
          onGo={onGo}
          openDraftHref={openDraftHref}
          onRetrySend={retrySend}
          showSetup={messages.length === 0 || pinSetup}
          onSendPrompt={(text) => submit(text)}
        />
        {busy ? (
          <div
            data-testid="assistant-thinking"
            className="px-[10px] py-[4px] font-mono text-[10.5px] text-muted"
          >
            thinking…
          </div>
        ) : null}
      </div>
    </div>
  );

  const footer = (
    <>
      {changes.length > 0 && !pageMode ? (
        <div className="shrink-0 px-[10px] pb-[6px]">
          <ChangeChip
            changes={changes}
            onUndo={onUndoChange ?? (() => undefined)}
            onUndoAll={onUndoAll ?? (() => undefined)}
          />
        </div>
      ) : null}
      {/* Handoff §1: the composer is ONE box — textarea on top, then the
          page-context button · trust pill · spacer · mic · Send. The box owns
          dictation and the page-context payload; the draft stays HERE, because
          a lost ask and a retry both come back into it. In the full page the
          box is the design's 752px column with its own breathing room. */}
      <div
        data-testid="assistant-composer-frame"
        className={`shrink-0 ${
          pageMode
            ? "mx-auto w-full max-w-[752px] px-[16px] pb-[18px] pt-[10px]"
            : "border-t border-line px-[10px] py-[8px]"
        }`}
      >
        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onSend={(text, options) => submit(text, options)}
          busy={busy}
          trustLevel={trustLevel}
          onTrustLevelChange={onTrustLevelChange}
          inputRef={inputRef}
          askLabel={popover || docked ? (chatContext ?? contextLabel) : null}
        />
        {/* Design 2f: `Open draft` sits beside the composer — the wide
            variants only. The draft door stays reachable in the transcript's
            `Go` link row while the popover has no room for it. */}
        {!popover && draftLink ? (
          <div className="pt-[6px]">
            <button
              type="button"
              data-testid="assistant-open-draft"
              title="Open the draft in the library"
              className="cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              onClick={() => onGo(draftLink.route)}
            >
              Open draft
            </button>
          </div>
        ) : null}
      </div>
    </>
  );

  const panel = (
    <div
      data-testid="assistant-panel"
      data-variant={variant}
      className={
        popover
          ? "flex max-h-[min(72vh,600px)] min-w-0 flex-col overflow-hidden rounded-[4px] border border-ink bg-surface shadow-raised"
          : // The wide sizes FILL the column they are handed (finding 1): the
            // conversation's own scroll is the body, the composer stays pinned
            // at the bottom of the column.
            "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-surface"
      }
    >
      {header}
      {body}
      {footer}
    </div>
  );

  if (pageMode) return panel;

  // The menu is a SIBLING of the panel (handoff §1), inside a relative holder
  // the panel does not clip.
  return (
    <>
      {panel}
      {threadsMenuOpen && onSwitchConversation && onNewConversation ? (
        <ThreadsMenu
          conversations={recentConversations}
          activeId={activeConversationId}
          onSwitch={onSwitchConversation}
          onNewConversation={onNewConversation}
          onClose={() => onThreadsMenuOpenChange?.(false)}
        />
      ) : null}
    </>
  );
}

export default AssistantPanel;
