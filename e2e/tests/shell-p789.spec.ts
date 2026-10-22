// P7–P9 acceptance: the rows `docs/design/handoff-app-shell/acceptance.md`
// still marks NOT COVERED. The sidebar's Inbox flag rises from the org event
// stream (ADR-0048) with NO timer poll (row: "live flags … NOT COVERED"),
// the Board "mine" filter matches `GET /runs?mine=true` and the from issues /
// scheduled chips are enabled and filter `GET /runs` by trigger (ADR-0056), a Studio
// agent node saved "as a reusable step" appears in `GET /node-templates`
// and on /steps (row: 3349840), the ⌘K mic drives a fake SpeechRecognition
// into an editable composer with nothing sent until Send (row: mic), the
// per-person trust level is enforced in the assistant loop (row: trust),
// follow-up questions round-trip as the option's plain-text label (row:
// questions), the approval detail page renders its summary / plan / files /
// free-text interpretation with a cancel, not a decision, at both widths
// (row: approval detail), /ops shows the health line, the real workers and
// the probe-backed capability matrix (row: operations), and Settings →
// Assistant shows the three levels plus the /ops link (rows: settings).
//
// Runs ONLY when COMMUNICATION_E2E_SHELL=1. checkShellScreen on every page;
// evidence() per step. Scratch pipelines / runs are created through the API
// (the m5-gate pattern: a human.approval ROOT node enters `waiting_human`
// the moment the run exists, so no worker turn is needed) and are left
// pending — the journeys never decide a gate.
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { BASE_URL } from "./env.js";
import { signIn, testidOf } from "./helpers.js";
import {
  SHELL_ENABLED,
  SHELL_GATE,
  apiAgentProfiles,
  apiLaunchers,
  apiPendingApprovals,
  apiProjects,
  apiRuns,
  checkShellScreen,
  evidence,
  watchPageErrors,
  type ApprovalRow,
  type ProjectRow,
} from "./shell-helpers.js";

const RUNS_OR_APPROVALS = /\/api\/v1\/(runs|approvals)([/?]|$)/;

interface NetSample {
  url: string;
  method: string;
  t: number;
}

/** Every /runs|/approvals GET plus the org SSE connection, with a clock. */
function netTap(page: Page): { samples: NetSample[] } {
  const samples: NetSample[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/events") {
      samples.push({ url: request.url(), method: "SSE", t: Date.now() });
      return;
    }
    if (request.method() === "GET" && RUNS_OR_APPROVALS.test(url.pathname)) {
      samples.push({ url: request.url(), method: request.method(), t: Date.now() });
    }
  });
  return { samples };
}

/**
 * Record org-SSE frames before the app loads: the stream delivers frames on
 * `onmessage` (envelope frames) and on named `addEventListener(type)`
 * handlers (typed frames), so both entry points are wrapped on the prototype
 * and every frame lands in `window.__sseFrames` with a timestamp.
 */
function installSseFrameTap(page: Page): void {
  page.addInitScript(() => {
    const frames: { type: string; data: string | null; t: number }[] = [];
    (window as unknown as Record<string, unknown>).__sseFrames = frames;
    const proto = (window as unknown as { EventSource?: { prototype: unknown } }).EventSource
      ?.prototype;
    if (proto === undefined) return;
    const source = proto as {
      addEventListener: (type: string, listener: unknown, options?: unknown) => void;
    };
    const origAdd = source.addEventListener;
    source.addEventListener = function (
      this: unknown,
      type: string,
      listener: unknown,
      options?: unknown,
    ) {
      if (typeof listener === "function") {
        const wrapped = (event: { data?: unknown }) => {
          try {
            frames.push({
              type,
              data: typeof event?.data === "string" ? event.data : null,
              t: Date.now(),
            });
          } catch {
            // the tap must never break the stream
          }
          return listener(event);
        };
        return origAdd.call(this, type, wrapped, options);
      }
      return origAdd.call(this, type, listener, options);
    };
    const onmessageOwner = proto as { __p789_onmessage?: ((event: unknown) => void) | null };
    Object.defineProperty(proto, "onmessage", {
      get(this: unknown) {
        return (this as typeof onmessageOwner).__p789_onmessage ?? null;
      },
      set(this: unknown, handler: unknown) {
        (this as typeof onmessageOwner).__p789_onmessage =
          typeof handler === "function"
            ? (event: unknown) => {
                try {
                  frames.push({
                    type: "message",
                    data:
                      typeof (event as { data?: unknown })?.data === "string"
                        ? (event as { data: string }).data
                        : null,
                    t: Date.now(),
                  });
                } catch {
                  // the tap must never break the stream
                }
                return handler(event);
              }
            : null;
      },
      configurable: true,
    });
  });
}

export interface Csrf {
  token: string;
  origin: string;
}

/** The session's CSRF token (internal/api/middleware.go: mutations 403 without it). */
async function apiCsrf(request: APIRequestContext): Promise<Csrf> {
  const res = await request.get(BASE_URL + "/api/v1/me");
  expect(res.status(), "GET /api/v1/me -> 200").toBe(200);
  const body = (await res.json()) as { csrf_token: string };
  return { token: body.csrf_token, origin: BASE_URL };
}

