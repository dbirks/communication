// Shared fixtures for the e2e journey specs. Subjects are throwaway identities
// handed to the mock OIDC provider's interactive login form (ADR-0012) — they
// are not credentials and nothing secret crosses this code.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, type Response } from "@playwright/test";
import {
  AGENT_TURN_TIMEOUT_MS,
  COMPOSE_FILES,
  COMPOSE_PROJECT,
  PERMISSION_TERMINAL_CONFIRM_MS,
  PERMISSION_TIMEOUT_MS,
} from "./env.js";

/**
 * The ONE workflow-gate decision path (finding 04, `DecisionBar`). Every gate
 * surface — Today's callout, the Inbox card, `/approvals/:id`, the run
 * workbench's gate card — renders the same bar with the same FIXED verbs
 * (`decision-approve` / `decision-request-changes` / `decision-reject`) and no
 * confirm step. A click holds the `POST /api/v1/approvals/{id}/decide` for ~5s
 * behind `decision-undo` (`decision-status` counts down), then sends it once.
 *
 * So a spec never clicks a verb and moves on: it goes through this helper,
 * which (a) proves the hold line appeared rather than an instant POST, (b)
 * waits for the decide response itself (the hold makes the POST ~5s late, so a
 * `toBeVisible` on a decided card is not evidence about the wire), (c) checks
 * the wire body carries the right decision word — a rejection with a note is
 * `Request changes` (`{decision: "rejected", comments}`), the API has no third
 * verb — and (d) counts the POSTs, so the decision happens EXACTLY once.
 *
 * `scope` is the tightest container the spec has (a callout, the gate card, the
 * page); the bar is found inside it.
 */
export type GateDecision = "approve" | "reject" | "changes";

/** Locate the decide route on any origin (`/api/v1/approvals/{id}/decide`). */
function isDecidePost(response: Response): boolean {
  return (
    response.request().method() === "POST" &&
    /\/api\/v1\/approvals\/[^/]+\/decide\b/.test(response.url())
  );
}

/** A `Locator` answers `.page()`; a `Page` does not (it has `context()`). */
function pageOf(scope: Page | Locator): Page {
  return typeof (scope as Locator).page === "function"
    ? (scope as Locator).page()
    : (scope as Page);
}

/**
 * The bar inside `scope`. A spec may hand the helper the bar itself (a locator
 * already keyed on `decision-bar`), a card, a callout or a whole page — and
 * `getByTestId` only searches DESCENDANTS, so the self case is checked first.
 */
async function decisionBarOf(scope: Page | Locator): Promise<Locator> {
  if (typeof (scope as Locator).getAttribute === "function") {
    const own = await (scope as Locator).getAttribute("data-testid").catch(() => null);
    if (own === "decision-bar") return scope as Locator;
  }
  return (scope as Locator).getByTestId("decision-bar").first();
}

