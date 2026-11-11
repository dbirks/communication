/**
 * Assistant v2 container (ADR-0050; handoff §1 "three sizes, one conversation").
 *
 * Owns what the presentational AssistantPanel does not: the ⌘J open state and
 * the three frame sizes — `popover` (400px, bottom-right), `dock` (the 450px
 * side panel the page narrows beside) and `page` (the real `/assistant` route:
 * thread list left, conversation centre, context right) — the persisted
 * conversation (the caller's newest, or a new one; state lives HERE, mounted at
 * the Shell, so a page change never loses the transcript), the transcript,
 * threads and change-log reads, and every mutation round-trip (send, answer,
 * confirm/dismiss, undo).
 *
 * The ask surface opens three ways (redesign finding 08): the floating `Ask`
 * button and the ⌘J chord — both through `askControl.ts`'s explicit `openAsk()`
 * — and the command palette's Ask row (`openAssistantPopover` below, which also
 * carries the question it was typed with). ⌘K belongs to the jump palette.
 *
 * The `page` size is the route, not an overlay: opening the full page
 * navigates to `/assistant` and remembers the route the ask came FROM (that
 * page is what the full page's "Looking at" column names, and where Exit full
 * page returns to — as the POPOVER, never the side panel). The route page
 * (`pages/AssistantPage.tsx`) hands this container a host element through the
 * module-scope registration below, and the conversation is PORTALLED into it,
 * so switching sizes never re-mounts the transcript, the draft or a turn in
 * flight.
 *
 * Failures are honest lines, not modals: a 503 `assistant_not_configured`
 * says so in one sentence, and nothing the server did not answer is shown.
 * Because a failed turn stores nothing (ADR-0034), the line also says the
 * question was not sent, and the person's words come back into the composer —
 * all three sizes and the palette's carried-over question behave the same way
 * (assistant-lost-ask).
 *
 * Issue #63 changes where an ask lives while its turn is in flight: every send
 * (composer, checklist starter, question option, palette carry-over) lands in
 * the transcript IMMEDIATELY as the person's own user bubble — `thinking…`
 * follows the bubble, and the server's rows replace the local one when the turn
 * settles. A failed turn keeps the bubble and answers it in place: the honest
 * error line under the person's words, with a `Retry` that sends them again.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { useLocation, useNavigate } from "react-router";
import AssistantPanel, {
  type RecentConversation,
  AssistantPageFrame,
  AssistantPageSideColumn,
  AssistantThreadColumn,
} from "./AssistantPanel";
import { openAsk, useAskOpen, type AskOpenContext } from "./askControl";
import {
  sectionOf,
  useMediaQuery,
  ASSISTANT_PAGE_PATH as ASSISTANT_PAGE_ROUTE,
  isAssistantPagePath,
} from "../Shell";
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
import type { AssistantMessagePostBody } from "../../api/assistant";
import type {
  AssistantChange,
  AssistantMessage,
  AssistantMessageContext,
  TrustLevel,
} from "./types";
import { pageContextFor, pageContextPayload, readPageContextOn } from "./pageContext";

/**
 * The PREFIX every threads read lives under (`assistantQueryKeys.conversations`
 * adds the size as its last segment), so one forget covers the header's 5 and
 * the thread column's 30.
 */
const ASSISTANT_THREADS_KEY = ["assistant", "conversations"] as const;
import type { ComposerRestore } from "./AssistantPanel";
import type { ComposerSendOptions } from "./Composer";

/** The palette's Ask row opens the popover (and carries its question). */
export const ASSISTANT_OPEN_EVENT = "communication:assistant-open";

/** The side panel's width (handoff §1): the 450px right-hand column. */
const DOCK_WIDTH_PX = 450;

/**
 * The full page's breakpoints (handoff §1): below ~1240px the context column
 * hides; below ~1000px the thread list hides too and the thread buttons return
 * to the header. `matchMedia` is the same question the CSS asks (Shell's
 * `useMediaQuery`), so the columns that MOUNT follow the viewport rather than
 * a stylesheet hiding them after the fact.
 */
const PAGE_THREADS_QUERY = "(min-width: 1000px)";
const PAGE_CONTEXT_QUERY = "(min-width: 1240px)";

