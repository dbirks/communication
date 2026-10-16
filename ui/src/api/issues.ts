/**
 * Read-only GitHub issue listing for the New run form (ADR-0031, wishlist W3's
 * read half): "what is in the tracker right now" for a repository the caller
 * can already see. Live proxy, never a mirror — nothing here caches past a
 * request, and the response is `no-store` upstream.
 *
 * Key rule: the cache key sits under `["project", projectId]` so the one
 * `invalidateProject` the SSE feeds make covers it (the issue list is
 * GitHub-owned, but a stale list is still a stale read).
 */
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";

export type GitHubIssue = components["schemas"]["GitHubIssue"];
export type GitHubIssueList = components["schemas"]["GitHubIssueList"];

/** The stable code a non-GitHub `git_url` answers with (ADR-0031). */
export const NOT_A_GITHUB_REPOSITORY = "not_a_github_repository";

/** `["project", id, "repos", repoId, "issues", label]` — label is part of the
 * key because it changes what upstream answers. */
export function repoIssuesKey(projectId: string, repositoryId: string, label: string) {
  return ["project", projectId, "repos", repositoryId, "issues", label] as const;
}

/**
 * `GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues?state=open`.
 * Enabled only once a repository is chosen; the label filter is applied by the
 * caller (an explicit click), never per keystroke, because the anonymous
 * GitHub budget is 60 requests per replica IP.
 */
export function useRepoIssues(projectId: string, repositoryId: string, label = "") {
  const trimmed = label.trim();
  const suffix = trimmed ? `&label=${encodeURIComponent(trimmed)}` : "";
  return useQuery({
    queryKey: repoIssuesKey(projectId, repositoryId, trimmed),
    queryFn: () =>
      apiFetch<GitHubIssueList>(
        `/api/v1/projects/${projectId}/repos/${repositoryId}/issues?state=open${suffix}`,
      ),
    enabled: projectId.length > 0 && repositoryId.length > 0,
    staleTime: 30_000,
    // A spent budget or a private repo is not retried into a second refusal;
    // the UI shows the upstream's own words instead.
    retry: false,
  });
}

/** The typed `422 not_a_github_repository` (body `code`, or the `type` URI). */
export function isNotGitHubRepository(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422) return false;
  const body = error.body as { code?: unknown } | null;
  if (body && typeof body === "object" && typeof body.code === "string") {
    return body.code === NOT_A_GITHUB_REPOSITORY;
  }
  return error.type.endsWith(`/${NOT_A_GITHUB_REPOSITORY}`);
}