export async function decideGate(
  scope: Page | Locator,
  decision: GateDecision,
  comments?: string,
  opts?: { timeoutMs?: number; expectedStatus?: number; expectedVersion?: number },
): Promise<Response> {
  // The brief's floor: the hold alone is ~5s, so nothing here may time out sooner.
  const timeoutMs = Math.max(15_000, opts?.timeoutMs ?? 30_000);
  const page = pageOf(scope);
  const bar = await decisionBarOf(scope);
  await expect(bar, "the gate's ONE decision bar is on screen").toBeVisible({ timeout: timeoutMs });
  const decidePosts: Response[] = [];
  const tap = (response: Response) => {
    if (isDecidePost(response)) decidePosts.push(response);
  };
  page.on("response", tap);
  try {
    const posted = page.waitForResponse((response) => isDecidePost(response), {
      timeout: timeoutMs,
    });
    const holdWord =
      decision === "approve"
        ? "Approved"
        : decision === "reject"
          ? "Rejected"
          : "Changes requested";
    if (decision === "changes") {
      await bar.getByTestId("decision-request-changes").click({ timeout: timeoutMs });
      const note = bar.getByTestId("decision-changes-text");
      await expect(note, "Request changes asks what should change").toBeVisible({
        timeout: timeoutMs,
      });
      if (comments === undefined || comments.trim().length === 0) {
        throw new Error("decideGate: 'changes' needs the note the person wrote");
      }
      await note.fill(comments, { timeout: timeoutMs });
      await bar.getByTestId("decision-changes-send").click({ timeout: timeoutMs });
    } else {
      await bar
        .getByTestId(decision === "approve" ? "decision-approve" : "decision-reject")
        .click({ timeout: timeoutMs });
    }
    // The hold, not an instant POST: the bar folds into its counting-down status
    // line and Undo becomes the escape hatch. A click that POSTed immediately
    // would blow past this line.
    const status = bar.getByTestId("decision-status");
    await expect(
      status,
      "the click holds the decision ~5s behind Undo instead of POSTing on the click",
    ).toContainText(new RegExp(`${holdWord}\\. The run continues in \\d+s\\.`), {
      timeout: timeoutMs,
    });
    await expect(bar.getByTestId("decision-undo"), "Undo is offered").toBeVisible({
      timeout: timeoutMs,
    });
    const response = await posted;
    expect(response.status(), "the decide POST's answer").toBe(opts?.expectedStatus ?? 200);
    const body = (
      response.request().postData() ? JSON.parse(response.request().postData()!) : {}
    ) as {
      decision?: string;
      comments?: string;
      version?: number;
    };
    // The API knows only `approved` | `rejected`; "Request changes" is a
    // rejection carrying the person's note.
    expect(body.decision, "the wire's decision word").toBe(
      decision === "approve" ? "approved" : "rejected",
    );
    if (decision === "changes") {
      expect(body.comments, "the note rides the rejection").toBe(comments!.trim());
    } else {
      expect(body.comments ?? "", "a bare verb carries no note").toBe("");
    }
    if (opts?.expectedVersion !== undefined) {
      // The CAS token the bar sends with the decision. It used to be printed on
      // the card (`approval-cas-version`); finding 04 folded it into the bar, so
      // the version claim is now read off the wire instead of off a label.
      expect(body.version, "the decide carries the row's CAS version").toBe(opts.expectedVersion);
    }
    // Exactly once: the hold has already elapsed, so a stray second POST (an
    // unmount flush racing the timer) would show up in this short settle.
    await page.waitForTimeout(1_000);
    expect(decidePosts.length, "the gate is decided exactly once").toBe(1);
    return response;
  } finally {
    page.off("response", tap);
  }
}

/** Throwaway mock-IdP subjects used across the suite. */
export const ADMIN_SUBJECT = "admin";
export const OUTSIDER_SUBJECT = "mallory";

/**
 * Navigate inside the app, tolerating the one window where the load balancer
 * has no healthy upstream: right after a replica restart, caddy can answer 502
 * for a few seconds (observed in the M1 restart → next-test handoff), and a
 * blank error page is what makes a later locator hang instead of fail.
 */
export async function gotoApp(page: Page, path = "/"): Promise<void> {
  for (let attempt = 1; attempt <= 10; attempt++) {
    const response = await page.goto(path, { waitUntil: "domcontentloaded" });
    if (response && response.ok()) return;
    await page.waitForTimeout(1_000);
  }
  throw new Error(`the app never answered 200 for ${path} on ${page.url()}`);
}

/**
 * Sign in through the mock OIDC provider: the app's `sign-in` link leaves the
 * SPA for `/auth/login`, which redirects to the IdP's interactive form
 * (`Enter any user/subject` + optional claims JSON — no real credentials).
 *
 * `claims` are written into the IdP's "Optional claims JSON" box, which is how
 * a journey gets a readable profile (`name`, `email`) instead of the bare
 * subject — the app derives a display name from the id token (ADR-0012 §4).
 */
export async function signIn(
  page: Page,
  subject: string,
  claims?: Record<string, unknown>,
): Promise<void> {
  await gotoApp(page, "/");
  await page.getByTestId("sign-in").click();
  const subjectField = page.getByPlaceholder("Enter any user/subject");
  await expect(subjectField).toBeVisible();
  await subjectField.fill(subject);
  if (claims) {
    const claimsField = page.getByPlaceholder(/Optional claims JSON/);
    await expect(claimsField).toBeVisible();
    await claimsField.fill(JSON.stringify(claims));
  }
  await page.getByRole("button", { name: "Sign-in" }).click();
  // The IdP redirect chain ends on the lab's own embedded UI origin (the
  // OIDC callback is registered there); the session cookie is shared per
  // host, so a fresh navigation to the app under test (baseURL) is signed in.
  // Every later relative `page.goto` in the suite resolves against baseURL,
  // so the suite works on the dev server's live tree from here on.
  await gotoApp(page, "/");
  await expect(page.getByTestId("user-badge")).toBeVisible();
}