/**
 * The `/assistant` route's path — the full page IS this route. The constant
 * lives with the shell's frame rules (`Shell.tsx`), which step the app nav back
 * to the 52px rail on the same path. It is RE-EXPORTED as an import binding,
 * not copied into a module-level `const`: these two modules import each other,
 * and a copy is evaluated while the other module is still in flight — the
 * first browser pass crashed the whole app on
 * `ReferenceError: Cannot access 'ASSISTANT_PAGE_PATH' before initialization`.
 */
export { ASSISTANT_PAGE_ROUTE };

/**
 * The threads read's two sizes: the header's title lookup needs the newest
 * conversation; the Threads menu and the full page's list show 30.
 */
const THREADS_LIMIT = 5;
const THREADS_MENU_LIMIT = 30;

/**
 * rcn-2f round 7: while the dock stands, the SHELL's content column reserves
 * the dock's width instead of letting the 450px sheet cover it. Design §1 docks
 * the panel BESIDE the chat: the column narrows, nothing is covered.
 *
 * The reservation is applied only while `html[data-assistant-dock="on"]` is set
 * and only at the desktop width where the dock is a column — below 1024 the
 * sheet is full-screen and reserves nothing. On the thread page the two fixed
 * rails step aside while the dock is open, so the transcript keeps a real
 * column instead of a sliver.
 *
 * The second rule is handoff §1's other half: the full page owns the content
 * column too, and the floating `Ask` button is hidden while the surface is
 * open — the page has its own thread list and composer, so a floating button
 * over it would be a second, contradictory door.
 */
const DOCK_RESERVATION_CSS = `@media (min-width: 1024px) {
  html[data-assistant-dock=on] main {
    margin-right: ${DOCK_WIDTH_PX}px;
    width: calc(100% - ${DOCK_WIDTH_PX}px);
    max-width: none;
  }
  html[data-assistant-dock=on] [data-testid="thread-list-pane"],
  html[data-assistant-dock=on] [data-testid="thread-side-panel-aside"] {
    display: none;
  }
}
html[data-assistant-open=on] [data-testid="ask-fab"] {
  display: none;
}
`;

/** The jump palette's open event; a page that owns the Ask chord claims it
 * through `askControl`, not by dispatching this. */
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
 * still the simple ask). `expanded` opens the FULL PAGE (the `/assistant`
 * route); `docked` opens the side panel beside the page it was asked from.
 * `entity` rides along as the ask's structured context so ids travel as data,
 * not as visible prose.
 */
export interface AssistantOpenRequest {
  text: string;
  /**
   * Open the conversation at its largest size — the full page. A ⌘K ask that
   * wants the whole content area leaves `docked` unset; the thread → workflow
   * ask sets it, because design 2f is done in a panel BESIDE the chat (rcn-2f
   * review item 1) and a full-page takeover hides the very transcript the draft
   * is read from.
   */
  expanded?: boolean;
  docked?: boolean;
  entity?: NonNullable<AssistantMessageContext["entity"]>;
  /**
   * The chat's title, when the ask is drafted FROM a specific chat (the 2f
   * thread → workflow path). It is what the panel's header names — the person
   * reads `“<title>”`, not the bare section name `threads` (rcn-6 review).
   * Never the id, which rides `entity`.
   */
  entityTitle?: string;
}

/**
 * Thread → workflow (design 2f): `Make a workflow…` opens the assistant as the
 * side panel DOCKED RIGHT of the chat it drafts from, with that chat as
 * context. The ask is one human sentence — `Turn the chat “title” into a
 * workflow` — and the conversation id travels as the message's structured
 * context entity, never in the visible text (the assistant reads the transcript
 * through its caller-checked `chat.transcript` tool; the id alone authorizes
 * nothing).
 */
export function openAssistantWorkflowDraft(chat: { id: string; title?: string | null }): void {
  const title = chat.title?.trim();
  const request: AssistantOpenRequest = {
    text: title
      ? `Turn the thread \u201C${title}\u201D into a workflow`
      : "Turn this thread into a workflow",
    expanded: true,
    docked: true,
    entity: { kind: "conversation", id: chat.id },
    // The header names the chat it was opened from, not `threads`.
    entityTitle: title ?? undefined,
  };
  window.dispatchEvent(
    new CustomEvent<AssistantOpenRequest>(ASSISTANT_OPEN_EVENT, {
      detail: request,
    }),
  );
}