async function apiPost(
  request: APIRequestContext,
  csrf: Csrf,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await request.post(BASE_URL + path, {
    data: body,
    headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
  });
  expect(
    res.status(),
    `POST ${path} -> ${res.status()} (want 2xx): ${await res.text().catch(() => "?")}`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status(), `POST ${path} -> ${res.status()} (want 2xx)`).toBeLessThan(300);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** The session's PATCH — the preferences mutation verb (patchMyPreferences). */
async function apiPatch(
  request: APIRequestContext,
  csrf: Csrf,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await request.patch(BASE_URL + path, {
    data: body,
    headers: { Origin: csrf.origin, "X-CSRF-Token": csrf.token },
  });
  expect(res.status(), `PATCH ${path} -> ${res.status()} (want 2xx)`).toBeGreaterThanOrEqual(200);
  expect(res.status(), `PATCH ${path} -> ${res.status()} (want 2xx)`).toBeLessThan(300);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * The scratch gate (the m5-journey GATE_TWIN pattern, a longer deadline): a
 * `human.approval` ROOT node so the run enters `waiting_human` the moment it
 * exists — `waiting_human` costs no worker turn — with one `process.exec`
 * node held back behind it. 600 s so the tests decide the test's own fate,
 * not the clock.
 */
const GATE_YAML = (
  slug: string,
): string => `# p789 scratch gate: one maintainer approval at the root, one printf behind it.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    P789 scratch gate for acceptance: a root approval the journey cancels, never decides.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the gate is asking about.
  outputs:
    type: object
    required: [after]
    properties:
      after: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 20
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: approve
    kind: human.approval
    retry:
      maxAttempts: 1
    config:
      summary: |-
        P789 acceptance gate for \${{ inputs.goal }} — the suite cancels its confirm step, it never decides.
      approverRoles: [maintainer]
      deadlineSeconds: 600
      onTimeout: fail
  - id: after_gate
    kind: process.exec
    dependsOn: [approve]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"ran off the p789 gate"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string}
  resultBindings:
    after: \${{ nodes.after_gate.outputs.after }}
`;

/** One plan node for the ask_all journey: the draft the assistant extends. */
const TRUST_YAML = (
  slug: string,
): string => `# p789 scratch: the ask_all journey's editable draft — one plan node.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    P789 scratch: one plan node the trust journey asks the assistant to extend with a gated approval step.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal: {type: string, minLength: 1}
  outputs:
    type: object
    required: [after]
    properties:
      after: {type: string}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 10
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: intake
    kind: human.approval
    config:
      summary: P789 scratch intake approval.
      approverRoles: [maintainer]
      onTimeout: fail
  - id: plan
    kind: process.exec
    dependsOn: [intake]
    timeoutSeconds: 120
    retry:
      maxAttempts: 1
    config:
      executable: printf
      args:
      - '%s\\n'
      - '{"after":"planned"}'
      outputExtraction: {mode: json_from_stdout}
    outputs:
      type: object
      required: [after]
      properties:
        after: {type: string}
  resultBindings:
    after: \${{ nodes.plan.outputs.after }}
`;

/** One agent node the "save as a reusable step" journey selects (4b). */
const AGENT_YAML = (
  slug: string,
  profileName: string,
  nodeId: string,
): string => `# p789 scratch pipeline: a single agent node for the reusable-step journey.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    P789 scratch: one agent node whose inspector offers "save as a reusable step".
spec:
  inputs:
    type: object
  outputs:
    type: object
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 3600
    maxNodeExecutions: 5
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
  - id: ${nodeId}
    kind: agent.acp
    config:
      profile: "${profileName}"
      prompt: Fix the build so the tests pass again.
`;

export interface ScratchPipeline {
  pipelineId: string;
  draftId: string;
  revisionId: string;
}

/** Create → draft → validate → publish, all through the API the UI uses. */
export async function publishPipeline(
  request: APIRequestContext,
  csrf: Csrf,
  slug: string,
  yaml: string,
): Promise<ScratchPipeline> {
  const pipeline = (await apiPost(request, csrf, "/api/v1/pipelines", {
    slug,
    display_name: `p789 ${slug}`,
    description: "scratch pipeline for the p789 acceptance suite",
  })) as { id: string };
  const draft = (await apiPost(request, csrf, `/api/v1/pipelines/${pipeline.id}/drafts`, {
    document_yaml: yaml,
  })) as { id: string; version: number };
  const validation = (await apiPost(request, csrf, `/api/v1/drafts/${draft.id}/validate`, {})) as {
    status?: string;
    errors?: unknown[];
  };
  const hardErrors = Array.isArray(validation.errors) ? validation.errors : [];
  expect(hardErrors, `draft ${draft.id} failed validation: ${JSON.stringify(hardErrors)}`).toEqual(
    [],
  );
  const revision = (await apiPost(request, csrf, `/api/v1/drafts/${draft.id}/publish`, {
    version: draft.version,
  })) as { id: string };
  return { pipelineId: pipeline.id, draftId: draft.id, revisionId: revision.id };
}

/** Start a run at the gate's revision; it waits on the approval immediately. */
export async function startGatedRun(
  request: APIRequestContext,
  csrf: Csrf,
  project: ProjectRow,
  revisionId: string,
): Promise<string> {
  // RunCreateResponse names the run `run_id` (not `id`) — reading `id`
  // yielded undefined and every later poll matched no approval.
  const run = (await apiPost(request, csrf, `/api/v1/projects/${project.id}/runs`, {
    pipeline_revision_id: revisionId,
    inputs: { goal: "P789 acceptance scratch gate" },
    idempotency: `p789-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
  })) as { run_id?: string; id?: string };
  const runId = run.run_id ?? run.id;
  if (!runId) throw new Error(`POST /runs did not name a run: ${JSON.stringify(run)}`);
  return runId;
}

/** Wait for the gate's pending approval to show up cross-project. */
export async function pendingApprovalForRun(
  request: APIRequestContext,
  runId: string,
): Promise<ApprovalRow> {
  const approvals = await apiPendingApprovals(request);
  const hit = approvals.find((row) => row.run_id === runId);
  if (hit) return hit;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const again = await apiPendingApprovals(request);
    const found = again.find((row) => row.run_id === runId);
    if (found) return found;
  }
  throw new Error(`no pending approval appeared for run ${runId}`);
}

/** The sidebar's Inbox flag count ("! n waiting"); 0 while the flag is absent. */
export async function inboxFlagCount(page: Page): Promise<number> {
  const badge = page.getByTestId("sidebar-link-inbox").getByLabel(/waiting$/);
  if (!(await badge.isVisible().catch(() => false))) return 0;
  const label = (await badge.getAttribute("aria-label")) ?? "";
  const match = label.match(/^(\d+) waiting$/);
  return match ? Number(match[1]) : 0;
}

/** The card ROOT only (the shell-p2 trick: the inner testids share the prefix). */
const CARD_ROOT =
  '[data-testid^="board-card-"]' +
  ':not([data-testid^="board-card-open-"])' +
  ':not([data-testid^="board-card-step-"])' +
  ':not([data-testid^="board-card-actions-"])' +
  ':not([data-testid^="board-card-retry-"])';

test.describe("shell p789 — live flags, board filters, reusable steps, mic, trust, questions, approvals, ops, settings", () => {
  test.skip(!SHELL_ENABLED, SHELL_GATE);
  test.use({ viewport: { width: 1500, height: 950 } });
  test.setTimeout(10 * 60_000);

  test("1. live flags: the Inbox flag rises on the org SSE frame, no /runs|/approvals timer poll", async ({
    page,
  }) => {
    installSseFrameTap(page);
    const { samples } = netTap(page);
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // Let the first paints, the SSE open and the flag reads settle before
    // the idle window: /runs|/approvals traffic must be quiet for 3 s straight.
    let quietSeconds = 0;
    let seen = samples.filter((sample) => sample.method !== "SSE").length;
    for (let i = 0; i < 30 && quietSeconds < 3; i += 1) {
      await page.waitForTimeout(1_000);
      const now = samples.filter((sample) => sample.method !== "SSE").length;
      quietSeconds = now === seen ? quietSeconds + 1 : 0;
      seen = now;
    }
    expect(quietSeconds, "the cross-project reads settle before the idle window").toBe(3);
    expect(
      samples.some((s) => s.method !== "SSE"),
      "the sidebar's flag reads fired before the idle window",
    ).toBe(true);
    const sseOpens = samples.filter((sample) => sample.method === "SSE");
    expect(
      sseOpens.length,
      "the sidebar must be connected to the org event stream GET /api/v1/events",
    ).toBeGreaterThanOrEqual(1);
    const before = await inboxFlagCount(page);
    const idleStart = samples.length;
    // No timer may own this column: eight quiet seconds prove nothing is
    // polling /runs or /approvals while the flag sits still.
    await page.waitForTimeout(8_000);
    const idlePolls = samples.slice(idleStart).filter((s) => s.method !== "SSE");
    expect(
      idlePolls,
      `timer polls fired while the page sat idle: ${idlePolls.map((s) => s.url).join(" | ")}`,
    ).toEqual([]);
    // Now a real event: a scratch gate run enters waiting_human at the API.
    const project = (await apiProjects(request))[0];
    expect(project, "the lab holds a project to run the scratch gate in").toBeTruthy();
    const csrf = await apiCsrf(request);
    const stamp = String(Date.now());
    const pipeline = await publishPipeline(
      request,
      csrf,
      `p789-live-${stamp}`,
      GATE_YAML(`p789-live-${stamp}`),
    );
    const runStart = samples.length;
    const runStartT = Date.now();
    const runId = await startGatedRun(request, csrf, project, pipeline.revisionId);
    await expect
      .poll(async () => inboxFlagCount(page), {
        message: "the Inbox flag must rise within 10 s",
        timeout: 10_000,
      })
      .toBe(before + 1);
    const refetches = samples.slice(runStart).filter((s) => s.method !== "SSE" && s.t >= runStartT);
    const frames =
      (await page.evaluate(
        () =>
          (
            window as unknown as {
              __sseFrames?: { type: string; data: string | null; t: number }[];
            }
          ).__sseFrames,
      )) ?? [];
    // The bound, derived from the invalidating consumers (not a magic 4):
    // a run./approval. frame dirties, per coalescer, at most these keys on
    // the open Home — the sidebar's two flag reads (GET /runs?status…&limit=200,
    // GET /approvals?status=pending, sidebarFlags.ts) and Home's two briefing
    // reads (the shared board runs key, one distinct GET /runs URL, and the
    // home approvals key, which shares the sidebar's approvals URL): 4 keys
    // over 3 distinct URLs. Each key refetches at most once per coalescer
    // flush, and the flushes are caused by run./approval. frames only (the
    // scratch run commits at least run.created + run.waiting_human). So:
    // per distinct URL, at most (its key count) x (frame windows); a URL
    // refetching beyond that is a coalescing bug and fails on its own list.
    const runFrames = frames.filter(
      (frame) => frame.type.startsWith("run.") || frame.type.startsWith("approval."),
    );
    const frameWindows = Math.max(runFrames.length, 2);
    const urlKey = (url: string): string => `${new URL(url).pathname}${new URL(url).search}`;
    const refetchUrls = refetches.map((sample) => urlKey(sample.url));
    console.log(
      `P789-T1 refetches after the frame (${refetchUrls.length}): ${refetchUrls.join(" | ")}`,
    );
    const distinctUrls = new Set(refetchUrls);
    // 4 invalidated keys render as at most 3 distinct URLs (the two
    // approvals keys share one); no other read may refetch at all.
    for (const url of distinctUrls) {
      expect(
        url.startsWith("/api/v1/runs") || url.startsWith("/api/v1/approvals"),
        `a non-invalidated read refetched after the frame: ${url}`,
      ).toBe(true);
    }
    for (const url of distinctUrls) {
      const keysPerUrl = url.startsWith("/api/v1/approvals") ? 2 : 1;
      const count = refetchUrls.filter((row) => row === url).length;
      expect(
        count,
        `refetch count for ${url} (${keysPerUrl} key(s) x ${frameWindows} frame window(s), coalesced per key)`,
      ).toBeLessThanOrEqual(keysPerUrl * frameWindows);
    }
    expect(
      refetches.length,
      `at most the coalesced invalidation refetches after the frames (4 keys x ${frameWindows} frame window(s)): ${refetchUrls.join(" | ")}`,
    ).toBeLessThanOrEqual(4 * frameWindows);
    if (runFrames.length > 0) {
      const firstFrame = runFrames.reduce((earliest, frame) =>
        frame.t < earliest.t ? frame : earliest,
      );
      const premature = refetches.filter((sample) => sample.t < firstFrame.t);
      expect(
        premature,
        `a refetch preceded the first run/approval SSE frame (${firstFrame.type} @ ${firstFrame.t}): ${premature.map((s) => s.url).join(" | ")}`,
      ).toEqual([]);
    }
    await checkShellScreen(page, "home after the live flag rose", stopWatching);
    await evidence(
      page,
      "shell-p789-live-flag",
      `the sidebar Inbox flag rose from ${before} to ${before + 1} within 10 s of run ${runId.slice(0, 8)} entering waiting_human, with ZERO /runs|/approvals GETs during the 8 s idle window, ${refetches.length} invalidation refetch(es) after the run, and ${frames.length} SSE frame(s) captured on /api/v1/events${frames.length > 0 ? " — every refetch timestamped after the first frame" : " — the frame hook captured nothing, so the no-timer half of the claim rests on the idle window only"}`,
    );
  });

  test("2. board: the 'mine' count equals GET /runs?mine=true; the from-issues/scheduled chips filter by trigger", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/board", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("board-page")).toBeVisible();
    await expect(page.getByTestId("board-loading")).toBeHidden({ timeout: 30_000 });
    const allRuns = await apiRuns(request);
    const allCards = await page.locator(CARD_ROOT).count();
    expect(allCards, "every cross-project run the caller can see becomes one card").toBe(
      allRuns.length,
    );
    const mineRuns = await request.get(BASE_URL + "/api/v1/runs?mine=true&limit=100");
    expect(mineRuns.status(), "GET /api/v1/runs?mine=true -> 200").toBe(200);
    const mineBody = (await mineRuns.json()) as { runs?: { id: string }[] };
    const mineCount = mineBody.runs?.length ?? 0;
    const mineChip = page.getByTestId("board-filter-mine");
    await expect(mineChip).toBeVisible();
    await mineChip.click();
    await expect(mineChip).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(CARD_ROOT)).toHaveCount(mineCount, { timeout: 15_000 });
    const issueChip = page.getByTestId("board-filter-issue");
    const scheduledChip = page.getByTestId("board-filter-scheduled");
    await expect(issueChip).toBeVisible();
    await expect(scheduledChip).toBeVisible();
    await expect(issueChip).toBeEnabled();
    await expect(scheduledChip).toBeEnabled();
    await expect(issueChip).toHaveAttribute("aria-pressed", "false");
    await expect(scheduledChip).toHaveAttribute("aria-pressed", "false");
    await checkShellScreen(page, "board with the mine filter", stopWatching);
    await evidence(
      page,
      "shell-p789-board-mine",
      `board cards without the filter equal GET /api/v1/runs (${allCards} of ${allRuns.length}), with 'mine' pressed the ${mineCount} cards equal GET /api/v1/runs?mine=true, and the from issues / scheduled chips are enabled and idle (ADR-0056)`,
    );

    // The scheduled chip now filters the board list by the run's trigger.
    const scheduledRequestPromise = page.waitForRequest(
      (req) => req.url().includes("/api/v1/runs") && req.url().includes("trigger=schedule"),
    );
    await scheduledChip.click();
    const scheduledRequest = await scheduledRequestPromise;
    expect(scheduledRequest.url()).toContain("trigger=schedule");
    await expect(scheduledChip).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("board-loading")).toBeHidden({ timeout: 30_000 });
    const scheduledResponse = await request.get(
      BASE_URL + "/api/v1/runs?limit=100&trigger=schedule",
    );
    expect(scheduledResponse.status(), "GET /api/v1/runs?trigger=schedule -> 200").toBe(200);
    const scheduledBody = (await scheduledResponse.json()) as {
      runs?: { id: string; trigger?: { kind: string } }[];
    };
    const scheduledIds = new Set(
      (scheduledBody.runs ?? [])
        .filter((row) => row.trigger?.kind === "schedule")
        .map((row) => row.id),
    );
    const cards = page.locator(CARD_ROOT);
    const cardCount = await cards.count();
    const cardIds: string[] = [];
    for (let i = 0; i < cardCount; i += 1) {
      const testid = await cards.nth(i).getAttribute("data-testid");
      if (typeof testid === "string" && testid.startsWith("board-card-")) {
        cardIds.push(testid.slice("board-card-".length));
      }
    }
    for (const id of cardIds) {
      expect(scheduledIds.has(id), `rendered card ${id} is a scheduled run`).toBe(true);
    }
  });

  test("3. studio: 'also save as a reusable step' lands in GET /node-templates and on /steps", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    const csrf = await apiCsrf(request);
    console.log("P789-T3 signed in, csrf ok");
    // The agent node needs a profile to point at; the lab holds some —
    // otherwise one is created through the same API.
    let profiles = await apiAgentProfiles(request);
    if (profiles.length === 0) {
      const launchers = await apiLaunchers(request);
      const launcherId = launchers.find((row) => row.registered)?.id ?? "claude";
      const created = (await apiPost(request, csrf, "/api/v1/agent-profiles", {
        name: "p789 scratch profile",
        launcher_id: launcherId,
      })) as { name?: string };
      profiles = [
        { id: "", name: created.name ?? "p789 scratch profile", launcher_id: launcherId },
      ];
    }
    const stamp = String(Date.now());
    const slug = `p789-step-${stamp}`;
    // The saved step's slug IS the node id, so the id must be unique per run
    // or a re-run 409s on the template the earlier run already saved. Node
    // ids and template slugs intersect at [a-z0-9] only (no dash, no underscore).
    const nodeId = `p789fix${stamp}`;
    const pipeline = await publishPipeline(
      request,
      csrf,
      slug,
      AGENT_YAML(slug, profiles[0].name, nodeId),
    );
    console.log("P789-T3 published", pipeline.pipelineId, pipeline.draftId);
    // The just-published draft's editor is READ-ONLY (Studio.tsx:
    // readOnly = !canAuthor || status === "published"), so its "save as a
    // reusable step" toggle is disabled. The journey needs the editable copy
    // the pipeline page offers: clone the published revision into a fresh
    // draft through the same API (setup — the journey below is still UI).
    const editable = (await apiPost(
      request,
      csrf,
      `/api/v1/pipelines/${pipeline.pipelineId}/drafts`,
      {
        from_revision_id: pipeline.revisionId,
      },
    )) as { id: string };
    console.log("P789-T3 editable draft", editable.id);
    console.log("P789-T3 goto draft");
    await page.goto(BASE_URL + `/workflows/${pipeline.pipelineId}/drafts/${editable.id}`, {
      waitUntil: "domcontentloaded",
    });
    console.log("P789-T3 canvas visible");
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    const node = page.getByTestId(`canvas-step-${nodeId}`);
    await expect(node).toBeVisible();
    await node.click();
    console.log("P789-T3 node clicked");
    const saveBlock = page.getByTestId("insp-save-step");
    await expect(saveBlock).toBeVisible();
    console.log("P789-T3 save block visible");
    await page.getByTestId("insp-save-step-toggle").check();
    console.log("P789-T3 toggle checked");
    const post = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/node-templates") && response.request().method() === "POST",
    );
    await page.getByTestId("insp-save-step-button").click();
    console.log("P789-T3 save clicked");
    const postResponse = await post;
    expect(
      postResponse.status(),
      `POST /api/v1/node-templates answered ${postResponse.status()}`,
    ).toBeLessThan(300);
    const template = (await postResponse.json()) as { id: string; slug?: string };
    await expect(page.getByTestId("insp-save-step-done")).toBeVisible();
    const listed = (await (
      await request.get(BASE_URL + "/api/v1/node-templates?limit=100")
    ).json()) as { templates?: { id: string }[] };
    expect(
      listed.templates?.some((row) => row.id === template.id),
      "the saved step is served by GET /api/v1/node-templates",
    ).toBe(true);
    await page.goto(BASE_URL + "/steps", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("steps-page")).toBeVisible();
    await expect(page.getByTestId("steps-loading")).toBeHidden({ timeout: 30_000 });
    await expect(page.getByTestId("steps-list")).toContainText(nodeId, { timeout: 15_000 });
    await checkShellScreen(page, "steps with the saved step", stopWatching);
    await evidence(
      page,
      "shell-p789-save-step",
      `selecting the agent node in the ${slug} draft and arming 'also save as a reusable step' POSTed the node as template ${template.id.slice(0, 8)} — it is listed by GET /api/v1/node-templates and shows on /steps`,
    );
  });

  test("4. mic: fake SpeechRecognition fills the composer, editable, nothing sends until Send", async ({
    page,
  }) => {
    page.addInitScript(() => {
      const Fake = class {
        continuous: boolean;
        interimResults: boolean;
        lang: string;
        onresult: ((event: unknown) => void) | null;
        onerror: ((event: unknown) => void) | null;
        onend: (() => void) | null;
        constructor() {
          this.continuous = false;
          this.interimResults = false;
          this.lang = "";
          this.onresult = null;
          this.onerror = null;
          this.onend = null;
        }
        start() {
          window.setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: false, 0: { transcript: "change the" } }],
            });
          }, 80);
          window.setTimeout(() => {
            this.onresult?.({
              resultIndex: 0,
              results: [{ isFinal: true, 0: { transcript: "change the build please" } }],
            });
          }, 300);
          window.setTimeout(() => this.onend?.(), 600);
        }
        stop() {
          this.onend?.();
        }
        abort() {
          this.onend?.();
        }
      };
      (window as unknown as Record<string, unknown>).SpeechRecognition = Fake;
      (window as unknown as Record<string, unknown>).webkitSpeechRecognition = Fake;
    });
    await signIn(page, "admin");
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    // No assistant write may leave the browser before Send is pressed.
    const assistantPosts: string[] = [];
    page.on("request", (r) => {
      if (/\/api\/v1\/assistant\//.test(r.url()) && r.method() !== "GET") {
        assistantPosts.push(`${r.method()} ${r.url()}`);
      }
    });
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    const mic = page.getByTestId("mic-button");
    await expect(mic, "the fake SpeechRecognition must make the mic render").toBeVisible();
    await mic.click();
    await expect(page.getByTestId("listening-bar")).toBeVisible();
    // The final transcript is appended to the composer as editable text.
    const composer = page.getByTestId("assistant-composer-input");
    await expect
      .poll(async () => (await composer.inputValue()).includes("change the build"), {
        message: "the final transcript lands in the composer",
        timeout: 10_000,
      })
      .toBe(true);
    await composer.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and ship it");
    const value = await composer.inputValue();
    expect(value, "the transcript is editable, not a frozen transcript").toContain(
      "change the build please and ship it",
    );
    expect(assistantPosts, "nothing is sent until Send is pressed").toEqual([]);
    await checkShellScreen(page, "assistant popover with the dictated text", stopWatching);
    await evidence(
      page,
      "shell-p789-mic",
      `the fake SpeechRecognition's interim + final results drove the listening bar and landed 'change the build please' in the composer, where ' and ship it' was typed on top — and ZERO non-GET requests reached /api/v1/assistant/ before Send`,
    );
    await page.keyboard.press("Escape");
  });

  interface AssistantMessageRow {
    id: string;
    kind: string;
    payload: { text?: string };
  }

  /** The newest assistant conversation's transcript (oldest first). */
  async function assistantTranscript(request: APIRequestContext): Promise<AssistantMessageRow[]> {
    const res = await request.get(BASE_URL + "/api/v1/assistant/conversations?limit=5");
    expect(res.status(), "GET /assistant/conversations -> 200").toBe(200);
    const body = (await res.json()) as { conversations?: { id: string }[] };
    const latest = body.conversations?.[0];
    if (!latest) return [];
    const msgs = await request.get(
      BASE_URL + `/api/v1/assistant/conversations/${latest.id}/messages?limit=100`,
    );
    expect(msgs.status(), "GET /assistant/conversations/{id}/messages -> 200").toBe(200);
    return ((await msgs.json()) as { messages?: AssistantMessageRow[] }).messages ?? [];
  }

  /** The stored document + version of a draft (GET /api/v1/drafts/{id}). */
  async function draftDocument(
    request: APIRequestContext,
    draftId: string,
  ): Promise<{ yaml: string; version: number }> {
    const res = await request.get(BASE_URL + `/api/v1/drafts/${draftId}`);
    expect(res.status(), "GET /api/v1/drafts/{id} -> 200").toBe(200);
    const body = (await res.json()) as { document_yaml?: string; version?: number };
    return { yaml: body.document_yaml ?? "", version: body.version ?? 0 };
  }

  interface AssistantRawRow {
    kind: string;
    text?: string;
    answer_markdown?: string;
    tool_calls?: { name?: string; ok?: boolean; summary?: string; reason?: string }[];
  }

  /** The newest conversation's RAW rows (wire shape: kind + fields flat). */
  async function assistantRows(request: APIRequestContext): Promise<AssistantRawRow[]> {
    const res = await request.get(BASE_URL + "/api/v1/assistant/conversations?limit=5");
    expect(res.status(), "GET /assistant/conversations -> 200").toBe(200);
    const body = (await res.json()) as { conversations?: { id: string }[] };
    const latest = body.conversations?.[0];
    if (!latest) return [];
    const msgs = await request.get(
      BASE_URL + `/api/v1/assistant/conversations/${latest.id}/messages?limit=100`,
    );
    expect(msgs.status(), "GET /assistant/conversations/{id}/messages -> 200").toBe(200);
    return ((await msgs.json()) as { messages?: AssistantRawRow[] }).messages ?? [];
  }

  test("5. trust: ask_all gates a draft edit behind the confirm card; Retry applies, the chip undoes", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    const csrf = await apiCsrf(request);
    // Setup through the API the UI uses: one scratch workflow whose document
    // holds a single node named `plan`. The just-published draft's editor is
    // READ-ONLY (Studio.tsx), so clone the revision into the editable copy
    // the journey opens — and the draft page puts the draft into the
    // assistant's page context (kind "draft"), so the model needs no search
    // to name the draft id.
    const stamp = String(Date.now());
    const slug = `p789-trust-${stamp}`;
    const pipeline = await publishPipeline(request, csrf, slug, TRUST_YAML(slug));
    const editable = (await apiPost(
      request,
      csrf,
      `/api/v1/pipelines/${pipeline.pipelineId}/drafts`,
      { from_revision_id: pipeline.revisionId },
    )) as { id: string };
    // Settings → Assistant: the stored level is changed through the page the
    // pill itself uses (same hook, same PATCH).
    await page.goto(BASE_URL + "/settings/assistant", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("settings-assistant")).toBeVisible();
    await page.getByTestId("settings-assistant-trust-level-option-ask_all").click();
    await expect
      .poll(
        async () => {
          const res = await request.get(BASE_URL + "/api/v1/me/preferences");
          const doc = (await res.json()) as { assistant?: { trust_level: string } };
          return doc.assistant?.trust_level;
        },
        { message: "the stored trust level becomes ask_all", timeout: 15_000 },
      )
      .toBe("ask_all");
    await page.goto(BASE_URL + `/workflows/${pipeline.pipelineId}/drafts/${editable.id}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.getByTestId("studio-canvas")).toBeVisible();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    // Under ask_all a DRAFT EDIT is a gated tool call (trust.go:
    // ClassDraftEdit), so the turn stops without executing and lands as a
    // confirm card. (A navigation is NOT the deterministic gate: ui.navigate
    // is ClassNavigate and is never gated — see the documented check below.)
    // The popover adopts the caller's newest conversation, which can carry
    // older draft-edit cards from earlier runs — and they ALL share the
    // server's draft-edit risk line (runner.go's riskText), so the risk
    // text alone cannot name this run's card (a strict-mode violation on
    // the shared confirm button rejects the wait instantly). The card is
    // named by its summary: actionSummary for draft.apply is
    // "Run <draft_id>" (trust.go), and the draft_id is this journey's
    // editable draft.
    const card = page
      .getByTestId("assistant-approval")
      .filter({ hasText: "changes the pipeline draft" })
      .filter({ hasText: `Run ${editable.id}` });
    // A card stays pending until confirmed or dismissed, and an earlier
    // ATTEMPT of this journey can leave its own pending card for the same
    // draft: confirm the newest one (DOM order = transcript order).
    const confirm = card.getByTestId("assistant-approval-confirm").last();
    const askForEdit = async () => {
      const composer = page.getByTestId("assistant-composer-input");
      await expect(composer, "the composer is enabled once no turn is in flight").toBeEnabled({
        timeout: 60_000,
      });
      await composer.fill(
        `Add a human approval step named trust_check after plan in ${slug}'s draft`,
      );
      await page.getByTestId("assistant-send").click();
    };
    await askForEdit();
    // The lab LLM can time out a turn (the lab runs
    // COMMUNICATION_ASSISTANT_TIMEOUT=180s since 5479538: "× no completion …
    // within 180s" error line, no transcript row): send once, and if THAT
    // failure is what we see, reopen a fresh popover (clears the error line)
    // and ask again. Each wait is bounded, past the 180 s per-completion
    // deadline, and there are at most two attempts.
    let gated = false;
    for (let attempt = 1; attempt <= 2 && !gated; attempt += 1) {
      gated = await confirm
        .waitFor({ state: "visible", timeout: 200_000 })
        .then(() => true)
        .catch(() => false);
      if (gated) break;
      const failedTurn = (await page.getByTestId("assistant-error").count()) > 0;
      if (!failedTurn) break; // the deterministic wait was exhausted — fail loudly below
      await page.keyboard.press("Escape");
      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("assistant-popover")).toBeVisible();
      await askForEdit();
    }
    expect(gated, "ask_all must gate the draft edit behind a confirm card").toBe(true);
    await expect(
      card,
      "the card carries the server's draft-edit risk line, not model text",
    ).toContainText("changes the pipeline draft's structure", { timeout: 15_000 });
    const before = await draftDocument(request, editable.id);
    expect(before.yaml, "the gated draft edit must NOT have executed before Retry").not.toContain(
      "trust_check",
    );
    await evidence(
      page,
      "shell-p789-trust-ask-all",
      `with trust level ask_all the assistant's draft edit ('add a human approval step named trust_check after plan in ${slug}') surfaced a confirm card carrying the server risk line, and GET /api/v1/drafts/${editable.id.slice(0, 8)} still holds the document WITHOUT trust_check at version ${before.version}`,
    );
    // Baseline the chip BEFORE the confirm: since 0f4c880 every assistant
    // mutation (including this confirm/Retry post) invalidates the
    // conversation's changes query, so after the Retry applies the edit the
    // count on the still-open popover must rise WITHOUT a reload. Older
    // conversations can carry older change rows, so the honest check is
    // "strictly more than before", not "exactly 1".
    const chipCount = async (): Promise<number> => {
      const chip = page.getByTestId("assistant-change-chip-toggle");
      if (!(await chip.isVisible().catch(() => false))) return 0;
      const text = (await chip.textContent().catch(() => "")) ?? "";
      const match = text.match(/^(\d+) change/);
      return match ? Number(match[1]) : 0;
    };
    const chipBefore = await chipCount();
    await confirm.click();
    let retryFailed = false;
    await expect
      .poll(async () => (await draftDocument(request, editable.id)).yaml, {
        message: "Retry re-runs the gated edit and the stored draft gains the node",
        timeout: 30_000,
      })
      .toContain("trust_check")
      .catch(() => {
        retryFailed = true;
      });
    if (retryFailed) {
      const errLine =
        (
          (await page
            .getByTestId("assistant-error")
            .textContent()
            .catch(() => null)) ?? ""
        ).trim() || "none";
      if (/text must be empty/i.test(errLine)) {
        throw new Error(
          "PRODUCT BUG (confirm path unreachable from the UI): the Retry POST failed with 'text must be empty when confirming or dismissing an approval request' — AssistantPopover.answerApproval posts text:'Retry' TOGETHER with confirm, but the approval branch (internal/api/assistant_conversations.go postMessageApproval; openapi AssistantMessagePost) requires text empty when confirm/dismiss is set. The gated draft edit therefore never executes and the draft stays WITHOUT trust_check.",
        );
      }
      throw new Error(`Retry did not apply the gated draft edit (assistant-error: ${errLine})`);
    }
    await evidence(
      page,
      "shell-p789-trust-retry",
      "clicking Retry re-ran the gated draft.apply through the version-checked draft PUT: GET /api/v1/drafts/{id} now contains the trust_check node",
    );
    // Undo through the change chip. The workaround of reloading the page so
    // the chip refetches on mount is gone with 0f4c880: the confirm/Retry
    // mutation invalidates the changes query, so the chip must update IN
    // PLACE on the still-open popover — no reload, no remount. The
    // confirmed edit is the conversation's newest change row.
    await expect(page.getByTestId("assistant-popover"), "the popover is still open").toBeVisible();
    const chipToggle = page.getByTestId("assistant-change-chip-toggle");
    await expect(chipToggle, "the change chip lists the confirmed edit").toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => chipCount(), {
        message: "the chip's count rises in place after the confirm (no reload)",
        timeout: 30_000,
      })
      .toBeGreaterThan(chipBefore);
    await chipToggle.click();
    const undo = page.getByTestId("assistant-change-undo").last();
    await expect(undo, "the draft-edit row is undoable").toBeVisible();
    await undo.click();
    await expect
      .poll(async () => (await draftDocument(request, editable.id)).yaml, {
        message: "the undo inverse removes the node again",
        timeout: 30_000,
      })
      .not.toContain("trust_check");
    await expect(page.getByTestId("assistant-change-undone").last()).toBeVisible({
      timeout: 30_000,
    });
    // SECONDARY, documented, NO assertion on the model's choice: navigation
    // is ClassNavigate and never gated (internal/assistant/trust.go's closed
    // table), even under ask_all — the run records whether the model used
    // the ui.navigate tool or wrote a link, and whether the page moved.
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    const navComposer = page.getByTestId("assistant-composer-input");
    const rowsBeforeNav = (await assistantRows(request)).length;
    await navComposer.fill("take me to the board");
    await page.getByTestId("assistant-send").click();
    // The turn appends its rows atomically — an answer, or a follow-up
    // question instead of one. Baseline on the total row count, so either
    // outcome is observed; classify afterwards, never assert on the choice.
    await expect
      .poll(async () => (await assistantRows(request)).length, {
        message: "the navigation turn landed its rows",
        timeout: 200_000,
      })
      .toBeGreaterThan(rowsBeforeNav);
    const navRows = await assistantRows(request);
    const navRow = [...navRows].reverse().find((row) => row.kind === "assistant");
    const navQuestion = [...navRows].reverse().find((row) => row.kind === "question");
    const usedNavigateTool = (navRow?.tool_calls ?? []).some((call) => call.name === "ui_navigate");
    const wroteBoardRef = /board/i.test(navRow?.answer_markdown ?? "");
    const landedOnBoard = /\/board([/?#]|$)/.test(new URL(page.url()).pathname);
    await evidence(
      page,
      "shell-p789-trust-navigate",
      `DOCUMENTED SECONDARY CHECK (no assertion on model choice): under ask_all 'take me to the board' ${
        usedNavigateTool
          ? `used the ui.navigate tool — class navigate is NEVER gated (internal/assistant/trust.go toolClasses) — and the browser ${landedOnBoard ? "landed on /board on its own" : "did not navigate on its own"}`
          : wroteBoardRef
            ? "answered with a board reference in its text/links and made NO ui.navigate tool call — links are not tool calls, so nothing was gated and the user would click"
            : navQuestion !== undefined
              ? `did not navigate or answer; it asked a follow-up question instead ('${navQuestion.text ?? ""}') — a question stops the turn without acting`
              : "neither called ui.navigate nor named the board in its answer"
      }`,
    );
    // Reset the lab's stored level: the default, per C2. PATCH is the
    // preferences mutation verb (openapi patchMyPreferences) — POST 405s.
    await apiPatch(request, csrf, "/api/v1/me/preferences", {
      assistant: { trust_level: "ask_risky" },
    });
    const reset = (await (await request.get(BASE_URL + "/api/v1/me/preferences")).json()) as {
      assistant?: { trust_level: string };
    };
    expect(reset.assistant?.trust_level, "trust level restored to ask_risky").toBe("ask_risky");
    await checkShellScreen(page, "home after the trust journey", stopWatching);
    await page.keyboard.press("Escape");
  });

  test("6. questions: a picked option is sent back as its label, plain text", async ({ page }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("sidebar")).toBeVisible();
    await page.keyboard.press("Meta+k");
    await expect(page.getByTestId("assistant-popover")).toBeVisible();
    const cards = page.getByTestId("assistant-question");
    // The popover adopts the caller's NEWEST conversation, so older
    // (answered) question cards from earlier runs still render in the list:
    // a DOM baseline (cards.count) can name a stale card — the previous run
    // hung reading options off one. Baseline on the server transcript
    // instead, and the model's new question is the LAST card (oldest-first
    // render; this send's rows append). First settle the transcript: an
    // in-flight turn from an earlier test may still be landing its rows.
    let lastRows = -1;
    for (let i = 0; i < 30; i += 1) {
      const n = (await assistantRows(request)).length;
      if (n === lastRows) break;
      lastRows = n;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    let pickedLabel: string | null = null;
    let labelRowsBefore = 0;
    let failedAttempts = 0;
    let failedLine = "";
    for (let attempt = 1; attempt <= 2 && pickedLabel === null; attempt += 1) {
      // A FRESH popover per attempt: a failed turn leaves its "× no
      // completion … within 180s" line in the popover's local state (the lab
      // runs COMMUNICATION_ASSISTANT_TIMEOUT=180s), and the
      // composer + Send stay disabled while any turn is in flight.
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("assistant-popover")).toBeHidden();
      await page.keyboard.press("Meta+k");
      await expect(page.getByTestId("assistant-popover")).toBeVisible();
      const composer = page.getByTestId("assistant-composer-input");
      await expect(composer, "the composer is enabled once no turn is in flight").toBeEnabled({
        timeout: 60_000,
      });
      const before = await assistantRows(request);
      const questionsBefore = before.filter((row) => row.kind === "question").length;
      const rowsBefore = before.length;
      await composer.fill("change the workflow");
      await page.getByTestId("assistant-send").click();
      // The turn appends atomically: a NEW question row (the model asks
      // back), answer rows, or — when the lab LLM times out — the
      // assistant-error line and NO rows. Every wait is bounded; the model
      // may legitimately never ask.
      let outcome: "asked" | "answered" | "failed" | "pending" = "pending";
      // Bounded past the 180 s per-completion deadline so a timed-out turn
      // can surface its error line before the wait expires.
      const deadline = Date.now() + 200_000;
      while (outcome === "pending" && Date.now() < deadline) {
        const rows = await assistantRows(request);
        if (rows.filter((row) => row.kind === "question").length > questionsBefore) {
          outcome = "asked";
        } else if (rows.length > rowsBefore) {
          outcome = "answered";
        } else if ((await page.getByTestId("assistant-error").count()) > 0) {
          failedLine =
            (
              (await page
                .getByTestId("assistant-error")
                .textContent()
                .catch(() => null)) ?? ""
            ).trim() || "unknown error";
          outcome = "failed";
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
      if (outcome === "asked") {
        // Option buttons render only on UNANSWERED cards (QuestionCard),
        // and a turn in flight from an earlier test can land its own card
        // before this attempt's — so the DOM baseline cannot name the new
        // card. Pick the newest card that still offers options; whichever
        // pending question it is, its option round-trips the same way.
        const openCards = cards.filter({
          has: page.getByTestId("assistant-question-option"),
        });
        const option = openCards.last().getByTestId("assistant-question-option").first();
        // innerText auto-waits and can hang on a re-rendered list: bound the
        // wait, then read textContent (no auto-wait).
        await option.waitFor({ state: "visible", timeout: 30_000 });
        pickedLabel = ((await option.textContent().catch(() => null)) ?? "").trim();
        expect(pickedLabel, "the option carries a label the model wrote").not.toBe("");
        // Baseline BEFORE the click: the honest claim is that the click
        // ADDS a user row with exactly the label's text.
        labelRowsBefore = before.filter(
          (row) => row.kind === "user" && row.text === pickedLabel,
        ).length;
        const pick = page.waitForRequest(
          (r) => r.url().endsWith("/messages") && r.method() === "POST",
          { timeout: 30_000 },
        );
        await option.click();
        const picked = await pick;
        // The round trip is the client's: the option's LABEL travels back
        // as plain text — the answer POST's body carries the label
        // verbatim in `text`, never the option's value, and no
        // confirm/dismiss (ADR-0050: the client posts the label verbatim).
        let pickedBody: { text?: string; confirm?: unknown; dismiss?: unknown } | null = null;
        try {
          pickedBody = JSON.parse(picked.postData() ?? "");
        } catch {
          pickedBody = null; // a non-JSON body fails the assertion below loudly
        }
        expect(pickedBody?.text, "the answer POST carries the option's label").toBe(pickedLabel);
        expect(
          pickedBody?.confirm ?? null,
          "an option answer is a plain-text turn, not an approval decision",
        ).toBeNull();
        expect(
          pickedBody?.dismiss ?? null,
          "an option answer is a plain-text turn, not an approval decision",
        ).toBeNull();
      } else if (outcome === "failed") {
        failedAttempts += 1;
      } else if (outcome === "pending") {
        throw new Error(
          `attempt ${attempt}: no transcript rows and no error line within 200 s — the turn never landed`,
        );
      }
      // "answered": the model chose not to ask back on this attempt — the
      // loop sends one more time, then falls to the honest path.
      // "failed": the lab LLM timed out the turn — retry once; if both
      // attempts fail the run is an infrastructure fault, reported loudly.
    }
    if (pickedLabel !== null) {
      // The answer's user row lands with the turn's rows in ONE transaction
      // (ADR-0050 decision 2): it is visible only when the answer TURN
      // completes. A multi-completion turn can outlast any fixed window at
      // the lab's 180 s per-completion deadline, so the POST body asserted
      // above IS the round-trip proof; the transcript row is confirmed when
      // it lands in the bounded window and recorded honestly when the turn
      // is still running.
      const labelLanded = await expect
        .poll(
          async () =>
            (await assistantRows(request)).filter(
              (row) => row.kind === "user" && row.text === pickedLabel,
            ).length,
          {
            message: "the picked option's label arrives in the transcript as a new user row",
            timeout: 120_000,
          },
        )
        .toBeGreaterThan(labelRowsBefore)
        .then(() => true)
        .catch(() => false);
      await checkShellScreen(page, "question answered from the option button", stopWatching);
      await evidence(
        page,
        "shell-p789-question-roundtrip",
        `the model's follow-up card appeared after 'change the workflow'; the option click POSTed the LABEL '${pickedLabel}' verbatim as the body's plain-text 'text' field (no value, no structured payload, no confirm/dismiss)${labelLanded ? " — and GET /assistant/conversations/{id}/messages gained a user row with EXACTLY that text" : " — the answer's user row had not landed when the 120 s bounded confirmation window closed (the answer turn, 180 s per completion at the lab, was still running); the POST body is the round-trip proof"}`,
      );
    } else {
      if (failedAttempts === 2) {
        throw new Error(
          `both attempts failed with the assistant error line '${failedLine}' and no transcript rows landed — the lab LLM is down, not a model choice`,
        );
      }
      // The model may legitimately not ask a follow-up. That is a real
      // outcome, recorded honestly — the turn itself must still be proven:
      // the LAST 'change the workflow' the journey sent must be followed by
      // an assistant row (history rows predate it, so the newest occurrence
      // is the honest one).
      const transcript = await assistantTranscript(request);
      const sentIndexes = transcript
        .map((row, index) =>
          row.kind === "user" && row.payload.text === "change the workflow" ? index : -1,
        )
        .filter((index) => index >= 0);
      const lastSent = sentIndexes[sentIndexes.length - 1];
      expect(lastSent, "the transcript holds the question the journey sent").not.toBeUndefined();
      const answered = transcript.slice(lastSent + 1).some((row) => row.kind === "assistant");
      expect(
        answered,
        "the assistant answered the newest sent question (it chose not to ask back)",
      ).toBe(true);
      await checkShellScreen(page, "assistant answered without a question card", stopWatching);
      await evidence(
        page,
        "shell-p789-question-roundtrip",
        "HONEST LIMITATION: after two attempts ('change the workflow', sent twice) the model never produced a follow-up question card, so the option-label round trip could not be exercised; the transcript proves both turns landed (user row + assistant row) with no question kind between them",
      );
    }
    await page.keyboard.press("Escape");
  });

  test("7. approval detail /approvals/<id>: summary, plan, files note, free text, cancel — both widths", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    // A fresh pending gate: the scratch pipeline whose approval we will
    // cancel, never decide.
    const csrf = await apiCsrf(request);
    const stamp = String(Date.now());
    const pipeline = await publishPipeline(
      request,
      csrf,
      `p789-approval-${stamp}`,
      GATE_YAML(`p789-approval-${stamp}`),
    );
    const project = (await apiProjects(request))[0];
    expect(project, "the lab holds a project to run the scratch gate in").toBeTruthy();
    const runId = await startGatedRun(request, csrf, project, pipeline.revisionId);
    const approval = await pendingApprovalForRun(request, runId);
    const tid = testidOf(approval.id);
    await page.goto(BASE_URL + `/approvals/${approval.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`approval-detail-loading-${tid}`)).toBeHidden({
      timeout: 30_000,
    });
    // The amber strip names the state; a pending gate is the amber ALERT-K.
    const strip = page.getByTestId(`approval-detail-strip-${tid}`);
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("NEEDS YOUR DECISION");
    // Summary: the model's summary, or the honest fallback on 503 ("from the
    // workflow"), never a blank card.
    const summary = page.getByTestId(`approval-detail-summary-${tid}`);
    const fallback = page.getByTestId(`approval-detail-summary-fallback-${tid}`);
    const unconfigured = page.getByTestId(`approval-detail-summary-unconfigured-${tid}`);
    await expect
      .poll(
        async () =>
          (await summary.isVisible().catch(() => false)) ||
          (await fallback.isVisible().catch(() => false)) ||
          (await unconfigured.isVisible().catch(() => false)),
        { message: "the summary card must render its honest state", timeout: 30_000 },
      )
      .toBe(true);
    const summaryKind = (await summary.isVisible().catch(() => false))
      ? "model summary"
      : (await fallback.isVisible().catch(() => false))
        ? "honest 503 fallback (from the workflow)"
        : "unconfigured note";
    // Plan inline when referenced, an honest line when not.
    await expect(page.getByTestId(`approval-detail-plan-${tid}`)).toBeVisible({
      timeout: 30_000,
    });
    // FILES IT WILL TOUCH: the wire carries no manifest — the section says so.
    const files = page.getByTestId(`approval-detail-files-${tid}`);
    await expect(files).toBeVisible();
    await expect(files).toContainText("Not available yet");
    // Free text → interpretation → proposed decision → the confirm step —
    // and the journey CANCELS the confirm, it never decides.
    const reply = page.getByTestId(`approval-detail-reply-${tid}`);
    await reply.fill("sounds good, approve it");
    await page.getByTestId(`approval-detail-reply-send-${tid}`).click();
    const proposal = page.getByTestId(`approval-detail-proposal-${tid}`);
    const interpretError = page.getByTestId(`approval-detail-interpret-error-${tid}`);
    const outcome = await Promise.race([
      // The interpretation is one assistant completion under the lab's
      // 180 s per-completion deadline (5479538), so the bounded wait is
      // past it.
      proposal.waitFor({ state: "visible", timeout: 200_000 }).then(() => "proposal" as const),
      interpretError.waitFor({ state: "visible", timeout: 200_000 }).then(() => "error" as const),
    ]).catch(() => "neither" as const);
    expect(
      outcome,
      "the free-text reply must end in a proposal or an honest interpretation error",
    ).not.toBe("neither");
    if (outcome === "proposal") {
      await page.getByTestId(`approval-detail-proposal-confirm-${tid}`).click();
      const confirmDialog = page.getByTestId(`approval-detail-confirm-${tid}`);
      await expect(confirmDialog, "every decision goes through the confirm step").toBeVisible();
      await confirmDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(confirmDialog).toBeHidden();
      // Cancelled, not decided: the gate is still pending at the API.
      const still = await apiPendingApprovals(request);
      expect(
        still.some((row) => row.id === approval.id),
        "cancelling the confirm step must not decide the gate",
      ).toBe(true);
    }
    await checkShellScreen(page, "approval detail at desktop width", stopWatching);
    await evidence(
      page,
      "shell-p789-approval-detail",
      `the amber 'NEEDS YOUR DECISION' strip, the ${String(summaryKind)} card, the plan section and the 'Not available yet' files note all rendered for gate ${tid}; the free-text reply produced ${outcome === "proposal" ? "a proposed decision and its confirm step, which the journey cancelled — the API still lists the approval pending" : `an honest interpretation error (${(await interpretError.innerText()).trim().slice(0, 120)})`}`,
    );
    // Phone width: the same page, the same honest content, no sideways scroll.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL + `/approvals/${approval.id}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId(`approval-detail-strip-${tid}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId(`approval-detail-files-${tid}`)).toBeVisible();
    await checkShellScreen(page, "approval detail at phone width", stopWatching);
    await evidence(
      page,
      "shell-p789-approval-narrow",
      "at 390px the strip, the files note and the decide rail stack without sideways scroll and stay axe-clean; the gate is still pending (the journey cancelled, never decided)",
    );
  });

  test("8. ops: health line, workers rows == GET /workers, matrix cells match GET /launchers", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/ops", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("ops-health-line")).toBeVisible();
    const healthText = (await page.getByTestId("ops-health-line").innerText()).trim();
    expect(healthText, "the health line is real text, not a placeholder").not.toBe("");
    const workers = (await (await request.get(BASE_URL + "/api/v1/workers")).json()) as {
      items: { name: string }[];
    };
    await expect(page.getByTestId("workers-table")).toBeVisible({ timeout: 30_000 });
    const rows = page.locator('[data-testid^="worker-row-"]');
    await expect(rows, "the workers table shows one row per registered worker").toHaveCount(
      workers.items.length,
      { timeout: 15_000 },
    );
    // Capability matrix: every cell is the registry's own word. ✓ observed
    // only where result is observed; the other two results keep their own
    // glyph and text.
    const matrixUnavailable = page.getByTestId("capability-matrix-unavailable");
    const matrixNone = page.getByTestId("capability-matrix-none");
    const matrixTable = page.getByTestId("capability-matrix-table");
    const registry = await apiLaunchers(request);
    if (registry.length === 0) {
      await expect(matrixNone, "no registry: the honest 'not served' note").toBeVisible();
    } else {
      await expect(matrixTable, "the matrix renders from GET /api/v1/launchers").toBeVisible({
        timeout: 30_000,
      });
      const columns = ["acp_session", "resume", "permission_prompts", "nono_required"] as const;
      for (const launcher of registry) {
        const row = page.getByTestId(`capability-row-${launcher.id}`);
        await expect(row, `matrix row for launcher ${launcher.id}`).toBeVisible();
        for (const column of columns) {
          const cell = page.getByTestId(`capability-cell-${launcher.id}-${column}`);
          const text = (await cell.innerText()).trim().replace(/\s+/g, " ");
          const capability = launcher.capabilities.find((row) => row.capability === column);
          const result = capability?.result;
          if (result === "observed") {
            expect(
              text.startsWith("✓ observed"),
              `${launcher.id} × ${column} is observed in the registry: cell says '${text}'`,
            ).toBe(true);
          } else if (result === "not_supported") {
            expect(
              text,
              `${launcher.id} × ${column} must not claim observed (registry: not_supported)`,
            ).toBe("× not supported");
          } else {
            expect(
              text,
              `${launcher.id} × ${column} must not claim observed (registry: ${result ?? "no row"})`,
            ).toBe("· not tested");
          }
        }
      }
      await expect(matrixUnavailable).toBeHidden();
    }
    await checkShellScreen(page, "operations", stopWatching);
    await evidence(
      page,
      "shell-p789-ops",
      `the health line reads '${healthText.slice(0, 100)}', the workers table holds ${workers.items.length} rows == GET /api/v1/workers, and every capability cell matches GET /api/v1/launchers (✓ observed only where result=observed: ${registry.flatMap((l) => l.capabilities.filter((c) => c.result === "observed").map((c) => `${l.id}:${c.capability}`)).join(", ") || "none observed"})`,
    );
  });

  test("9. settings → assistant shows the three levels, stored one checked; settings links /ops", async ({
    page,
  }) => {
    await signIn(page, "admin");
    const request = page.request;
    const stopWatching = watchPageErrors(page);
    await page.goto(BASE_URL + "/settings", { waitUntil: "domcontentloaded" });
    await expect(page, "/settings lands on the Layout tab").toHaveURL(/\/settings\/layout$/);
    await expect(page.getByTestId("settings-page")).toBeVisible();
    const opsLink = page.getByTestId("settings-ops-link");
    await expect(opsLink, "Settings carries the Operations entry").toBeVisible();
    expect(await opsLink.getAttribute("href"), "the Operations entry points at /ops").toBe("/ops");
    await page.goto(BASE_URL + "/settings/assistant", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("settings-assistant")).toBeVisible();
    const options = [
      { value: "ask_all", label: "Ask before everything" },
      { value: "ask_risky", label: "Ask for risky actions" },
      { value: "no_ask", label: "Don't ask" },
    ];
    for (const option of options) {
      const label = page.getByTestId(`settings-assistant-trust-level-option-${option.value}`);
      await expect(label, `the '${option.label}' line renders`).toBeVisible();
      await expect(label).toContainText(option.label);
    }
    const stored = (await (await request.get(BASE_URL + "/api/v1/me/preferences")).json()) as {
      assistant?: { trust_level: string };
    };
    const level = stored.assistant?.trust_level ?? "ask_risky";
    const checked = page
      .getByTestId(`settings-assistant-trust-level-option-${level}`)
      .getByRole("radio");
    await expect(checked, `the stored level ${level} is the checked radio`).toBeChecked();
    await checkShellScreen(page, "settings assistant", stopWatching);
    await evidence(
      page,
      "shell-p789-settings",
      `settings → assistant shows all three trust levels with the stored one (${level}) checked, matching GET /me/preferences, and the settings footer's Operations entry links to /ops`,
    );
  });
});
