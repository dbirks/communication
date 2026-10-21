// Shared helpers for the app-shell + IA redesign acceptance suites (phases 1–6,
// shell-p1…shell-p6).
//
// Gate: COMMUNICATION_E2E_SHELL=1 — every suite skips everywhere else, the same
// env-gate idiom as the issue2 suites. Every journey step in those suites calls
// `evidence()` (full-page screenshot to ${E2E_EVIDENCE_DIR}/<name>.png plus one
// `EVIDENCE <name>: <what it proves>` line), and every page runs
// `checkShellScreen()` (axe — fail on serious/critical via tests/a11y.ts — plus
// no sideways document scroll plus no uncaught page errors).
//
// API reads use the signed-in browser session: the `request` fixture shares the
// page's storage state (the same pattern `repinAssignment` in helpers.ts uses),
// so a journey's counts are compared against the exact data the page reads.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { BASE_URL } from "./env.js";
import { checkA11y } from "./a11y.js";
import { signIn } from "./helpers.js";

/** The shared gate: suites only run against the app-shell lab. */
export const SHELL_ENABLED = process.env.COMMUNICATION_E2E_SHELL === "1";
export const SHELL_GATE =
  "requires the app-shell lab (COMMUNICATION_E2E_SHELL=1, E2E_BASE_URL=http://localhost:15173)";

const EVIDENCE_DIR = process.env.E2E_EVIDENCE_DIR ?? "test-results/shell";

/** One piece of journey evidence: a screenshot plus a single log line. */
export async function evidence(page: Page, name: string, what: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`), fullPage: true });
  console.log(`EVIDENCE ${name}: ${what}`);
}

/** The design rule "no sideways scroll" as a page assertion. */
export async function noSidewaysScroll(page: Page): Promise<void> {
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, `the document scrolls sideways on ${page.url()}`).toBe(true);
}

/**
 * Record uncaught exceptions on the page; the returned function asserts none
 * (a PAGEERROR in a journey is a hard failure). Call the guard right after
 * navigation, keep it, and assert at the journey's end.
 */
export function watchPageErrors(page: Page): () => void {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return () => {
    expect(errors, `pageerror(s) on ${page.url()}: ${errors.join(" | ")}`).toEqual([]);
  };
}

/** Every page in every phase: axe clean, no sideways scroll, no PAGEERROR. */
export async function checkShellScreen(
  page: Page,
  name: string,
  assertNoErrors?: () => void,
): Promise<void> {
  await checkA11y(page, name);
  await noSidewaysScroll(page);
  assertNoErrors?.();
}

/**
 * Sign in at the 390px viewport. The shared `signIn` waits for `user-badge`,
 * but at phone width the sidebar (and its footer badge) hides behind the
 * drawer's menu button — so open the drawer and read the footer's `sign-out`
 * instead (the issue2 suite's same trick).
 */
export async function signInNarrow(page: Page, subject: string): Promise<void> {
  await page.goto(BASE_URL + "/");
  await page.getByTestId("sign-in").click();
  await page.getByPlaceholder("Enter any user/subject").fill(subject);
  await page.getByRole("button", { name: "Sign-in" }).click();
  // The IdP redirect chain lands on the API's own origin (the embedded dist);
  // come back to the dev origin the journey runs against before asserting.
  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  // Two `sidebar`/`sign-out` elements exist in the DOM at phone width (the
  // display:none desktop column plus the drawer); the drawer is last.
  await page.getByTestId("sidebar-open").click();
  await expect(page.getByTestId("sidebar").last()).toBeVisible();
  await expect(page.getByTestId("sign-out").last()).toBeVisible();
}

/** Sign in at 390px WITHOUT leaving the drawer open. */
export async function signInNarrowClosed(page: Page, subject: string): Promise<void> {
  await signInNarrow(page, subject);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sidebar").last()).toBeHidden();
}

/* ---------------------------------------------------------------- API reads. */

interface Paged<T> {
  runs?: T[];
  approvals?: T[];
  items?: T[];
  pipelines?: T[];
  templates?: T[];
  launchers?: T[];
  next_cursor?: string | null;
}

/** A signed-in GET; cursor-paginated, bounded so a bad cursor can't hang it. */
async function apiAll<T>(request: APIRequestContext, start: string): Promise<T[]> {
  const rows: T[] = [];
  let url = start;
  for (let page = 0; page < 50; page += 1) {
    const res = await request.get(BASE_URL + url);
    if (!res.ok()) throw new Error(`GET ${url} -> ${res.status()}`);
    const body = (await res.json()) as Paged<T>;
    const list =
      body.runs ??
      body.approvals ??
      body.items ??
      body.pipelines ??
      body.templates ??
      body.launchers;
    if (list) rows.push(...(list as T[]));
    const cursor = body.next_cursor;
    if (!cursor) return rows;
    url = `${start}${start.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
  }
  throw new Error(`cursor pagination did not end for ${start}`);
}

