import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAgentProfiles, useConversations } from "../api/queries";
import type { ConversationSummary, Project } from "../api/types";
import { ProblemBanner, Spinner } from "./Feedback";
import NewConversationDialog from "./NewConversationDialog";
import { Button } from "./ds/Button";
import { Panel } from "./ds/Panel";
import { Row, StatusChip } from "./ds/Row";
import { CONVERSATION_STATE, stateOf } from "./ds/states";
import { shortId } from "../lib/format";
import { routes } from "../lib/routes";

/**
 * Stable hook for the browser proof: `conversation-row-<title-slug>` mirrors how
 * repository rows are keyed, and falls back to the id when a title has no
 * word characters at all.
 */
export function titleSlug(title: string, id: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || shortId(id);
}

function controllerName(conversation: ConversationSummary): string {
  if (conversation.control.kind === "none") return "nobody";
  if (conversation.control.kind === "run_attempt") return "a pipeline run";
  return conversation.control.display_name ?? "a member";
}

/** The leaf of an instance key like `/review` or `/loop/body/scan`. */
export function instanceLeaf(key: string): string {
  const parts = key.split("/").filter((part) => part.length > 0);
  return parts.at(-1) ?? key;
}

/** The `run_link` a run-origin conversation deep-links from. */
type RunLink = NonNullable<ConversationSummary["run_link"]>;

/**
 * The Run Workbench deep link for a run-linked conversation (ADR-0043): the
 * workbench reads `node`/`instance`/`attempt` from the URL. `node` is the
 * definition node id and is omitted when the node execution did not store one.
 */
export function conversationRunHref(link: RunLink): string {
  // `routes.run` drops empty values, so `node` is omitted when the node
  // execution stored no definition id — the workbench reads the same params.
  return routes.run(link.run_id, {
    node: link.node_id ?? "",
    instance: link.node_execution_id,
    attempt: String(link.attempt_number),
  });
}

export interface OriginBadgeProps {
  conversation: Pick<ConversationSummary, "origin" | "run_link">;
}

/**
 * Where a conversation was opened: a plain "Manual" tag, or a "From run" tag
 * that deep-links into the Run Workbench at the run, node execution and
 * attempt that opened it. The run says its title when the run stored one,
 * its short id otherwise; the node says its definition id, its instance-key
 * leaf otherwise.
 *
 * The badge is a span with link semantics, not an anchor: in the
 * conversations list the row itself is the anchor, and an `<a>` nested in an
 * `<a>` is invalid HTML (React logs a hydration error for it). The handler
 * calls `stopPropagation` so the row's own Link handler never runs, and
 * `preventDefault` so the wrapper anchor's default browser navigation never
 * runs either — otherwise a pointer click would follow the row's conversation
 * href and only keyboard Enter would reach the workbench. Both fire before
 * `navigate(href)` takes the SPA deep link.
 */
export function OriginBadge({ conversation }: OriginBadgeProps) {
  const navigate = useNavigate();
  const link = conversation.run_link;
  if (conversation.origin === "run" && link) {
    const href = conversationRunHref(link);
    return (
      <span
        role="link"
        tabIndex={0}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          navigate(href);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            navigate(href);
          }
        }}
        data-testid="conversation-origin-run"
        title={href}
        className="inline-flex max-w-[220px] cursor-pointer items-center gap-1 rounded-[2px] border border-line-strong bg-surface px-[6px] py-[1px] font-mono text-[10.5px] text-accent-text hover:bg-paper hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      >
        <span className="truncate">
          From run · {link.run_title || shortId(link.run_id)} ·{" "}
          {link.node_id || instanceLeaf(link.node_instance_key)}
        </span>
      </span>
    );
  }
  if (conversation.origin === "run") {
    return (
      <span
        data-testid="conversation-origin-run"
        className="inline-flex items-center rounded-[2px] border border-line-strong bg-surface px-[6px] py-[1px] font-mono text-[10.5px] text-muted"
      >
        From run
      </span>
    );
  }
  return (
    <span
      data-testid="conversation-origin-manual"
      className="inline-flex items-center rounded-[2px] border border-line bg-surface px-[6px] py-[1px] font-mono text-[10.5px] text-muted"
    >
      Manual
    </span>
  );
}

const ORIGIN_FILTERS = [
  { value: "all", label: "All", testid: "conversation-filter-all" },
  { value: "manual", label: "Manual", testid: "conversation-filter-manual" },
  { value: "run", label: "From runs", testid: "conversation-filter-run" },
] as const;

