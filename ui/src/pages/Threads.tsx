/**
 * Threads (route `/threads`) — the cross-project thread list (C3 / ADR-0047:
 * `GET /api/v1/conversations` returns the existing `ConversationSummary` rows
 * from every project the caller is a member of, newest first).
 *
 * The rows name ids only, so the project and profile *names* come from the
 * two directories this page reads itself — never a fabricated label. The
 * "one-off only" chip filters the loaded page client-side: the endpoint
 * accepts no origin parameter, so the page says what it is rather than
 * pretending to filter the whole list.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useAgentProfiles, useProjects } from "../api/queries";
import type { ConversationSummary } from "../api/types";
import type { components } from "../api/schema";
import NewConversationDialog from "../components/NewConversationDialog";
import { OriginBadge, titleSlug } from "../components/Conversations";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { Button } from "../components/ds/Button";
import { Panel } from "../components/ds/Panel";
import { Row, StatusChip } from "../components/ds/Row";
import { CONVERSATION_STATE, stateOf } from "../components/ds/states";
import { formatAge } from "../lib/format";
import { routes } from "../lib/routes";

type CrossProjectConversations = components["schemas"]["CrossProjectConversationList"];

const PAGE_LIMIT = 50;

/**
 * The cross-project page. Lives here (not in `api/queries.ts`, which other
 * work owns) and reads the C3 envelope verbatim.
 */
function useCrossProjectThreads(cursor: string | null) {
  return useQuery({
    queryKey: ["conversations", "cross-project", cursor],
    queryFn: () =>
      apiFetch<CrossProjectConversations>(
        `/api/v1/conversations?limit=${PAGE_LIMIT}${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`,
      ),
  });
}

/** Who drives the thread, in words (mirrors the project list's rule). */
function controllerName(conversation: ConversationSummary): string {
  if (conversation.control.kind === "none") return "nobody";
  if (conversation.control.kind === "run_attempt") return "a pipeline run";
  return conversation.control.display_name ?? "a member";
}

export default function Threads() {
  const [oneOffOnly, setOneOffOnly] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const list = useCrossProjectThreads(cursor);
  const projects = useProjects();
  const profiles = useAgentProfiles();

  const projectName = (id: string) =>
    projects.data?.items.find((project) => project.id === id)?.name ?? shortProjectId(id);
  const profileName = (id: string) =>
    profiles.data?.items.find((profile) => profile.id === id)?.name ?? shortProfileId(id);

  const rows = (list.data?.items ?? []).filter(
    (conversation) => !oneOffOnly || conversation.origin === "manual",
  );

  return (
    <div className="min-w-0 max-w-[820px] space-y-4">
      <header className="space-y-1">
        <h1 id="threads-heading" className="text-title-l font-bold">
          Threads
        </h1>
        <p className="text-[12.5px] text-muted">
          One-off threads across every project you are a member of — no workflow attached.
        </p>
      </header>
      <Panel
        id="threads"
        title="THREADS"
        headingLevel={2}
        meta={list.data ? `${list.data.items.length} on this page` : undefined}
      >
        <div className="space-y-3 p-[10px]" data-testid="threads-page">
          <div
            role="group"
            aria-label="Thread filters"
            className="flex flex-wrap items-center gap-[5px]"
            data-testid="threads-filters"
          >
            <button
              type="button"
              aria-pressed={oneOffOnly}
              aria-label="show one-off threads only"
              data-testid="threads-one-off-filter"
              onClick={() => setOneOffOnly((current) => !current)}
              className={`rounded-[2px] border px-[7px] py-[2px] font-mono text-[10.5px] ${
                oneOffOnly
                  ? "border-ink bg-ink text-paper"
                  : "border-line-strong bg-surface text-muted hover:text-ink"
              }`}
            >
              one-off only
            </button>
            <span className="font-mono text-[10.5px] text-faint">
              filters this page — the endpoint accepts no origin parameter
            </span>
            <span className="ml-auto">
              <Button
                variant="secondary"
                compact
                data-testid="threads-new-open"
                onClick={() => setDialogOpen(true)}
              >
                New thread
              </Button>
            </span>
          </div>
          {list.isPending ? <Spinner label="Loading threads" /> : null}
          {list.error ? (
            <ProblemBanner
              error={list.error}
              fallback="The cross-project thread list could not be loaded — newer servers carry it; open threads from a project's Threads tab until then."
            />
          ) : null}
          {list.data ? (
            rows.length === 0 ? (
              oneOffOnly && list.data.items.length > 0 ? (
                <p className="text-[12.5px] text-muted" data-testid="threads-nomatch">
                  No one-off threads on this page — run-linked conversations are hidden by the
                  filter.
                </p>
              ) : (
                <p className="text-[12.5px] text-muted" data-testid="threads-list-empty">
                  No threads yet — start one from the New menu or from a project's Threads tab.
                </p>
              )
            ) : (
              <ul className="space-y-[4px]" data-testid="threads-list">
                {rows.map((conversation) => (
                  <li key={conversation.id}>
                    <Row
                      to={routes.thread(conversation.id)}
                      data-testid={`thread-row-${titleSlug(conversation.title, conversation.id)}`}
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
                          {projectName(conversation.project_id)} ·{" "}
                          {profileName(conversation.agent_profile_id)} · controller:{" "}
                          {controllerName(conversation)} · updated{" "}
                          {formatAge(conversation.updated_at)} ago
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
          {list.data && list.data.next_cursor ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                compact
                data-testid="threads-next-page"
                onClick={() => setCursor(list.data?.next_cursor ?? null)}
              >
                Next page
              </Button>
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
        </div>
      </Panel>
      <NewConversationDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

/** A uuid tail for the one line where a directory has not resolved yet. */
function shortProjectId(id: string): string {
  return id.length > 13 ? `…${id.slice(-6)}` : id;
}

function shortProfileId(id: string): string {
  return id.length > 13 ? `…${id.slice(-6)}` : id;
}
