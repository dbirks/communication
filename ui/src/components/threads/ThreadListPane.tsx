/**
 * The 320px thread list pane (design 1g) — the left column of `/threads` and
 * of the open thread at `/threads/:id`, so moving between threads never
 * leaves the page.
 *
 * Data honesty (AGENTS.md): every row is a `ConversationSummary` from an
 * endpoint the app already calls — `GET /api/v1/conversations` (ADR-0047,
 * keyset page, newest first) across projects, or `GET
 * /projects/{id}/conversations` when the pane is filtered to one project.
 * The rows name ids only, so the project and profile *names* come from the
 * two directories this reads. Two things the design shows and the API does
 * not serve, and this never fakes:
 * - the repo inside the mono line (`project / repo · agent`) —
 *   `ConversationSummary` carries no repository, so the line is `project ·
 *   agent`; the list endpoint would need the conversation's workspace repo
 *   name to close the gap;
 * - the last agent line under a live row — the summary carries no transcript
 *   text, so nothing is rendered for it; `GET /api/v1/conversations` would
 *   need a `last_agent_line` field.
 *
 * Search and the chips filter the loaded page client-side (the cross-project
 * endpoint accepts no `q`/`origin` parameter — the project-scoped one does,
 * but this one path filters both honestly); the keyset "Next page" walk stays.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { useAgentProfiles, useConversations, useMe, useProjects } from "../../api/queries";
import type { ConversationSummary } from "../../api/types";
import type { components } from "../../api/schema";
import NewConversationDialog from "../NewConversationDialog";
import { Spinner } from "../Feedback";
import { Button } from "../ds/Button";
import { Input } from "../ds/Field";
import { CONVERSATION_STATE, STATES, stateOf, type StateName } from "../ds/states";
import { formatAge, shortId } from "../../lib/format";
import { routes } from "../../lib/routes";

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
}

export function useThreadList(projectId: string, cursor: string | null): ThreadListState {
  const cross = useCrossProjectThreads(cursor, projectId.length === 0);
  const scoped = useConversations(projectId);
  if (projectId.length > 0) {
    return {
      isPending: scoped.isPending,
      isError: scoped.isError,
      error: scoped.error ?? null,
      items: scoped.data?.items ?? [],
      loaded: Boolean(scoped.data),
      nextCursor: null,
    };
  }
  return {
    isPending: cross.isPending,
    isError: cross.isError,
    error: cross.error ?? null,
    items: cross.data?.items ?? [],
    loaded: Boolean(cross.data),
    nextCursor: cross.data?.next_cursor ?? null,
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

/** The one-line mono meta under a row title. The design's worded statuses
 *  are exactly these two — every other status rides on the glyph alone. */
const ROW_STATUS_WORDS: Partial<Record<ConversationSummary["status"], string>> = {
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
}: {
  testid: string;
  label: string;
  first: boolean;
  rows: ConversationSummary[];
  selectedId: string;
  projectName: (id: string) => string;
  profileName: (id: string) => string;
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
          />
        ))}
      </ul>
    </div>
  );
}

/** One row: glyph · title · age, then the mono `project · agent` line, then
 *  (never faked) whatever the wire says about the status word. Selection is
 *  the raised treatment: ink edge, hard shadow, accent wash. */
function ThreadItem({
  conversation,
  selected,
  projectName,
  profileName,
}: {
  conversation: ConversationSummary;
  selected: boolean;
  projectName: string;
  profileName: string;
}) {
  const state: StateName = stateOf(CONVERSATION_STATE[conversation.status]);
  const spec = STATES[state];
  const word = ROW_STATUS_WORDS[conversation.status];
  return (
    <li>
      <Link
        to={routes.thread(conversation.id)}
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
            {conversation.title}
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-faint">
            {formatAge(conversation.updated_at)}
          </span>
        </span>
        <span className="block truncate pl-[17px] font-mono text-[10.5px] text-muted">
          {projectName} · {profileName}
          {word ? ` · ${word}` : ""}
        </span>
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
}

export function ThreadListPane({ projectId = "", selectedId = "" }: ThreadListPaneProps) {
  const [search, setSearch] = useState("");
  const [chip, setChip] = useState<"all" | "mine" | "runs">("all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const list = useThreadList(projectId, cursor);
  const me = useMe();
  const projects = useProjects();
  const profiles = useAgentProfiles();

  const projectName = (id: string) =>
    projects.data?.items.find((project) => project.id === id)?.name ?? shortId(id);
  const profileName = (id: string) =>
    profiles.data?.items.find((profile) => profile.id === id)?.name ?? shortId(id);

  const query = search.trim().toLowerCase();
  // `mine` before `me` has resolved filters nothing yet — an unloaded
  // directory is not evidence that a thread is nobody's.
  const mineKnown = chip !== "mine" || Boolean(me.data);
  const rows = list.items.filter(
    (conversation) =>
      (chip === "all" ||
        (chip === "mine" && (!mineKnown || conversation.created_by === me.data?.id)) ||
        (chip === "runs" && conversation.origin === "run")) &&
      (query === "" || conversation.title.toLowerCase().includes(query)),
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
          // The pane stays quiet about roles: the page that hosts it owns the
          // loud banner (ProblemBanner, role="alert"). Here the list says it
          // could not read, in a line, and stops.
          <p
            className="px-[14px] pt-3 font-mono text-[11px] text-st-failed-tag-fg"
            data-testid="threads-list-error"
          >
            <span aria-hidden="true">× </span>
            the thread list could not be read
          </p>
        ) : null}
        {list.loaded && !list.isError ? (
          rows.length === 0 ? (
            list.items.length > 0 ? (
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
                />
                <ThreadGroup
                  testid="threads-group-earlier"
                  label="EARLIER"
                  first={live.length === 0}
                  rows={earlier}
                  selectedId={selectedId}
                  projectName={projectName}
                  profileName={profileName}
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
      <NewConversationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}