export interface RunRow {
  id: string;
  status: string;
  project_id: string;
  project_name?: string;
  pipeline_slug?: string;
  steps?: { node_id: string; kind: string; state: string }[];
}
export const apiRuns = (request: APIRequestContext) =>
  apiAll<RunRow>(request, "/api/v1/runs?limit=100");

export interface ApprovalRow {
  id: string;
  state?: string;
  status?: string;
  kind?: string;
  run_id?: string;
  project_id?: string;
}
export const apiPendingApprovals = (request: APIRequestContext) =>
  apiAll<ApprovalRow>(request, "/api/v1/approvals?status=pending");

export interface ConversationRow {
  id: string;
  title: string;
  project_id: string;
  origin?: string;
}
export const apiConversations = (request: APIRequestContext) =>
  apiAll<ConversationRow>(request, "/api/v1/conversations?limit=100");

export interface PipelineRow {
  id: string;
  slug: string;
  display_name?: string;
  latest_revision_number: number;
  revision_count: number;
}
export const apiPipelines = (request: APIRequestContext) =>
  apiAll<PipelineRow>(request, "/api/v1/pipelines");

export interface PipelineRevisionRow {
  revision_number: number;
  revision_digest: string;
}

/** The pipeline's newest revision summary (the list is newest first). */
export async function apiPipelineRevisions(
  request: APIRequestContext,
  pipelineId: string,
): Promise<PipelineRevisionRow[]> {
  const res = await request.get(`${BASE_URL}/api/v1/pipelines/${pipelineId}/revisions?limit=1`);
  if (!res.ok()) throw new Error(`GET /pipelines/${pipelineId}/revisions -> ${res.status()}`);
  const body = (await res.json()) as { revisions: PipelineRevisionRow[] };
  return body.revisions;
}

export interface ProjectRow {
  id: string;
  slug: string;
  name: string;
}
export const apiProjects = (request: APIRequestContext) =>
  apiAll<ProjectRow>(request, "/api/v1/projects");

export interface ProfileRow {
  id: string;
  name: string;
  launcher_id: string;
}
export const apiAgentProfiles = (request: APIRequestContext) =>
  apiAll<ProfileRow>(request, "/api/v1/agent-profiles");

export interface LauncherCapability {
  capability: string;
  result: string;
  observed_at: string | null;
  evidence: string | null;
}
export interface LauncherRow {
  id: string;
  display_name: string;
  registered: boolean;
  workers_online: number;
  capabilities: LauncherCapability[];
}
export const apiLaunchers = (request: APIRequestContext) =>
  apiAll<LauncherRow>(request, "/api/v1/launchers");

export interface PreferencesDoc {
  layout: {
    projects_mode: "tree" | "switcher";
    ask_placement: "sidebar" | "floating";
    show_workflow_folders: boolean;
    expanded: Record<string, boolean>;
  };
  updated_at: string | null;
}
export async function apiPreferences(request: APIRequestContext): Promise<PreferencesDoc> {
  const res = await request.get(BASE_URL + "/api/v1/me/preferences");
  if (!res.ok()) throw new Error(`GET /me/preferences -> ${res.status()}`);
  return (await res.json()) as PreferencesDoc;
}

/* ------------------------------------------------ setup writes through the
   API (allowed: the journey of every test still goes through the UI). A fresh
   lab seeds two gate-waiting runs only — no live agent step, no saved steps
   and no threads — so the journeys' surfaces are prepared here. */

export interface Csrf {
  token: string;
  origin: string;
}

/** The signed-in session's CSRF token (mutations 403 without it). */
export async function apiCsrf(request: APIRequestContext): Promise<Csrf> {
  const res = await request.get(BASE_URL + "/api/v1/me");
  if (!res.ok()) throw new Error(`GET /me -> ${res.status()}`);
  const body = (await res.json()) as { csrf_token: string };
  return { token: body.csrf_token, origin: BASE_URL };
}