/** Add a repository through the project page form and wait for its row. */
export async function addRepository(
  page: Page,
  projectUrl: string,
  name: string,
  gitUrl: string,
): Promise<void> {
  await page.goto(projectUrl);
  await revealAddForm(page, "repo-add-toggle", page.getByTestId("repo-name"));
  await page.getByTestId("repo-name").fill(name);
  await page.getByTestId("repo-git-url").fill(gitUrl);
  await page.getByTestId("repo-submit").click();
  await expect(rowFor(page, name)).toBeVisible();
}

/**
 * The overview's add-forms are collapsed behind a toggle (open by default only
 * on an empty project), so a helper must open the form before filling it.
 */
async function revealAddForm(page: Page, toggleTestid: string, firstField: Locator): Promise<void> {
  const toggle = page.getByTestId(toggleTestid);
  // The toggle renders as soon as the panel knows the viewer is a maintainer;
  // waiting on it avoids racing the SPA's first data fetch.
  await expect(toggle.or(firstField).first()).toBeVisible();
  if (!(await firstField.isVisible())) {
    await toggle.click();
  }
  await expect(firstField).toBeVisible();
}

/**
 * The members page of a project, from the project's own URL (the overview).
 * Design 1b: the members panel and the event feed moved off `/p/<id>`; the form
 * they contain lives at `/p/<id>/members`, linked from the overview's footnote.
 */
