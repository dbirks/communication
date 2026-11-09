/**
 * The 320px thread list pane (design 1g) — the left column of `/threads` and
 * of the open thread at `/threads/:id`, so moving between threads never
 * leaves the page.
 *
 * Data (AGENTS.md): every row is a `ConversationSummary` from an
 * endpoint the app already calls — `GET /api/v1/conversations` (ADR-0047,
 * keyset page, newest first) across projects, or `GET
 * /projects/{id}/conversations` when the pane is filtered to one project.
 * The rows name ids only, so the project and profile *names* come from the
 * two directories this reads. The design's `project / repo · agent` mono
 * line and the last agent line under a row are served data, not guesses:
 * ADR-0065 put `repository_name` and `last_agent_line` on
 * `ConversationSummary`. The repository members are ONE fact — null
 * together, or the repository the thread works in — and a null id is the
 * wire's "works in the whole project" word (ADR-0067 amendment), so the
 * row prints `project / Whole project` instead of dropping the scope
 * segment. (The summary's three-arm derivation can still name a moved
 * thread's old workspace repository; the host's `declaredScope` prop
 * carries the one fact only the detail read has — the declared binding —
 * and outranks the derivation for the row it names.) Both fields are
 * null when the thread has no repository binding or the agent has not
 * spoken (and absent from an older server), so those rows honestly fall
 * back to `project · agent` with no last line.
 *
 * Search and the chips: a project-filtered pane sends the debounced title
 * search and `from runs` to the list route as `q`/`origin` (ADR-0043) — the
 * SAME server query the project's tab count uses — and `mine` stays
 * client-side, because no route parameter names an author. The cross-project
 * endpoint accepts no `q`/`origin` parameter, so there every filter narrows
 * the loaded page client-side. The keyset "Next page" walk stays.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import {
  useAgentProfiles,
  useConversations,
  useMe,
  useProjects,
  prefetchConversation,
  type ConversationListFilters,
} from "../../api/queries";
import type { ConversationSummary } from "../../api/types";
import type { components } from "../../api/schema";
import NewConversationDialog from "../NewConversationDialog";
import { ProblemBanner, Spinner } from "../Feedback";
import { Button } from "../ds/Button";
import { Input } from "../ds/Field";
import { CONVERSATION_STATE, STATES, stateOf, type StateName } from "../ds/states";
import { formatAge, shortId } from "../../lib/format";
import { previewLine } from "../../lib/preview";
import { routes } from "../../lib/routes";
import { legacyRunThreadTitle, type RunThreadTitle } from "./runThreadTitle";

type CrossProjectConversations = components["schemas"]["CrossProjectConversationList"];

const PAGE_LIMIT = 50;

/** The cross-project read (C3 / ADR-0047). Lives here — `api/queries.ts` is
 *  owned elsewhere — and reads the envelope verbatim. */
