/**
 * ADR-0056 part 2 — the issue-trigger surface (backend committed in c5ef3d7):
 * "when an open GitHub issue in this repository for this assignment shows up,
 * start it". The CRUD half rides the same project-scoped reads the schedules
 * fan shares, so the one `invalidateProject` the SSE feeds make covers the
 * poll bookkeeping (`cursor_at` / `last_polled_at` / `last_error`) too.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type { components } from "./schema";

export type IssueTrigger = components["schemas"]["IssueTrigger"];
export type IssueTriggerList = components["schemas"]["IssueTriggerList"];
export type IssueTriggerCreate = components["schemas"]["IssueTriggerCreate"];
export type IssueTriggerPatch = components["schemas"]["IssueTriggerPatch"];

/** `["project", id, "issue-triggers"]` — the same prefix discipline as
 * `queryKeys.assignments` / `schedulesKey`, spelled inline because this module
 * is the issue-trigger surface's own and stays out of the shared key map. */
function issueTriggersKey(projectId: string) {
  return ["project", projectId, "issue-triggers"] as const;
}

/** Query options for `GET /api/v1/projects/{projectId}/issue-triggers` — the
 * same key `useIssueTriggers` reads, so the workflows page and the project
 * page's own fan share one cache entry. */
export function issueTriggersQueryOptions(projectId: string, enabled = true) {
  return {
    queryKey: issueTriggersKey(projectId),
    queryFn: () => apiFetch<IssueTriggerList>(`/api/v1/projects/${projectId}/issue-triggers`),
    enabled: enabled && projectId.length > 0,
  } as const;
}

/** `GET /api/v1/projects/{projectId}/issue-triggers` — Viewer+. One read per
 * project the caller maintains; the rows are grouped by assignment client-side
 * (a workflow pins one assignment per project). */
export function useIssueTriggers(projectId: string) {
  return useQuery(issueTriggersQueryOptions(projectId));
}

/** `POST /api/v1/projects/{projectId}/issue-triggers` — Maintainer+. The
 * server answers `422 not_a_github_repository` / `422 not_fireable` /
 * `400 invalid_labels` as the mutation's error, which the dialog renders inline
 * rather than dressing up as a saved state. */
export function useCreateIssueTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: IssueTriggerCreate) =>
      apiFetch<IssueTrigger>(`/api/v1/projects/${projectId}/issue-triggers`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: issueTriggersKey(projectId) });
    },
  });
}

/**
 * `PATCH /api/v1/issue-triggers/{issueTriggerId}` — Maintainer+, optimistic on
 * `version` (the value the caller read): a stale-version 409 surfaces as the
 * mutation's error and the screen re-reads via invalidation.
 */
export function usePatchIssueTrigger(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ issueTriggerId, body }: { issueTriggerId: string; body: IssueTriggerPatch }) =>
      apiFetch<IssueTrigger>(`/api/v1/issue-triggers/${issueTriggerId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: issueTriggersKey(projectId) });
    },
  });
}
