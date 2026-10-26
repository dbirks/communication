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
 * but at phone width the sidebar (and its footer user menu) hides behind the
 * drawer's menu button — so open the drawer, open the user menu, and read the
 * menu's `sign-out` instead (the issue2 suite's same trick).
 */
export async function signInNarrow(page: Page, subject: string): Promise<void> {
  await page.goto(BASE_URL + "/");
  await page.getByTestId("sign-in").click();
  await page.getByPlaceholder("Enter any user/subject").fill(subject);
  await page.getByRole("button", { name: "Sign-in" }).click();
  // The IdP redirect chain lands on the API's own origin (the embedded dist);
  // come back to the dev origin the journey runs against before asserting.
  await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
  // At 390px the sidebar sits behind the phone top strip's menu button:
  // open the drawer, then open the footer's user menu to reach the sign-out.
  await page.getByTestId("sidebar-open").click();
  const drawer = page.getByTestId("sidebar").last();
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("user-menu").click();
  await expect(drawer.getByTestId("user-menu-list")).toBeVisible();
  await expect(drawer.getByTestId("sign-out")).toBeVisible();
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
  /** The row's own timestamps — `finished_at ?? created_at` is the board's
   * DONE TODAY predicate (ui/src/components/board/columns.ts:runUpdatedAt). */
  created_at: string;
  finished_at?: string | null;
  /** ADR-0056 part 1: how the run was started (the board's trigger chips). */
  trigger?: { kind?: string | null; ref?: string | null } | null;
  steps?: { node_id: string; kind: string; state: string }[];
}
export const apiRuns = (request: APIRequestContext) =>
  apiAll<RunRow>(request, "/api/v1/runs?limit=100");

/* ------------------------------------------- the board's own read and clock.
 *
 * The Board (artboard 2d) is NOT "every run the API returns": it is one page
 * of `GET /api/v1/runs` — every status, `limit=200`, no `updated_since`
 * (`ui/src/api/board.ts`: BOARD_RUN_STATUSES / BOARD_RUN_LIMIT / boardRunQuery)
 * — and the DONE TODAY column is a client-side clock on top of that page
 * (`ui/src/components/board/columns.ts`: isDoneToday / columnRuns). A
 * `completed` run is a card only while `finished_at ?? created_at` is at or
 * after the BROWSER's local midnight, so a test that counts every completed
 * row the API returns over-counts on any lab with a finished run older than
 * midnight — and a lab whose journey crosses midnight drifts mid-test.
 *
 * These mirrors are the board's rule, and `pinBrowserClock` fixes the
 * browser's clock to the same instant the expectation is computed from, so
 * midnight cannot pass between the API read and the page read.
 */

/** The board's status filter (ui/src/api/board.ts: BOARD_RUN_STATUSES). */
export const BOARD_RUN_STATUSES = [
  "queued",
  "preparing",
  "running",
  "waiting_human",
  "paused",
  "failed",
  "interrupted",
  "cancelled",
  "completed",
] as const;

/** The board's page size (ui/src/api/board.ts: BOARD_RUN_LIMIT) — one page only. */
export const BOARD_RUN_LIMIT = 200;

/** The board's status → column map (ui/src/components/board/columns.ts: STATUS_COLUMN). */
export const BOARD_STATUS_COLUMN: Record<string, string> = {
  queued: "queued",
  preparing: "queued",
  running: "running",
  waiting_human: "needs-you",
  paused: "needs-you",
  failed: "failed",
  interrupted: "failed",
  cancelled: "failed",
  completed: "done",
};

export const BOARD_COLUMNS = ["queued", "running", "needs-you", "failed", "done"] as const;

export interface BoardRunFilter {
  /** Keep one project's runs; absent = every project the caller belongs to. */
  projectId?: string;
  /** `mine=true` — runs the caller started. */
  mine?: boolean;
  /** ADR-0056: only runs started by this trigger kind. */
  trigger?: string;
}

