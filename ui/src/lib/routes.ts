/**
 * Canonical path builders for every link in the app (route contract C1).
 *
 * The route table in `App.tsx` is the source of truth for what mounts where;
 * this module is the single place a link's *string* is built, so a later
 * phase can move a route in one file without chasing hard-coded hrefs.
 *
 * Legacy URLs stay alive: `App.tsx` registers every old path as a
 * `<Navigate replace>` redirect that preserves the query string and hash.
 * In particular the ADR-0043 workbench URL state (`?view=…&node=…&instance=…`)
 * is preserved byte-for-byte when `/projects/:p/runs/:r` redirects to
 * `/runs/:r` — the workbench reads the same params on the new path, so an
 * old permalink keeps its view, node, instance, attempt and scopes.
 */

export type ProjectTab = "runs" | "pipelines" | "artifacts" | "conversations" | "settings";

/** The workflow page's header tabs (design 1e): routes, not fragments. */
export type WorkflowTab = "overview" | "yaml" | "used-in" | "history";

function encode(value: string): string {
  return encodeURIComponent(value);
}

/** Append `params` as a query string, leaving an existing one untouched. */
function withParams(path: string, params?: Record<string, string>): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, value);
  }
  const query = search.toString();
  return query === "" ? path : `${path}?${query}`;
}

export const routes = {
  /** `/` — the Home briefing (placeholder until the briefing data lands). */
  home: (): string => "/",
  inbox: (): string => "/inbox",
  board: (): string => "/board",
  threads: (): string => "/threads",
  thread: (id: string): string => `/threads/${encode(id)}`,
  projects: (): string => "/projects",
  project: (id: string): string => `/p/${encode(id)}`,
  /** A project tab: `/p/:projectId/{runs|pipelines|artifacts|conversations|settings}`. */
  projectTab: (id: string, tab: ProjectTab): string => `/p/${encode(id)}/${tab}`,
  /** A repository page: `/p/:projectId/:repo` (the repository's own name). */
  repository: (projectId: string, repo: string): string =>
    `/p/${encode(projectId)}/${encode(repo)}`,
  workflows: (): string => "/workflows",
  workflow: (id: string): string => `/workflows/${encode(id)}`,
  /** A workflow-page tab: `overview` is the page itself (`/workflows/:id`),
   * the rest are their own routes (`/workflows/:id/yaml` …). */
  workflowTab: (id: string, tab: WorkflowTab): string =>
    tab === "overview" ? `/workflows/${encode(id)}` : `/workflows/${encode(id)}/${tab}`,
  draft: (pipelineId: string, draftId: string): string =>
    `/workflows/${encode(pipelineId)}/drafts/${encode(draftId)}`,
  steps: (): string => "/steps",
  step: (id: string): string => `/steps/${encode(id)}`,
  profiles: (): string => "/profiles",
  profile: (id: string): string => `/profiles/${encode(id)}`,
  /**
   * `/runs/:runId` — the project-less workbench deep link. `params` carries
   * the ADR-0043 URL state (`view`, `node`, `instance`, `attempt`, `scopes`)
   * and is preserved unchanged when legacy URLs redirect here.
   */
  run: (id: string, params?: Record<string, string>): string =>
    withParams(`/runs/${encode(id)}`, params),
  /**
   * `/ops` — the legacy Operations URL. It now redirects to the real Settings
   * tab (`/settings/operations`); the builder returns the canonical path.
   */
  ops: (): string => "/settings/operations",
  /** User settings: `/settings/:tab` (`layout`, `assistant`, `operations`);
      `/settings` → `layout`. */
  settings: (tab?: string): string => (tab ? `/settings/${encode(tab)}` : "/settings/layout"),
  /** `/approvals/:approvalId` — the 4g approval detail page (ADR-0052). */
  approval: (id: string): string => `/approvals/${encode(id)}`,
};