export function projectMembersUrl(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, "")}/members`;
}

/** The repo table row for a given repository name. */
export function rowFor(page: Page, name: string) {
  return page.getByTestId(`repo-row-${name}`);
}

/** Select the `<select>` whose option text mentions `text`, by that option's value. */
export async function selectByOptionText(page: Page, testid: string, text: string): Promise<void> {
  const select = page.getByTestId(testid);
  const option = select.locator("option", { hasText: text });
  await expect(option.first()).toBeAttached();
  const value = await option.first().getAttribute("value");
  await select.selectOption(value ?? "");
}

/**
 * Add `displayName` to the project as a member with `role`.
 *
 * The members panel is not on the overview any more (Projects Review design 1b
 * put the tabs across the header and moved members off it), so the member form
 * is driven on the page that hosts it: `/p/<id>/members`.
 */
export async function addMember(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectMembersUrl(projectUrl));
  await revealAddForm(page, "member-add-toggle", page.getByTestId("member-user"));
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(page.getByTestId(`member-row-${displayName}`)).toContainText(`role: ${role}`);
}

/**
 * Open the overview's collapsed add-form, retrying the toggle. Under heavy
 * live churn (workspace rows updating, parallel members saving) the toggle
 * click can land on a re-rendering header and be lost, leaving the form
 * closed. The reveal is therefore retried — bounded, and each retry re-reads
 * the page — before giving up.
 */
export async function revealAddFormRetrying(
  page: Page,
  toggleTestid: string,
  firstField: Locator,
  attempts = 4,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await firstField.isVisible().catch(() => false)) return;
    const toggle = page.getByTestId(toggleTestid);
    await expect(toggle).toBeVisible();
    await toggle.click();
    const opened = await firstField
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
    // The click was lost: reload the overview and try the toggle again.
    await page.reload();
  }
  throw new Error(`the ${toggleTestid} form never opened after ${attempts} attempts`);
}

/** `addMember`, but the form reveal survives a lost toggle click. */
export async function addMemberRetrying(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectMembersUrl(projectUrl));
  await revealAddFormRetrying(page, "member-add-toggle", page.getByTestId("member-user"));
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(page.getByTestId(`member-row-${displayName}`)).toContainText(`role: ${role}`);
}

/**
 * Idempotent member setup. The overview's add form is collapsed behind the
 * "Add member" toggle, and a single click can lose a race with the panel's
 * live re-render — the toggle's click lands but the field never mounts, so the
 * shared `revealAddForm`'s one-shot click times out. This helper first takes
 * the fast path (the row already carries the target role — true once a prior
 * run added the member) and only otherwise opens the form, RE-CLICKING the
 * toggle in a bounded loop until the user select is actually present. The add
 * flow is add-OR-update (PUT), so a seeded role is corrected through it.
 */
export async function setMember(
  page: Page,
  projectUrl: string,
  displayName: string,
  role: string,
): Promise<void> {
  await page.goto(projectMembersUrl(projectUrl));
  const row = page.getByTestId(`member-row-${displayName}`);
  if ((await row.count()) > 0 && ((await row.textContent()) ?? "").includes(`role: ${role}`)) {
    return;
  }
  const toggle = page.getByTestId("member-add-toggle");
  const field = page.getByTestId("member-user");
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; attempt < 6 && (await field.count()) === 0; attempt += 1) {
    if (!(await toggle.isVisible().catch(() => false))) continue;
    await toggle.click();
    await field.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
  }
  await expect(field).toBeVisible();
  await selectByOptionText(page, "member-user", displayName);
  await page.getByTestId("member-role").selectOption(role);
  await page.getByTestId("member-submit").click();
  await expect(row).toContainText(`role: ${role}`);
}

/** Start a conversation from the project page; resolves to its app path. */
export async function startConversation(
  page: Page,
  projectUrl: string,
  options: { title: string; profile: string; prompt: string },
): Promise<string> {
  await page.goto(projectUrl);
  // Design 1b: the thread-list panel (and its `New thread` button) moved to the
  // Threads tab; the overview's own header verb opens the same dialog, with the
  // project fixed. The create form lives in a dialog; open it before the fields
  // exist.
  await page.getByTestId("project-new-conversation").click();
  await page.getByTestId("new-conversation-dialog").waitFor();
  await page.getByTestId("conversation-new-title").fill(options.title);
  await selectByOptionText(page, "conversation-new-profile", options.profile);
  await page.getByTestId("conversation-new-prompt").fill(options.prompt);
  await page.getByTestId("conversation-new-submit").click();
  // The standalone thread page (route contract C1: conversations live at
  // `/threads/:conversationId`; the old `/projects/…/conversations/…` URL
  // redirects to it, but the canonical target is what is asserted).
  await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Send a prompt from an open conversation page (the controller's composer). */
export async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const composer = page.getByTestId("composer-input");
  await expect(composer).toBeEnabled();
  await composer.fill(prompt);
  await page.getByTestId("composer-send").click();
  // The prompt is accepted into the journal, not echoed by the response body.
  await expect(page.getByTestId("composer-input")).toHaveValue("");
}

/**
 * Wait for the newest turn to reach a terminal status. `turn-status` is the
 * page's one description of the turn (`describeTurn`), and a real agent turn is
 * measured in model round-trips, not milliseconds.
 */
export async function expectTurnStatus(
  page: Page,
  status: RegExp,
  timeout = AGENT_TURN_TIMEOUT_MS,
): Promise<void> {
  await expect(page.getByTestId("turn-status")).toContainText(status, { timeout });
}

/** The permission card that is still waiting for a human, if any. */
export function openPermissionCard(page: Page): Locator {
  return page.getByTestId("permission-card").filter({ hasText: "awaiting a decision" });
}

/**
 * The turn statuses with no future for a permission request, read off the
 * page's own words (`turnStatusText` in `ui/src/api/transcript.ts`:
 * `completed (…)`, `cancelled (…)`, `failed (…)`, `stopped — outcome
 * unknown`). A turn in one of these states can never raise the card, so a wait
 * for the card must stop rather than sit out its budget.
 */
const TERMINAL_TURN_STATUS = /completed|cancelled|failed|stopped — outcome unknown/i;
/** Statuses that prove the wait is watching a LIVE turn (not a stale chip). */
const LIVE_TURN_STATUS = /idle|queued|starting|running/i;

/** One locator's text, whitespace-flattened, or "" when it is not on the page. */
async function flattenedText(target: Locator): Promise<string> {
  const raw = await target.innerText().catch(() => "");
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** The page's own description of the newest turn, or "" when it is not there. */
async function readTurnStatus(page: Page): Promise<string> {
  return flattenedText(page.getByTestId("turn-status").first());
}

/** The last transcript line, flattened and clipped — the failure's last fact. */
async function readLastTranscriptLine(page: Page): Promise<string> {
  const items = page.getByTestId("transcript-item");
  const count = await items.count().catch(() => 0);
  if (count === 0) return "(no transcript lines)";
  const text = await flattenedText(items.nth(count - 1));
  if (!text) return "(last transcript line empty)";
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

export interface OpenPermissionWaitOptions {
  /** Ceiling for the card to appear; defaults to the permission budget. */
  timeout?: number;
  /** Extra sentence fragment named in the failure (e.g. the profile under test). */
  context?: string;
}

/**
 * Wait for exactly ONE permission card awaiting a decision, and fail FAST when
 * it can no longer come.
 *
 * The budget ({@link PERMISSION_TIMEOUT_MS} in env.ts, evidence there for
 * issue #28) is sized for a live agent that stalls an upstream tool-call stream
 * for ~3 minutes and then retries — so it is minutes, not seconds. Waiting it
 * out blindly would turn a dead turn into a multi-minute hang, so the wait also
 * reads the page's own turn status while it polls: the moment a LIVE turn has
 * been seen and it then reaches a terminal status (`completed`, `cancelled`,
 * `failed`, `stopped`) with no card, the wait fails immediately with a message
 * naming that turn status and the last transcript line, instead of sitting out
 * the budget. The terminal read is confirmed for {@link
 * PERMISSION_TERMINAL_CONFIRM_MS} only while no live turn has been observed
 * yet, because the chip can still describe the PREVIOUS turn for a moment after
 * a prompt is accepted (it reads `cancelled`/`completed` until the new turn's
 * first event lands).
 *
 * Resolves to the open-card locator once exactly one card matches; on a timeout
 * or a dead turn it throws (no assertion is softened: a card that never arrives
 * still fails the journey).
 */
export async function waitForOpenPermission(
  page: Page,
  { timeout = PERMISSION_TIMEOUT_MS, context = "" }: OpenPermissionWaitOptions = {},
): Promise<Locator> {
  const pending = openPermissionCard(page);
  const deadline = Date.now() + timeout;
  let sawLiveTurn = false;
  let terminalSince = 0;
  let lastStatus = "";
  let lastCount = 0;
  const fail = async (reason: string): Promise<never> => {
    const status = (lastStatus || (await readTurnStatus(page)) || "(no turn-status)").replace(
      /\s+/g,
      " ",
    );
    const line = await readLastTranscriptLine(page);
    throw new Error(
      `no single open permission card on ${page.url()} ${reason} ` +
        `(cards awaiting a decision: ${lastCount}; turn status: "${status}"; ` +
        `last transcript line: ${line})${context ? ` — ${context}` : ""}`,
    );
  };
  for (;;) {
    lastCount = await pending.count().catch(() => 0);
    if (lastCount === 1) return pending;
    lastStatus = await readTurnStatus(page);
    if (LIVE_TURN_STATUS.test(lastStatus)) {
      sawLiveTurn = true;
      terminalSince = 0;
    } else if (TERMINAL_TURN_STATUS.test(lastStatus)) {
      if (sawLiveTurn) await fail("never appeared — the turn is over");
      terminalSince = terminalSince === 0 ? Date.now() : terminalSince;
      if (Date.now() - terminalSince >= PERMISSION_TERMINAL_CONFIRM_MS) {
        await fail(
          `stayed absent while the turn was already over for ${PERMISSION_TERMINAL_CONFIRM_MS}ms`,
        );
      }
    } else {
      terminalSince = 0;
    }
    if (Date.now() >= deadline) await fail(`within ${timeout}ms`);
    await page.waitForTimeout(1_000);
  }
}

/**
 * A handle to ONE specific permission card, captured while it is on screen.
 * The app stamps `data-permission-request-id` on the card's transcript row
 * (`ui/src/components/Transcript.tsx`); a page built before that markup falls
 * back to the positional handle, which is sound for the same reason: decided
 * cards are never removed from the transcript and new cards only ever append,
 * so a card's index among `permission-card`s does not shift under a decision.
 */
export interface PermissionCardRef {
  requestId: string | null;
  position: number;
}

/** Pin one card (default: the single open one) BEFORE it is decided. */
export async function pinPermissionCard(page: Page, card?: Locator): Promise<PermissionCardRef> {
  const target = card ?? openPermissionCard(page).first();
  const ref = await target.evaluate((el) => {
    const cards = Array.from(document.querySelectorAll('[data-testid="permission-card"]'));
    const id =
      el.getAttribute("data-permission-request-id") ??
      el.closest("[data-permission-request-id]")?.getAttribute("data-permission-request-id");
    return { requestId: id ?? null, position: cards.indexOf(el) };
  });
  if (ref.requestId === null && ref.position < 0)
    throw new Error("the permission card vanished before it could be pinned to an identity");
  return ref;
}

/** The one card a previous {@link pinPermissionCard} captured. */
export function pinnedPermissionCard(page: Page, ref: PermissionCardRef): Locator {
  // The request id is a UUID ([0-9a-f-]), safe inside a quoted attribute
  // selector without escaping.
  return ref.requestId !== null
    ? page.locator(
        `[data-permission-request-id="${ref.requestId}"] [data-testid="permission-card"]`,
      )
    : page.getByTestId("permission-card").nth(ref.position);
}

/**
 * Allow the open permission request as the controller, preferring the
 * allow-once option (Claude's `"Yes"`) over an "always allow" that would stop
 * the journey from ever asking again. The card is PINNED to its own identity
 * before the click and the decided assertion is made on that same card only —
 * never on a transcript-wide count, because earlier turns of the same
 * conversation can hold decided cards (e.g. a cancelled turn's request) that
 * would make any transcript-wide count a coin flip on real-agent behaviour.
 * Resolves once that exact request is journalled as decided with the chosen
 * option (and, when `expectedBy` is given, by that person), and returns the
 * option label.
 *
 * Note the trap this avoids: `openPermissionCard` filters on "awaiting a
 * decision", so a decided card stops matching it — asserting "says decided"
 * through that filter can never be true. The closed state is read from the
 * pinned card instead.
 */
export async function allowOpenPermission(
  page: Page,
  timeout = PERMISSION_TIMEOUT_MS,
  expectedBy?: string,
): Promise<string> {
  const pending = await waitForOpenPermission(page, { timeout });
  const ref = await pinPermissionCard(page, pending.first());
  const yes = pending.getByRole("button", { name: "Yes", exact: true });
  const chosen = (await yes.count()) > 0 ? yes.first() : pending.getByTestId("permission-allow");
  const label = (await chosen.textContent())?.trim() ?? "";
  await chosen.click();
  const decided = pinnedPermissionCard(page, ref);
  await expect(decided).toHaveCount(1, { timeout });
  await expect(decided).toContainText("status: decided", { timeout });
  if (label) await expect(decided).toContainText(`answered "${label}"`, { timeout });
  if (expectedBy) await expect(decided).toContainText(`by ${expectedBy}`, { timeout });
  return label;
}

/** Become the controller, retrying a read that went stale mid-flight (§9 CAS). */
export async function takeControl(page: Page, timeout = 120_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const back = page.getByTestId("return-control");
        if (await back.isVisible().catch(() => false)) return true;
        const btn = page.getByTestId("take-control");
        if (await btn.isEnabled().catch(() => false))
          await btn.click({ timeout: 5_000 }).catch(() => {});
        return false;
      },
      { timeout, intervals: [1_000] },
    )
    .toBe(true);
}

/**
 * Put the page back at the top of EVERY scroll container before a `fullPage`
 * capture, then wait two animation frames so the paint reflects it.
 *
 * A `fullPage` screenshot is stitched from the page's scroll position, and a
 * sticky top bar paints at that position — so a journey that auto-scrolled a
 * clicked row leaves the bar's ink stitched MID-PAGE over the content in the
 * 390 captures (observed in the emulator's phone shots: the app-shell band
 * crossing the transcript). Nothing is restored afterwards: the capture is
 * evidence of the screen as designed (from the top), not of wherever the last
 * click happened to leave it.
 *
 * The reset covers the document (`window` + `documentElement`/`body`) AND every
 * element holding a scroll offset — the app scrolls `window` on some pages and
 * its own `<main>` on others, and a capture must not depend on which.
 *
 * ONE exception: an element carrying `data-capture-keep-scroll` keeps its
 * scroll offset. The marker names the surfaces where the PRODUCT owns the
 * reader's view — the thread's transcript scroller, whose offset the
 * transcript pin (`ui/src/components/conversation/useTranscriptScroll.ts`)
 * holds at the newest row. Resetting it reads the reader as scrolled up and
 * re-pins mid-reflow, so the capture caught a transient harness state where
 * the newest reply sat under the composer while the live page's own pin check
 * passed. Descendants are NOT shielded by the marker: an element reset
 * applies to the marked container only, and a scrollable inside it (a code
 * block) still resets.
 */
export async function scrollToTopForCapture(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const twoFrames = () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    const resetAll = () => {
      window.scrollTo(0, 0);
      for (const el of [document.documentElement, document.body]) {
        if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
          el.scrollTop = 0;
          el.scrollLeft = 0;
        }
      }
      for (const el of Array.from(document.querySelectorAll("*"))) {
        // The product-owned reader view keeps its place (see the header
        // note on `data-capture-keep-scroll`).
        if (el.hasAttribute("data-capture-keep-scroll")) continue;
        if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
        el.scrollTop = 0;
        el.scrollLeft = 0;
      }
    };
    resetAll();
    await twoFrames();
    // A frame later the layout may have settled somewhere else again (a
    // virtualised list, a scroll-restoring effect); one more pass, then paint.
    resetAll();
    await twoFrames();
  });
}

/**
 * A screenshot of the current screen into the repo's gitignored browser
 * output directory (`.playwright-cli/`) — never into the working tree, and
 * never a build artifact a human has to clean up afterwards.
 */
export async function shot(page: Page, name: string): Promise<string> {
  const dir = path.join(repoRoot, ".playwright-cli");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await scrollToTopForCapture(page);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/**
 * The `data-testid` suffix the app itself computes for an id
 * (`ui/src/lib/format.ts`'s `testidOf`: first 13 alphanumeric characters, so
 * UUIDs that differ only in their fourth group cannot collide). A journey that
 * must name one row out of a list has to spell the id the same way the page
 * does.
 */
export function testidOf(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

/** The tail an id is *shown* by (`shortId` in the same file): last 8 characters. */
export function shortRefOf(id: string): string {
  return id.slice(-8);
}

/**
 * Pin a project's pipeline assignment to an exact published revision so that
 * NEW runs start from that revision (re-pinning is effective at new-run
 * creation only; running runs keep their snapshot). A SETUP call — the journey
 * that follows starts the run through the UI. `page.request` shares the
 * signed-in browser session, and the CSRF token is echoed exactly the way the
 * app's `apiFetch` does it (from `GET /api/v1/me`).
 *
 * Creates the assignment when the pipeline has none yet, otherwise re-pins the
 * existing row. Resolves the revision's uuid from its `sha256:…` digest (route
 * 13 accepts a digest as its id, ADR-0021 § 5).
 */
export async function repinAssignment(
  page: Page,
  projectId: string,
  pipelineId: string,
  revisionDigest: string,
): Promise<void> {
  const me = (await (await page.request.get("/api/v1/me")).json()) as { csrf_token: string };
  const headers = { "x-csrf-token": me.csrf_token };
  const revision = (await (
    await page.request.get(`/api/v1/revisions/${revisionDigest}`)
  ).json()) as { id: string };
  const list = (await (
    await page.request.get(`/api/v1/projects/${projectId}/assignments`)
  ).json()) as { assignments: { id: string; pipeline_id: string }[] };
  const existing = (list.assignments ?? []).find((entry) => entry.pipeline_id === pipelineId);
  if (existing) {
    const response = await page.request.patch(`/api/v1/assignments/${existing.id}`, {
      data: { pinned_revision_id: revision.id },
      headers,
    });
    if (!response.ok())
      throw new Error(`re-pin failed (${response.status()}): ${await response.text()}`);
    return;
  }
  const response = await page.request.post(`/api/v1/projects/${projectId}/assignments`, {
    data: { pipeline_id: pipelineId, pinned_revision_id: revision.id },
    headers,
  });
  if (!response.ok()) {
    throw new Error(`create assignment failed (${response.status()}): ${await response.text()}`);
  }
}

/**
 * Open a project from the project list by its slug; resolves to its app path
 * (`/p/<uuid>`, route contract C1), which every section link is built from.
 */
export async function openProjectBySlug(page: Page, slug: string): Promise<string> {
  // The project list is its own page now (route contract C1: `/projects`);
  // the home briefing no longer renders the project cards.
  await gotoApp(page, "/projects");
  await page.getByTestId(`project-link-${slug}`).click();
  await expect(page.getByTestId("project-name")).toBeVisible();
  return new URL(page.url()).pathname;
}

/**
 * Wait for the run inspector's own statement of the run's status. The chip is
 * the page's single description of it (`RunStatusChip`), and a real run is
 * measured in worker polls, not milliseconds — so the wait is bounded here and
 * nowhere else.
 */
export async function expectRunStatus(page: Page, status: RegExp, timeout: number): Promise<void> {
  await expect(page.getByTestId("run-header-status")).toContainText(status, { timeout });
}

/**
 * Click a Run Workbench header action (redesign finding 11, RunHeader.tsx):
 * the header carries ONE primary action inline per run state (waiting →
 * `run-review-plan`, failed → `run-retry` "Retry step", running →
 * `run-pause`) and every other action rides the ⋯ menu — `run-more-actions`
 * opens `run-more-menu`, whose items are only in the DOM while it is open
 * (the ds `Menu` renders nothing when closed). Click the id inline when the
 * header shows it there, else open ⋯ and click it in the menu.
 */
export async function clickRunAction(page: Page, testid: string, timeout = 15_000): Promise<void> {
  const action = page.getByTestId(testid);
  if (await action.isVisible().catch(() => false)) {
    await action.click({ timeout });
    return;
  }
  await page.getByTestId("run-more-actions").click({ timeout });
  await expect(page.getByTestId("run-more-menu")).toBeVisible({ timeout });
  await action.click({ timeout });
}

/**
 * The strict counterpart of `clickRunAction`: the header offers this action
 * NOWHERE — not inline and not in the ⋯ menu. A closed-menu `toHaveCount(0)`
 * proves nothing about a menu-borne verb (its items are not mounted until the
 * menu opens), so this opens ⋯ first and only then asserts the absence.
 */
export async function expectRunActionAbsent(
  page: Page,
  testid: string,
  timeout = 30_000,
): Promise<void> {
  await expect(page.getByTestId(testid), `no inline ${testid}`).toHaveCount(0, { timeout });
  const more = page.getByTestId("run-more-actions");
  await expect(more, "the ⋯ trigger is part of every run header").toBeVisible({ timeout });
  await more.click({ timeout });
  await expect(page.getByTestId("run-more-menu")).toBeVisible({ timeout });
  await expect(page.getByTestId(testid), `${testid} is not in the ⋯ menu either`).toHaveCount(0);
  await page.keyboard.press("Escape");
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Regression gate for the app-shell redesign: the old top app bar is gone —
 * Sidebar v3 replaced it, so no `header` or `nav` may carry the old bar's
 * `aria-label="Primary"` any more. The sidebar's own `aside` (a complementary
 * region, not a header or nav) may keep the label; that is not the app bar.
 */
export async function expectNoLegacyAppBar(page: Page): Promise<void> {
  await expect(page.locator('header[aria-label="Primary"]')).toHaveCount(0);
  await expect(page.locator('nav[aria-label="Primary"]')).toHaveCount(0);
}

/**
 * Restart services through the same compose invocation the suite runs against
 * (`E2E_COMPOSE_FILES`), never a raw container id, so the e2e project's own
 * layers decide what a restart means.
 */
export function restartComposeServices(...services: string[]): void {
  const args = ["compose", "-p", COMPOSE_PROJECT];
  for (const file of COMPOSE_FILES) args.push("-f", file);
  args.push("restart", ...services);
  execDocker(args);
}

/**
 * The env the compose layers interpolate against. `compose.real.yml` marks
 * the gateway key vars REQUIRED (`:?`) — docker compose resolves them on
 * EVERY subcommand, `restart` included, even though a restart never applies
 * new config. A runner that started the lab with these exported does not
 * hand them to the Playwright process, so fall back to the documented host
 * file (the file form compose.real.yml itself names): only the variables
 * that are absent get filled, and the key's contents never leave the child
 * environment (nothing here prints them).
 */
function composeInterpolationEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const keyFile =
    env.COMMUNICATION_LLM_API_KEY_HOST_FILE ??
    path.join(process.env.HOME ?? "", ".config", "communication", "llmc-api-key");
  if (!env.COMMUNICATION_LLM_API_KEY_HOST_FILE && existsSync(keyFile)) {
    env.COMMUNICATION_LLM_API_KEY_HOST_FILE = keyFile;
  }
  if (!env.LLMC_API_KEY && existsSync(keyFile)) {
    env.LLMC_API_KEY = readFileSync(keyFile, "utf8").trim();
  }
  return env;
}

/**
 * Run one docker command against the daemon. On this host the runner user
 * is not in the `docker` group — the socket refuses it (`permission denied
 * … docker.sock`) — while passwordless sudo is available, so the first
 * permission-denied answer falls back to `sudo -n -E docker` and every later
 * call goes straight there.
 */
let dockerNeedsSudo = false;
/** Exported for lab-launcher.ts's seed upsert (same stack, same sudo fallback). */
export function execDocker(args: string[]): Buffer {
  const env = composeInterpolationEnv();
  const run = (prefix: string[]) =>
    execFileSync(prefix[0], [...prefix.slice(1), ...args], {
      cwd: repoRoot,
      env,
      stdio: "pipe",
      timeout: 180_000,
    });
  if (dockerNeedsSudo) return run(["sudo", "-n", "-E", "docker"]);
  try {
    return run(["docker"]);
  } catch (error) {
    const message = `${(error as { stderr?: Buffer | string }).stderr ?? error}`;
    if (!/permission denied.*docker\.sock/i.test(message)) throw error;
    dockerNeedsSudo = true;
    return run(["sudo", "-n", "-E", "docker"]);
  }
}