type OriginFilter = (typeof ORIGIN_FILTERS)[number]["value"];

export interface ConversationsProps {
  project: Project;
}

/**
 * A project's conversations (J2: "three conversations" in one glance). Each row
 * says where it was opened and who is driving, because that is what a
 * supervising team reads. The search box and the All/Manual/From-runs filter
 * both travel to the list route (`q` and `origin`, ADR-0043); the search is
 * debounced so a title is not re-fetched per keystroke.
 */
export default function Conversations({ project }: ConversationsProps) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const canStart = project.my_role === "maintainer" || project.my_role === "contributor";

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const conversations = useConversations(project.id, {
    origin: originFilter === "all" ? undefined : originFilter,
    q: debouncedQuery,
  });
  const profiles = useAgentProfiles();

  const profileName = (conversation: ConversationSummary) => {
    // The list row carries only `agent_profile_id`; the name comes from the
    // profile directory this section already reads for the form.
    const profile = profiles.data?.items.find(
      (candidate) => candidate.id === conversation.agent_profile_id,
    );
    return profile ? profile.name : conversation.agent_profile_id;
  };

  // An active filter or search narrows an empty answer to "nothing matches";
  // only an unfiltered empty list may say the project has none yet.
  const filtered = debouncedQuery.trim() !== "" || originFilter !== "all";

  return (
    <Panel
      id="conversations"
      title="CONVERSATIONS"
      headingId="conversations-heading"
      headingLevel={2}
      meta={conversations.data ? `${conversations.data.items.length} total` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        <div
          role="group"
          aria-label="Conversation filters"
          className="flex flex-wrap items-center gap-[5px]"
          data-testid="conversation-filters"
        >
          {ORIGIN_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={originFilter === filter.value}
              aria-label={`show ${filter.label} conversations`}
              data-testid={filter.testid}
              onClick={() => setOriginFilter(filter.value)}
              className={`rounded-[2px] border px-[7px] py-[2px] font-mono text-[10.5px] ${
                originFilter === filter.value
                  ? "border-ink bg-ink text-paper"
                  : "border-line-strong bg-surface text-muted hover:text-ink"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <input
            type="search"
            aria-label="Search conversations by title"
            placeholder="search title"
            value={query}
            data-testid="conversation-search"
            onChange={(event) => setQuery(event.target.value)}
            className="ml-auto w-[11rem] rounded-[2px] border border-line-strong bg-surface px-[6px] py-[2px] font-mono text-[10.5px] text-ink placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          />
        </div>
        {conversations.isPending ? <Spinner label="Loading conversations" /> : null}
        {conversations.error ? (
          <ProblemBanner
            error={conversations.error}
            fallback="Conversations could not be loaded."
          />
        ) : null}
        {conversations.data ? (
          conversations.data.items.length === 0 ? (
            filtered ? (
              <p className="text-[12.5px] text-muted" data-testid="conversation-list-nomatch">
                No conversations match
              </p>
            ) : (
              <p className="text-[12.5px] text-muted" data-testid="conversation-list-empty">
                No conversations yet.
              </p>
            )
          ) : (
            <ul className="space-y-[4px]" data-testid="conversation-list">
              {conversations.data.items.map((conversation) => (
                <li key={conversation.id}>
                  <Row
                    to={routes.thread(conversation.id)}
                    data-testid={`conversation-row-${titleSlug(conversation.title, conversation.id)}`}
                  >
                    <StatusChip
                      state={stateOf(CONVERSATION_STATE[conversation.status])}
                      label={conversation.status}
                    />
                    <OriginBadge conversation={conversation} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold">
                        {conversation.title}
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-muted">
                        profile: {profileName(conversation)} · controller:{" "}
                        {controllerName(conversation)} · updated: {conversation.updated_at}
                      </span>
                    </span>
                    {conversation.has_active_turn ? (
                      <StatusChip state="running" label="turn open" />
                    ) : null}
                  </Row>
                </li>
              ))}
            </ul>
          )
        ) : null}

        {canStart ? (
          <Button
            variant="secondary"
            data-testid="conversations-new-open"
            onClick={() => setDialogOpen(true)}
          >
            New conversation
          </Button>
        ) : (
          <p className="text-[12.5px] text-muted">
            Only project contributors and maintainers can start conversations.
          </p>
        )}
        <NewConversationDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          projectId={project.id}
          project={project}
        />
      </div>
    </Panel>
  );
}