async function apiPostJson<T>(
  request: APIRequestContext,
  csrf: Csrf,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await request.post(BASE_URL + path, {
    data: body,
    headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
  });
  const text = await res.text().catch(() => "?");
  if (res.status() < 200 || res.status() >= 300) {
    throw new Error(`POST ${path} -> ${res.status()}: ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as T) ?? ({} as T);
}

/** A profile name the sandbox may run a long foreground wait with: the m4
 * seed's preapproved m4-reviewer first, then any preapproved profile, then
 * the first profile at all. */
export async function apiProfileForAgentRun(request: APIRequestContext): Promise<ProfileRow> {
  const profiles = await apiAgentProfiles(request);
  if (profiles.length === 0) throw new Error("the lab holds no agent profile");
  const detail = (await (await request.get(`${BASE_URL}/api/v1/agent-profiles`)).json()) as {
    items?: (ProfileRow & { permission_mode?: string })[];
  };
  const rows = detail.items ?? [];
  return (
    rows.find((row) => row.name === "m4-reviewer") ??
    rows.find((row) => row.permission_mode === "preapproved_within_sandbox") ??
    rows[0]
  );
}

/** The first project that carries a repository (a worktree workspace needs one). */
export async function apiProjectWithRepo(request: APIRequestContext): Promise<ProjectRow> {
  const projects = await apiProjects(request);
  for (const project of projects) {
    const res = await request.get(`${BASE_URL}/api/v1/projects/${project.id}/repos?limit=50`);
    if (!res.ok()) continue;
    const body = (await res.json()) as { items?: unknown[] };
    if ((body.items ?? []).length > 0) return project;
  }
  throw new Error("no project with a repository found for the scratch run");
}

/** Create → draft → validate → publish, all through the API the UI uses.
 * Returns the ids the journey needs (the published revision to pin a run on). */
export async function apiPublishPipeline(
  request: APIRequestContext,
  csrf: Csrf,
  slug: string,
  yaml: string,
): Promise<{ pipelineId: string; draftId: string; revisionId: string }> {
  const pipeline = await apiPostJson<{ id: string }>(request, csrf, "/api/v1/pipelines", {
    slug,
    display_name: `scratch ${slug}`,
    description: "scratch pipeline for the app-shell acceptance suite",
  });
  const draft = await apiPostJson<{ id: string; version: number }>(
    request,
    csrf,
    `/api/v1/pipelines/${pipeline.id}/drafts`,
    { document_yaml: yaml },
  );
  const validation = await apiPostJson<{ valid?: boolean; errors?: unknown[] }>(
    request,
    csrf,
    `/api/v1/drafts/${draft.id}/validate`,
    {},
  );
  if (validation.valid !== true) {
    throw new Error(`draft ${draft.id} failed validation: ${JSON.stringify(validation.errors)}`);
  }
  const revision = await apiPostJson<{ id: string }>(
    request,
    csrf,
    `/api/v1/drafts/${draft.id}/publish`,
    {
      version: draft.version,
    },
  );
  return { pipelineId: pipeline.id, draftId: draft.id, revisionId: revision.id };
}

/** Start a run pinned to a revision (one transaction on the API side). */
export async function apiStartRun(
  request: APIRequestContext,
  csrf: Csrf,
  projectId: string,
  revisionId: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const run = await apiPostJson<{ run_id?: string; id?: string }>(
    request,
    csrf,
    `/api/v1/projects/${projectId}/runs`,
    {
      pipeline_revision_id: revisionId,
      inputs,
      idempotency: `shell-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    },
  );
  const runId = run.run_id ?? run.id;
  if (!runId) throw new Error(`POST /runs did not name a run: ${JSON.stringify(run)}`);
  return runId;
}

/**
 * Wait for the run's agent node to be claimed with its conversation stamped
 * (the dock's live conversation). Bounded, never open-ended; a terminal node
 * that never carried a conversation fails the wait with the node's facts.
 */
export async function apiWaitRunAgentConversation(
  request: APIRequestContext,
  runId: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline)
      throw new Error(`no live agent conversation on run ${runId} in ${timeoutMs} ms`);
    const res = await request.get(`${BASE_URL}/api/v1/runs/${runId}/nodes`);
    if (res.status() === 404) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      continue;
    }
    if (!res.ok()) throw new Error(`GET /runs/${runId}/nodes -> ${res.status()}`);
    const body = (await res.json()) as {
      node_executions?: { id: string; node_instance_key: string; kind: string; status: string }[];
    };
    const agent = (body.node_executions ?? []).find((row) => row.kind === "agent.acp");
    if (agent) {
      const detail = (await (
        await request.get(`${BASE_URL}/api/v1/runs/${runId}/nodes/${agent.id}`)
      ).json()) as {
        status: string;
        attempts?: { status: string; conversation_id?: string | null }[];
      };
      const conversationId = detail.attempts?.find(
        (attempt) => attempt.conversation_id,
      )?.conversation_id;
      if (conversationId) return conversationId;
      if (["failed", "cancelled", "skipped"].includes(detail.status)) {
        throw new Error(
          `agent node ${agent.node_instance_key} went ${detail.status} without a live conversation: ${JSON.stringify(detail)}`,
        );
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** A one-off (manual) thread through the API — the journeys read it back. */
export async function apiCreateConversation(
  request: APIRequestContext,
  csrf: Csrf,
  projectId: string,
  profileId: string,
  title: string,
): Promise<string> {
  const conversation = await apiPostJson<{ id: string }>(
    request,
    csrf,
    `/api/v1/projects/${projectId}/conversations`,
    { agent_profile_id: profileId, title },
  );
  return conversation.id;
}

/** The agent profile's id for a conversation create (a name is not enough). */
export async function apiProfileId(request: APIRequestContext): Promise<string> {
  const body = (await (await request.get(`${BASE_URL}/api/v1/agent-profiles`)).json()) as {
    items?: { id: string }[];
  };
  const profile = body.items?.[0];
  if (!profile) throw new Error("the lab holds no agent profile");
  return profile.id;
}
