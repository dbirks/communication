/**
 * ChatList — the 300px left-column chat list for Chats (redesign R3).
 *
 * Reuses `useThreadList` from ThreadListPane for pagination and scoped/unscoped
 * reads. In All scope, groups rows by project in the projects list order; in a
 * project scope, renders flat rows without headers.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { IconPlus } from "@tabler/icons-react";
import {
  prefetchConversation,
  queryKeys,
  useAgentProfiles,
  useMe,
  useProjects,
} from "../../api/queries";
import type { Conversation, ConversationSummary, Run } from "../../api/types";
import { shortId } from "../../lib/format";
import { previewLine } from "../../lib/preview";
import { routes } from "../../lib/routes";
import { Spinner } from "../Feedback";
import { useThreadList } from "../threads/ThreadListPane";
import { legacyRunThreadTitle } from "../threads/runThreadTitle";

const RUNNING_RUN_STATUSES = new Set(["queued", "preparing", "running"]);

function chatRowStatus(
  conversation: ConversationSummary,
  meId: string | undefined,
  queryClient: QueryClient,
): { text: string; className: string } | null {
  const detail = queryClient.getQueryData<Conversation>(queryKeys.conversation(conversation.id));

  const hasPendingPermission =
    (detail?.pending_permissions ?? []).some((p) => p.status === "pending") &&
    conversation.control.kind === "human" &&
    (!meId || conversation.control.user_id === meId);

  const handedToMe =
    conversation.status !== "archived" &&
    !conversation.has_active_turn &&
    conversation.control.kind === "human" &&
    meId !== undefined &&
    conversation.control.user_id === meId &&
    conversation.control.previous_user_id != null &&
    conversation.control.previous_user_id !== meId;

  if (hasPendingPermission || handedToMe) {
    return { text: "! you", className: "text-st-waiting-tag-fg" };
  }

  const turnRunning =
    conversation.status !== "disconnected" &&
    conversation.status !== "archived" &&
    conversation.has_active_turn === true;

  const linkedRunRunning = (detail?.linked_runs ?? []).some((lr) => {
    const run = queryClient.getQueryData<Run>(queryKeys.run(lr.run_id));
    return run ? RUNNING_RUN_STATUSES.has(run.status) : false;
  });

  if (turnRunning || linkedRunRunning) {
    return { text: "● run", className: "text-st-running-tag-fg" };
  }

  return null;
}

export interface ChatListProps {
  scope: string | null;
  selectedId?: string;
}

export function ChatList({ scope, selectedId = "" }: ChatListProps) {
  const projectId = scope ?? "";
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | "manual" | "runs">("all");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);

  useEffect(() => {
    setCursor(null);
  }, [projectId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const list = useThreadList(projectId, cursor, {
    q: debouncedSearch.trim() ? debouncedSearch : undefined,
    origin: originFilter === "runs" ? "run" : originFilter === "manual" ? "manual" : undefined,
  });
  const me = useMe();
  const projects = useProjects();
  const profiles = useAgentProfiles();
  const queryClient = useQueryClient();

  const projectItems = projects.data?.items ?? [];
  const projectName = (id: string) => projectItems.find((p) => p.id === id)?.name ?? shortId(id);
  const profileName = (id: string) => profiles.data?.items.find((p) => p.id === id)?.name ?? "";

  const query = search.trim().toLowerCase();
  const rows = useMemo(() => {
    return list.items.filter((conversation) => {
      if (projectId && conversation.project_id !== projectId) return false;
      if (originFilter === "runs" && conversation.origin !== "run") return false;
      if (originFilter === "manual" && conversation.origin !== "manual") return false;
      if (query === "") return true;
      if (conversation.title.toLowerCase().includes(query)) return true;
      const legacy =
        conversation.origin === "run"
          ? legacyRunThreadTitle(conversation.title, conversation.run_link)
          : null;
      return legacy ? legacy.title.toLowerCase().includes(query) : false;
    });
  }, [list.items, projectId, originFilter, query]);

  const groups = useMemo(() => {
    if (projectId) return null;
    const byProject = new Map<string, ConversationSummary[]>();
    for (const row of rows) {
      const bucket = byProject.get(row.project_id) ?? [];
      bucket.push(row);
      byProject.set(row.project_id, bucket);
    }
    const ordered: { projectId: string; name: string; rows: ConversationSummary[] }[] = [];
    for (const project of projectItems) {
      const bucket = byProject.get(project.id);
      if (bucket && bucket.length > 0) {
        ordered.push({ projectId: project.id, name: project.name, rows: bucket });
        byProject.delete(project.id);
      }
    }
    for (const [pid, bucket] of byProject) {
      ordered.push({ projectId: pid, name: projectName(pid), rows: bucket });
    }
    return ordered;
  }, [projectId, rows, projectItems]);

  const renderRow = (conversation: ConversationSummary) => {
    const selected = conversation.id === selectedId;
    const legacy =
      conversation.origin === "run"
        ? legacyRunThreadTitle(conversation.title, conversation.run_link)
        : null;
    const title = legacy ? legacy.title : conversation.title;
    const status = chatRowStatus(conversation, me.data?.id, queryClient);
    const preview = previewLine(conversation.last_agent_line);
    const author = profileName(conversation.agent_profile_id);
    const lastLine = preview ? (author ? `${author}: ${preview}` : preview) : "";

    return (
      <Link
        key={conversation.id}
        to={routes.chat(conversation.id, scope)}
        onPointerEnter={() => prefetchConversation(queryClient, conversation.id)}
        data-testid={`chat-row-${conversation.id}`}
        aria-current={selected ? "page" : undefined}
        className={`flex flex-col justify-center gap-[2px] rounded-[8px] px-[8px] py-[9px] focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] ${
          selected ? "bg-accent-wash" : "bg-transparent hover:bg-rail"
        }`}
      >
        <span className="flex items-center gap-[8px]">
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
            {title}
          </span>
          {status ? (
            <span
              data-testid={`chat-row-status-${conversation.id}`}
              className={`shrink-0 font-mono text-[11.5px] font-semibold ${status.className}`}
            >
              {status.text}
            </span>
          ) : null}
        </span>
        {lastLine ? (
          <span className="block truncate text-[12.5px] text-muted">{lastLine}</span>
        ) : null}
      </Link>
    );
  };

  return (
    <aside
      data-testid="chat-list"
      aria-label="Chats"
      className="flex h-full min-h-0 flex-col gap-[2px] overflow-y-auto border-r border-line-soft bg-surface px-[8px] py-[16px]"
    >
      <div className="flex items-center gap-[8px] px-[8px] pb-[10px]">
        <span className="min-w-0 flex-1 text-[16px] font-bold text-ink">Chats</span>
        <Link
          to={routes.chat("new", scope)}
          data-testid="chat-new"
          className="ds-btn ds-btn--secondary ds-btn--compact h-[28px]! shrink-0 gap-[6px]! max-md:min-h-[44px]"
        >
          <IconPlus size={14} stroke={1.5} aria-hidden="true" />
          New
        </Link>
      </div>

      <div className="flex flex-col gap-[6px] px-[8px] pb-[6px] md:flex-row md:items-center">
        <input
          type="search"
          data-testid="chat-search"
          aria-label="Search chats"
          placeholder="Search chats"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-[30px] w-full rounded-[8px] border border-line bg-surface px-[10px] text-[12.5px] text-ink placeholder:text-faint focus:border-accent focus:outline-none md:min-w-0 md:flex-1 max-md:min-h-[44px]"
        />
        <div
          role="group"
          aria-label="Chat filters"
          data-testid="threads-filters"
          className="grid h-[26px] grid-cols-3 gap-[2px] rounded-[8px] bg-disabled-bg p-[2px] md:w-fit md:shrink-0 max-md:h-auto max-md:min-h-[44px]"
        >
          {(
            [
              {
                id: "all",
                label: "All",
                accessible: "All",
                testid: "threads-filter-all",
              },
              {
                id: "manual",
                label: "One-off",
                accessible: "One-off",
                testid: "threads-filter-manual",
              },
              {
                id: "runs",
                label: "Runs",
                accessible: "From runs",
                testid: "threads-filter-runs",
              },
            ] as const
          ).map((option) => {
            const active = originFilter === option.id;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={active}
                aria-label={option.accessible}
                data-testid={option.testid}
                onClick={() => setOriginFilter(option.id)}
                className={`flex items-center justify-center rounded-[6px] border px-[6px] text-[11.5px] leading-none focus-visible:outline-2 focus-visible:outline-accent max-md:min-h-[44px] ${
                  active
                    ? "border-fill-edge bg-surface font-semibold text-ink"
                    : "border-transparent font-medium text-muted hover:text-ink"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {list.isPending ? (
        <div className="px-[8px] py-[10px]">
          <Spinner label="Loading chats" />
        </div>
      ) : null}

      {list.isError ? (
        <div
          data-testid="chat-list-error"
          role="alert"
          className="flex flex-col items-start gap-[8px] px-[8px] py-[10px]"
        >
          <p className="text-[12.5px] text-st-failed-tag-fg">The chat list could not be loaded.</p>
          <button
            type="button"
            data-testid="chat-list-retry"
            onClick={() => list.refetch()}
            disabled={list.fetching}
            className="rounded-[8px] border border-line-strong bg-surface px-[10px] py-[4px] text-[12.5px] font-semibold text-ink hover:bg-paper focus-visible:outline-2 focus-visible:outline-accent disabled:text-disabled-fg"
          >
            {list.fetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {list.loaded && !list.isError ? (
        rows.length === 0 ? (
          <p data-testid="chat-list-empty" className="px-[8px] py-[10px] text-[12.5px] text-muted">
            {list.items.length > 0 ||
            (projectId.length > 0 && (query !== "" || originFilter !== "all"))
              ? "No chats match your search."
              : "No chats yet."}
          </p>
        ) : groups ? (
          <div className="flex flex-col gap-[2px]">
            {groups.map((group) => (
              <div key={group.projectId} data-testid={`chat-group-${group.projectId}`}>
                <p className="px-[8px] pb-[4px] pt-[12px] font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
                  {group.name}
                </p>
                <div className="flex flex-col gap-[2px]">{group.rows.map(renderRow)}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-[2px]">{rows.map(renderRow)}</div>
        )
      ) : null}

      {list.nextCursor !== null || cursor ? (
        <div className="mt-auto flex items-center gap-[12px] px-[8px] pt-[10px]">
          {list.nextCursor ? (
            <button
              type="button"
              data-testid="chat-load-more"
              onClick={() => setCursor(list.nextCursor)}
              className="text-[12.5px] font-semibold text-accent-text hover:underline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Load more
            </button>
          ) : null}
          {cursor ? (
            <button
              type="button"
              data-testid="chat-first-page"
              onClick={() => setCursor(null)}
              className="text-[12.5px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              First page
            </button>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