/** The board's query string (ui/src/api/board.ts: boardRunQuery), same order. */
export function boardRunQuery(filter: BoardRunFilter = {}): string {
  const params = new URLSearchParams();
  params.set("status", BOARD_RUN_STATUSES.join(","));
  params.set("limit", String(BOARD_RUN_LIMIT));
  if (filter.projectId) params.set("project_id", filter.projectId);
  if (filter.mine) params.set("mine", "true");
  if (filter.trigger) params.set("trigger", filter.trigger);
  return params.toString();
}

/**
 * One page of `GET /api/v1/runs` on the board's own query — deliberately NOT
 * `apiAll`: the board never follows `next_cursor`, so rows past its page are
 * not on the board and must not be counted against it.
 */
export async function apiBoardRuns(
  request: APIRequestContext,
  filter: BoardRunFilter = {},
): Promise<RunRow[]> {
  const query = boardRunQuery(filter);
  const res = await request.get(BASE_URL + `/api/v1/runs?${query}`);
  if (!res.ok()) throw new Error(`GET /api/v1/runs?${query} -> ${res.status()}`);
  const body = (await res.json()) as { runs?: RunRow[] };
  return body.runs ?? [];
}

/** Local midnight of `now` (ui/src/components/board/columns.ts: localMidnight). */
export function localMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** `COALESCE(finished_at, created_at)` (columns.ts: runUpdatedAt). */
export function runUpdatedAt(run: RunRow): number {
  const value = run.finished_at ?? run.created_at;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) throw new Error(`run ${run.id} has no readable timestamp`);
  return ms;
}

/** The board's DONE TODAY clock (columns.ts: isDoneToday). */
export function isDoneToday(run: RunRow, now: Date): boolean {
  return (
    BOARD_STATUS_COLUMN[run.status] === "done" && runUpdatedAt(run) >= localMidnight(now).getTime()
  );
}

/**
 * The runs the board renders as cards in its default "by state" view: every
 * row of the board's page except a `completed` run finished before local
 * midnight (columns.ts: columnRuns drops exactly those). The "by repo" /
 * "by workflow" groupings do NOT apply the clock (groupByRepo/groupByWorkflow
 * take the whole page), so only this list matches the state columns.
 */
export function boardCardRuns(runs: readonly RunRow[], now: Date): RunRow[] {
  return runs.filter((run) => BOARD_STATUS_COLUMN[run.status] !== "done" || isDoneToday(run, now));
}

/** Per-column card counts for the state view (columns.ts: columnRuns). */
export function boardColumnCounts(
  runs: readonly RunRow[],
  now: Date,
): Record<(typeof BOARD_COLUMNS)[number], number> {
  const counts: Record<(typeof BOARD_COLUMNS)[number], number> = {
    queued: 0,
    running: 0,
    "needs-you": 0,
    failed: 0,
    done: 0,
  };
  for (const run of boardCardRuns(runs, now)) {
    counts[(BOARD_STATUS_COLUMN[run.status] ?? "queued") as (typeof BOARD_COLUMNS)[number]] += 1;
  }
  return counts;
}

/**
 * Pin the browser's clock to `now` — call it BEFORE the first navigation, the
 * way Playwright documents it. `clock.setFixedTime` freezes `Date` (and
 * `performance.now`) at that instant while real timers keep firing, so SSE,
 * react-query invalidation and Playwright's own waits are unaffected; only
 * "what time is it on the page" becomes deterministic. Returns the pinned
 * instant so the test computes its midnight from the very clock the page
 * reads — no race when a journey crosses midnight.
 */
export async function pinBrowserClock(page: Page, now: Date = new Date()): Promise<Date> {
  await page.clock.setFixedTime(now);
  return now;
}

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

/**
 * The project a scratch journey write should land in: the seeded `m4-exit`
 * when the reader can see it. The lab's project list is alphabetical and
 * grows scratch rows from every suite that ran before (m1's Customer
 * Platform, the emulator's short-lived `Emu proj …` rows an emu run may
 * delete while a journey reads), so a first-row pick is no longer a stable
 * fact. Falls back to the first row when m4-exit is not visible.
 */
export async function apiScratchProject(request: APIRequestContext): Promise<ProjectRow> {
  const projects = await apiProjects(request);
  return projects.find((p) => p.slug === "m4-exit") ?? projects[0];
}

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
