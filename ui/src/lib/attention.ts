/**
 * "What still asks something of someone", computed once from the wires the
 * control plane actually serves.
 *
 * `/inbox` aggregates it across every project the caller belongs to; a project
 * overview reads the same shape for one project. Both must agree — a stalled
 * run listed as attention on one screen and as "fine" on the other is the same
 * fact stated twice differently — so the reduction lives here rather than in a
 * page.
 *
 * Honesty rules are the run pages': the wire carries no run *name* and no
 * approval *title*, so a row's raw `summary`/`node_instance_key`/`status` are
 * all this returns, and no "needs you" signal is composed. A conversation only
 * gets a pending-permission count when `getConversation` actually reported one,
 * which is why the prompt read is a second fan-out narrowed to
 * `has_active_turn === true`.
 */
import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { apiFetch, problemOf } from "../api/client";
import { queryKeys } from "../api/queries";
import type {
  Approval,
  ApprovalList,
  Conversation,
  ConversationStatus,
  ConversationSummary,
  ConversationSummaryList,
  Project,
  RunSummary,
  RunSummaryList,
} from "../api/types";

type RunStatus = RunSummary["status"];

export const ACTIVE_STATES: readonly RunStatus[] = ["queued", "preparing", "running"];
export const STALLED_STATES: readonly RunStatus[] = ["failed", "paused"];

/**
 * The conversation statuses that still ask something of someone: `active` has
 * an agent session attached, `disconnected` lost one with a turn still open.
 * `idle` is dormant history (nothing attached, nothing open) and `archived` is
 * terminal, so neither is listed.
 */
export const LIVE_CONVERSATION_STATES: readonly ConversationStatus[] = ["active", "disconnected"];

export interface DecisionItem {
  project: Project;
  approval: Approval;
}

export interface RunItem {
  project: Project;
  run: RunSummary;
}

export interface ConversationItem {
  project: Project;
  conversation: ConversationSummary;
  /** Pending ACP prompts read from `getConversation`; 0 when never fetched. */
  pendingPermissions: number;
}

export interface UnreadProject {
  project: Project;
  title: string;
}

export interface Attention {
  decisions: DecisionItem[];
  stalled: RunItem[];
  conversations: ConversationItem[];
  running: RunItem[];
  unread: UnreadProject[];
  /** At least one of the reads is still in flight (with projects to read). */
  pending: boolean;
}

/** Stable empty list so a caller may pass `undefined` without a new identity. */
const NO_PROJECTS: readonly Project[] = [];

/**
 * The per-project reads the attention lists aggregate. `useQueries` over the
 * caller's dynamic project list rather than a child component per project: the
 * sections are cross-project (a row from one project sorts against a row from
 * another), so the data has to arrive in one place anyway.
 *
 * Conversations are a three-level read — project list, project conversations,
 * then the detail of only those reporting `has_active_turn` — because the list
 * row carries no pending-prompt field and inventing one is not on the table.
 */