function useCrossProjectThreads(cursor: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["conversations", "cross-project", cursor],
    queryFn: () =>
      apiFetch<CrossProjectConversations>(
        `/api/v1/conversations?limit=${PAGE_LIMIT}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      ),
    enabled,
  });
}

/** One page of rows, whichever endpoint served them, in the shape the pane
 *  renders. `nextCursor` is null for a project page (that route has no
 *  keyset cursor) and for the last cross-project page. */
export interface ThreadListState {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  items: ConversationSummary[];
  loaded: boolean;
  nextCursor: string | null;
  /** Re-run the read that failed — what the pane's `Retry` presses. */
  refetch: () => void;
  /** The read is in flight (a retry included). */
  fetching: boolean;
}

export function useThreadList(
  projectId: string,
  cursor: string | null,
  filters: ConversationListFilters = {},
): ThreadListState {
  const cross = useCrossProjectThreads(cursor, projectId.length === 0);
  const scoped = useConversations(projectId, filters);
  if (projectId.length > 0) {
    return {
      isPending: scoped.isPending,
      isError: scoped.isError,
      error: scoped.error ?? null,
      items: scoped.data?.items ?? [],
      loaded: Boolean(scoped.data),
      nextCursor: null,
      refetch: () => void scoped.refetch(),
      fetching: scoped.isFetching,
    };
  }
  return {
    isPending: cross.isPending,
    isError: cross.isError,
    error: cross.error ?? null,
    items: cross.data?.items ?? [],
    loaded: Boolean(cross.data),
    nextCursor: cross.data?.next_cursor ?? null,
    refetch: () => void cross.refetch(),
    fetching: cross.isFetching,
  };
}

/** What `LIVE` means here, said exactly: the server's own flags — a live ACP
 *  session is attached (`status: active`) or someone is prompting right now
 *  (`has_active_turn`). A `disconnected` thread keeps its open turn but no
 *  session: it is EARLIER with its state word, not a fake live row. */
function isLive(conversation: ConversationSummary): boolean {
  if (conversation.status === "disconnected" || conversation.status === "archived") {
    return false;
  }
  return conversation.status === "active" || conversation.has_active_turn === true;
}

/** The worded statuses on the mono meta line — the glyph NEVER rides alone:
 *  `ds/states` says a state carries its glyph AND its word, never colour (or
 *  a shape) alone, and the thread row honours that for every status the wire
 *  can serve (`m5-inbox`: the row wears the conversation's own state word).
 *  `idle` got its word from rcn-6 review 1 — an open chat with nothing
 *  attached must not read as the queued `·`-only `pending` row. */
const ROW_STATUS_WORDS: Partial<Record<ConversationSummary["status"], string>> = {
  active: "active",
  disconnected: "disconnected",
  archived: "archived",
};

function FilterChip({
  active,
  onClick,
  testid,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testid: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? "rounded-[2px] border border-ink bg-ink px-[7px] py-[2px] font-mono text-[10.5px] text-paper"
          : "rounded-[2px] border border-line-strong bg-surface px-[7px] py-[2px] font-mono text-[10.5px] text-muted hover:text-ink"
      }
      data-testid={testid}
    >
      {children}
    </button>
  );
}

function GroupLabel({ children, first }: { children: ReactNode; first: boolean }) {
  return (
    <p
      className={`font-mono text-[10px] font-semibold tracking-[.06em] text-muted ${
        first ? "pt-[10px]" : "pt-[14px]"
      } px-[14px] pb-[4px]`}
    >
      {children}
    </p>
  );
}

/** One labelled group of the list; the group renders nothing when it has no
 *  rows, so a label never shouts over an empty shelf. */
function ThreadGroup({
  testid,
  label,
  first,
  rows,
  selectedId,
  projectName,
  profileName,
  declaredScope,
}: {
  testid: string;
  label: string;
  first: boolean;
  rows: ConversationSummary[];
  selectedId: string;
  projectName: (id: string) => string;
  profileName: (id: string) => string;
  declaredScope?: { id: string; repositoryId: string | null };
}) {
  if (rows.length === 0) return null;
  return (
    <div data-testid={testid}>
      <GroupLabel first={first}>{label}</GroupLabel>
      <ul className="space-y-[4px] px-2">
        {rows.map((conversation) => (
          <ThreadItem
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selectedId}
            projectName={projectName(conversation.project_id)}
            profileName={profileName(conversation.agent_profile_id)}
            declaredScope={declaredScope}
          />
        ))}
      </ul>
    </div>
  );
}

/** One row: glyph · title · age, then the mono `project / repo · agent` line
 *  (ADR-0065's `repository_name`; no binding → the project alone, as before),
 *  then the last line the agent wrote whenever the wire serves one — never
 *  faked. Selection is the raised treatment: ink edge, hard shadow, accent
 *  wash.
 *
 *  The scope segment answers the chat's SCOPE, not its workspace: the row's
 *  `repository_id` is the same fact as its `repository_name` (the wire keeps
 *  them together — "null exactly when `repository_id` is null"), so a row
 *  that answers `repository_id: null` names no repository even when the name
 *  member carries one — a name beside a null id is the three-arm derivation's
 *  workspace checkout, not the chat's scope, and the row says so (rcn-review13
 *  item 1: a moved chat's row kept printing the workspace's repository). A
 *  host that has read one row in detail hands down its declared scope
 *  (`declaredScope`): the summary row still answers the workspace arm for a
 *  moved thread, but the declared binding — null, the whole project — is the
 *  fact only the detail read carries, and it outranks the derivation for the
 *  row it names. */
function ThreadItem({
  conversation,
  selected,
  projectName,
  profileName,
  declaredScope,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  projectName: string;
  profileName: string;
  declaredScope?: { id: string; repositoryId: string | null };
}) {
  // gh-69: a pointer that lands on a row warms that thread's detail read (a
  // 60s-fresh prefetch per row), so the click itself opens the thread without
  // waiting on a round trip. Touch taps fire `pointerenter` too — at worst the
  // open read is one the click was going to make anyway.
  const queryClient = useQueryClient();
  const state: StateName = stateOf(CONVERSATION_STATE[conversation.status]);
  const spec = STATES[state];
  // `idle` reads as `idle` (an open chat with nothing queued), never as the
  // queued `·`-only row that reads as `pending`; a turn in flight says
  // `pending`. The rest ride the worded-status table (rcn-6 review 1).
  const word =
    conversation.status === "idle"
      ? conversation.has_active_turn
        ? "pending"
        : "idle"
      : ROW_STATUS_WORDS[conversation.status];
  const repo = conversation.repository_name ?? null;
  // The row's OWN declared scope is the null arm: `repository_id: null` is
  // the wire's "works in the whole project" (ADR-0067 amendment), and the
  // name member beside it is the derivation's workspace checkout, not a
  // scope — never a repository (rcn-review13 item 1). A row a control plane
  // predating the field answers (undefined) keeps the old `project · agent`
  // shape: no read says that thread is unbound.
  const wholeProjectRow = conversation.repository_id === null;
  // The host's detail read knows the declared scope of the row it opens, and
  // null says the whole project even while the summary's three-arm derivation
  // still names the old workspace's repository (rcn-review13 item 1 — the
  // SELECTED row kept naming the project's first repository after the move).
  const declared =
    declaredScope && declaredScope.id === conversation.id ? declaredScope.repositoryId : undefined;
  const scope = declared === null || wholeProjectRow ? "Whole project" : repo;
  // The served line is the agent's own text; the ONE shared preview helper
  // strips its leading markdown markers and inline emphasis, so the row
  // leads with the sentence, not a bullet (pass-1 review).
  const preview = previewLine(conversation.last_agent_line);
  // Round-16: a run-origin row the server still named in raw ids (`run
  // 01a1a992 /plan attempt 1`) is rendered in words — the same humanised
  // form the new server-side title carries — from the row's own run_link
  // (ADR-0043), with the run reference demoted to a muted secondary line.
  // A title a person wrote, or a link that cannot name the node, stays
  // exactly what the wire sent.
  const legacy: RunThreadTitle | null =
    conversation.origin === "run"
      ? legacyRunThreadTitle(conversation.title, conversation.run_link)
      : null;
  const shownTitle = legacy ? legacy.title : conversation.title;
  return (
    <li>
      <Link
        to={routes.thread(conversation.id)}
        onPointerEnter={() => prefetchConversation(queryClient, conversation.id)}
        data-testid={`thread-row-${conversation.id}`}
        aria-current={selected ? "page" : undefined}
        className={`block rounded-[3px] border px-[10px] py-[9px] ${
          selected
            ? "border-ink bg-accent-wash shadow-(--shadow-raised)"
            : "border-transparent hover:border-line-strong hover:bg-surface"
        }`}
      >
        <span className="flex items-center gap-[6px]">
          <span aria-hidden="true" className={`shrink-0 font-mono text-[11px] ${spec.tagFg}`}>
            {spec.glyph}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
            {shownTitle}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {formatAge(conversation.updated_at)}
          </span>
        </span>
        <span className="block truncate pl-[17px] font-mono text-[10.5px] text-muted">
          {scope ? `${projectName} / ${scope}` : projectName} · {profileName}
          {word ? ` · ${word}` : ""}
        </span>
        {legacy ? (
          // The run reference as secondary metadata (screens 1g/2a name runs
          // by a short `#ref`), muted — never the raw id the stored title
          // carried.
          <span
            className="block truncate pl-[17px] font-mono text-[10.5px] text-muted"
            data-testid={`thread-run-ref-${conversation.id}`}
          >
            {legacy.secondary}
          </span>
        ) : null}
        {preview ? (
          <span
            className="block truncate pl-[17px] text-[12px] text-muted"
            data-testid={`thread-last-line-${conversation.id}`}
          >
            {preview}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

export interface ThreadListPaneProps {
  /** Filter to one project (a project's Threads tab reuses this view);
   *  empty means every project the caller is a member of. */
  projectId?: string;
  /** The thread rendered in the pane beside this list, when one is. */
  selectedId?: string;
  /**
   * The declared scope (ADR-0067 amendment: `repository_id` as stored —
   * null = the whole project) of a row the host has ALREADY read in detail.
   * The summary rows answer the three-arm derivation, and a thread moved to
   * the whole project still carries its old workspace's repository in that
   * derivation — so for the one row the host can prove, the declared scope
   * outranks the name the summary derives (rcn-review13 item 1).
   */
  declaredScope?: { id: string; repositoryId: string | null };
  /**
   * Whether this pane is the ONLY error surface for the failed read. When the
   * pane sits alone (the `/threads` list column, which stays visible at every
   * width), it owns a loud `role="alert"` banner — the one place the reader
   * looks — and the host page must NOT draw a second one. When false the pane
   * keeps only its quiet one-line note, deferring the loud banner to the host
   * (a project's Threads tab, where the list IS the page). The loud banner and
   * the quiet note share the `threads-list-error` test id, so a failed read is
   * said ONCE regardless of who hosts the pane — pass-2 review found it said
   * twice on `/threads` (a quiet line in the pane and a loud banner in the
   * thread column).
   */
  ownsError?: boolean;
  /**
   * Whether this pane is the ONLY title on its column. The `/threads` list
   * route draws the shared `PageBand` (`Threads`) above the two panes, so the
   * pane must not print a second `Threads` heading under it (finding 07, review
   * pass): the host passes `ownsTitle={false}` and puts the pane's `New thread`
   * verb in the band's actions slot (`threads/NewThreadAction`). Hosts that
   * give the column no band — the open thread at `/threads/:id`, the loading
   * frame — leave this true, so the list column still names itself and still
   * offers the verb.
   */
  ownsTitle?: boolean;
}

export function ThreadListPane({
  projectId = "",
  selectedId = "",
  declaredScope,
  ownsError = false,
  ownsTitle = true,
}: ThreadListPaneProps) {
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<"all" | "mine" | "runs">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // The project-scoped route matches `q` server-side (ADR-0043); debounced so
  // a title is not re-fetched per keystroke (the panel this pane replaced in
  // the project's Threads tab did the same). The client-side filter below
  // already narrows on each keystroke, so the debounce only hides a duplicate
  // round trip, never a result.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  // Only the project-scoped read answers to the params; the cross-project
  // endpoint does not, so the cross pane asks nothing it cannot serve.
  const list = useThreadList(projectId, cursor, {
    q: debouncedSearch.trim() ? debouncedSearch : undefined,
    origin: chip === "runs" ? "run" : undefined,
  });
  const me = useMe();
  const projects = useProjects();
  const profiles = useAgentProfiles();

  const projectName = (id: string) =>
    projects.data?.items.find((project) => project.id === id)?.name ?? shortId(id);
  const profileName = (id: string) =>
    profiles.data?.items.find((profile) => profile.id === id)?.name ?? shortId(id);

  const query = search.trim().toLowerCase();
  // The search matches what the row RENDERS: the stored title, and — for a
  // run row the pane re-renders in words from its legacy id title — the
  // worded title too, so "plan" finds it.
  const matchesQuery = (conversation: ConversationSummary): boolean => {
    if (query === "") return true;
    if (conversation.title.toLowerCase().includes(query)) return true;
    const legacy =
      conversation.origin === "run"
        ? legacyRunThreadTitle(conversation.title, conversation.run_link)
        : null;
    return legacy ? legacy.title.toLowerCase().includes(query) : false;
  };
  // `mine` before `me` has resolved filters nothing yet — an unloaded
  // directory is not evidence that a thread is nobody's.
  const mineKnown = chip !== "mine" || Boolean(me.data);
  const rows = list.items.filter(
    (conversation) =>
      (chip === "all" ||
        (chip === "mine" && (!mineKnown || conversation.created_by === me.data?.id)) ||
        (chip === "runs" && conversation.origin === "run")) &&
      matchesQuery(conversation),
  );
  const live = rows.filter(isLive);
  const earlier = rows.filter((conversation) => !isLive(conversation));

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-surface"
      data-testid="threads-page"
      aria-label="Threads"
    >
      <div className="flex flex-col gap-[10px] border-b border-line px-[14px] pb-[12px] pt-4">
        {/* Pass-2 review (`project-1b-threads`) and the finding-07 review pass
            use the same rule: whoever draws the band owns the title and the one
            `New thread` verb, and the pane draws neither under it. Inside a
            project's Threads tab that band is `ProjectHeader`'s; on `/threads`
            it is the shared `PageBand` (`Threads` + `threads-new-open`). Where
            no band stands above the column — the open thread at `/threads/:id`
            and the loading frame — the pane is the column's only title, so it
            keeps the heading and the verb. */}
        {projectId || !ownsTitle ? null : (
          <div className="flex items-center gap-2">
            <h1 id="threads-heading" className="min-w-0 flex-1 text-[19px] font-semibold">
              Threads
            </h1>
            <Button
              variant="primary"
              compact
              data-testid="threads-new-open"
              onClick={() => setDialogOpen(true)}
            >
              New thread
            </Button>
          </div>
        )}
        <Input
          id="threads-search"
          data-testid="threads-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search threads"
          aria-label="Search threads"
        />
        <div
          role="group"
          aria-label="Thread filters"
          className="flex flex-wrap items-center gap-[5px]"
          data-testid="threads-filters"
        >
          <FilterChip
            active={chip === "all"}
            onClick={() => setChip("all")}
            testid="threads-filter-all"
          >
            {projectId ? "all" : "all projects"}
          </FilterChip>
          <FilterChip
            active={chip === "mine"}
            onClick={() => setChip(chip === "mine" ? "all" : "mine")}
            testid="threads-filter-mine"
          >
            mine
          </FilterChip>
          <FilterChip
            active={chip === "runs"}
            onClick={() => setChip(chip === "runs" ? "all" : "runs")}
            testid="threads-filter-runs"
          >
            from runs
          </FilterChip>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {list.isPending ? (
          <div className="p-[14px]">
            <Spinner label="Loading threads" />
          </div>
        ) : null}
        {list.isError ? (
          ownsError ? (
            // Alone on the screen (the `/threads` list column, visible at every
            // width): this pane IS the loud banner, so the failure stays
            // reachable on a phone and the host draws no second one. Same test
            // id as the quiet note it replaces.
            <div className="p-[14px]" data-testid="threads-list-error">
              <ProblemBanner
                error={list.error}
                fallback="The list shows no threads because none could be read. Open a project's Threads tab meanwhile."
                subject="the thread list"
                retry={{
                  onClick: list.refetch,
                  pending: list.fetching,
                  testid: "threads-list-retry",
                }}
              />
            </div>
          ) : (
            // Hosted beside other content: stay quiet about roles, the host page
            // owns the loud banner. Here the list says it could not read, in a
            // line, and stops.
            <p
              className="px-[14px] pt-3 font-mono text-[11px] text-st-failed-tag-fg"
              data-testid="threads-list-error"
            >
              <span aria-hidden="true">× </span>
              the thread list could not be read
            </p>
          )
        ) : null}
        {list.loaded && !list.isError ? (
          rows.length === 0 ? (
            // Nothing on screen: the loaded page had rows (client-side
            // filtering hid them), or this is the project route with an
            // active filter — where the SERVER matched and answered empty,
            // so "the unfiltered shelf is empty" is not something this read
            // can still see (the unfiltered read lives in the tab's count,
            // not here). Otherwise the caller really has no threads.
            list.items.length > 0 || (projectId.length > 0 && (query !== "" || chip !== "all")) ? (
              <p
                className="px-[14px] pt-[10px] text-[12.5px] text-muted"
                data-testid="threads-nomatch"
              >
                No threads match the search or filter on this page.
              </p>
            ) : (
              <p
                className="px-[14px] pt-[10px] text-[12.5px] text-muted"
                data-testid="threads-list-empty"
              >
                No threads yet — start one with New thread.
              </p>
            )
          ) : (
            <>
              <div data-testid="threads-list">
                <ThreadGroup
                  testid="threads-group-live"
                  label="LIVE"
                  first
                  rows={live}
                  selectedId={selectedId}
                  projectName={projectName}
                  profileName={profileName}
                  declaredScope={declaredScope}
                />
                <ThreadGroup
                  testid="threads-group-earlier"
                  label="EARLIER"
                  first={live.length === 0}
                  rows={earlier}
                  selectedId={selectedId}
                  projectName={projectName}
                  profileName={profileName}
                  declaredScope={declaredScope}
                />
              </div>
              {list.nextCursor !== null || cursor ? (
                <div className="flex items-center gap-2 px-[14px] pt-2">
                  {list.nextCursor ? (
                    <Button
                      variant="ghost"
                      compact
                      data-testid="threads-next-page"
                      onClick={() => setCursor(list.nextCursor)}
                    >
                      Next page
                    </Button>
                  ) : null}
                  {cursor ? (
                    <Button
                      variant="ghost"
                      compact
                      data-testid="threads-first-page"
                      onClick={() => setCursor(null)}
                    >
                      First page
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </>
          )
        ) : null}
      </div>
      {/* Only where the pane still owns the verb does it open the dialog: with
          the band holding `New thread` (`threads/NewThreadAction`) the pane's
          `dialogOpen` has no trigger any more, and a project's Threads tab put
          its verb — and its dialog — in `ProjectFrame`. */}
      {projectId || !ownsTitle ? null : (
        <NewConversationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
      )}
    </div>
  );
}
