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

/** The one host the server's GitHub adapter speaks to — a GitHub Enterprise
 * host is a different deployment and answers `422 not_a_github_repository`
 * (internal/integrations/github/repo.go), so the UI must not ask either. */
const GITHUB_HOST = "github.com";

/** One `owner`/`repo` path segment, same shape the server accepts. */
const repoSegment = /^[A-Za-z0-9._-]{1,100}$/;

/** Reduce a git remote to `[host, path]`, mirroring the server's
 * `splitGitRemote`: an `ssh://`/`https://`/`http://`/`git://` URL, or
 * scp-style `[user@]host:path`. Any other scheme (`file://`, …) or a bare
 * path is not a host-and-path remote. */
function remoteHostAndPath(gitUrl: string): [string, string] | null {
  const s = gitUrl.trim();
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (scheme) {
    if (!["ssh", "https", "http", "git"].includes(scheme[1].toLowerCase())) return null;
    try {
      const url = new URL(s);
      if (!url.hostname) return null;
      return [url.hostname, url.pathname];
    } catch {
      return null;
    }
  }
  const colon = s.indexOf(":");
  if (colon <= 0) return null;
  let head = s.slice(0, colon);
  const tail = s.slice(colon + 1);
  const at = head.lastIndexOf("@");
  if (at >= 0) head = head.slice(at + 1);
  if (!head || !tail || /[\\/]/.test(head)) return null;
  return [head, `/${tail}`];
}

/**
 * Whether a repository `git_url` names a GitHub.com remote the issues route
 * can answer for — the client-side mirror of `github.ParseRepository`:
 * host must be `github.com` (Enterprise hosts are deliberately excluded) and
 * the path exactly `owner/repo` (`.git` and trailing slashes trimmed). A
 * `file://` path, a GitLab URL or a GitHub *web page* URL (`/o/r/issues`)
 * is false, so the UI skips the request that would only ever return `422
 * not_a_github_repository`.
 */
export function isGitHubRepository(gitUrl: string): boolean {
  const hostAndPath = remoteHostAndPath(gitUrl);
  if (!hostAndPath) return false;
  const [host, path] = hostAndPath;
  if (host.toLowerCase() !== GITHUB_HOST) return false;
  const trimmedPath = path.replace(/^\/+/, "").replace(/\/+$/, "");
  const noSuffix = trimmedPath.endsWith(".git")
    ? trimmedPath.slice(0, -".git".length)
    : trimmedPath;
  const [owner, repo, ...extra] = noSuffix.split("/").filter((part) => part.length > 0);
  if (!owner || !repo || extra.length > 0) return false;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return false;
  return repoSegment.test(owner) && repoSegment.test(repo);
}

/** `["project", id, "repos", repoId, "issues", label]` — label is part of the
 * key because it changes what upstream answers. */
export function repoIssuesKey(projectId: string, repositoryId: string, label: string) {
  return ["project", projectId, "repos", repositoryId, "issues", label] as const;
}

/**
 * `GET /api/v1/projects/{projectId}/repos/{repositoryId}/issues?state=open`.
 * Enabled only once a repository is chosen *and* the caller has confirmed the
 * remote is GitHub-hosted (`isGitHubRepository`) — asking the server and
 * eating its `422` is how the repo page used to light up the console for
 * every local/file remote; the caller now knows from the `git_url` it already
 * has. The label filter is applied by the caller (an explicit click), never
 * per keystroke, because the anonymous GitHub budget is 60 requests per
 * replica IP.
 */
export function useRepoIssues(projectId: string, repositoryId: string, label = "", enabled = true) {
  const trimmed = label.trim();
  const suffix = trimmed ? `&label=${encodeURIComponent(trimmed)}` : "";
  return useQuery({
    queryKey: repoIssuesKey(projectId, repositoryId, trimmed),
    queryFn: () =>
      apiFetch<GitHubIssueList>(
        `/api/v1/projects/${projectId}/repos/${repositoryId}/issues?state=open${suffix}`,
      ),
    enabled: enabled && projectId.length > 0 && repositoryId.length > 0,
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