export function useProjectAttention(projects: readonly Project[]): Attention {
  const empty = projects.length === 0;
  const gateResults = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.approvals(project.id),
      queryFn: () => apiFetch<ApprovalList>(`/api/v1/projects/${project.id}/approvals`),
    })),
  });
  const runResults = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.runs(project.id),
      queryFn: () => apiFetch<RunSummaryList>(`/api/v1/projects/${project.id}/runs`),
    })),
  });
  const conversationResults = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.conversations(project.id),
      queryFn: () =>
        apiFetch<ConversationSummaryList>(`/api/v1/projects/${project.id}/conversations`),
    })),
  });

  const live = useMemo(
    () => liveConversations(projects, conversationResults),
    [projects, conversationResults],
  );
  /**
   * The prompt check is a second read, so it is narrowed to what could possibly
   * hold one: `permission_requests` hang off a turn, and `has_active_turn` is
   * the list row's own statement that a turn is open. Anything else is listed
   * by status alone rather than guessed at.
   */
  const prompting = useMemo(
    () => live.filter((item) => item.conversation.has_active_turn === true),
    [live],
  );
  const detailResults = useQueries({
    queries: prompting.map(({ conversation }) => ({
      queryKey: queryKeys.conversation(conversation.id),
      queryFn: () => apiFetch<Conversation>(`/api/v1/conversations/${conversation.id}`),
    })),
  });

  return useMemo(() => {
    const decisions: DecisionItem[] = [];
    const stalled: RunItem[] = [];
    const running: RunItem[] = [];
    const unread: UnreadProject[] = [];

    projects.forEach((project, index) => {
      const gates = gateResults[index];
      const runs = runResults[index];
      const convoList = conversationResults[index];
      /** A `waiting_human` run whose gate is still open is a decision, not a
       * stall — the same fact must not be listed twice under two headings. */
      const pendingGates = new Set<string>();

      if (gates?.data) {
        for (const approval of gates.data.approvals) {
          if (approval.state !== "pending") continue;
          pendingGates.add(approval.run_id);
          decisions.push({ project, approval });
        }
      } else if (gates?.isError) {
        unread.push({ project, title: problemOf(gates.error).title });
      }

      if (runs?.data) {
        for (const run of runs.data.runs) {
          if (run.depth !== 0) continue; // children belong to their parent's tree
          if (ACTIVE_STATES.includes(run.status)) running.push({ project, run });
          else if (STALLED_STATES.includes(run.status)) stalled.push({ project, run });
          else if (run.status === "waiting_human" && !pendingGates.has(run.id)) {
            stalled.push({ project, run });
          }
        }
      } else if (runs?.isError) {
        unread.push({ project, title: problemOf(runs.error).title });
      }

      if (convoList?.isError) {
        unread.push({ project, title: problemOf(convoList.error).title });
      }
    });

    /**
     * Prompt order comes from the `prompting` fan-out, which is `live` filtered
     * in the same order, so index `n` answers `prompting[n]`.
     */
    const pendingById = new Map<string, number>();
    prompting.forEach(({ conversation }, index) => {
      const detail = detailResults[index];
      const pending =
        detail?.data?.pending_permissions?.filter((request) => request.status === "pending")
          .length ?? 0;
      if (pending > 0) pendingById.set(conversation.id, pending);
    });

    const conversations: ConversationItem[] = live.map((item) => ({
      ...item,
      pendingPermissions: pendingById.get(item.conversation.id) ?? 0,
    }));

    const byAge = (a: RunItem, b: RunItem) => b.run.created_at.localeCompare(a.run.created_at);
    stalled.sort(byAge);
    running.sort(byAge);
    // Oldest gate first: the one closest to its deadline is the one still open.
    decisions.sort((a, b) => a.approval.created_at.localeCompare(b.approval.created_at));
    // A prompt waiting on the controller leads; the rest is most-recent-first.
    conversations.sort((a, b) => {
      const aPending = a.pendingPermissions > 0 ? 0 : 1;
      const bPending = b.pendingPermissions > 0 ? 0 : 1;
      return (
        aPending - bPending || b.conversation.updated_at.localeCompare(a.conversation.updated_at)
      );
    });
    const reading = [...gateResults, ...runResults, ...conversationResults];
    return {
      decisions,
      stalled,
      conversations,
      running,
      unread,
      pending: !empty && reading.some((result) => result.isPending),
    };
  }, [projects, empty, gateResults, runResults, live, prompting, detailResults]);
}

/**
 * Every live conversation across the caller's projects, in read order, with the
 * count fields the section needs filled in later by the prompt fan-out.
 */
function liveConversations(
  projects: readonly Project[],
  results: readonly { data?: ConversationSummaryList; isError: boolean }[],
): ConversationItem[] {
  const items: ConversationItem[] = [];
  projects.forEach((project, index) => {
    const list = results[index]?.data;
    if (!list) return;
    for (const conversation of list.items) {
      if (LIVE_CONVERSATION_STATES.includes(conversation.status)) {
        items.push({ project, conversation, pendingPermissions: 0 });
      }
    }
  });
  return items;
}

/**
 * Attention for a single project — the same read, one element wide. Passing a
 * `null` project (still loading) asks for nothing rather than fetching a blank
 * id.
 */
export function useAttentionForProject(project: Project | null | undefined): Attention {
  const projects = useMemo(() => (project ? [project] : NO_PROJECTS), [project]);
  return useProjectAttention(projects);
}
