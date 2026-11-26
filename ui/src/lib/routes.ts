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

export type ProjectTab = "runs" | "workflows" | "artifacts" | "threads" | "settings";

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

/** Manage's left sub-nav, in order (handoff README §7). */
export const MANAGE_SECTIONS = [
  "projects",
  "repositories",
  "people",
  "runners",
  "agents",
  "secrets",
] as const;
export type ManageSection = (typeof MANAGE_SECTIONS)[number];

/** The three daily places in the top bar's pill, plus Manage. */
export type Section = "home" | "chats" | "factory" | "manage";

export const routes = {
  /**
   * Redesign routes (docs/design/redesign/CONTRACT.md). The selected project
   * ("scope") is a URL prefix: `/p/:projectId/...`; "All projects" has none.
   * Pass `scope` = a project id, or null/undefined for All.
   */
  scopeHome: (scope?: string | null): string => (scope ? `/p/${encode(scope)}` : "/"),
  chats: (scope?: string | null): string => `${scope ? `/p/${encode(scope)}` : ""}/chats`,
  /** `new` is the New chat pane. */
  chat: (id: string, scope?: string | null): string =>
    `${scope ? `/p/${encode(scope)}` : ""}/chats/${encode(id)}`,
  factory: (scope?: string | null): string => `${scope ? `/p/${encode(scope)}` : ""}/factory`,
  /** The workflow editor. `params` may carry `draft`, `panel` (`yaml` |
   * `used-in` | `versions`) and `run` (show a run's live state on the canvas). */
  factoryWorkflow: (
    pipelineId: string,
    scope?: string | null,
    params?: Record<string, string>,
  ): string =>
    withParams(`${scope ? `/p/${encode(scope)}` : ""}/factory/${encode(pipelineId)}`, params),
  /** Manage is global (never scoped): `/manage/:section[/:itemId]`. */
  manage: (section: ManageSection = "projects", itemId?: string): string =>
    itemId ? `/manage/${section}/${encode(itemId)}` : `/manage/${section}`,
  /** `/` — the Home briefing (placeholder until the briefing data lands). */
  home: (): string => "/",
  /** Legacy addresses (finding 03): `/inbox` and `/board` are no longer
   * mounted pages — `App.tsx` redirects both to `/` the way `/ops` redirects
   * to Settings. No surface links them any more (the interrupted-run callout
   * and the approval 404 page both send the reader to Today); the builders
   * stay because they are the addresses the redirect answers. */
  inbox: (): string => "/inbox",
  board: (): string => "/board",
  threads: (): string => "/chats",
  thread: (id: string): string => `/chats/${encode(id)}`,
  projects: (): string => "/manage/projects",
  project: (id: string): string => `/p/${encode(id)}`,
  /** A project tab: `/p/:projectId/{runs|workflows|artifacts|threads|settings}`
   * (finding 02: the tab is `workflows`; the old `pipelines` segment redirects). */
  projectTab: (id: string, tab: ProjectTab): string => {
    if (tab === "threads") return `/p/${encode(id)}/chats`;
    if (tab === "runs" || tab === "workflows") return `/p/${encode(id)}/factory`;
    if (tab === "settings") return `/manage/projects/${encode(id)}`;
    return `/p/${encode(id)}/${tab}`;
  },
  /** A project's members page: `/p/:projectId/members` — who to ask for access. */
  projectMembers: (id: string): string => `/manage/people?project=${encode(id)}`,
  /** A thread inside a project's URL space: `/p/:projectId/threads/:threadId`
   * (finding 01 renamed the segment; the resource is still a conversation). */
  projectThread: (projectId: string, threadId: string): string =>
    `/p/${encode(projectId)}/chats/${encode(threadId)}`,
  /** A repository page: `/p/:projectId/:repo` (the repository's own name). */
  repository: (projectId: string, repo: string): string =>
    `/p/${encode(projectId)}/${encode(repo)}`,
  workflows: (): string => "/factory",
  workflow: (id: string): string => `/factory/${encode(id)}`,
  /** A workflow-page tab: `overview` is the page itself (`/workflows/:id`),
   * the rest are their own routes (`/workflows/:id/yaml` …). */
  workflowTab: (id: string, tab: WorkflowTab): string =>
    tab === "overview"
      ? `/factory/${encode(id)}`
      : `/factory/${encode(id)}?panel=${tab === "history" ? "versions" : tab}`,
  draft: (pipelineId: string, draftId: string): string =>
    `/factory/${encode(pipelineId)}?draft=${encode(draftId)}`,
  /** Steps lives under Workflows now (finding 02): `/workflows/steps` is a
   * tab of the Workflows page; the old `/steps` paths redirect. */
  steps: (): string => "/manage/agents?tab=steps",
  step: (id: string): string => `/manage/agents?tab=steps&item=${encode(id)}`,
  /** Skill collections: a tab of Manage → Agents & models. */
  collections: (): string => "/manage/agents?tab=skills",
  collection: (id: string): string => `/manage/agents?tab=skills&item=${encode(id)}`,
  profiles: (): string => "/manage/agents",
  profile: (id: string): string => `/manage/agents/${encode(id)}`,
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
  ops: (): string => "/manage/runners",
  /** User settings: `/settings/:tab` (`layout`, `assistant`, `accounts`,
      `operations`); `/settings` → `layout`. `accounts` is the ADR-0085 agent
      sign-in tab — an organization admin's, so the nav hides it for everyone
      else while the URL still resolves to the body's own refusal. */
  settings: (tab?: string): string => {
    if (tab === "operations") return "/manage/runners";
    if (tab === "assistant") return "/manage/agents?tab=assistant";
    return "/manage/agents";
  },
  /**
   * `/profile` — the signed-in PERSON's own page (their name, picture and
   * organization, all read-only because the identity provider owns them). It
   * is deliberately singular and separate from `profiles()`/`profile(id)`
   * above, which are the AGENT profile library.
   */
  account: (): string => "/profile",
  /** `/approvals/:approvalId` — the 4g approval detail page (ADR-0052). */
  approval: (id: string): string => `/approvals/${encode(id)}`,
};
