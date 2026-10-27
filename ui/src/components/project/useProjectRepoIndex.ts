/**
 * The project's workspaces, indexed by the thing that owns them.
 *
 * `GET /projects/{id}/workspaces` is the only read that connects a run or a
 * thread to a *repository*: `RunSummary` and `ConversationSummary` carry no
 * repository member (the handoff's repository-page note says the same — “Runs
 * that record their repo” is listed as needed backend). The workspace row does
 * carry `run_id` / `conversation_id` and the checkouts it holds, so a glance
 * screen can say which repository a run is working in *when a workspace exists
 * to say so* — and must say nothing when it does not (the list is live +
 * recent: a finished run's workspace may be released, and a queued run has no
 * checkout yet).
 *
 * `live` is the state the wire reports (`preparing` / `ready`), never a guess
 * from timestamps. `released` and `lost` scopes are history and are counted as
 * such: they do not make a repository look busy.
 */
import { useMemo } from "react";
import { useWorkspaces } from "../../api/queries";

const LIVE_STATES: readonly string[] = ["preparing", "ready"];

export interface ProjectRepoIndex {
  /** The repositories one run is working in, or `null` when no live-or-recent
   * workspace names this run. */
  reposForRun: (runId: string) => string[] | null;
  /** The repositories one thread is working in, same rule. */
  reposForThread: (conversationId: string) => string[] | null;
  /** Repository id → the workspaces of that repository still live. */
  liveCountByRepository: ReadonlyMap<string, number>;
  /** `true` while the read has not answered: a caller must not print a count
   * it does not have. */
  pending: boolean;
}

export function useProjectRepoIndex(projectId: string): ProjectRepoIndex {
  const workspaces = useWorkspaces(projectId);
  const items = workspaces.data?.workspaces;

  return useMemo(() => {
    const byRun = new Map<string, string[]>();
    const byThread = new Map<string, string[]>();
    const live = new Map<string, number>();
    for (const workspace of items ?? []) {
      const names = workspace.repos.map((repo) => repo.name);
      if (workspace.run_id) byRun.set(workspace.run_id, names);
      if (workspace.conversation_id) byThread.set(workspace.conversation_id, names);
      if (!LIVE_STATES.includes(workspace.state)) continue;
      for (const repo of workspace.repos) {
        live.set(repo.repository_id, (live.get(repo.repository_id) ?? 0) + 1);
      }
    }
    return {
      reposForRun: (runId: string) => byRun.get(runId) ?? null,
      reposForThread: (conversationId: string) => byThread.get(conversationId) ?? null,
      liveCountByRepository: live,
      pending: workspaces.isPending,
    };
  }, [items, workspaces.isPending]);
}

/** The design's `storefront` segment: the repositories, joined by `+` when a
 * scope really does hold more than one, or `null` when nothing says. */
export function repoSegment(names: string[] | null): string | null {
  if (!names || names.length === 0) return null;
  return names.join(" + ");
}