/* ------------------------------------------------------------------ full-page
 * host handoff. The route page registers its content element here; the engine
 * (mounted once at the Shell) portals the page-mode conversation into it. A
 * module-scope registry, not a prop: the two halves of the frame mount in
 * different places of the tree (the Shell's chrome vs. the route chunk), and a
 * ref callback reports the element the moment the route commits — including
 * when the route chunk arrives late behind `Suspense`.
 */
let pageHost: HTMLElement | null = null;
const pageHostListeners = new Set<() => void>();

/** `pages/AssistantPage.tsx` calls this with its host element (null on unmount). */
export function setAssistantPageHost(host: HTMLElement | null): void {
  if (pageHost === host) return;
  pageHost = host;
  for (const notify of pageHostListeners) notify();
}

function subscribePageHost(notify: () => void): () => void {
  pageHostListeners.add(notify);
  return () => {
    pageHostListeners.delete(notify);
  };
}

/** The full-page host element, or `null` while the `/assistant` route is away. */
function useAssistantPageHost(): HTMLElement | null {
  return useSyncExternalStore(
    subscribePageHost,
    () => pageHost,
    () => null,
  );
}

/** The route's own page context (the label + route the full page names). */
function pageLabelRouteOf(pathname: string): { label: string; route: string } {
  const page = pageContextFor(pathname);
  return { label: page.label, route: page.route };
}

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
 * re-adopt the caller's newest conversation — over a `New thread` the user
 * already started (the follow-up would land in the wrong history). The choice
 * — including a pending New — therefore survives a remount until
 * `New thread` is pressed again.
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
    // storage unavailable (private mode): the choice lives in memory only.
  }
}

export interface AssistantPopoverProps {
  /**
   * What an ask opened on this surface is ABOUT, for a page that mounts the
   * surface itself because it stands outside the Shell (the tour player,
   * design 7b: full screen, no sidebar, no floating `Ask`). The ⌘J chord and
   * any `openAsk()` with no question of its own ask THIS — so the chord names
   * the thing on screen instead of opening an empty box. A plain `Shell`
   * mount passes nothing and the chord stays a bare ask.
   *
   * It is read at open time (a callback, not a value), so the page never has
   * to re-mount the surface as its selection moves.
   */
  askContext?: () => AskOpenContext | null;
}

export default function AssistantPopover({ askContext }: AssistantPopoverProps = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { trustLevel, setTrustLevel } = useAssistantPrefs();
  // The page's ask context, read when the chord lands — never a dependency of
  // the claim effect below, so moving between stops re-reads it without
  // re-registering the surface.
  const askContextRef = useRef(askContext);
  askContextRef.current = askContext;

  // ui-convfix: the persisted choice seeds the session state — a fresh
  // mount resumes the conversation (or the pending New) instead of
  // re-adopting the caller's newest one.
  const [choice] = useState(readChoice);
  const [open, setOpen] = useState(false);
  /**
   * Which of the three sizes (handoff §1) the surface stands in. Only one at a
   * time; `page` is the `/assistant` route itself — see `onAssistantRoute`
   * below, which keeps this state and the URL in step in both directions.
   */
  const [mode, setMode] = useState<"popover" | "dock" | "page">("popover");
  /**
   * What the surface was opened ABOUT, in words: the chat the 2f draft ask was
   * drafted from, or the thing a page that mounts the surface itself has on
   * screen (the tour player names the current stop's piece). The header names
   * the thread with it; every other open carries nothing and the header falls
   * back to the page section.
   */
  const [dockedChatTitle, setDockedChatTitle] = useState<string | null>(null);
  /** The Threads menu (handoff §1: a sibling box, one open at a time). */
  const [threadsMenuOpen, setThreadsMenuOpen] = useState(false);
  /**
   * The route the full page was opened FROM — what its "Looking at" column
   * names and where Exit full page returns. `/assistant` visited directly has
   * no such route, and the column then says what the composer's page context
   * says about `/assistant` itself.
   */
  const [pageReturnRoute, setPageReturnRoute] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(
    choice?.conversationId ?? null,
  );
  /**
   * Design (prototype `push({ kind: 'setup' })`): the system.status checklist
   * is the FIRST message of a thread that started empty, so it stays above the
   * conversation after the first send. Pinned for a new/empty thread, unpinned
   * when the person switches to another existing thread.
   */
  const [setupPinned, setSetupPinned] = useState<boolean>(
    (choice?.conversationId ?? null) === null,
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
   * ui-newconv: the user pressed New thread — the newest conversation
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

  /** The full page is the route: the URL says it, whatever set the state. A
   * nested `/assistant/…` path is still the full page (the shell collapses the
   * app nav for the same range). */
  const onAssistantRoute = isAssistantPagePath(location.pathname);
  const pageHost = useAssistantPageHost();
  const showThreadColumn = useMediaQuery(PAGE_THREADS_QUERY);
  const showContextColumn = useMediaQuery(PAGE_CONTEXT_QUERY);

  // The route and the size agree in both directions: arriving at /assistant
  // (a link, a reload, the Back button) opens the full page; leaving it — by
  // Exit full page or by any navigation the person makes while the surface is
  // open — drops back to the popover, which is what handoff §1 requires
  // ("Leaving full page returns to the popover, not the side panel").
  useEffect(() => {
    if (onAssistantRoute) {
      setOpen(true);
      setMode("page");
    } else {
      setMode((current) => (current === "page" ? "popover" : current));
    }
  }, [onAssistantRoute]);

  // The threads read is as wide as the list on screen (handoff §1): the header
  // needs the newest conversation for its title alone, while the Threads menu
  // and the full page's thread column show 30. The two reads are separate keys
  // and the WIDE one is asked only while its list stands — and the menu keeps
  // drawing the narrow page while that one is in flight, so opening it never
  // flashes an empty list.
  const threadsWide = mode === "page" || threadsMenuOpen;
  const conversations = useAssistantConversations(THREADS_LIMIT, open);
  const threads = useAssistantConversations(THREADS_MENU_LIMIT, open && threadsWide);
  const createConversation = useCreateAssistantConversation();
  const messagesQuery = useAssistantMessages(conversationId);
  const post = usePostAssistantMessage();
  const changesQuery = useAssistantChanges(conversationId);
  const undoChange = useUndoAssistantChange();
  const undoAll = useUndoAllAssistantChanges();

  // The server's transcript is the source of truth; adopted while there is
  // nothing on screen for the current conversation (first open, a New
  // thread, a Threads-menu switch — the switch handlers clear the
  // transcript state first). Once rows are on screen, a post appends its own
  // rows and a later refetch must not clobber them.
  useEffect(() => {
    if (conversationId !== null && messagesQuery.data && messages.length === 0) {
      setMessages(messagesQuery.data);
    }
  }, [conversationId, messagesQuery.data, messages.length]);

  /**
   * One plain-text turn (composer, checklist starter, a question's option
   * label, or the palette's carried-over question). Resolves `true` when the
   * server took the turn and `false` when it did not — the panel puts a
   * rejected composer ask back in the composer (assistant-lost-ask).
   *
   * `carriedOver` marks the palette's question, which never lived in the
   * composer: on failure this container hands it back through `composerRestore`.
   *
   * Issue #63: the ask shows as the person's own bubble the moment it is
   * sent — an optimistic local row appended BEFORE the round-trip (so the
   * starter's question disappears on the click and `thinking…` follows the
   * words). On success the server's echoed rows replace the local row; on
   * failure the bubble stays, carries the honest line under it, and offers
   * `Retry` (see MessageList).
   *
   * `entity` names the ask's subject as STRUCTURED context (the chat a
   * workflow draft is about) — it rides the post body's context, never the
   * visible text.
   */
  const localSeq = useRef(0);
  /**
   * The first message gives a conversation its title (ADR-0050 decision 2), so
   * the threads read behind the header title and the thread column is stale the
   * moment a turn lands. Forgetting it here is what makes a NEW thread's own
   * name appear in the header instead of "New thread" — the header names the
   * thread with what the server called it, never with the page (finding 2).
   */
  const queryClient = useQueryClient();

  /**
   * The route the ask is ABOUT: the page the full page was opened from. On the
   * `/assistant` route the browser's location names the assistant itself, but
   * the ask is about the thing the person was looking at — so the remembered
   * route is what the page context (and the header's chip) names, exactly as
   * the full page's "Looking at" column shows it.
   */
  const askRoute = pageReturnRoute ?? location.pathname;

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
      options?: ComposerSendOptions,
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
        payload: { kind: "user", text: trimmed, ...(options?.spoken ? { spoken: true } : {}) },
        created_at: new Date().toISOString(),
        local: { state: "pending" },
      };
      setMessages((current) => [...current, optimistic]);
      // The composer owns what rides with the ask: its page context (with the
      // handoff §3 `page` block) is the turn's context, and a turn sent with
      // "Send with my messages" unchecked carries NONE at all (CONTRACT §2).
      // A send with no options (a question's option label, a starter, a retry)
      // names the route alone, exactly as it always did. On the full page the
      // route the composer read is `/assistant`; the context the person means
      // is the page the ask came from, so that route is what travels.
      const pageRoute = mode === "page" ? askRoute : location.pathname;
      let context: AssistantMessageContext | undefined =
        options === undefined
          ? assistantContextOf(pageRoute)
          : options.context
            ? (pageContextPayload(pageContextFor(pageRoute), true) ?? { ...options.context })
            : undefined;
      if (entity) {
        // A draft ask names ITS subject even when page context is off — the
        // conversation ref is structured context, not what is on screen.
        const base = context ?? { route: pageRoute };
        base.entity = entity;
        context = base;
      }
      return (async () => {
        try {
          let id = conversationId;
          if (!id) {
            const created = await createConversation.mutateAsync();
            id = created.id;
            setConversationId(id);
            setAwaitingNew(false);
          }
          const body: AssistantMessagePostBody & { spoken?: boolean } = { text: trimmed };
          if (context) body.context = context;
          if (options?.spoken) body.spoken = true;
          const result = await post.mutateAsync({
            conversationId: id,
            body,
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
          // The turn may have named the conversation: the header title and the
          // thread column read it from this list.
          queryClient.invalidateQueries({ queryKey: ASSISTANT_THREADS_KEY });
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
      askRoute,
      conversationId,
      createConversation,
      handBackToComposer,
      queryClient,
      mode,
      post,
      location.pathname,
      retireFailedAsks,
    ],
  );

  /** Handoff §1: `New thread` — clear the panel; the next send
   * creates the fresh conversation (no transcript, no change chip). The chat a
   * docked draft ask was opened from goes with it: the header of the empty
   * thread reads "New thread", the page-context button still names the page. */
  const startNew = useCallback(() => {
    setSetupPinned(true);
    setConversationId(null);
    setMessages([]);
    setSendError(null);
    setAwaitingNew(true);
    setThreadsMenuOpen(false);
    setDockedChatTitle(null);
  }, []);

  /** ui-newconv: the Threads menu's switch — adopt that conversation's
   * transcript (and its change chip) once its rows load. */
  const switchConversation = useCallback(
    (id: string) => {
      setThreadsMenuOpen(false);
      if (id === conversationId) return;
      setSetupPinned(false);
      setMessages([]);
      setConversationId(id);
      setSendError(null);
      setAwaitingNew(false);
    },
    [conversationId],
  );

  /** Handoff §1: popover ⇄ side panel. The side panel toggles back to the
   * popover; from the full page the same button docks the panel beside the
   * page the ask came from. */
  const toggleDock = useCallback(() => {
    setThreadsMenuOpen(false);
    if (mode === "dock") {
      setMode("popover");
      return;
    }
    if (mode === "page" && pageReturnRoute !== null) navigate(pageReturnRoute);
    setMode("dock");
  }, [mode, navigate, pageReturnRoute]);

  /**
   * Handoff §1: the full page is the `/assistant` route. Opening it remembers
   * the page the ask came from (docked or popover — that page is what the
   * right-hand "Looking at" column names); leaving it — through the same
   * button, whose title reads `Exit full page` there — navigates back and
   * returns the POPOVER, never the side panel.
   */
  const togglePage = useCallback(() => {
    setThreadsMenuOpen(false);
    if (mode === "page") {
      // The route effect below drops the size back to the popover the moment
      // the URL changes — leaving full page returns to the POPOVER, never the
      // side panel.
      navigate(pageReturnRoute ?? "/");
      return;
    }
    if (location.pathname !== ASSISTANT_PAGE_ROUTE) setPageReturnRoute(location.pathname);
    navigate(ASSISTANT_PAGE_ROUTE);
    setMode("page");
  }, [location.pathname, mode, navigate, pageReturnRoute]);

  // ⌘J is Ask (finding 08, which supersedes ADR-0050's ⌘K toggle: ⌘K belongs to
  // the jump palette and nothing opens the assistant from it). The listener runs
  // in the CAPTURE phase on purpose: the chord must be order-invariant, so a
  // page that mounts a keyboard handler later (the Studio, whose own ⌘S/⌘Z
  // handlers run in the bubble phase) cannot swallow it. It calls `openAsk()`
  // rather than touching its own state, so the button, the chord and any later
  // claimant all travel the same path.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        openAsk();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // This component is the Ask surface `openAsk()` reaches — unless a page claims
  // the chord while it is on screen (the Studio draft footer). A request with no
  // question of its own takes the page's `askContext` (the tour player's current
  // stop), so the chord and the floating button answer with what the reader is
  // looking at.
  useAskOpen((request) => {
    const context = askContextRef.current?.() ?? {};
    const question = (request.text?.trim() ? request.text : (context.text ?? "")).trim();
    const subject = (request.subject ?? context.subject ?? "").trim();
    closeOtherMenus();
    setDockedChatTitle(subject.length > 0 ? subject : null);
    setOpen(true);
    if (question.length > 0) void send(question, true);
  });

  // The palette's Ask row (a bare string) and the structured 2f draft ask
  // both open the surface here: the string opens the popover, an
  // `AssistantOpenRequest` opens the side panel (docked) or the full page, and
  // names its entity as the ask's structured context. A panel the draft ask
  // opened closes completely on esc (it never falls back to the floating
  // popover over the chat's composer — the 2f review).
  const openedByDraftAsk = useRef(false);
  useEffect(() => {
    const onOpen = (event: Event) => {
      closeOtherMenus();
      const detail = (event as CustomEvent<string | AssistantOpenRequest | undefined>).detail;
      const request: AssistantOpenRequest =
        typeof detail === "string" ? { text: detail } : (detail ?? { text: "" });
      if (request.expanded) {
        openedByDraftAsk.current = true;
        if (request.docked) {
          setMode("dock");
        } else {
          if (location.pathname !== ASSISTANT_PAGE_ROUTE) setPageReturnRoute(location.pathname);
          navigate(ASSISTANT_PAGE_ROUTE);
          setMode("page");
        }
      }
      // Name the chat the panel opened from in the header; every other open (a
      // bare ⌘K ask, the palette) carries no chat title and clears it.
      setDockedChatTitle(
        typeof request.entityTitle === "string" && request.entityTitle.trim()
          ? request.entityTitle
          : null,
      );
      setOpen(true);
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (text.length > 0) void send(text, true, request.entity);
    };
    window.addEventListener(ASSISTANT_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ASSISTANT_OPEN_EVENT, onOpen);
  }, [location.pathname, navigate, send]);

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

  /**
   * rcn-2f round 7 / handoff §1: the dock reserves its width on the shell's
   * main area (the `margin-right` above) and the floating `Ask` button stands
   * down while ANY size of the surface is open — the flags on the document
   * element are the only state the injected CSS reads, so a close releases the
   * column and the button the instant the surface stands down.
   */
  useEffect(() => {
    const root = document.documentElement;
    if (open && mode === "dock") {
      root.setAttribute("data-assistant-dock", "on");
    } else {
      root.removeAttribute("data-assistant-dock");
    }
    return () => root.removeAttribute("data-assistant-dock");
  }, [open, mode]);

  useEffect(() => {
    const root = document.documentElement;
    if (open) {
      root.setAttribute("data-assistant-open", "on");
    } else {
      root.removeAttribute("data-assistant-open");
    }
    return () => root.removeAttribute("data-assistant-open");
  }, [open]);

  /** `Confirm` / `Not now` on a pending approval_request (ADR-0050 Decision 4).
   * The decision post carries ONLY the request id — `{confirm: <id>}` or
   * `{dismiss: <id>}` — never `text` (the handler 400s a decision post that
   * carries text); a failed decision shows the API's own message inline.
   * Part 1 answers `400 approval_requests_not_available` until the gate
   * lands; the honest line says so.
   *
   * The card must then read as DECIDED. The POST's response holds the
   * acknowledgement (and any change row) the turn appended — the
   * approval_request row itself is updated in place server-side and is not
   * echoed back — so the row on screen is re-stamped here (the same
   * `pending → confirmed | dismissed` move the store made). A decision that
   * FAILED (the 409s) leaves the card pending: the server never ran anything,
   * and the retry really is still there to press. */
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
        const state = confirm ? ("confirmed" as const) : ("dismissed" as const);
        setMessages((current) => [
          ...current.map((message) =>
            message.id === messageId && message.payload.kind === "approval_request"
              ? { ...message, payload: { ...message.payload, state } }
              : message,
          ),
          // A re-read of the transcript answers the decided row with its own
          // updated copy; the same row must not stand on screen twice.
          ...result.filter((row) => row.id !== messageId),
        ]);
      } catch (error) {
        setSendError(failureLine(error, "decision"));
      }
    })();
  };

  /** The decision-failure line, identical in all three sizes (assistant-lost-ask).
   * Issue #63 moved a failed QUESTION ask inline — its line now lives under
   * the person's own bubble with the Retry — so this row carries the
   * approval Round-Trip failures, which have no user bubble of their own. */
  const errorLine = sendError ? (
    <p
      data-testid="assistant-error"
      className="m-0 max-w-full rounded-[4px] border border-st-failed-pale-edge bg-st-failed-pale-body px-[8px] py-[5px] text-[11.5px] leading-[1.4] text-st-failed-pale-fg"
    >
      {sendError}
    </p>
  ) : null;

  const close = useCallback(() => {
    setOpen(false);
    setThreadsMenuOpen(false);
  }, []);

  /** Handoff §1: the popover ⇄ side panel ⇄ full page moves. `shrink` is what
   * esc and Close do in the side panel — back to the popover; a panel the
   * draft ask opened closes completely instead (the 2f review). */
  const closeExpanded = useCallback(() => {
    setThreadsMenuOpen(false);
    if (openedByDraftAsk.current) {
      openedByDraftAsk.current = false;
      setOpen(false);
      setMode("popover");
    } else {
      setMode("popover");
    }
  }, []);

  /** ui-newconv: the Threads menu's rows, newest first (the API's order). */
  const recentConversations = (
    threads.data?.conversations ??
    conversations.data?.conversations ??
    []
  ).map((c) => ({
    id: c.id,
    title: c.title,
    lastMessageAt: c.last_message_at,
  }));

  /** The full page's "Looking at": the page the ask came from, or the plain
   * statement that the composer is not sending a page at all. */
  const lookingAt = readPageContextOn()
    ? pageLabelRouteOf(askRoute)
    : { label: "Page context off", route: "" };

  // The route owns the whole content column: while it stands there is no
  // popover to draw, and the conversation lives in the portalled frame below.
  const showPopover = open && mode !== "page";

  if (!open) return null;

  // The conversation's own title (null until the first message gives it one);
  // the panel's header names the thread with it, never with the page section.
  const threadTitle = recentConversations.find((row) => row.id === conversationId)?.title ?? null;
  const contextLabel = contextLabelOf(askRoute);
  /**
   * The thread the page has open, in the form its THREADS column must LEAD with
   * (§2 review fix — the prototype's `threadRows` always contain the current
   * thread): the saved row when the threads read carries it, and for a new
   * thread with nothing persisted yet the unsaved `{ id: "" }` row, which reads
   * as the selected `New thread · now`. A saved thread whose row has not arrived
   * yet is `null` — the column then draws no rows and no false empty state.
   */
  const currentThreadRow: RecentConversation | null =
    recentConversations.find((row) => row.id === conversationId) ??
    (conversationId === null ? { id: "", title: null, lastMessageAt: null } : null);
  const changes: AssistantChange[] = changesQuery.data?.changes ?? [];

  // Every size of the surface holds the same conversation, the same trust
  // level and the same round-trips: only the frame differs.
  const panelProps = {
    contextLabel,
    // The chat the panel was opened from (2f docked draft ask); names the
    // header thread `“<title>”` when the thread has no title of its own.
    chatContext: dockedChatTitle,
    threadTitle,
    messages,
    trustLevel,
    onTrustLevelChange: (level: TrustLevel) => setTrustLevel(level),
    changes,
    onUndoChange: (changeId: string) => undoChange.mutate(changeId),
    onUndoAll: () => conversationId && undoAll.mutate({ conversationId }),
    // The composer's send names what came with the ask: whether the text
    // arrived by dictation, and the page context attached to it (§2/§5).
    onSend: (text: string, options?: ComposerSendOptions) => send(text, false, undefined, options),
    onAnswerQuestion: (label: string) => send(label),
    composerRestore,
    onConfirmApproval: (messageId: string) => answerApproval(messageId, true),
    onDismissApproval: (messageId: string) => answerApproval(messageId, false),
    onGo: (route: string) => navigate(route),
    onNewConversation: startNew,
    pinSetup: setupPinned,
    recentConversations,
    activeConversationId: conversationId,
    onSwitchConversation: switchConversation,
    threadsMenuOpen,
    onThreadsMenuOpenChange: setThreadsMenuOpen,
    onDock: toggleDock,
    onExpandPage: togglePage,
    busy: post.isPending || createConversation.isPending,
  };

  /**
   * The full page (handoff §1, mock L456–480): the thread list at 240px and
   * the context column at 260px hide on a narrow viewport — and when the
   * thread list goes, New thread / Threads come back to the conversation's
   * header (`showThreadControls` below).
   */
  const pageFrame = (
    <AssistantPageFrame
      threadColumn={
        showThreadColumn ? (
          <AssistantThreadColumn
            conversations={recentConversations}
            activeId={conversationId}
            currentThread={currentThreadRow}
            onSwitch={switchConversation}
            onNewConversation={startNew}
          />
        ) : null
      }
      sideColumn={
        showContextColumn ? (
          <AssistantPageSideColumn
            pageContextOn={readPageContextOn()}
            pageLabel={lookingAt.label}
            pageRoute={lookingAt.route}
            changes={changes}
            trustLevel={trustLevel}
          />
        ) : null
      }
    >
      <AssistantPanel
        variant="page"
        {...panelProps}
        showThreadControls={!showThreadColumn}
        onClose={close}
      />
    </AssistantPageFrame>
  );

  return (
    <>
      <style data-testid="assistant-frame-css">{DOCK_RESERVATION_CSS}</style>
      {onAssistantRoute && pageHost !== null
        ? createPortal(
            <>
              {sendError ? <div className="px-[16px] pt-[8px]">{errorLine}</div> : null}
              {pageFrame}
            </>,
            pageHost,
          )
        : null}
      {showPopover ? (
        // ONE element for both floating sizes, with the error slot and the
        // holder in the same positions: a size change swaps classes, never the
        // tree, so the panel instance — its draft, a turn in flight — survives
        // popover ⇄ side panel.
        <div
          className={
            mode === "dock"
              ? // Handoff §1's side panel (and the 2f thread → workflow draft):
                // the sheet is the right-hand column, and the injected
                // reservation shrinks the shell's content column by the same
                // width, so the page beside it stays on screen whole. §3: it is
                // pinned to the VIEWPORT (`inset-0` → `lg:inset-y-0` with
                // `lg:left-auto`), so its 48px head stays at y=0 while the page
                // behind it scrolls. Below 1024px a column would leave nothing
                // of the page, so the panel takes the screen and reserves no
                // width.
                "fixed inset-0 z-40 flex flex-col border-l border-ink bg-surface lg:inset-y-0 lg:left-auto lg:w-[450px]"
              : // Handoff §1's popover: the 400px box anchored 16px off the
                // bottom-right corner. The holder is the relative anchor the
                // Threads menu — a SIBLING of the panel, which clips with
                // `overflow: hidden` — places its box against.
                "fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-32px)] flex-col items-end gap-[6px]"
          }
          data-testid="assistant-popover"
          data-dock={mode === "dock" ? "right" : undefined}
        >
          {/* §3: the side panel is pinned to the viewport (`fixed`, top 0,
              bottom 0), so its 48px head sits flush with the top of the window
              even while the page behind it is scrolled. The error slot is
              therefore drawn ONLY when there is an error to draw — an empty
              padded wrapper above the panel pushed that head down 8px. */}
          {sendError ? (
            <div className={mode === "dock" ? "px-[10px] pt-[8px]" : "contents"}>{errorLine}</div>
          ) : null}
          <div
            className={
              mode === "dock"
                ? "relative flex min-h-0 flex-1 flex-col"
                : "relative flex w-[400px] max-w-full flex-col items-stretch"
            }
          >
            <AssistantPanel
              variant={mode}
              {...panelProps}
              onClose={mode === "dock" ? closeExpanded : close}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
