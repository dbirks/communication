// Journeys for handoff-repo-chat-nav (docs/design/handoff-repo-chat-nav/) —
// the shell, the repo page (List + Lanes), repo chats, thread → workflow, the
// Inputs tab and the run-by-hand form. The handoff's renders reuse the OLD
// badge numbers (its 2e is not the Workflows Review's 2e), so every badge
// here is namespaced `rcn-` — env.ts `EMU_DESIGN_DIRS` maps `rcn-3a` to
// handoff-repo-chat-nav/png/3a.png without touching anyone's files.
//
// What the journeys play (the handoff's final picks):
//   rcn-3c — the one left sidebar: collapse to the rail, hover a rail project
//            tile for its flyout, and the collapsed state surviving a reload (a
//            saved layout pref). Plus the project's own configure surface the
//            sidebar's ⋯ menu used to hold — finding 09 moved it to the project
//            header (`+ Repository` opening its dialog in place, `Settings`) and
//            to the settings page's Settings | Members tab strip. Ends
//            EXPANDED so the next journey of any pass starts from the default.
//   rcn-3a — the repo List view: the chat box (type + Start lands in the new
//            repo-scoped chat), the All/Runs/Chats/Mine chips, the WORKFLOWS
//            row (trigger line + latest-result line + Run), and the OPEN
//            ISSUES panel — which on the lab's file:// repo is the honest
//            `Issue hand-offs need a GitHub repository` state, never a fake
//            issue row to Hand off (mockdata rule). Plus the feed's empty
//            state and its runs-read server error, the way empty-error.spec.ts
//            and server-error.spec.ts do theirs. And ASSISTANT NOTICED with a
//            note the MODEL wrote (`rcn-3a repo-notes`): the notes journey
//            never writes a row — the only thing it does is the repo page's own
//            `GET …/repos/{r}/notes`, which IS the generator's trigger
//            (ADR-0071 § Decision 6) — waits (bounded) for the assistant to
//            answer about `server`, whose DATA block is the pass's runs on that
//            repository and its real open GitHub issues, then draws the note
//            with its one allowlisted action and dismisses it for good.
//   rcn-3b — Lanes: the switch, the four lanes with the WORKFLOWS chip row,
//            the honest empty issues lane on the file:// repo (which cannot
//            have GitHub issues at all), and the choice persisting per repo
//            across a reload. Ends back on List. The DRAG half of 3b plays on
//            `server`, whose ISSUES lane reads a real tracker: a real HTML5
//            drag drops an issue on RUNNING, the `START #<n> WITH` menu offers
//            the pass's `Emu lanes` pin (the one pin whose pinned revision
//            declares the ADR-0066 `github_issue` input), and the run the drop
//            posts is read back through the API — then cancelled.
//   rcn-2e + rcn-1h — the chat: control handoff, the composer's agent chip
//            ("NEXT TURN RUNS ON"), a real turn on one profile, a switch to
//            another (the transcript divider), a second real turn, and the
//            side panel's AGENTS IN THIS CHAT with its turn ranges. The WORKS
//            IN switcher (ADR-0067 amendment) moves the chat to "Whole
//            project" and back — the ds Menu's rows and tick, and the
//            transcript's "moved this chat to …" system line in both
//            directions.
//   rcn-2f — the side panel's `Make a workflow…` opens the assistant panel
//            with the chat as context. The ask is the app's own canned line;
//            what the model answers with is deliberately NOT asserted. Run
//            as the ORG ADMIN (rcn-review11-2f): the library draft the flow
//            saves needs the library role, which alice — the project
//            maintainer — does not hold, so her entry is disabled with the
//            reason and the journey verifies the flow on the admin session.
//   rcn-1j — the Inputs tab: add a GitHub-issue input and a required text
//            input no trigger fills, save the draft, and read the WHO FILLS
//            rows — the by-hand line, the trigger's ✓ and the server's `!`.
//   rcn-1k — Run from the repo's workflow row opens the form whose fields are
//            built from the pinned revision's declared inputs. The 1k screen
//            itself — the ISSUE PICKER — plays on `server` with the pass's
//            `Emu lanes` pin, the one pin whose revision declares the
//            `github_issue` input, and is captured with the picker open over
//            real GitHub issues; the `Emu rcn` pin's goal/repository/revision
//            form keeps its own screen (`rcn-1k run-form-fields`). Cancelled —
//            these journeys never start a run of either pin.
//   3d     — agent mail (ADR-0072): the settings switch turned ON through
//            the UI, a chat in `web` whose CONTROLLER asks the agent in
//            `server` with the composer @-path (`@server <question>` →
//            `mail_to`, ADR-0072 § 9), the inline card, LINKED CHATS, the
//            answer arriving from a real read-only model turn, and the
//            asked chat's workspace proving no writes over the API. The
//            agent-initiated fenced-block path is deterministic-covered by
//            the Go suites (internal/worker, internal/store/postgres).
//
// Seeding (per pass, over the API the way setup/empty-error do it): admin
// publishes "Emu rcn <pass>" (the plan-with-approval template with the
// ADR-0066 annotations the forms read) and "Emu lanes <pass>" (one
// deterministic hold node, whose only required input is the ADR-0066
// `github_issue` the lane drag posts — the rcn workflow cannot carry that
// input in its published r1 without taking rcn-1j away from the authoring flow
// it exists to prove); alice creates a project with TWO
// repositories — `web` (the lab's file:// fixture remote) and `server` (a
// real, tiny public github.com repo — the issue trigger's honest home,
// because the server refuses an issue trigger on a non-GitHub repo, and the
// remote must be mirrorable for the chat's turns to run) — pins the workflow,
// authors a labeled issue trigger on `server`, and seeds one repo-scoped
// chat. Everything is pass-stamped and left behind; only the trigger is
// paused at the end so its poller stops with the pass.
//
// Profile rule (2026-11-02, run 41503571017): every chat these journeys
// start (2e, 2f's carrier, 3d) starts on the LAB LAUNCHER's profile —
// `labProfiles` below, keyed by COMMUNICATION_LAB_LAUNCHER exactly like
// e2e/tests/lab-launcher.ts — because ADR-0072 carries the asking chat's
// profile into the linked mail chat, and the org's items[0] is the
// migration-seeded `Claude Code` row no Actions runner can authenticate.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, apiMutate } from "./fixtures.js";
import {
  attachGitHubReadCredential,
  ensureGitHubReadCredential,
  gitHubReadModeNote,
} from "./github-read-credential.js";
import {
  EMU_ADMIN_STATE,
  EMU_ALICE_STATE,
  EMU_BASE_URL,
  EMU_OUT_DIR,
  EMU_PASS_ID,
  EMU_REPO_ROOT,
} from "./env.js";
import { LAB_LAUNCHER } from "../tests/lab-launcher.js";

const WF_NAME = `Emu rcn ${EMU_PASS_ID}`;
const WF_SLUG = `emu-rcn-${EMU_PASS_ID}`.toLowerCase();
// The workflow the LANES DRAG starts (rcn-3b): a pin whose pinned revision
// really declares a `github_issue` input — the one thing the `START #<n> WITH`
// menu reads to decide what it may offer — and whose repo-scoped assignment an
// ADR-0064 issue start is legal on (the server refuses `issue` on a project-wide
// pin). The rcn workflow above cannot be that pin: adding the issue input to
// its published r1 would take rcn-1j away from the flow it exists to prove
// (authoring that input into a draft).
const DRAG_WF_NAME = `Emu lanes ${EMU_PASS_ID}`;
const DRAG_WF_SLUG = `emu-lanes-${EMU_PASS_ID}`.toLowerCase();
const PROJECT_NAME = `Emu rcn ${EMU_PASS_ID}`;
const PROJECT_SLUG = `emu-rcn-${EMU_PASS_ID}`.toLowerCase();
const FILE_REPO = "web";
const GH_REPO = "server";
// The trigger repo's remote is a REAL — and deliberately tiny — public
// repository: the worker mirrors EVERY repository of a chat's project
// before a turn runs, and an unreachable remote fails the turn's workspace
// prep outright (observed with the missing-* shape: `server.git failed:
// could not read Username`). octocat/Hello-World mirrors in a keystroke, its
// issue reads go to the live tracker (authenticated on Actions through the
// ADR-0061 credential in github-read-credential.ts, anonymously locally), and
// the trigger stays inert
// — no issue of it carries this pass's label, and the pass PAUSES the
// trigger at the end anyway.
const GH_URL = "https://github.com/octocat/Hello-World.git";
/** The ADR-0061 `integration_broker` secret carrying this run's GitHub read
 * token (see github-read-credential.ts). Stamped with the pass id, so a pass
 * never reuses another run's — expired — `GITHUB_TOKEN`. */
const GH_READ_SLUG = `emu-gh-read-${EMU_PASS_ID}`.toLowerCase();
/** The lab's `app.git` fixture branch. Its remote lives on the worker's own
 * host (`file:///srv/m4/fixtures/app.git`), unreachable from the runner, so
 * it cannot be read the way {@link remoteDefaultBranch} reads a network one;
 * `main` is what the fixture is built with, and the journeys that mirror it
 * prove it every pass. */
const FILE_REPO_BRANCH = "main";
const EMU_LABEL = `emu-rcn-${EMU_PASS_ID}`;
const SEED_CHAT_TITLE = `Emu rcn chat ${EMU_PASS_ID}`;
/** The chat-box prompt: its first line becomes the thread's title. */
const CHAT_PROMPT = `EMU-RCN ${EMU_PASS_ID} — reply with exactly OK`;
// Agent mail (design 3d, ADR-0072). The token rides INSIDE the question the
// person types after the `@server` mention, so the mail card's question
// line is assertable without matching model prose.
const MAIL_CHAT_TITLE = `Emu rcn mail ${EMU_PASS_ID}`;
const MAIL_QUESTION_TOKEN = `EMU-Q-${EMU_PASS_ID}`;
/** The 3d question, sent through the composer @-path (ADR-0072 § 9): the
 * ask dispatches when the person sends `@server <this>` — the mail card
 * shows the question verbatim, and the asked chat's agent answers it
 * read-only on a real model. */
const MAIL_QUESTION = `${MAIL_QUESTION_TOKEN} — what is in this repository? Answer in one short sentence.`;

/** Escape a literal for a RegExp source (the 2f ask carries the chat's title). */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The thread's pin (rcn-review11): the newest transcript row must end fully
 * above the composer at both emu widths — on first load, on new rows, and
 * after a resize. The round-11 DEFECTs were exactly this failing in a real
 * browser while the jsdom pin tests passed: at 390 the thread-details
 * disclosure trails the transcript inside the scroller (the side panel
 * itself lives in the Details sheet, not the scroller — rcn-review14), so a
 * pin at the scroller's raw max hid the newest row above the visible area;
 * at 1280
 * a composer/header reflow moved the visible bottom with no content growth
 * and nothing re-pinned.
 *
 * `chatPinGap` is the width-local geometry read: the newest VISIBLE row of
 * the VISIBLE chat column (the last `transcript-item` inside the thread
 * page's own `conversation-main`, hidden copies filtered out) minus the
 * visible composer's own top (`thread-composer-pin`), in pixels. ≤ 0 is
 * the invariant.
 *
 * Why the locators are scoped this way (the 1280 false failure, run
 * 41800986449): a document-wide `querySelectorAll` measures whichever
 * copy the DOM happens to hold last — a row in another surface's
 * transcript, a phone-width stack, or a row scrolled OUT of the visible
 * window of a DIFFERENT scroller — and that element's layout rect is not
 * what the reader sees at this width. The capture that went with the false
 * failure showed the thread's own newest rows fully clear of its own
 * composer, while the document-wide read reported the opposite.
 */

/**
 * The newest VISIBLE transcript row of the visible chat column, or null
 * when the column (or a visible row of it) is not on screen. Rows the
 * scroller has scrolled out of its visible window still report their
 * LAYOUT rect — exactly the rows the pin must bring back into view — so
 * only their display state is filtered, never their scroll position: a
 * regression that hides the newest row under the composer leaves a
 * visible row whose bottom sits below the composer's top, and this read
 * fails on it.
 */
async function visibleLastTranscriptRow(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    // checkVisibility() is the browser's own answer: unlike a walk over
    // display/visibility it also excludes what a closed <details> keeps
    // laid out but unrendered — 3f8d4b2's verification measured a
    // "Turn completed" copy inside the closed "Thread details" disclosure
    // (y≈786) while the visible one sat at y≈437.
    const visible = (el: HTMLElement): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return el.checkVisibility({
        contentVisibilityAuto: true,
        visibilityProperty: true,
        opacityProperty: true,
      });
    };
    const main = document.querySelector<HTMLElement>("[data-testid='conversation-main']");
    if (main === null) return null;
    const rows = Array.from(
      main.querySelectorAll<HTMLElement>("[data-testid='transcript-item']"),
    ).filter(visible);
    return rows.length > 0 ? rows[rows.length - 1].getBoundingClientRect().bottom : null;
  });
}

/** The top of the chat's own VISIBLE pinned composer, or null when it is
 * not on screen (another surface's composer is not this chat's pin). */
async function visibleComposerTop(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const composer =
      document.querySelector<HTMLElement>("[data-testid='thread-composer-pin']") ?? null;
    if (composer === null) return null;
    const rect = composer.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;
    if (
      !composer.checkVisibility({
        contentVisibilityAuto: true,
        visibilityProperty: true,
        opacityProperty: true,
      })
    )
      return null;
    return rect.top;
  });
}

async function chatPinGap(page: Page): Promise<number | null> {
  const rowBottom = await visibleLastTranscriptRow(page);
  if (rowBottom === null) return null;
  const composerTop = await visibleComposerTop(page);
  if (composerTop === null) return null;
  return rowBottom - composerTop;
}

/** Bounded assertion of the pin's geometry at the page's current width —
 * the LIVE state the capture is about to shoot. */
async function expectChatPinLive(page: Page, width: number): Promise<void> {
  try {
    await expect
      .poll(() => chatPinGap(page), {
        timeout: 10_000,
        message: `the newest transcript row must end fully above the composer at ${width} (the thread's pin)`,
      })
      .toBeLessThanOrEqual(1);
  } catch (error) {
    // Name what was measured, so a failure says whether the pin is broken
    // or a locator found nothing (b10ef47 failed every pass with the 1280
    // capture showing the newest row well above the composer).
    const probe = await page.evaluate(() => {
      const mains = Array.from(
        document.querySelectorAll<HTMLElement>("[data-testid='conversation-main']"),
      );
      const main = mains[0] ?? null;
      const rows = main
        ? Array.from(main.querySelectorAll<HTMLElement>("[data-testid='transcript-item']")).filter(
            (el) => el.checkVisibility({ contentVisibilityAuto: true }),
          )
        : [];
      const last = rows.length > 0 ? rows[rows.length - 1] : null;
      const composers = document.querySelectorAll("[data-testid='thread-composer-pin']").length;
      return {
        mains: mains.length,
        rows: rows.length,
        lastRowRect: last ? JSON.stringify(last.getBoundingClientRect()) : null,
        lastRowText: last ? (last.textContent ?? "").slice(0, 80) : null,
        composers,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
      };
    });
    const rowBottom = await visibleLastTranscriptRow(page);
    const composerTop = await visibleComposerTop(page);
    // Every scroll container from the newest row up, and the document: which
    // one scrolls, where it sits and how tall its content is.
    const scrollers = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("[data-testid='conversation-main']");
      const rows = main
        ? Array.from(main.querySelectorAll<HTMLElement>("[data-testid='transcript-item']"))
        : [];
      const out: string[] = [];
      let node: HTMLElement | null = rows.length > 0 ? rows[rows.length - 1] : main;
      while (node !== null) {
        const st = getComputedStyle(node);
        if (
          node.scrollHeight > node.clientHeight + 1 ||
          st.overflowY === "auto" ||
          st.overflowY === "scroll"
        ) {
          out.push(
            `${node.tagName.toLowerCase()}${node.dataset.testid ? `[${node.dataset.testid}]` : ""}.${st.overflowY} top=${node.scrollTop} sh=${node.scrollHeight} ch=${node.clientHeight}`,
          );
        }
        node = node.parentElement;
      }
      out.push(`window.scrollY=${window.scrollY} doc.sh=${document.documentElement.scrollHeight}`);
      return out;
    });
    const shot = `${EMU_OUT_DIR}/pin-failure-${width}.png`;
    await page.screenshot({ path: shot }).catch(() => undefined);
    throw new Error(
      `${(error as Error).message.split("\n")[0]} — measured rowBottom=${rowBottom} composerTop=${composerTop} probe=${JSON.stringify(probe)} scrollers=${JSON.stringify(scrollers)} shot=${shot}`,
    );
  }
}

/**
 * The width-local check after a chat capture, at one emu width. The emu's
 * `screen()` resets every scroll container to the top before each shot, so
 * the reader's bottom position the pin owns is re-established first: the
 * transcript's scroller is put at the pin's own landing (the transcript's
 * bottom on the visible bottom — NOT the scroller's raw max, which at 390
 * leaves the trailing thread-details disclosure in view), and the hook's
 * window-resize input re-runs the pin — the same input the capture's
 * 1280→390→1280 round-trip gives it. A regression that hides the newest row
 * under the composer then fails the poll, not just a reviewer's eye.
 * (rcn-review14: the scroller itself now carries `data-capture-keep-scroll`,
 * so `scrollToTopForCapture` no longer resets it — this re-establishment is
 * the poll's own setup, not the capture's.)
 */
async function expectChatPinAtWidth(page: Page, width: 1280 | 390): Promise<void> {
  await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
  // The reflow — and the hook's re-pin on it — lands a beat after the resize.
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    // The same scoping the geometry read uses: the VISIBLE row of the
    // VISIBLE chat column, so the pin is re-established on the row the
    // reader sees at this width.
    const main = document.querySelector<HTMLElement>("[data-testid='conversation-main']");
    if (main === null) return;
    // checkVisibility() is the browser's own answer: unlike a walk over
    // display/visibility it also excludes what a closed <details> keeps
    // laid out but unrendered — 3f8d4b2's verification measured a
    // "Turn completed" copy inside the closed "Thread details" disclosure
    // (y≈786) while the visible one sat at y≈437.
    const visible = (el: HTMLElement): boolean => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return false;
      return el.checkVisibility({
        contentVisibilityAuto: true,
        visibilityProperty: true,
        opacityProperty: true,
      });
    };
    const rows = Array.from(
      main.querySelectorAll<HTMLElement>("[data-testid='transcript-item']"),
    ).filter(visible);
    const lastRow = rows[rows.length - 1];
    if (lastRow === undefined) return;
    let node: HTMLElement | null = lastRow.parentElement;
    let scroller: HTMLElement | null = null;
    while (node !== null && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        scroller = node;
        break;
      }
      node = node.parentElement;
    }
    if (scroller === null) return;
    const content = Array.from(main.children).find((el) => el.contains(lastRow));
    if (content === null) return;
    const contentBottom =
      content.getBoundingClientRect().bottom -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    scroller.scrollTop = Math.max(0, Math.round(contentBottom - scroller.clientHeight));
    window.dispatchEvent(new Event("resize"));
  });
  await expectChatPinLive(page, width);
}

/** The capture's own round-trip, asserted: both emu widths, back on the
 * desktop frame when done (the journeys act at 1280). */
async function expectChatPinBothWidths(page: Page): Promise<void> {
  await expectChatPinAtWidth(page, 1280);
  await expectChatPinAtWidth(page, 390);
  await page.setViewportSize({ width: 1280, height: 900 });
}

/** One row of GET /api/v1/agent-profiles (the members these journeys read). */
interface ProfileRow {
  id: string;
  name: string;
  launcher_id: string;
}

/**
 * The lab launcher's profiles (list order = by name): the journeys that
 * START a chat (2e's chat-box chat, 3d's mail chat, the seed chat) start it
 * on the first of these, and the 2e switch moves to another one, so the
 * whole redesign suite runs real turns on the launcher the acceptance
 * workflow picked (`COMMUNICATION_LAB_LAUNCHER`, e2e/tests/lab-launcher.ts;
 * Actions sets pi, ADR-0069). Why not `items[0]`: the org-wide list also
 * carries migration 00003's seeded `Claude Code` and `Codex` rows, which
 * sort FIRST by name, and an Actions runner has no Claude login — a chat
 * started there fails its real turns with the ACP adapter's own
 * `Authentication required` (observed on run 41503571017; and ADR-0072
 * rides the asking chat's profile into every linked mail chat, so 3d failed
 * at the answering turn with exactly that message). Under the historical
 * local default (launcher `claude`) the first lab profile IS the migration
 * `Claude Code` row, so local runs keep the exact profile they used
 * before.
 */
async function labProfiles(page: Page): Promise<ProfileRow[]> {
  const profiles = await page.request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
  expect(profiles.status(), "the lab serves its agent profiles").toBe(200);
  const list = ((await profiles.json()) as { items?: ProfileRow[] }).items ?? [];
  const lab = list.filter((profile) => profile.launcher_id === LAB_LAUNCHER);
  expect(
    lab.length,
    `the lab seeds at least one agent profile on launcher ${LAB_LAUNCHER} (COMMUNICATION_LAB_LAUNCHER=${LAB_LAUNCHER}; the migration-seeded claude/codex rows do not count)`,
  ).toBeGreaterThan(0);
  return lab;
}

/** The chat box's profile-chip menu row testid for a profile (the UI
 * sanitizes and truncates the id — RepoChatBox.tsx). */
const chatBoxProfileTestid = (id: string): string =>
  `repo-chat-profile-${id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13)}`;

/** What `waitForMailLink` settles with: the outgoing link's terminal facts. */
interface MailLinkRow {
  state: string;
  answer: string | null;
  reason: string | null;
  otherConversationId: string;
}

/** Poll the asking chat's detail until its outgoing link leaves `asked`
 * (answered | failed | expired — ADR-0072 § 5) or the budget runs out. The
 * page streams the same facts; this is the journey's independent read, and
 * the settled row's reason/answer is what names a failing leg. */
async function waitForMailLink(
  page: Page,
  chatId: string,
  budgetMs: number,
): Promise<MailLinkRow | null> {
  const deadline = Date.now() + budgetMs;
  let last: MailLinkRow | null = null;
  for (;;) {
    const res = await page.request.get(`${EMU_BASE_URL}/api/v1/conversations/${chatId}`);
    if (res.status() === 200) {
      const detail = (await res.json()) as {
        linked_chats?: {
          direction: string;
          state: string;
          answer?: string | null;
          reason?: string | null;
          other_conversation?: { id?: string };
        }[];
      };
      const row = (detail.linked_chats ?? []).find((link) => link.direction === "outgoing");
      if (row !== undefined) {
        last = {
          state: row.state,
          answer: row.answer ?? null,
          reason: row.reason ?? null,
          otherConversationId: row.other_conversation?.id ?? "",
        };
        if (row.state !== "asked") return last;
      }
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

const ids = {
  pipelineId: "",
  revisionId: "",
  projectId: "",
  fileRepoId: "",
  ghRepoId: "",
  assignmentId: "",
  triggerId: "",
  chatId: "",
  mailChatId: "",
  mailLinkedChatId: "",
  // The lanes-drag journey's own rows (see DRAG_WF_NAME) and the run it starts.
  dragPipelineId: "",
  dragRevisionId: "",
  dragAssignmentId: "",
  dragRunId: "",
};

/** One assistant note as the store serves it (ADR-0071, `AssistantNote`). */
interface ServedNote {
  id: string;
  project_id: string;
  scope_kind: string;
  scope_id: string;
  text: string;
  action?: { kind: string } | null;
  created_at: string;
  expires_at?: string | null;
}

/** The kinds the union owns (internal/api's AssistantNoteAction*, mirrored in
 * ui/src/api/notes.ts). The note the journey proves is the model's, so it
 * asserts its action is one of THESE — never free text the model invented. */
const NOTE_ACTION_KINDS = ["start_chat", "hand_off", "make_workflow", "open_run"];

/** `ui/src/lib/format.ts testidOf` — the tail the app puts on a data-testid. */
function testidKey(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(0, 13);
}

/* ------------------------------------------------------------------ seed */

/** The plan-with-approval template with this pass's slug and the ADR-0066
 * input annotations the 1k form builds its fields from: `goal` as long text
 * (a textarea) and a new `revision` input as a branch with a default (a mono
 * text field that starts prefilled). Un-annotated `repository` stays text. */
function seedYaml(slug: string): string {
  const template = readFileSync(
    path.join(
      EMU_REPO_ROOT,
      "ui",
      "src",
      "lib",
      "pipeline",
      "templates",
      "plan-with-approval.yaml.txt",
    ),
    "utf8",
  );
  let text = template.replace(/^(\s*name:\s*)plan-with-approval\s*$/m, `$1${slug}`);
  expect(text, "the template carries its metadata name to rewrite").not.toBe(template);
  const goalEdit = text.replace(
    /^ {6}repository:$/m,
    "        x-communication-input:\n          type: long_text\n          label: Goal\n      repository:",
  );
  expect(
    goalEdit,
    "the template's inputs block carries `repository:` where the goal annotation goes",
  ).not.toBe(text);
  text = goalEdit;
  const revisionEdit = text.replace(
    /^ {2}outputs:$/m,
    '      revision:\n        type: string\n        default: "main"\n        x-communication-input:\n          type: branch\n          label: Revision\n  outputs:',
  );
  expect(
    revisionEdit,
    "the template's inputs block ends where the branch property is added",
  ).not.toBe(text);
  return revisionEdit;
}

/**
 * The lanes-drag workflow's document: the ADR-0066 `github_issue` input as its
 * ONE required input (so a drop posts the run instead of handing over to the
 * run-by-hand form, whose rule is "every OTHER required input has a default"),
 * and one deterministic `process.exec` node that holds for two minutes. No
 * `model.chat`, no `agent.acp`: nothing this journey starts can spend the lab's
 * model budget, and the hold is what keeps the run a live Running-lane card
 * while the journey reads it back and asks for its cancel.
 */
function dragSeedYaml(slug: string): string {
  return `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Emulator lanes journey: the workflow a dragged issue starts. Its only
    required input is the ADR-0066 GitHub issue; the one node is a
    deterministic hold, so no model call is ever asked of the lab.
spec:
  inputs:
    type: object
    required:
      - issue
    properties:
      issue:
        type: object
        x-communication-input: {type: github_issue, label: Issue, help: The issue this run was dragged from}
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 900
    maxNodeExecutions: 5
    maxChildDepth: 0
    workspaceMode: worktree
    cancelPolicy: cascade
  nodes:
    - id: hold
      kind: process.exec
      timeoutSeconds: 600
      retry:
        maxAttempts: 1
      config:
        executable: sh
        args:
          - -c
          - sleep 120
        outputExtraction:
          mode: none
`;
}

/** The `server` repo's fake github.com remote has no tracker: the lab answers
 * its issues reads (GET …/repos/<id>/issues?state=open) with a GitHub failure
 * (502 — observed). That noise is scratch-caused and scoped to THIS journey's
 * project, so the journeys that stand on pages which fan out to it declare
 * it. The pattern keeps the query tail: the api handler matches the pathname
 * and the console handler matches the browser's full URL, so one regex must
 * answer both. */
function issuesReadOf(projectId: string): RegExp {
  return new RegExp(`/api/v1/projects/${projectId}/repos/[^/]+/issues([?]|$)`);
}

/**
 * Record a journey NOTE — a fact about the check, not a defect — the way
 * e2e/emulator/fixtures.ts's recorder does: the same `[emu] NOTE` line in the
 * pass log, plus a Playwright annotation so the test result carries it too.
 * The recorder's own note() is private and fixtures.ts is outside this
 * file's brief, so a journey that must record a fact it observed (e.g. that
 * a transient upstream read forced one reload) records it here.
 */
function journeyNote(detail: string): void {
  console.log(`[emu] NOTE ${test.info().titlePath.join(" > ")}: ${detail}`);
  test.info().annotations.push({ type: "note", description: detail });
}

/**
 * One leg of a REAL HTML5 drag on the lanes. Playwright's mouse cannot carry a
 * DataTransfer, so the DragEvents are dispatched inside the page — the
 * technique proven in e2e/tests/issue2-studio.spec.ts — with ONE DataTransfer
 * stashed on the window for the whole drag, the way a browser hands the same
 * object to dragstart, dragover and drop.
 */
async function laneDrag(
  page: Page,
  testid: string,
  type: "dragstart" | "dragover" | "drop" | "dragend",
): Promise<void> {
  const landed = await page.evaluate(
    ([id, eventType, dtType]) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      if (el === null) return false;
      const holder = window as unknown as { __emuLaneDrag?: DataTransfer };
      if (eventType === "dragstart") holder.__emuLaneDrag = new DataTransfer();
      const dataTransfer = holder.__emuLaneDrag ?? new DataTransfer();
      dataTransfer.setData(dtType, id);
      el.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer }));
      if (eventType === "dragend") delete holder.__emuLaneDrag;
      return true;
    },
    [testid, type, "application/x-communication-issue"] as [string, string, string],
  );
  expect(
    landed,
    `the ${type} landed on [data-testid="${testid}"] — that element is on the page`,
  ).toBe(true);
}

/* ------------------------------------------------- resolve-or-create seed
 * Playwright restarts the worker when a serial group fails, so no seed may
 * live only in module state (server-error.spec.ts carries the same scar):
 * every ensure step first RESOLVES this pass's row by its pass-stamped
 * slug/name/label, and creates it only when the lab does not have it yet.
 * A pass replay therefore reuses the rows a dead worker left behind.
 */

/** admin (library role): the annotated workflow, published at r1. */
async function ensureWorkflow(page: Page): Promise<void> {
  if (ids.pipelineId !== "" && ids.revisionId !== "") return;
  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/pipelines`);
  expect(list.status(), "the library list answers").toBe(200);
  const pipelines = (await list.json()) as { pipelines?: { id: string; slug: string }[] };
  const found = (pipelines.pipelines ?? []).find((entry) => entry.slug === WF_SLUG) ?? null;
  if (found !== null) {
    ids.pipelineId = found.id;
    const revisions = await page.request.get(
      `${EMU_BASE_URL}/api/v1/pipelines/${found.id}/revisions`,
    );
    expect(revisions.status(), "the revision list answers").toBe(200);
    const rows = (await revisions.json()) as { revisions?: { id: string }[] };
    expect(
      (rows.revisions ?? []).length,
      "the pass's workflow carries its published revision",
    ).toBeGreaterThan(0);
    ids.revisionId = (rows.revisions ?? [])[0].id;
    return;
  }
  const pipeline = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/pipelines`, {
    slug: WF_SLUG,
    display_name: WF_NAME,
    description: "emulator repo-chat-nav journey workflow",
  });
  const pipelineBody = await pipeline.text();
  expect(
    pipeline.status(),
    `creating the journey workflow answers 201 (got ${pipeline.status()}: ${pipelineBody.slice(0, 240)})`,
  ).toBe(201);
  ids.pipelineId = (JSON.parse(pipelineBody) as { id: string }).id;
  expect(ids.pipelineId, "the journey workflow has an id").toMatch(/^[0-9a-f-]{36}$/);

  const draft = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/pipelines/${ids.pipelineId}/drafts`,
    { document_yaml: seedYaml(WF_SLUG) },
  );
  const draftBody = await draft.text();
  expect(
    draft.status(),
    `seeding the annotated draft answers 201 (got ${draft.status()}: ${draftBody.slice(0, 300)})`,
  ).toBe(201);
  const draftJson = JSON.parse(draftBody) as { id: string; version: number };
  const validated = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/validate`,
  );
  const validBody = await validated.text();
  expect(
    (JSON.parse(validBody) as { valid?: boolean }).valid,
    `the annotated draft validates (${validBody.slice(0, 400)})`,
  ).toBe(true);
  const published = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/publish`,
    { version: draftJson.version },
  );
  const publishedBody = await published.text();
  expect(
    published.status(),
    `publishing answers 2xx (got ${published.status()}: ${publishedBody.slice(0, 300)})`,
  ).toBeLessThan(300);
  ids.revisionId = (JSON.parse(publishedBody) as { id: string }).id;
  expect(ids.revisionId, "the publish answers with the revision").toMatch(/^[0-9a-f-]{36}$/);
}

/** admin (library role): the workflow the lane drag starts, at r1. */
async function ensureDragWorkflow(page: Page): Promise<void> {
  if (ids.dragPipelineId !== "" && ids.dragRevisionId !== "") return;
  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/pipelines`);
  expect(list.status(), "the library list answers").toBe(200);
  const pipelines = (await list.json()) as { pipelines?: { id: string; slug: string }[] };
  const found = (pipelines.pipelines ?? []).find((entry) => entry.slug === DRAG_WF_SLUG) ?? null;
  if (found !== null) {
    ids.dragPipelineId = found.id;
    const revisions = await page.request.get(
      `${EMU_BASE_URL}/api/v1/pipelines/${found.id}/revisions`,
    );
    expect(revisions.status(), "the revision list answers").toBe(200);
    const rows = (await revisions.json()) as { revisions?: { id: string }[] };
    expect(
      (rows.revisions ?? []).length,
      "the lanes-drag workflow carries its published revision",
    ).toBeGreaterThan(0);
    ids.dragRevisionId = (rows.revisions ?? [])[0].id;
    return;
  }
  // The library needs the library role: only the admin seed creates the row,
  // which is why alice's seed asserts it rather than authoring it.
  const pipeline = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/pipelines`, {
    slug: DRAG_WF_SLUG,
    display_name: DRAG_WF_NAME,
    description: "emulator repo-chat-nav lanes-drag journey workflow",
  });
  const pipelineBody = await pipeline.text();
  expect(
    pipeline.status(),
    `creating the lanes-drag workflow answers 201 (got ${pipeline.status()}: ${pipelineBody.slice(0, 240)})`,
  ).toBe(201);
  ids.dragPipelineId = (JSON.parse(pipelineBody) as { id: string }).id;

  const draft = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/pipelines/${ids.dragPipelineId}/drafts`,
    { document_yaml: dragSeedYaml(DRAG_WF_SLUG) },
  );
  const draftBody = await draft.text();
  expect(
    draft.status(),
    `seeding the lanes-drag draft answers 201 (got ${draft.status()}: ${draftBody.slice(0, 300)})`,
  ).toBe(201);
  const draftJson = JSON.parse(draftBody) as { id: string; version: number };
  const validated = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/validate`,
  );
  const validBody = await validated.text();
  expect(
    (JSON.parse(validBody) as { valid?: boolean }).valid,
    `the lanes-drag draft validates (${validBody.slice(0, 400)})`,
  ).toBe(true);
  const published = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/publish`,
    { version: draftJson.version },
  );
  const publishedBody = await published.text();
  expect(
    published.status(),
    `publishing the lanes-drag workflow answers 2xx (got ${published.status()}: ${publishedBody.slice(0, 300)})`,
  ).toBeLessThan(300);
  ids.dragRevisionId = (JSON.parse(publishedBody) as { id: string }).id;
  expect(ids.dragRevisionId, "the lanes-drag publish answers with the revision").toMatch(
    /^[0-9a-f-]{36}$/,
  );
}

/** alice: the pin the drop starts — pinned to `server`, because ADR-0064
 * refuses an `issue` start on a project-wide assignment (`issue_requires_repo_
 * assignment`) and the repository must be a GitHub remote for the issue to
 * exist at all. Resolve-or-create like every other seed row. */
async function ensureDragPin(page: Page): Promise<void> {
  if (ids.dragAssignmentId !== "") return;
  await ensureProject(page);
  await ensureRepos(page);
  if (ids.dragPipelineId === "" || ids.dragRevisionId === "") {
    // Read the published row rather than author it (see ensureDragWorkflow).
    await ensureDragWorkflow(page);
  }
  expect(ids.dragPipelineId, "the admin seed published the lanes-drag workflow").toMatch(
    /^[0-9a-f-]{36}$/,
  );
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/assignments`,
  );
  expect(list.status(), "the assignment list answers").toBe(200);
  const assignments = (await list.json()) as {
    assignments?: { id: string; pipeline_id: string; repository_id?: string | null }[];
  };
  const found =
    (assignments.assignments ?? []).find(
      (entry) => entry.pipeline_id === ids.dragPipelineId && entry.repository_id === ids.ghRepoId,
    ) ?? null;
  if (found !== null) {
    ids.dragAssignmentId = found.id;
    return;
  }
  const assignment = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/assignments`,
    {
      pipeline_id: ids.dragPipelineId,
      pinned_revision_id: ids.dragRevisionId,
      repository_id: ids.ghRepoId,
    },
  );
  const body = await assignment.text();
  expect(
    assignment.status(),
    `pinning the lanes-drag workflow to \`${GH_REPO}\` answers 201 (got ${assignment.status()}: ${body.slice(0, 300)})`,
  ).toBe(201);
  ids.dragAssignmentId = (JSON.parse(body) as { id: string }).id;
}

/** This project's run rows, newest first, as the project's own run list
 * serves them (the assertion target for "the drop started a run"). */
async function projectRuns(page: Page): Promise<{
  runs: {
    id: string;
    status: string;
    title?: string | null;
    repository_id?: string | null;
    assignment_id?: string | null;
    trigger?: { kind: string; ref?: string | null } | null;
  }[];
}> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/runs`);
  expect(res.status(), `the project run list answers (got ${res.status()})`).toBe(200);
  return (await res.json()) as {
    runs: {
      id: string;
      status: string;
      title?: string | null;
      repository_id?: string | null;
      assignment_id?: string | null;
      trigger?: { kind: string; ref?: string | null } | null;
    }[];
  };
}

/** Read-only resolve for the leave-the-lab-quiet step: this pass's project and
 * its lanes-drag pin, or null when the pass never created them. It creates
 * nothing — the quiet step may not author rows the seed did not. */
async function resolveDragPin(
  page: Page,
): Promise<{ projectId: string; assignmentId: string } | null> {
  const projects = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  const projectId =
    (
      (await projects.json().catch(() => ({}))) as { items?: { slug: string; id: string }[] }
    ).items?.find((entry) => entry.slug === PROJECT_SLUG)?.id ?? "";
  if (projectId === "") return null;
  const pipelines = await page.request.get(`${EMU_BASE_URL}/api/v1/pipelines`);
  const pipelineId =
    (
      (await pipelines.json().catch(() => ({}))) as { pipelines?: { slug: string; id: string }[] }
    ).pipelines?.find((entry) => entry.slug === DRAG_WF_SLUG)?.id ?? "";
  if (pipelineId === "") return null;
  const assignments = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${projectId}/assignments`,
  );
  const assignmentId =
    (
      (await assignments.json().catch(() => ({}))) as {
        assignments?: { pipeline_id: string; id: string }[];
      }
    ).assignments?.find((entry) => entry.pipeline_id === pipelineId)?.id ?? "";
  return assignmentId === "" ? null : { projectId, assignmentId };
}

/** alice: the project that owns the two repos, the pin and the chat. */
async function ensureProject(page: Page): Promise<void> {
  if (ids.projectId !== "") return;
  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(list.status(), "the project list answers").toBe(200);
  const projects = (await list.json()) as { items?: { id: string; slug: string }[] };
  const found = (projects.items ?? []).find((entry) => entry.slug === PROJECT_SLUG) ?? null;
  if (found !== null) {
    ids.projectId = found.id;
    return;
  }
  const project = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/projects`, {
    name: PROJECT_NAME,
    slug: PROJECT_SLUG,
    description: "emulator repo-chat-nav journey project",
  });
  const projectBody = await project.text();
  expect(
    project.status(),
    `creating the journey project answers 201 (got ${project.status()}: ${projectBody.slice(0, 300)})`,
  ).toBe(201);
  ids.projectId = (JSON.parse(projectBody) as { id: string }).id;
  expect(ids.projectId, "the journey project has an id").toMatch(/^[0-9a-f-]{36}$/);
}

/** The branch a remote actually points HEAD at — the registration's
 * `default_branch` must be this, not a guess. ADR-0017 D2 refuses to guess a
 * branch name: the worker mirrors the remote and bases the checkout on the
 * named branch, so a registration naming a branch the remote does not carry
 * fails EVERY turn of EVERY chat in that project at workspace prep — seen as
 * `mirror /repos/<project>/server.git has no branch "main" to base server on`
 * when `server` was registered as `main` while octocat/Hello-World's HEAD
 * symref is `master`. The refusal is the product's right answer; the seeding
 * is what was wrong. */
function remoteDefaultBranch(url: string): string {
  const out = execFileSync("git", ["ls-remote", "--symref", url, "HEAD"], {
    encoding: "utf8",
    timeout: 60_000,
  });
  // `ref: refs/heads/master<TAB>HEAD` — the symref line names the branch;
  // `\S+` stops at the tab, so the line's `HEAD` tail must not be anchored away.
  const match = /^ref:\s+refs\/heads\/(\S+)/m.exec(out);
  expect(
    match,
    `${url} answers \`git ls-remote --symref HEAD\` with a symbolic ref (got ${out.slice(0, 200)})`,
  ).toBeTruthy();
  return match![1];
}

/** alice: `web` on the lab's file:// fixture remote, `server` on a real
 * public GitHub repo (the issue trigger's honest home — the server refuses
 * one on a non-GitHub repo with `not_a_github_repository`, which is exactly
 * the List view's asserted empty state on `web`).
 *
 * `server`'s issues read is authenticated on Actions: when the job exported
 * `E2E_GITHUB_READ_TOKEN_FILE`, the row is created with (or patched to) the
 * ADR-0061 `integration_broker` credential so the ISSUES lane reads
 * api.github.com at 5000 requests/hour instead of the anonymous 60 this egress
 * IP shares with every other workflow — the same knob e2e/tests/m5-issue-run
 * .spec.ts uses for its `m5gh-*` row. Without the variable the row carries no
 * credential and the read stays anonymous, exactly as before. The token value
 * never reaches a row, a log line or results.json. */
async function ensureRepos(page: Page): Promise<void> {
  if (ids.fileRepoId !== "" && ids.ghRepoId !== "") return;
  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos`);
  expect(list.status(), "the repository list answers").toBe(200);
  const repos = (await list.json()) as { items?: { id: string; name: string }[] };
  const find = (name: string): string =>
    (repos.items ?? []).find((entry) => entry.name === name)?.id ?? "";
  // null when no token file is configured — today's anonymous behaviour.
  const credentialSecretId = await ensureGitHubReadCredential(page, ids.projectId, GH_READ_SLUG);
  const create = async (
    name: string,
    gitUrl: string,
    defaultBranch: string,
    credential: string | null,
  ): Promise<string> => {
    const res = await apiMutate(
      page,
      "POST",
      `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos`,
      {
        name,
        git_url: gitUrl,
        default_branch: defaultBranch,
        ...(credential === null ? {} : { credential_secret_id: credential }),
      },
    );
    const body = await res.text();
    expect(
      res.status(),
      `adding ${name} answers 201 (got ${res.status()}: ${body.slice(0, 240)})`,
    ).toBe(201);
    const created = JSON.parse(body) as { id: string; credential?: string };
    if (credential !== null) {
      expect(
        created.credential,
        `${name} was created without the ADR-0061 credential attached`,
      ).toBe("configured");
    }
    return created.id;
  };
  ids.fileRepoId =
    find(FILE_REPO) !== ""
      ? find(FILE_REPO)
      : await create(FILE_REPO, "file:///srv/m4/fixtures/app.git", FILE_REPO_BRANCH, null);
  // Read the remote's own HEAD rather than naming a branch by habit (see
  // `remoteDefaultBranch`): this repo is the one the 3d agent turn mirrors.
  const existingGhRepo = find(GH_REPO);
  ids.ghRepoId =
    existingGhRepo !== ""
      ? existingGhRepo
      : await create(GH_REPO, GH_URL, remoteDefaultBranch(GH_URL), credentialSecretId);
  if (existingGhRepo !== "" && credentialSecretId !== null) {
    // Patch even when the row reads `configured`: resolve-or-create seeding
    // can reuse a row whose token died with the run that wrote it.
    await attachGitHubReadCredential(page, ids.projectId, existingGhRepo, credentialSecretId);
  }
}

/** alice: the pin — one assignment per (project, pipeline), resolved first. */
async function ensureAssignment(page: Page): Promise<void> {
  if (ids.assignmentId !== "") return;
  await ensureProject(page);
  await ensureRepos(page);
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/assignments`,
  );
  expect(list.status(), "the assignment list answers").toBe(200);
  const assignments = (await list.json()) as {
    assignments?: { id: string; pipeline_id: string }[];
  };
  const found =
    (assignments.assignments ?? []).find((entry) => entry.pipeline_id === ids.pipelineId) ?? null;
  if (found !== null) {
    ids.assignmentId = found.id;
    return;
  }
  const assignment = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/assignments`,
    { pipeline_id: ids.pipelineId, pinned_revision_id: ids.revisionId },
  );
  const assignmentBody = await assignment.text();
  expect(
    assignment.status(),
    `pinning the workflow answers 201 (got ${assignment.status()}: ${assignmentBody.slice(0, 300)})`,
  ).toBe(201);
  ids.assignmentId = (JSON.parse(assignmentBody) as { id: string }).id;
}

/** alice: the labeled issue trigger on `server` (enabled — the WHO FILLS
 * panel only lists armed triggers; paused again by the final step). */
async function ensureTrigger(page: Page): Promise<void> {
  if (ids.triggerId !== "") return;
  await ensureAssignment(page);
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/issue-triggers`,
  );
  expect(list.status(), "the issue-trigger list answers").toBe(200);
  const triggers = (await list.json()) as {
    issue_triggers?: { id: string; assignment_id: string; labels?: string[] }[];
  };
  const found =
    (triggers.issue_triggers ?? []).find(
      (entry) =>
        entry.assignment_id === ids.assignmentId && (entry.labels ?? []).includes(EMU_LABEL),
    ) ?? null;
  if (found !== null) {
    ids.triggerId = found.id;
    return;
  }
  const trigger = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/issue-triggers`,
    {
      assignment_id: ids.assignmentId,
      repository_id: ids.ghRepoId,
      event: "labeled",
      labels: [EMU_LABEL],
      inputs: { goal: "Issue {{issue.number}}: {{issue.title}}", repository: FILE_REPO },
      enabled: true,
    },
  );
  const triggerBody = await trigger.text();
  expect(
    trigger.status(),
    `authoring the issue trigger answers 201 (got ${trigger.status()}: ${triggerBody.slice(0, 300)})`,
  ).toBe(201);
  ids.triggerId = (JSON.parse(triggerBody) as { id: string }).id;
}

/** alice: the repo-scoped chat (ADR-0067: born bound to `web`), title-resolved. */
async function ensureSeedChat(page: Page): Promise<void> {
  await ensureAssignment(page);
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/conversations?repository=${FILE_REPO}`,
  );
  expect(list.status(), "the repo's conversation list answers").toBe(200);
  const chats = (await list.json()) as { items?: { id: string; title: string }[] };
  if ((chats.items ?? []).some((entry) => entry.title === SEED_CHAT_TITLE)) return;
  // The lab launcher's profile, not items[0] (see labProfiles).
  const firstProfile = (await labProfiles(page))[0].id;
  const chat = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/conversations`,
    { title: SEED_CHAT_TITLE, agent_profile_id: firstProfile, repository: FILE_REPO },
  );
  const chatBody = await chat.text();
  expect(
    chat.status(),
    `creating the repo-scoped chat answers 201 (got ${chat.status()}: ${chatBody.slice(0, 300)})`,
  ).toBe(201);
}

/** alice: the mail chat (ADR-0067 bound to `web`), title-resolved like the
 * seed chat. Created WITHOUT a prompt: the journey prompts through the
 * composer, alice holding control as the chat's creator. */
async function ensureMailChat(page: Page): Promise<void> {
  if (ids.mailChatId !== "") return;
  await ensureProject(page);
  await ensureRepos(page);
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/conversations?repository=${FILE_REPO}`,
  );
  expect(list.status(), "the repo's conversation list answers").toBe(200);
  const chats = (await list.json()) as { items?: { id: string; title: string }[] };
  const found = (chats.items ?? []).find((entry) => entry.title === MAIL_CHAT_TITLE);
  if (found !== undefined) {
    ids.mailChatId = found.id;
    return;
  }
  // The mail chat starts on the lab launcher's profile because ADR-0072
  // § 2/§ 9 carries the asking chat's CURRENT profile into the linked chat
  // and its answer turn: a chain born on `Claude Code` asks `Claude Code`
  // (run 41503571017: every rcn-3d pass died `Authentication required` at
  // the answering turn for exactly this reason).
  const firstProfile = (await labProfiles(page))[0].id;
  const chat = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/conversations`,
    { title: MAIL_CHAT_TITLE, agent_profile_id: firstProfile, repository: FILE_REPO },
  );
  const chatBody = await chat.text();
  expect(
    chat.status(),
    `creating the mail chat answers 201 (got ${chat.status()}: ${chatBody.slice(0, 300)})`,
  ).toBe(201);
  ids.mailChatId = (JSON.parse(chatBody) as { id: string }).id;
  expect(ids.mailChatId, "the mail chat has an id").toMatch(/^[0-9a-f-]{36}$/);
}

test.describe("repo-chat-nav (admin: publish the workflow the forms read)", () => {
  test.describe.configure({ mode: "serial", timeout: 5 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("seed — create, annotate, validate, publish Emu rcn <pass>", async ({ page }) => {
    // Resolve-or-create (see the seed note): a worker restart mid-file
    // reuses the pass's published workflow instead of 409ing on the slug.
    await ensureWorkflow(page);
    expect(ids.pipelineId, "the journey workflow exists").toMatch(/^[0-9a-f-]{36}$/);
    expect(ids.revisionId, "the journey workflow is published").toMatch(/^[0-9a-f-]{36}$/);
  });

  test("seed — publish the workflow the lane drag starts (Emu lanes <pass>)", async ({ page }) => {
    // The 3b drag needs a pin whose PINNED REVISION declares the ADR-0066
    // `github_issue` input — that declaration, not a guess, is what puts a
    // workflow in the `START #<n> WITH` menu. Authoring it is the library
    // role's work, so it happens here, on the admin session.
    await ensureDragWorkflow(page);
    expect(ids.dragPipelineId, "the lanes-drag workflow exists").toMatch(/^[0-9a-f-]{36}$/);
    expect(ids.dragRevisionId, "the lanes-drag workflow is published").toMatch(/^[0-9a-f-]{36}$/);
  });
});

/* ------------------------------------------------------------------ alice */

test.describe("repo-chat-nav (alice: shell, repo list, lanes, chat, run form)", () => {
  test.describe.configure({ mode: "serial", timeout: 25 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("seed — the project, its two repos, the pin, the issue trigger, a chat", async ({
    page,
    emu,
  }) => {
    // Every step is resolve-or-create (see the seed note): a worker restart
    // mid-pass reuses the rows the dead worker left, never 409s on them.
    emu.expectFailure(/\/api\/v1\/projects$/, 409);
    emu.expectFailure(/\/api\/v1\/projects$/, 422);
    await test.step("the project and its two repositories", async () => {
      expect(ids.pipelineId, "the admin seed published the journey workflow").toMatch(
        /^[0-9a-f-]{36}$/,
      );
      await ensureProject(page);
      await ensureRepos(page);
      expect(ids.fileRepoId, "the project carries the file:// repo").toMatch(/^[0-9a-f-]{36}$/);
      expect(ids.ghRepoId, "the project carries the GitHub-shaped repo").toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("the pin and the issue trigger on the GitHub-shaped repo", async () => {
      await ensureAssignment(page);
      expect(ids.assignmentId, "the workflow is pinned to the project").toMatch(/^[0-9a-f-]{36}$/);
      await ensureTrigger(page);
      expect(ids.triggerId, "the labeled issue trigger exists").toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("the repo pin the lane drag starts", async () => {
      await ensureDragPin(page);
      expect(ids.dragAssignmentId, "the issue-accepting workflow is pinned to `server`").toMatch(
        /^[0-9a-f-]{36}$/,
      );
    });

    await test.step("the repo-scoped chat (ADR-0067: born bound to `web`)", async () => {
      await ensureSeedChat(page);
    });
  });

  test("assistant notes — the model writes one about `server`; dismiss keeps it gone (rcn-3a)", async ({
    page,
    emu,
  }) => {
    // The goal item this proves is the panel's own claim: the repo page shows
    // notes the MODEL wrote, dismissible, with nothing hard-coded behind them.
    // So nothing here writes a row. There is no note-creating route (ADR-0071
    // § Decision 5 — `there is no POST here`), no database touch, no test-only
    // seam: the only thing the journey does is make the same
    // `GET …/repos/{r}/notes` the repo page makes, which is the generator's own
    // trigger (ADR-0071 § Decision 6), and then read what it is served. What
    // appears is model output or the panel stays honestly empty — and an empty
    // panel fails this journey rather than being padded out.
    //
    // Why the wait is 5 minutes: a note-less GET asks the model ONCE and the
    // scope's cooldown is 30 minutes, but an attempt that stored nothing re-arms
    // on a short ladder (30s, then 1min, then 2min), so five minutes of the
    // page's own read covers four completions. `server` is the right scope: its
    // DATA block is the pass's real runs on the repository plus its real open
    // GitHub issues — the same reads the page itself makes.
    test.setTimeout(9 * 60_000);
    emu.expectFailure(issuesReadOf(ids.projectId));
    const notesUrl = `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos/${ids.ghRepoId}/notes`;
    const readNotes = async (): Promise<ServedNote[]> => {
      const res = await page.request.get(notesUrl);
      // Assertion messages are evaluated eagerly, and a bodyless response (a
      // 204, or one whose body the network layer has dropped) has nothing to
      // read: only ask for the body when the status is one we would fail on,
      // and never let that read be the thing that throws.
      const body = res.ok() ? "" : await res.text().catch(() => "<body unavailable>");
      expect(
        res.status(),
        `the notes read answers 200 (got ${res.status()}: ${body.slice(0, 200)})`,
      ).toBe(200);
      return ((await res.json()) as { notes?: ServedNote[] }).notes ?? [];
    };

    let note: ServedNote | null = null;
    await test.step("the assistant writes a note for this reader", async () => {
      const deadline = Date.now() + 5 * 60_000;
      let polls = 0;
      while (note === null) {
        polls += 1;
        // The first read of the scope is what asks the model; every later one
        // re-reads the panel and, past each ladder gap, asks again.
        const served = await readNotes();
        if (served.length > 0) note = served[0];
        else if (Date.now() >= deadline) {
          throw new Error(
            `the assistant wrote nothing for this reader about \`${GH_REPO}\` in ${polls} reads ` +
              `over 5 minutes. The read IS the trigger and the model is configured in this stack ` +
              `(compose.real.yml's COMMUNICATION_ASSISTANT_* triple); the api replicas log every ` +
              'attempt as "assistant notes: …", so the compose logs name the reason (a refused ' +
              "answer, a failed completion, or a DATA block with no runs and no open issues to be honest " +
              "about). The panel is never padded out to make this pass.",
          );
        } else {
          await page.waitForTimeout(2_000);
        }
      }
      // It is the model's sentence, and the store's own contract says every
      // note carries one allowlisted action (ADR-0071 § Decision 4).
      expect(note.text.trim().length, "the note says something").toBeGreaterThan(0);
      expect(
        NOTE_ACTION_KINDS,
        `the note's action kind (${note.action?.kind}) is one the client owns`,
      ).toContain(note.action?.kind ?? "");
    });

    // `note` is non-null past the step above (the step throws otherwise); this
    // is the narrowing TypeScript cannot do through a closure for us.
    const shown = note as ServedNote;

    await test.step("3a notes — the note renders in ASSISTANT NOTICED with its action", async () => {
      await page.goto(`/p/${ids.projectId}/${GH_REPO}`);
      await expect(page.getByTestId("repo-page"), "the repo page renders").toBeVisible({
        timeout: 30_000,
      });
      const panel = page.getByTestId("repo-assistant-notes");
      await expect(panel, "design 3a: ASSISTANT NOTICED").toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("repo-assistant-notes-empty"),
        "the panel is not standing in its empty state — the note the model wrote is here",
      ).toHaveCount(0);
      const row = page.getByTestId(`repo-assistant-note-${shown.id}`);
      await expect(
        row,
        "design 3a: the note is drawn as one sentence of the model's own words",
      ).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText(shown.text);
      await expect(
        row.getByTestId(`repo-assistant-note-${shown.id}-action`),
        "design 3a: the note's one action is a button the page itself owns",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-assistant-notes-count"),
        "the count is what the store served, at most the panel's three",
      ).toHaveText(/^[1-3]$/);
      await emu.screen("rcn-3a", "repo-notes");
    });

    await test.step("3a notes — dismiss: the write answers, the row goes, the reload keeps it gone", async () => {
      const dismissed = page.getByTestId(`repo-assistant-note-${shown.id}-dismiss`);
      await expect(dismissed, "design 3a: every note carries its own dismiss").toBeVisible();
      const written = page.waitForResponse(
        (res) =>
          res.request().method() === "POST" &&
          res.url().includes(`/api/v1/notes/${shown.id}/dismiss`),
        { timeout: 30_000 },
      );
      await dismissed.click();
      const receipt = await written;
      // The dismissal's success answer is a 204 with NO body, and
      // `Network.getResponseBody` throws "Response body is not available" for
      // one — while the template string here is evaluated eagerly, before the
      // assertion runs. So the body is only read for a status outside 2xx (the
      // failure case, where it is the evidence we want) and the read is caught.
      const receiptBody = receipt.ok()
        ? ""
        : await receipt.text().catch(() => "<body unavailable>");
      expect(
        receipt.status(),
        `the dismissal answers 2xx for its owner (got ${receipt.status()}: ${receiptBody.slice(0, 200)})`,
      ).toBeGreaterThanOrEqual(200);
      expect(
        receipt.status(),
        "a dismissal that did not land is not a dismissal",
      ).toBeLessThan(300);
      // The row leaves on the click, not on the next read (notes.ts dismisses
      // the cache entry optimistically and re-reads after the 204).
      await expect(
        page.getByTestId(`repo-assistant-note-${shown.id}`),
        "the dismissed note is off the panel",
      ).toHaveCount(0);
      await page.reload();
      await expect(page.getByTestId("repo-page"), "the page reloads").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByTestId(`repo-assistant-note-${shown.id}`),
        "a dismissed note stays dismissed across the reload — it was a row, not a render",
      ).toHaveCount(0);
      const after = await readNotes();
      expect(
        after.map((row2) => row2.id),
        "the store no longer serves this reader's dismissed note",
      ).not.toContain(shown.id);
    });

    await test.step("3a notes — every note the assistant wrote for this pass stays dismissed", async () => {
      // The generator may have written up to three notes for this reader about
      // `server`. The claim above is the one the goal item names; this step is
      // the same act repeated over whatever else the model wrote, so no later
      // screen of this repository (`rcn-3a repo`, `rcn-3a repo-feed-empty`,
      // `rcn-1k` all capture this page) inherits model text that only this
      // journey was written to prove — and so the dismissal is proven for every
      // row rather than for one lucky one. Each is dismissed the reader's own
      // way: the panel's `dismiss`, answered by POST /notes/{id}/dismiss.
      const dismissed: string[] = [shown.id];
      for (let i = 0; i < 4; i++) {
        const row = page.locator('li[data-testid^="repo-assistant-note-"]').first();
        if (!(await row.isVisible().catch(() => false))) break;
        const testid = await row.getAttribute("data-testid");
        expect(testid, "a note row is drawn under its own id").toBeTruthy();
        const id = (testid ?? "").replace("repo-assistant-note-", "");
        const wrote = page.waitForResponse(
          (res) =>
            res.request().method() === "POST" && res.url().includes(`/api/v1/notes/${id}/dismiss`),
          { timeout: 30_000 },
        );
        await row.getByTestId(`repo-assistant-note-${id}-dismiss`).click();
        const receipt = await wrote;
        expect(
          receipt.status(),
          `dismissing the assistant's other note answers 2xx (got ${receipt.status()})`,
        ).toBeLessThan(300);
        dismissed.push(id);
      }
      // Dismissal is per user and it holds: none of these rows comes back to the
      // reader who dismissed it, whatever else the assistant has to say later.
      const left = await readNotes();
      for (const id of dismissed) {
        expect(
          left.map((row) => row.id),
          `note ${id} was dismissed by its owner and is served no more`,
        ).not.toContain(id);
      }
    });
  });

  test("shell — one sidebar, the rail, the flyout, the project header's actions, persisted collapse", async ({
    page,
    emu,
  }) => {
    // A GH-page leg fans out to the real tracker's issues read; the
    // lab's own 502s on it are scratch noise, declared (see issuesReadOf).
    emu.expectFailure(issuesReadOf(ids.projectId));
    await test.step("expanded (2c): New thread, Today, Threads, PROJECTS, Workflows/Agents rows", async () => {
      await page.goto(`/p/${ids.projectId}`);
      await expect(
        page.getByTestId("sidebar"),
        "design 2c: the one left column renders",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("new-chat"), "design 2c: New thread").toBeVisible();
      await expect(
        page.getByTestId("sidebar-link-home"),
        "design 2c: the row is Today (was Home)",
      ).toContainText(/today/i);
      await expect(page.getByTestId("sidebar-link-threads"), "design 2c: Threads").toContainText(
        /threads/i,
      );
      await expect(
        page.getByTestId(`sidebar-project-toggle-${ids.projectId}`),
        "design 2c: the PROJECTS tree carries the project",
      ).toBeVisible();
      await expect(
        page.getByTestId("sidebar-link-workflows"),
        "design 2c/finding 02: the split library keeps a top-level Workflows row",
      ).toBeVisible();
      await emu.screen("rcn-3c", "expanded");
    });

    await test.step("the project header's configure actions (finding 09: the sidebar ⋯ is gone)", async () => {
      // Finding 09 retired the hover-only ⋯ project menu: `+ Repository`,
      // `Settings` and the members page are the project's own actions now, in
      // the header and behind the settings page's tab strip. The sidebar row is
      // a tree toggle again — it carries no menu at all.
      await page.goto(`/p/${ids.projectId}`);
      await expect(
        page.getByTestId("project-name"),
        "finding 09: the project page answers",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("sidebar-project-menu"),
        "finding 09: the sidebar's ⋯ project menu is gone, not merely hidden",
      ).toHaveCount(0);
      await expect(
        page.getByTestId(`sidebar-project-menu-${ids.projectId}`),
        `finding 09: no ⋯ trigger on the ${ids.projectId.slice(0, 8)} row either`,
      ).toHaveCount(0);
      const addRepository = page.getByTestId("project-add-repository");
      await expect(
        addRepository,
        "finding 09: '+ Repository' is a project-header action (this project's viewer maintains it)",
      ).toBeVisible({ timeout: 30_000 });
      await expect(addRepository, "finding 09: the verb says '+ Repository'").toHaveText(
        /\+\s*Repository/,
      );
      const settingsLink = page.getByTestId("project-settings-link");
      await expect(
        settingsLink,
        "finding 09: 'Settings' is the header's way to the project's configuration",
      ).toBeVisible();
      await expect(settingsLink).toHaveAttribute(
        "href",
        new RegExp(`^/p/${ids.projectId}/settings$`),
      );
      await emu.screen("rcn-3c", "header-actions");

      // `+ Repository` opens the dialog IN PLACE, on this page — the menu's old
      // route through the settings page is gone. The dialog is then CANCELLED:
      // the configured git URL is the file repo's own, so submitting would
      // collide, and this journey has no business adding repositories.
      await addRepository.click();
      const dialog = page.getByTestId("add-repository-dialog");
      await expect(
        dialog,
        "finding 09: '+ Repository' opens the add-repository dialog in place",
      ).toBeVisible({ timeout: 10_000 });
      expect(
        new URL(page.url()).pathname,
        "the dialog is a dialog, not a navigation away from the project page",
      ).toBe(`/p/${ids.projectId}`);
      await expect(
        dialog.getByTestId("repo-name"),
        "the dialog names the repository it adds",
      ).toBeVisible();
      await expect(
        dialog.getByTestId("repo-git-url"),
        "the dialog asks for the git URL",
      ).toBeVisible();
      await expect(
        dialog.getByTestId("repo-default-branch"),
        "the dialog asks for the default branch",
      ).toBeVisible();
      await dialog.getByTestId("repo-name").fill(`emu-scratch-${EMU_PASS_ID}`);
      await dialog.getByTestId("repo-git-url").fill("file:///srv/m4/fixtures/app.git");
      await emu.screen("rcn-3c", "add-repository");
      await dialog.getByTestId("repo-add-cancel").click();
      await expect(dialog, "Cancel closes the dialog").toBeHidden({ timeout: 10_000 });
      const repos = await page.request.get(
        `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos`,
      );
      expect(repos.status(), "the cancelled dialog read the repositories").toBe(200);
      const rows = (await repos.json()) as { items?: { name: string }[] };
      expect(
        (rows.items ?? []).map((row) => row.name),
        "cancelling wrote no repository",
      ).not.toContain(`emu-scratch-${EMU_PASS_ID}`);

      // The settings page carries the section's tabs — the menu's `Settings`
      // and `Members` rows are a tab strip over two routes.
      await settingsLink.click();
      await expect(page).toHaveURL(new RegExp(`/p/${ids.projectId}/settings$`), {
        timeout: 30_000,
      });
      const tabs = page.getByTestId("project-settings-tabs");
      await expect(
        tabs,
        "finding 09: the settings page owns the Settings | Members tab strip",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        tabs.getByTestId("project-settings-tab-settings"),
        "the Settings tab is the page you are on",
      ).toHaveAttribute("aria-current", "page");
      const membersTab = tabs.getByTestId("project-settings-tab-members");
      await expect(membersTab, "the Members tab is its own route").toHaveAttribute(
        "href",
        new RegExp(`^/p/${ids.projectId}/members$`),
      );
      await emu.screen("rcn-3c", "settings-tabs");
      await membersTab.click();
      await expect(page).toHaveURL(new RegExp(`/p/${ids.projectId}/members$`), {
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("project-members-page"),
        "the Members tab lands on the project's members page",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("project-settings-tab-members"),
        "the strip stays on the members page with Members current (one section, two pages)",
      ).toHaveAttribute("aria-current", "page");
    });

    await test.step("collapse to the rail (3c)", async () => {
      await page.getByTestId("sidebar-collapse").click();
      await expect(
        page.getByTestId("sidebar-expand"),
        "design 3c: the collapsed rail carries its expand control",
      ).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("new-chat-rail"), "design 3c: the rail's +").toBeVisible();
      await expect(
        page.getByTestId(`sidebar-rail-project-${ids.projectId}`),
        "design 3c: one initials tile per project",
      ).toBeVisible();
      await expect(
        page.getByTestId("sidebar-rail-library"),
        "design 3c/finding 02: the rail tile is labelled Workflows",
      ).toBeVisible();
      await emu.screen("rcn-3c", "rail");
    });

    await test.step("hovering a tile opens its flyout with the repos", async () => {
      await page.getByTestId(`sidebar-rail-project-${ids.projectId}`).hover();
      const flyout = page.getByTestId(`sidebar-rail-flyout-${ids.projectId}`);
      await expect(
        flyout,
        "design 3c: hovering (or focusing) a tile opens the project flyout",
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        flyout,
        `design 3c: the flyout lists the project's repositories (${FILE_REPO})`,
      ).toContainText(FILE_REPO, { timeout: 15_000 });
      // Goal item 2: the flyout is a ds Popover — the same shared arrow, in
      // the same box, claimed the same way.
      await expect(
        flyout.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      // Review round 2: design 3c's RIGHT panel is this exact state — a tile
      // hovered, the flyout OPEN with its pointer arrow crossing the 4px
      // gap — captured at both widths (the phone documents the rail away;
      // see the `rcn-3c flyout` landmarks). Nothing moves the mouse while
      // the two widths are shot, so the hover-driven flyout survives both.
      await emu.screen("rcn-3c", "flyout");
    });

    await test.step("reload — the collapsed state persists, then restore expanded", async () => {
      await page.reload();
      await expect(
        page.getByTestId("sidebar-expand"),
        "design 3c: the collapsed rail is a saved layout pref — it survives the reload",
      ).toBeVisible({ timeout: 30_000 });
      // Leave the column EXPANDED for every other journey (and every later
      // pass) — the preference lives on this user's account across passes.
      await page.getByTestId("sidebar-expand").click();
      await expect(page.getByTestId("sidebar-collapse")).toBeVisible({ timeout: 10_000 });
    });
  });

  test("repo list — the chat box, the chips, the workflows row, honest issues", async ({
    page,
    emu,
  }) => {
    // The GH_REPO capture reads a real GitHub tracker (authenticated on
    // Actions, anonymous locally — see github-read-credential.ts); a refusal
    // (502 github_rate_limited) is honest state, declared so it never counts
    // as harness noise (see issuesReadOf).
    emu.expectFailure(issuesReadOf(ids.projectId));
    await test.step("3a empty — a repo with nothing said yet says so", async () => {
      await page.goto(`/p/${ids.projectId}/${GH_REPO}`);
      await expect(page.getByTestId("repo-page"), "design 3a: the repo page renders").toBeVisible({
        timeout: 30_000,
      });
      const empty = page.getByTestId("repo-activity-empty");
      await expect(
        empty,
        "design 3a: the feed starts honestly empty (its own repo, this pass's project)",
      ).toBeVisible({ timeout: 30_000 });
      await expect(empty).toContainText(/say something in the thread box/i);
      await emu.screen("rcn-3a", "repo-feed-empty");
    });

    await test.step("3a — the chat box, the WORKFLOWS row, the honest OPEN ISSUES", async () => {
      await page.goto(`/p/${ids.projectId}/${FILE_REPO}`);
      await expect(page.getByTestId("repo-chat-box")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("repo-chat-input"),
        "design 3a: the thread box names the repo it threads in",
      ).toHaveAttribute("aria-label", new RegExp(`thread in ${FILE_REPO}`, "i"));
      // WORKFLOWS · n — the seeded pin's row: its trigger line, its latest
      // result line, its Run verb. (This project has no GitHub issues to hand
      // off — OPEN ISSUES proves that below.)
      const row = page
        .locator('[data-testid^="repo-workflow-row-"]')
        .filter({ hasText: WF_NAME })
        .first();
      await expect(row, "design 3a: the repo's workflow row").toBeVisible({ timeout: 30_000 });
      await expect(
        row.locator('[data-testid^="repo-workflow-triggers-"]').first(),
        "design 3a: the row carries a trigger line",
      ).toBeVisible();
      await expect(
        row.locator('[data-testid^="repo-workflow-result-"]').first(),
        "design 3a: the row carries a latest-result line",
      ).toBeVisible();
      // OPEN ISSUES on a file:// repo: the honest state, asserted HERE so a
      // passing capture proves it; the design's `Hand off` row cannot exist
      // without a GitHub tracker, and inventing one is the mockdata rule.
      const notGitHub = page.getByTestId("repo-issues-not-github");
      await expect(
        notGitHub,
        "design 3a: with no GitHub remote OPEN ISSUES says hand-offs need one — no fake issues",
      ).toBeVisible({ timeout: 15_000 });
      await expect(notGitHub).toContainText(/need a github repository/i);
      await emu.screen("rcn-3a", "repo");
    });

    await test.step("the filter chips: All · Runs · Chats · Mine", async () => {
      await page.getByTestId("repo-filter-runs").click();
      await expect(
        page.getByTestId("repo-activity-empty"),
        "the Runs chip shows the honest line when the repo has no runs",
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("repo-filter-chats").click();
      await expect(
        page.locator('[data-testid^="repo-chat-row-"]').first(),
        "the Chats chip shows the repo's chats",
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("repo-filter-mine").click();
      await expect(
        page.locator('[data-testid^="repo-chat-row-"]').first(),
        "Mine keeps the chats alice started",
      ).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("repo-filter-all").click();
    });

    await test.step("type + Start lands in the new repo-scoped chat", async () => {
      // Start the chat on the LAB LAUNCHER's profile, not the chip's
      // default (items[0] = migration 00003's `Claude Code`, which an
      // Actions runner cannot authenticate — see labProfiles). The 2e
      // turn legs and the 2f chat are real turns; under
      // COMMUNICATION_LAB_LAUNCHER=pi that means pi. Locally (claude
      // default) the first lab profile is the migration row the chip
      // already carries, so nothing moves.
      const lab = await labProfiles(page);
      await page.getByTestId("repo-chat-profile").click();
      const profileMenu = page.getByTestId("repo-chat-profile-menu");
      await expect(profileMenu, "the chat box's profile chip opens the picker").toBeVisible({
        timeout: 10_000,
      });
      await expect(
        profileMenu.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      await profileMenu.getByTestId(chatBoxProfileTestid(lab[0].id)).click();
      await expect(
        page.getByTestId("repo-chat-profile"),
        `the chat starts on the lab launcher's ${lab[0].name}`,
      ).toContainText(lab[0].name, { timeout: 10_000 });
      await page.getByTestId("repo-chat-input").fill(CHAT_PROMPT);
      await page.getByTestId("repo-chat-start").click();
      await page.waitForURL(/\/threads\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      ids.chatId = new URL(page.url()).pathname.split("/").pop() ?? "";
      expect(ids.chatId, "Start navigated to the created thread").toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        page.getByTestId("conversation-title"),
        "the thread is named by the prompt's own first line, never a paraphrase",
      ).toHaveText(CHAT_PROMPT.split("\n")[0]);
      await expect(
        page.getByTestId("side-panel-works-in"),
        "design 2e: the chat works in this repo",
      ).toContainText(FILE_REPO, { timeout: 15_000 });
    });

    await test.step("chat details — the sheet the 390 header opens (rcn-2e)", async () => {
      // rcn-chat-rail-390: at 390 the rail has no visible column, so the
      // header's Details toggle opens the SAME panel as a right-side sheet.
      // screen() shoots both widths from this one state: at 1280 the sheet
      // is not mounted (its toggle is lg:hidden) and the capture is the page
      // with the panel's visible column; at 390 the sheet stands open.
      await page.setViewportSize({ width: 390, height: 844 });
      const toggle = page.getByTestId("chat-details-toggle");
      await expect(
        toggle,
        "rcn-chat-rail-390: below lg the chat header offers Details",
      ).toBeVisible();
      await toggle.click();
      const sheet = page.getByTestId("chat-details-sheet");
      await expect(sheet, "Details opens the side panel as a right-side sheet").toBeVisible();
      await expect(
        sheet.getByTestId("conversation-side-panel"),
        "the sheet carries the same panel content the 1280 aside column does",
      ).toBeVisible();
      // The pin's width-local check at the capture's live state (rcn-review11).
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "chat-details");
      await expectChatPinBothWidths(page);
      // Close it for the journey's remaining steps — at the PHONE frame.
      // screen() restored the 1280 width, where the sheet is unmounted
      // (its toggle is `lg:hidden`), so an Esc there would hide nothing and
      // the hidden check would pass on the desktop width alone while the
      // sheet's open state leaked into the next 390 capture. Back to 390
      // first, where the sheet really mounts — then the desktop frame.
      // Readiness is the sheet itself: `open` is viewport-gated, so the
      // matchMedia change + React remount land asynchronously after the
      // resize, and the sheet registers its Escape listener synchronously
      // in its mount commit — a visible sheet is by construction an
      // Esc-listening one. (Pass 2's flake: Esc fired before the remount
      // and the sheet came back open.)
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        sheet,
        "the sheet is remounted and visible AT 390 before Esc",
      ).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(sheet, "Esc closes the sheet AT 390").toBeHidden({ timeout: 10_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await test.step("3a server-error — the runs read fails, the page owns it", async () => {
      emu.expectFailure(new RegExp(`/api/v1/projects/${ids.projectId}/runs$`), 500);
      await page.route(new RegExp(`/api/v1/projects/${ids.projectId}/runs$`), (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/problem+json",
          body: JSON.stringify({
            type: "about:blank",
            title: "Internal Server Error",
            detail: "Internal Server Error: emulated failure",
            status: 500,
          }),
        }),
      );
      await page.goto(`/p/${ids.projectId}/${FILE_REPO}`);
      const banner = page
        .getByRole("alert")
        // review 3a item 2: the card says the break once — the page's own
        // sentence, not the banner's three-line restatement.
        .filter({ hasText: /couldn.t load this repository.s runs/i })
        .first();
      await expect(
        banner,
        "design 3a: a failed runs read is an honest ProblemBanner in the feed, not a blank panel",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("repo-name"),
        "design 3a: the page keeps its heading over the failure",
      ).toBeVisible();
      await expect(
        page.locator('[data-testid^="repo-workflow-result-"]').first(),
        "the workflow rows do not invent a result over the failed read",
      ).toContainText(/runs unavailable|loading/i, { timeout: 15_000 });
      await emu.screen("rcn-3a", "server-error");
    });
  });

  test("repo lanes — the switch, the lanes, the per-repo persistence", async ({ page, emu }) => {
    await test.step("switch to Lanes", async () => {
      await page.goto(`/p/${ids.projectId}/${FILE_REPO}`);
      await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
      const savedPatch = page
        .waitForResponse((res) => /\/api\/v1\/me\/preferences$/.test(res.url()), {
          timeout: 20_000,
        })
        .catch(() => null);
      await page.getByTestId("repo-view-lanes").click();
      await expect(page.getByTestId("repo-lanes"), "design 3b: the Lanes view").toBeVisible({
        timeout: 15_000,
      });
      // The four lanes, and the WORKFLOWS chip row over them.
      await expect(page.getByTestId("repo-lane-workflows")).toBeVisible();
      await expect(page.getByTestId("repo-lane-issues")).toBeVisible();
      await expect(page.getByTestId("repo-lane-needs-you")).toBeVisible();
      await expect(page.getByTestId("repo-lane-running")).toBeVisible();
      await expect(page.getByTestId("repo-lane-finished")).toBeVisible();
      // Drag-to-start is a `web`-repo story with no GitHub issues it cannot
      // have: the lane's honest empty line IS the state (see 3a's OPEN
      // ISSUES assertion); nothing is dropped, so nothing is invented.
      await expect(
        page.getByTestId("repo-lane-issues-not-github"),
        "design 3b: the issues lane says hand-offs need a GitHub repository — no fake cards",
      ).toBeVisible();
      await savedPatch;
    });

    await test.step("reload — the choice persists per repo", async () => {
      await page.reload();
      await expect(
        page.getByTestId("repo-lanes"),
        "design 3b: the List/Lanes choice is saved per repo — it survives the reload",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("rcn-3b", "lanes");
    });

    await test.step("back to List (the default the next journey of any pass expects)", async () => {
      await page.getByTestId("repo-view-list").click();
      await expect(page.getByTestId("repo-runs"), "the List view is back").toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test("repo lanes drag — an issue dropped on RUNNING starts the workflow (rcn-3b)", async ({
    page,
    emu,
  }) => {
    // The goal item the rest of this file never proved: nothing dragged an
    // issue into RUNNING anywhere, because the lanes journey plays on `web`, a
    // file:// repo with no issues it can have. Here the board plays on
    // `server`, whose ISSUES lane reads the live api.github.com tracker, and
    // the drop is a real HTML5 drag (a DataTransfer carried through
    // dragstart/dragover/drop — the technique e2e/tests/issue2-studio.spec.ts
    // proves). Nothing is mocked or invented: the card is a served GitHub row,
    // the run is read back through the API, and the run the drop starts is
    // cancelled at the end so the pass leaves no work behind. The workflow it
    // starts is the pass's own `Emu lanes` pin — the only pin whose pinned
    // revision declares the ADR-0066 `github_issue` input the menu reads.
    test.setTimeout(8 * 60_000);
    let cardTestid = "";
    let issueNumber = 0;
    let draggedTitle = "";
    let draggedUrl = "";
    let tracker = "";

    await test.step("the pass's issue-accepting pin on `server`", async () => {
      await ensureDragPin(page);
      expect(ids.dragAssignmentId, "the pin the menu offers exists").toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("Lanes on `server`: the ISSUES lane lists a real issue", async () => {
      await page.goto(`/p/${ids.projectId}/${GH_REPO}`);
      await expect(page.getByTestId("repo-page"), "design 3a: the repo page renders").toBeVisible({
        timeout: 30_000,
      });
      const savedPatch = page
        .waitForResponse((res) => /\/api\/v1\/me\/preferences$/.test(res.url()), {
          timeout: 20_000,
        })
        .catch(() => null);
      await page.getByTestId("repo-view-lanes").click();
      await expect(page.getByTestId("repo-lanes"), "design 3b: the Lanes view").toBeVisible({
        timeout: 15_000,
      });
      // The cards come from GitHub. Whichever budget this pass reads on — the
      // authenticated 5000/hour one when the job exported the token file, the
      // anonymous 60/hour one otherwise — a spent budget (or a closed
      // tracker) leaves the lane saying so with the upstream's own words, and
      // this journey FAILS naming the mode it ran in — it does not drag an
      // invented card (the mockdata rule) and it does not skip.
      //
      // A transient upstream failure (run 42164529404 pass 2: one GitHub 5xx
      // emptied a lane over a tracker that was there the whole time) gets
      // what a person would do: while the lane shows its error line, ONE page
      // reload and ONE more poll — with the reload recorded as a note, never
      // hidden. Every final failure quotes what the lane actually said (its
      // visible error line) and what the issues route answers to a direct GET
      // (status + first 240 chars), so the next triage never has to guess.
      const issuesUrl = `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos/${ids.ghRepoId}/issues?state=open`;
      const laneErrorText = (): Promise<string> =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="repo-lane-issues-error"]');
          return el ? (el.textContent ?? "").replace(/\s+/g, " ").trim() : "";
        });
      const pollIssueCard = async (attempt: string): Promise<void> => {
        await expect
          .poll(
            async () => {
              cardTestid = await page.evaluate(() => {
                const ids = Array.from(
                  document.querySelectorAll('[data-testid^="repo-lane-issue-"]'),
                )
                  .map((el) => el.getAttribute("data-testid") ?? "")
                  .filter((id) => /^repo-lane-issue-\d+$/.test(id));
                return ids[0] ?? "";
              });
              return cardTestid;
            },
            {
              timeout: 45_000,
              message: `the ISSUES lane listed no open issue to drag — ${gitHubReadModeNote(GH_REPO)}; the lane names the upstream's own refusal in its error line (it never drags an invented card and never skips) [${attempt}]`,
            },
          )
          .not.toBe("");
      };
      const laneFailure = async (why: unknown, preReloadError: string): Promise<Error> => {
        const probe = await page.request.get(issuesUrl);
        const probeBody = (await probe.text()).slice(0, 240);
        const laneText = await laneErrorText();
        const quoted = why instanceof Error ? why.message : String(why);
        const pre = preReloadError === "" ? "" : ` (before the reload: "${preReloadError}")`;
        return new Error(
          `${quoted}\n` +
            `the lane's visible error line: "${laneText || "(none visible)"}"${pre}\n` +
            `direct GET of the issues route: ${probe.status()}: ${probeBody}`,
        );
      };
      try {
        await pollIssueCard("first attempt");
      } catch (firstFailure) {
        const firstError = await laneErrorText();
        if (firstError === "") {
          // The lane shows no error line to refresh against: nothing a
          // reload could fix — fail now, still quoting the lane's state and
          // the route's direct answer.
          throw await laneFailure(firstFailure, "");
        }
        journeyNote(
          "ISSUES lane: the first read left the lane saying " +
            `"${firstError}" — ${gitHubReadModeNote(GH_REPO)}; reloaded ONCE and ` +
            "polling again (a transient upstream failure gets the refresh a person would try)",
        );
        await page.reload();
        await expect(
          page.getByTestId("repo-lanes"),
          "design 3b: the Lanes view is back after the one reload",
        ).toBeVisible({ timeout: 30_000 });
        try {
          await pollIssueCard("after one reload");
        } catch (secondFailure) {
          throw await laneFailure(secondFailure, firstError);
        }
      }
      await savedPatch;
      issueNumber = Number(cardTestid.replace("repo-lane-issue-", ""));
      // The card is a row the tracker read answers — the lane did not make it up.
      const issues = await page.request.get(
        `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos/${ids.ghRepoId}/issues?state=open`,
      );
      const issuesBody = await issues.text();
      expect(
        issues.status(),
        `the tracker read the lane stands on answered (got ${issues.status()}: ${issuesBody.slice(0, 240)})`,
      ).toBe(200);
      const listed = JSON.parse(issuesBody) as {
        repository?: string;
        items?: { number: number; title: string; html_url: string }[];
      };
      const row = (listed.items ?? []).find((item) => item.number === issueNumber) ?? null;
      expect(
        row,
        `the lane's card #${issueNumber} is a row the issues route answers for`,
      ).toBeTruthy();
      draggedTitle = row!.title;
      draggedUrl = row!.html_url;
      tracker = listed.repository ?? "";
      expect(tracker, "the issues read echoes the owner/repo it called").toMatch(/^[^/]+\/[^/]+$/);
    });

    await test.step("drag the issue over RUNNING: the lane lights and catches it", async () => {
      const card = page.getByTestId(cardTestid);
      await expect(card, "design 3b: the issue is a draggable card").toContainText(
        `#${issueNumber}`,
      );
      await laneDrag(page, cardTestid, "dragstart");
      await laneDrag(page, "repo-lane-running", "dragover");
      await expect(
        page.getByTestId("repo-lane-running"),
        "design 3b: the RUNNING lane answers a dragged issue with the dashed accent lighting",
      ).toHaveClass(/outline-dashed/);
      await expect(
        page.getByTestId("repo-lane-drop-preview"),
        "design 3b: the lane previews the issue it is about to catch",
      ).toContainText(`#${issueNumber} · dragging`);
    });

    await test.step("the drop opens START #<n> WITH with its pointer arrow", async () => {
      await laneDrag(page, "repo-lane-running", "drop");
      const menu = page.getByTestId("repo-start-issue-menu");
      await expect(menu, "design 3b: the caught issue opens the START #<n> WITH menu").toBeVisible({
        timeout: 15_000,
      });
      await expect(menu).toContainText(new RegExp(`Start #${issueNumber} with`, "i"));
      await expect(
        menu.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      await expect(
        page.getByTestId("repo-lane-drop-card"),
        "design 3b: the caught card is the menu's anchor",
      ).toContainText(`#${issueNumber}`);
      await expect(
        page.getByTestId(`repo-start-issue-workflow-${testidKey(ids.dragAssignmentId)}`),
        "design 3b: the menu offers the pinned workflow whose pinned revision declares the github_issue input",
      ).toHaveText(DRAG_WF_NAME);
      // The pass's project-wide `Emu rcn` pin declares no issue input, so the
      // menu must not pretend it could take the issue.
      await expect(menu).not.toContainText(WF_NAME);
      await emu.screen("rcn-3b", "lanes-drag");
    });

    await test.step("choosing it starts the run — and the page lands on it", async () => {
      await page
        .getByTestId(`repo-start-issue-workflow-${testidKey(ids.dragAssignmentId)}`)
        .click();
      await page.waitForURL(/\/runs\/[0-9a-f-]{36}$/, { timeout: 30_000 });
      ids.dragRunId = new URL(page.url()).pathname.split("/").pop() ?? "";
      expect(ids.dragRunId, "the drop started a run and opened it").toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("the API holds a run for that issue, with the issue in its inputs", async () => {
      let row: {
        id: string;
        status: string;
        title?: string | null;
        repository_id?: string | null;
        assignment_id?: string | null;
        trigger?: { kind: string; ref?: string | null } | null;
      } | null = null;
      await expect
        .poll(
          async () => {
            row = (await projectRuns(page)).runs.find((run) => run.id === ids.dragRunId) ?? null;
            return row;
          },
          {
            timeout: 30_000,
            message: "the dropped issue never produced a row in the project's own run list",
          },
        )
        .not.toBeNull();
      expect(row!.assignment_id, "the run rides the pin the menu named").toBe(ids.dragAssignmentId);
      expect(
        row!.repository_id,
        "ADR-0060: the run is attributed to the repository the pin names",
      ).toBe(ids.ghRepoId);
      // ADR-0064: the run records the issue trigger fact a fire would have.
      expect(row!.trigger?.kind, "the run records an issue start").toBe("issue");
      expect(
        row!.trigger?.ref,
        "the trigger ref names the tracker and the number the card carried",
      ).toBe(`${tracker}#${issueNumber}`);
      expect(
        row!.title,
        "the run's banner is the issue's own title (the UI's 200-character bound)",
      ).toBe(draggedTitle.slice(0, 200));

      // ADR-0066: the issue rides the input the pinned revision declares, in
      // the runtime shape the plan's bindings read.
      let value: Record<string, unknown> = {};
      await expect
        .poll(
          async () => {
            const detail = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${ids.dragRunId}`);
            expect(
              detail.status(),
              `GET /api/v1/runs/${ids.dragRunId} answers (got ${detail.status()})`,
            ).toBe(200);
            const inputs =
              (
                (await detail.json()) as {
                  inputs?: { name: string; value: unknown; origin: string }[];
                }
              ).inputs ?? [];
            const input = inputs.find((entry) => entry.name === "issue") ?? null;
            value = (input?.value ?? {}) as Record<string, unknown>;
            return input === null ? "" : input.origin;
          },
          {
            timeout: 30_000,
            message:
              "the run never recorded its github_issue input (run_inputs are written in the creating transaction)",
          },
        )
        .toBe("submitted");
      expect(value.number, "issue.number is the number the card carried").toBe(issueNumber);
      expect(value.title, "issue.title is the tracker's own title").toBe(draggedTitle);
      expect(value.url, "issue.url is the tracker's own link").toBe(draggedUrl);
      expect(value.repo, "issue.repo is the owner/repo the issues read echoed").toBe(tracker);
    });

    await test.step("the Running lane wears the started run", async () => {
      await page.goto(`/p/${ids.projectId}/${GH_REPO}`);
      await expect(page.getByTestId("repo-page")).toBeVisible({ timeout: 30_000 });
      await page.getByTestId("repo-view-lanes").click();
      const card = page.getByTestId(`repo-lane-run-${testidKey(ids.dragRunId)}`);
      await expect(
        card,
        "design 3b: the issue dropped into RUNNING is now a running card",
      ).toBeVisible({ timeout: 45_000 });
      await expect(card).toContainText(DRAG_WF_NAME);
      // states.ts' words: a run the scheduler has not started yet reads
      // `pending`, a live one `running` — both are the RUNNING lane's story.
      await expect(card).toContainText(/running|pending/i);
      await emu.screen("rcn-3b", "lanes-running");
    });

    await test.step("cancel — this journey leaves no run for the lab to work through", async () => {
      const cancelled = await apiMutate(
        page,
        "POST",
        `${EMU_BASE_URL}/api/v1/runs/${ids.dragRunId}/cancel`,
      );
      const body = await cancelled.text();
      expect(
        cancelled.status(),
        `the cancel request answers 2xx (got ${cancelled.status()}: ${body.slice(0, 240)})`,
      ).toBeLessThan(300);
      // A cancel is a request; the stop is what the lanes must eventually show.
      // The workflow's only node is a two-minute `sleep` — no model call exists
      // in it, so nothing here can spend the lab's model budget either way.
      await expect
        .poll(
          async () => {
            const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${ids.dragRunId}`);
            return ((await res.json()) as { status?: string }).status ?? "";
          },
          {
            timeout: 5 * 60_000,
            message: `run ${ids.dragRunId} never reached a terminal status after the cancel`,
          },
        )
        .toMatch(/cancelled|completed|failed|interrupted/);
    });

    await test.step("back to List (the default the next journey of any pass expects)", async () => {
      await page.getByTestId("repo-view-list").click();
      await expect(page.getByTestId("repo-runs"), "the List view is back").toBeVisible({
        timeout: 15_000,
      });
    });
  });

  test("chat — control, the agent chip, a real turn, a switch, the agents panel", async ({
    page,
    emu,
  }) => {
    test.setTimeout(22 * 60_000);
    const chip = page.getByTestId("composer-agent-chip");
    await test.step("open the chat the List view started", async () => {
      expect(ids.chatId, "the repo-list journey left a chat").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/threads/${ids.chatId}`);
      await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
      await expect(chip, "design 2e: the composer carries the next-turn agent chip").toBeVisible({
        timeout: 30_000,
      });
      // The pin's width-local check at the capture's live state (rcn-review11).
      await expectChatPinLive(page, 1280);
      // The 390 shot keeps the Details sheet CLOSED, so the reviewer judges
      // the CHAT itself at 390: the panel's design landmarks accept the
      // header's Details toggle as the one tap that reaches the panel, and
      // the dedicated `rcn-2e chat-details*` screens show the open sheet.
      await page.setViewportSize({ width: 390, height: 844 });
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "chat");
      await expectChatPinBothWidths(page);
    });

    await test.step("the first prompt's turn settles (the turn legs are real)", async () => {
      // The chat was started from the repo page's chat box, so turn 1 is
      // already queued to the agent. Wait for it to settle: a turn RECORD
      // appears in the side panel (an agent row with its range), and the
      // chip becomes pressable again (it is disabled WHILE a turn is open —
      // ADR-0068). The assertions are on the turn record and the panel —
      // never on the agent's reply text; a turn the lab cannot complete
      // prints its honest `Turn failed:` line and settles between turns.
      await expect(
        page.locator('[data-testid^="side-panel-agent-row-"]').first(),
        "the side panel lists the agent that ran the turn (this needs the lab's worker and a real model)",
      ).toBeVisible({ timeout: 10 * 60_000 });
      await expect(
        page.locator('[data-testid^="side-panel-agent-range-"]').first(),
        "the row carries its turn range (`turn 1` / `turns 1–2`)",
      ).toContainText(/turn/i, { timeout: 30_000 });
      await expect(chip, "between turns the chip is pressable again").toBeEnabled({
        timeout: 10 * 60_000,
      });
    });

    await test.step("return control, then take it back", async () => {
      const give = page.getByTestId("return-control");
      await expect(give, "the starter is the controller and can hand control back").toBeVisible({
        timeout: 30_000,
      });
      await give.click({ timeout: 20_000 });
      const take = page.getByTestId("take-control");
      await expect(take, "design 2e: without control, Take control is the way back").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("composer-input"),
        "a non-controller cannot prompt: the composer is disabled",
      ).toBeDisabled({ timeout: 30_000 });
      await take.click({ timeout: 20_000 });
      await expect(
        page.getByTestId("controller-badge"),
        "design 2e: back in control, the badge names the controller",
      ).toContainText(/control/i, { timeout: 30_000 });
      await expect(chip, "the chip belongs to the controller again").toBeEnabled({
        timeout: 30_000,
      });
    });

    await test.step("switch the profile — the transcript prints the divider", async () => {
      // Pick deterministically: the conversation read names the current
      // profile id, the org list names another one, the menu row is its
      // `composer-agent-profile-<id>` testid. No label-guessing.
      const conv = await page.request.get(`${EMU_BASE_URL}/api/v1/conversations/${ids.chatId}`);
      expect(conv.status(), "the conversation read answers").toBe(200);
      const currentProfileId = ((await conv.json()) as { agent_profile_id?: string })
        .agent_profile_id as string;
      const profiles = await page.request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
      expect(profiles.status(), "the lab serves its agent profiles").toBe(200);
      const list = ((await profiles.json()) as { items?: ProfileRow[] }).items ?? [];
      // Switch WITHIN the lab launcher: the second turn must run on the
      // same launcher the chat started on (pi on Actions — the migration
      // claude/codex rows cannot answer there), just another profile, so
      // the AGENTS IN THIS CHAT list gets its two pi rows. Only when the
      // lab seeds a single launcher profile does the switch fall back to
      // any other profile (the pre-rule behaviour).
      const next =
        list.find(
          (profile) => profile.id !== currentProfileId && profile.launcher_id === LAB_LAUNCHER,
        ) ?? list.find((profile) => profile.id !== currentProfileId);
      expect(
        next,
        "the lab seeds more than one agent profile, so the picker has somewhere to switch to",
      ).toBeTruthy();
      await chip.click();
      const menu = page.getByTestId("composer-agent-menu");
      await expect(menu, "design 1h: the chip opens the picker").toBeVisible({ timeout: 10_000 });
      await expect(
        menu.getByText(/NEXT TURN RUNS ON/i),
        "design 1h: the menu captions itself",
      ).toBeVisible();
      await expect(
        menu.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      await menu.getByTestId(`composer-agent-profile-${next!.id}`).click();
      await expect(chip, `the chip moves to ${next!.name}`).toContainText(next!.name, {
        timeout: 30_000,
      });
      await expect(
        page.getByTestId("agent-switch-divider"),
        "design 2e: the switch prints its centred divider in the transcript",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("agent-switch-divider"),
        "the divider says the transcript and branch carried over",
      ).toContainText(/carried over/i, { timeout: 15_000 });
    });

    await test.step("a second real turn runs on the new profile", async () => {
      const composer = page.getByTestId("composer-input");
      await expect(composer, "the controller's composer is enabled").toBeEnabled();
      await composer.fill(`EMU-RCN ${EMU_PASS_ID} — reply with exactly OK`);
      await page.getByTestId("composer-send").click();
      await expect(composer, "the prompt is accepted into the journal").toHaveValue("", {
        timeout: 30_000,
      });
      // The AGENTS IN THIS CHAT list is per maximal run of turns: two turns
      // on two profiles must produce two rows, each with its range.
      const rows = page.locator('[data-testid^="side-panel-agent-row-"]');
      await expect(
        rows.nth(1),
        "the side panel shows BOTH agents with their turn ranges",
      ).toBeVisible({ timeout: 10 * 60_000 });
      await expect(chip, "the second turn settled").toBeEnabled({ timeout: 10 * 60_000 });
      // The pin's width-local check at the capture's live state (rcn-review11):
      // this is the exact screen whose newest row the review found under the
      // composer. Both emu widths, through the capture's own round-trip.
      await expectChatPinLive(page, 1280);
      // The 390 shot keeps the Details sheet CLOSED (see the chat capture
      // above): the panel's landmarks accept the toggle as the one tap.
      await page.setViewportSize({ width: 390, height: 844 });
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "switched");
      await expectChatPinBothWidths(page);
    });

    await test.step("chat details — the sheet with the switched agents (rcn-2e)", async () => {
      // rcn-chat-rail-390: the same capture on the switched state — the
      // sheet's AGENTS IN THIS CHAT rows carry the two turns' ranges.
      await page.setViewportSize({ width: 390, height: 844 });
      const toggle = page.getByTestId("chat-details-toggle");
      await expect(
        toggle,
        "rcn-chat-rail-390: below lg the chat header offers Details",
      ).toBeVisible();
      await toggle.click();
      const sheet = page.getByTestId("chat-details-sheet");
      await expect(sheet, "Details opens the side panel as a right-side sheet").toBeVisible();
      await expect(
        sheet.locator('[data-testid^="side-panel-agent-row-"]').first(),
        "the sheet lists the agents the turns ran on",
      ).toBeVisible({ timeout: 30_000 });
      // The pin's width-local check at the capture's live state (rcn-review11).
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "chat-details-switched");
      await expectChatPinBothWidths(page);
      // Same reset as the first chat-details step: screen() restored the
      // desktop frame, where the sheet is unmounted and a hidden check is
      // trivially true — so the Esc fires AT 390, where the sheet really
      // mounts, and the picker step below acts in the desktop frame.
      // Readiness is the sheet itself: `open` is viewport-gated, so the
      // matchMedia change + React remount land asynchronously after the
      // resize, and the sheet registers its Escape listener synchronously
      // in its mount commit — a visible sheet is by construction an
      // Esc-listening one. (Pass 2's flake: Esc fired before the remount
      // and the sheet came back open.)
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(
        sheet,
        "the sheet is remounted and visible AT 390 before Esc",
      ).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(sheet, "Esc closes the sheet AT 390").toBeHidden({ timeout: 10_000 });
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await test.step("the picker, captured with the menu open (rcn-1h)", async () => {
      await chip.click();
      const menu = page.getByTestId("composer-agent-menu");
      await expect(menu, "design 1h: the picker opens over the composer").toBeVisible({
        timeout: 10_000,
      });
      // Goal item 2, claimed at the capture's own live state: this is the
      // screen whose landmark list now carries `rcn-menu-arrow`.
      await expect(
        menu.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      // The pin's width-local check at the capture's live state (rcn-review11).
      await expectChatPinLive(page, 1280);
      await emu.screen("rcn-1h", "next-turn-menu");
      await page.keyboard.press("Escape");
      await expect(menu, "Esc closes the picker").toBeHidden({ timeout: 10_000 });
      // The menu is closed now, so the both-widths re-check is safe to run.
      await expectChatPinBothWidths(page);
    });
  });

  test("chat — WORKS IN moves the chat's scope and back", async ({ page, emu }) => {
    // Its own test, deliberately: as the chat journey's final step the
    // combined 22-minute leg exhausted the test budget before
    // `works-in-moved` was ever captured (run 41735462805) — the report
    // could not tell whether the budget ran out or a click waited forever.
    // Every action here is bounded, and after each capture the switcher
    // proves itself back at 1280 before the next click.
    await test.step("re-enter the chat on its own", async () => {
      expect(ids.chatId, "the chat journey left its thread").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/threads/${ids.chatId}`);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(
        page.getByTestId("conversation-title"),
        "the chat renders before the switcher is touched",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("thread-side-panel-aside"),
        "the side panel's aside renders at 1280 before the switcher is touched",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("WORKS IN — the scope switcher moves the chat to the whole project and back", async () => {
      // The ADR-0067 amendment's WORKS IN switcher (3ae47e6): the panel's repo
      // name carries a ▾ button that opens a ds Menu of the project's
      // repositories plus "Whole project", the DECLARED binding ticked, one
      // pick = one `PATCH /api/v1/conversations/{id}`. The journal's
      // `conversation.scope_changed` row is the transcript's own evidence —
      // the move prints its system line ("<person> moved this chat to …"),
      // and the new scope answers from the next turn. This step moves and
      // moves BACK, leaving the chat bound to the repo it was born in.
      const worksIn = page.getByTestId("side-panel-works-in");
      await expect(
        worksIn,
        "design 2e: the panel's WORKS IN names the repo the chat works in",
      ).toContainText(FILE_REPO);
      const switcher = page.getByTestId("side-panel-works-in-switch");
      await expect(
        switcher,
        "the repo name carries the scope switcher (the host names this chat)",
      ).toBeVisible();
      await switcher.click({ timeout: 15_000 });
      const scopeMenu = page.getByTestId("side-panel-scope-menu");
      await expect(scopeMenu, "the switcher opens the scope menu").toBeVisible({
        timeout: 10_000,
      });
      await expect(switcher, "the trigger reports the menu open").toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(scopeMenu, "the scope surface is the ds Menu").toHaveRole("menu");
      await expect(
        scopeMenu.getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      await expect(scopeMenu.getByRole("menuitem"), "the menu's rows").toHaveCount(3);
      await expect(
        scopeMenu.getByTestId("side-panel-scope-item-whole"),
        "the menu offers Whole project",
      ).toContainText(/whole project/i);
      await expect(
        scopeMenu.getByTestId(`side-panel-scope-item-${FILE_REPO}`),
        "the menu lists the chat's repository",
      ).toContainText(FILE_REPO);
      await expect(
        scopeMenu.getByTestId(`side-panel-scope-item-${GH_REPO}`),
        "the menu lists the project's other repository",
      ).toContainText(GH_REPO);
      await expect(
        scopeMenu.getByTestId(`side-panel-scope-item-${FILE_REPO}`),
        "the repo the chat works in is the one ticked",
      ).toContainText(new RegExp(`✓\\s*${FILE_REPO}`));
      await expect(
        scopeMenu.getByTestId("side-panel-scope-item-whole"),
        "Whole project is not ticked while the chat is bound",
      ).not.toContainText("✓");
      // The capture goes with the menu CLOSED, on purpose: screen() shoots
      // both widths from this state — at 1280 the menu is on the aside, and
      // at 390 the panel (the transcript's old inline stack, the
      // rcn-chat-rail-390 reflow, is gone — rcn-review14) sits behind the
      // header's Details toggle, which no menu state rides on. An open menu
      // (present at 1280, absent at 390) would file a false "390 lost" reflow
      // defect; the menu's structure is the assertions above, and the
      // landmark list for these two screens is what both widths show.
      await page.keyboard.press("Escape");
      await expect(scopeMenu, "Esc closes the scope menu").toBeHidden({ timeout: 10_000 });
      // The pin's width-local check at the capture's live state (rcn-review11).
      await expectChatPinLive(page, 1280);
      // The 390 shot keeps the Details sheet CLOSED (see the chat capture):
      // the panel's landmarks accept the toggle as the one tap.
      await page.setViewportSize({ width: 390, height: 844 });
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "works-in-menu");
      await expectChatPinBothWidths(page);

      // After each capture the switcher proves itself back at 1280 before
      // the next click: screen() resizes through 390 on its way back to
      // 1280, and a capture that left the panel re-mounted is exactly where
      // a click can hang with no bound of its own.
      // The 390 leg of the round-trip unmounts the aside on the matchMedia
      // change; back at 1280 the page remounts it, which lands a beat AFTER
      // setViewportSize. A click in that beat misses the switcher, which
      // then unmounts with the panel — so wait for the swap itself before
      // acting (faac464, run 41754108482: the reopened menu's items were
      // never found).
      await expect(
        page.getByTestId("chat-details-sheet"),
        "the Details sheet is unmounted at 1280 (its toggle is lg:hidden)",
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByTestId("thread-side-panel-aside").getByTestId("side-panel-works-in-switch"),
        "the switcher is back in the 1280 aside",
      ).toBeVisible({ timeout: 15_000 });
      await expect(switcher, "the switcher is back at 1280 after the capture").toBeVisible({
        timeout: 15_000,
      });
      await expect(switcher, "the switcher is back at 1280 after the capture").toBeEnabled({
        timeout: 15_000,
      });

      // Pick "Whole project": the panel's state answers (the tick moves —
      // the switcher reads the DECLARED binding the PATCH wrote back), and
      // the transcript prints the journal's scope-changed system line.
      await switcher.click({ timeout: 15_000 });
      await expect(scopeMenu, "the switcher reopens for the pick").toBeVisible({
        timeout: 10_000,
      });
      await scopeMenu.getByTestId("side-panel-scope-item-whole").click({ timeout: 15_000 });
      await expect(scopeMenu, "the pick closes the menu").toBeHidden({ timeout: 10_000 });
      await expect(
        page.getByText(/moved this thread to the whole project/i),
        "the transcript prints the journal's scope-changed system line",
      ).toBeVisible({ timeout: 30_000 });
      await switcher.click({ timeout: 15_000 });
      await expect(scopeMenu, "the switcher reopens to show the panel's state").toBeVisible({
        timeout: 10_000,
      });
      // The tick reads the DECLARED binding the PATCH wrote back to the
      // conversation cache (useChangeConversationScope's setQueryData) — allow
      // that write-back to settle, the same async the transcript line waited on.
      await expect(
        scopeMenu.getByTestId("side-panel-scope-item-whole"),
        "the panel's state text answers the move — Whole project is ticked",
      ).toContainText("✓", { timeout: 10_000 });
      await expect(
        scopeMenu.getByTestId(`side-panel-scope-item-${FILE_REPO}`),
        "the old binding's tick is gone",
      ).not.toContainText("✓", { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(scopeMenu, "Esc closes the scope menu").toBeHidden({ timeout: 10_000 });
      // The pin's width-local check at the capture's live state (rcn-review11):
      // the scope move printed a system line — a NEW transcript row — and
      // this is the screen whose last row the review found cut at 1280.
      await expectChatPinLive(page, 1280);
      // The 390 shot keeps the Details sheet CLOSED (see the chat capture):
      // the panel's landmarks accept the toggle as the one tap.
      await page.setViewportSize({ width: 390, height: 844 });
      await expectChatPinLive(page, 390);
      await emu.screen("rcn-2e", "works-in-moved");
      await expectChatPinBothWidths(page);

      // Same re-probe after the second capture (see above): the switcher
      // must be back at 1280 and pressable before the move-back click.
      // The 390 leg unmounted the aside; back at 1280 it remounts a beat
      // AFTER setViewportSize, so wait for the swap before acting.
      await expect(
        page.getByTestId("chat-details-sheet"),
        "the Details sheet is unmounted at 1280 (its toggle is lg:hidden)",
      ).toHaveCount(0, { timeout: 15_000 });
      await expect(
        page.getByTestId("thread-side-panel-aside").getByTestId("side-panel-works-in-switch"),
        "the switcher is back in the 1280 aside",
      ).toBeVisible({ timeout: 15_000 });
      await expect(switcher, "the switcher is back at 1280 after the capture").toBeVisible({
        timeout: 15_000,
      });
      await expect(switcher, "the switcher is back at 1280 after the capture").toBeEnabled({
        timeout: 15_000,
      });

      // Back to the repo the chat was born in (ADR-0067) — the second move
      // proves the system line renders in both directions, and the pass's
      // rows stay honest for whichever journey reads this chat later.
      await switcher.click({ timeout: 15_000 });
      await expect(scopeMenu, "the switcher reopens for the move back").toBeVisible({
        timeout: 10_000,
      });
      await scopeMenu.getByTestId(`side-panel-scope-item-${FILE_REPO}`).click({
        timeout: 15_000,
      });
      await expect(scopeMenu, "the pick closes the menu").toBeHidden({ timeout: 10_000 });
      await expect(
        page.getByText(new RegExp(`moved this chat to ${FILE_REPO}`, "i")),
        "the move back prints its own scope-changed system line",
      ).toBeVisible({ timeout: 30_000 });
    });
  });

  // Thread → workflow (design 2f) — run as the ORG ADMIN, not alice.
  // The library draft the flow saves needs the library role (spec
  // 01-domain-model: a project maintainer may publish a shared pipeline
  // "only with library role"), and the fail-closed reading holds: only an
  // organization admin has it today. For alice — the project maintainer —
  // the rail's `Make a workflow…` entry is disabled with the reason
  // (rcn-review11-2f), so the journey verifies the flow as the admin
  // session the 1j authoring journey already uses; the org admin reads
  // alice's thread (org-wide visibility) and the draft save succeeds.
  test.describe("thread → workflow (the library-draft actor is the org admin)", () => {
    test.use({ storageState: EMU_ADMIN_STATE });

    test("thread → workflow — Make a workflow… opens the assistant with the chat", async ({
      page,
      emu,
    }) => {
      // Round-9 defect A: the 2f capture fired while the model was still
      // "thinking…" — the drafting waits below can take a live-model turn each,
      // so this test gets its own headroom on top of the group's default.
      test.setTimeout(28 * 60_000);
      await test.step("the side panel's note and its Make a workflow… action", async () => {
        expect(ids.chatId, "the chat journey left its thread").toMatch(/^[0-9a-f-]{36}$/);
        await page.goto(`/threads/${ids.chatId}`);
        const note = page.getByTestId("assistant-note-workflow");
        await expect(
          note,
          "design 2e: the panel's ASSISTANT slot carries the workflow suggestion note",
        ).toBeVisible({ timeout: 30_000 });
        await expect(note).toContainText(/make a workflow/i);
        // The admin holds the library role, so the entry is the enabled one
        // (alice, its maintainer, sees it disabled with the reason — the
        // UI's own tests assert that half, rcn-review11-2f).
        await expect(
          page.getByTestId("assistant-note-workflow-action-make_workflow"),
          "the admin holds the library role, so the 2f entry is pressable",
        ).toBeEnabled();
      });

      await test.step("the assistant panel opens with the chat as context (2f)", async () => {
        // The ask must name THIS thread: the shipped canned line (e211688) is
        // `Turn the chat “<title>” into a workflow` — only a title-less chat
        // falls back to `Turn this chat into a workflow` — so the chat's own
        // title, read from the API, is what proves the note opened the panel on
        // this conversation rather than on some generic subject. The model's
        // answer is never asserted.
        const conv = await page.request.get(`${EMU_BASE_URL}/api/v1/conversations/${ids.chatId}`);
        expect(conv.status(), "the conversation read answers").toBe(200);
        const chatTitle = (((await conv.json()) as { title?: string }).title ?? "").trim();
        expect(chatTitle, "this journey's chat carries a title the ask can name").not.toBe("");
        await page.getByTestId("assistant-note-workflow-action-make_workflow").click();
        await expect(
          page.getByTestId("assistant-popover"),
          "design 2f: Make a workflow… opens the assistant panel",
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          page
            .getByText(
              new RegExp(
                `turn the chat [^\n]*${escapeForRegex(chatTitle)}[^\n]* into a workflow`,
                "i",
              ),
            )
            .first(),
          `the note's ask travels to the panel naming this chat (${chatTitle}) — the app's own canned line; the model's answer is never asserted`,
        ).toBeVisible({ timeout: 30_000 });
        // Round-9 defect A: capture ONLY after the answer has landed — the
        // `thinking…` line (AssistantPanel `assistant-thinking`) is gone AND
        // the answer carries at least one of the design's drafting elements:
        // the step list (`assistant-step-list`), a QUESTION card
        // (`assistant-question`) or the draft door — `Open draft`
        // (`assistant-open-draft`) in the wide panel, the transcript's `Go ›`
        // link row (`assistant-link`) in this 400px popover (MessageList.tsx /
        // QuestionCard.tsx / AssistantPanel.tsx). A question card IS the
        // design's state — capturing it is the right 2f. Bounded, generous
        // for a live model, the way the turn legs bound their waits.
        //
        // v565 pass-3 (defect B): the shared model gateway answers transient
        // 5xx to this stack even after the product's own egress retries
        // (internal/assistant/model.go: any 5xx/429, up to 3 attempts with
        // backoff). A failed turn stores nothing (ADR-0034) and the panel
        // answers the failed ask with its honest line and its own Retry
        // (Issue #63) — the journey takes that affordance (which proves it
        // works) up to twice, declaring the 503 itself as expected scratch
        // noise the way the GH-page legs declare their 502s, and quotes the
        // SERVER's failure bodies in the assertion when the turn still ends
        // without a drafting state. The assertion itself is unchanged.
        emu.expectFailure(/\/api\/v1\/assistant\/conversations\/[0-9a-f-]+\/messages$/, 503);
        const turnFailures: string[] = [];
        const onResponse = (res: import("playwright").Response) => {
          if (
            res.request().method() === "POST" &&
            res.url().includes(`/api/v1/assistant/conversations/${ids.chatId}/messages`) &&
            res.status() >= 500
          ) {
            void res
              .text()
              .then((body) =>
                turnFailures.push(
                  `http ${res.status()}: ` +
                    // Only the problem envelope's code+detail is quoted; the
                    // body is the server's own words, capped like everything
                    // else this file prints.
                    body.slice(0, 300),
                ),
              )
              .catch(() => turnFailures.push(`http ${res.status()}: <body unreadable>`));
          }
        };
        page.on("response", onResponse);
        try {
          const thinking = page.getByTestId("assistant-thinking");
          const askDeadline = Date.now() + 10 * 60_000;
          let retriesUsed = 0;
          let thinkingGone = false;
          for (;;) {
            for (;;) {
              if ((await thinking.count()) === 0) {
                thinkingGone = true;
                break;
              }
              if (Date.now() >= askDeadline) break;
              await page.waitForTimeout(2_000);
            }
            // A failed turn leaves the user bubble with `Retry` under it
            // (MessageList's Issue #63 row). Send the ask again the way the
            // product tells a human to — but never past a terminal answer:
            // only retry while the last thing seen was a failure line.
            const retry = page.getByTestId("assistant-send-retry");
            if (thinkingGone && (await retry.count()) > 0 && retriesUsed < 2) {
              retriesUsed += 1;
              await retry.last().click();
              thinkingGone = false;
              await page.waitForTimeout(2_000);
              continue;
            }
            break;
          }
          expect(
            thinkingGone,
            "design 2f: the assistant stopped thinking within the live-model budget",
          ).toBe(true);
          const draftingLocators = [
            page.getByTestId("assistant-step-list"),
            page.getByTestId("assistant-question"),
            page.getByTestId("assistant-open-draft"),
            page.getByTestId("assistant-link"),
          ];
          const lastAnswer = page.locator('[data-testid="assistant-msg-assistant"]').last();
          let drafted = false;
          let answerText = "";
          const draftDeadline = Date.now() + 10 * 60_000;
          for (;;) {
            if ((await lastAnswer.count()) > 0) {
              answerText = (await lastAnswer.innerText()).trim();
            }
            for (const locator of draftingLocators) {
              if ((await locator.count()) > 0) {
                drafted = true;
                break;
              }
            }
            if (drafted || Date.now() >= draftDeadline) break;
            await page.waitForTimeout(2_000);
          }
          expect(
            drafted,
            `design 2f: the answer must carry the drafting state — a step list, a QUESTION card or the draft door (Open draft). What the model actually answered: "${answerText.slice(0, 500)}"` +
              (retriesUsed > 0 ? ` [journey re-sent the failed ask ${retriesUsed}×]` : "") +
              (turnFailures.length > 0
                ? ` The server's own failure bodies: ${turnFailures.join(" | ")}`
                : ""),
          ).toBe(true);
          await emu.screen("rcn-2f", "workflow-draft");
          await page.keyboard.press("Escape");
        } finally {
          page.off("response", onResponse);
        }
      });
    });
  });

  // The 3d agent-mail journey sits at the END of this group (below the run
  // form): it is the file's longest leg — two real-model turns plus the
  // asked chat's — and nothing queues behind it.

  // Design 1k's central element is the ISSUE PICKER, so the `rcn-1k run-form`
  // capture opens the run-by-hand form on the pass's `Emu lanes` pin — the one
  // pin whose pinned revision declares the ADR-0066 `github_issue` input — on
  // `server`, whose GitHub remote the pass has already attached a read
  // credential to (github-read-credential.ts). The picker reads that tracker
  // itself and is captured OPEN over real issues, exactly as the handoff draws
  // it. The project-wide `Emu rcn` pin declares goal / repository / revision
  // and no issue input, so its form keeps its own capture on
  // `rcn-1k run-form-fields` — neither half of 1k loses its screen, and neither
  // one starts a run.
  test("run by hand — the form is built from the pinned revision's inputs", async ({
    page,
    emu,
  }) => {
    // The picker's rows come from api.github.com; the budget this pass reads on
    // is the one github-read-credential.ts names.
    test.setTimeout(8 * 60_000);

    await test.step("the pass's issue-accepting pin on `server`", async () => {
      await ensureDragPin(page);
      expect(
        ids.dragAssignmentId,
        "the pin whose revision declares the github_issue input exists",
      ).toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step("Run on `server` opens the raised form on that pin", async () => {
      await page.goto(`/p/${ids.projectId}/${GH_REPO}`);
      await expect(page.getByTestId("repo-page"), "design 3a: the repo page renders").toBeVisible({
        timeout: 30_000,
      });
      // The workflow row lives on the List view, and the view is a saved
      // per-repository preference another journey may have left on Lanes.
      if (!(await page.getByTestId("repo-workflows").isVisible().catch(() => false))) {
        await page.getByTestId("repo-view-list").click();
        await expect(
          page.getByTestId("repo-workflows"),
          "design 3a: List is back, with the repository's workflow rows",
        ).toBeVisible({ timeout: 30_000 });
      }
      const row = page
        .locator('[data-testid^="repo-workflow-row-"]')
        .filter({ hasText: DRAG_WF_NAME })
        .first();
      await expect(row, "the issue-accepting pin's row is on the page").toBeVisible({
        timeout: 30_000,
      });
      await row.locator('[data-testid^="repo-workflow-run-"]').first().click();
      await expect(
        page.getByTestId("run-form-dialog"),
        "design 1k: Run opens the raised form",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("the github_issue input is a picker, not a number field", async () => {
      await expect(
        page.getByTestId("run-form-title"),
        "design 1k: the title names the run",
      ).toContainText(/run /i);
      await expect(
        page.getByTestId("run-form-subtitle"),
        "design 1k: the mono subtitle names the pin",
      ).toContainText(/pinned r\d+/);
      await expect(
        page.getByTestId("new-run-input-issue-picker"),
        "design 1k: ISSUE TO WORK ON is the searchable picker over the repo's issues",
      ).toBeVisible({ timeout: 15_000 });
      const field = page.getByTestId("new-run-input-issue");
      expect(
        await field.evaluate((el) => el.tagName),
        "design 1k: the picker is a searchable input",
      ).toBe("INPUT");
      expect(
        await field.evaluate((el) => (el as HTMLInputElement).type),
        "design 1k: the issue is picked, never typed as a number",
      ).toBe("text");
      // It really has a tracker to read: neither honest fallback renders — the
      // "not pinned to one repository" line, nor the "not a GitHub repository"
      // one, nor the upstream's own error line.
      await expect(page.getByTestId("new-run-input-issue-no-repo")).toHaveCount(0);
      await expect(page.getByTestId("new-run-input-issue-not-github")).toHaveCount(0);
      await expect(page.getByTestId("new-run-input-issue-error")).toHaveCount(0);
    });

    let issueNumber = 0;
    let issueTitle = "";
    await test.step("the picker opens on `server`'s REAL open issues", async () => {
      // Focus opens it — the same interaction a person has, and the state the
      // design's 1k renders. It stays open across the widths `emu.screen`
      // captures at: nothing in a resize or a screenshot blurs the field.
      await page.getByTestId("new-run-input-issue").click();
      await expect(
        page.getByTestId("new-run-input-issue-options"),
        "design 1k: the field opens its list of issues",
      ).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          async () => {
            issueNumber = await page.evaluate(() => {
              const ids = Array.from(
                document.querySelectorAll('[data-testid^="new-run-input-issue-option-"]'),
              )
                .map((el) => el.getAttribute("data-testid") ?? "")
                .filter((id) => /^new-run-input-issue-option-\d+$/.test(id));
              const first = ids[0] ?? "";
              return first === "" ? 0 : Number(first.replace("new-run-input-issue-option-", ""));
            });
            return issueNumber;
          },
          {
            timeout: 45_000,
            message: `the issue picker listed no open issue — ${gitHubReadModeNote(GH_REPO)}; the picker shows the upstream's own refusal in its error line (it never invents a row and never skips)`,
          },
        )
        .not.toBe(0);
      // The row is one the tracker read answers — the picker did not make it up
      // (the same honesty check the rcn-3b lane drag makes against its card).
      const issues = await page.request.get(
        `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos/${ids.ghRepoId}/issues?state=open`,
      );
      const issuesBody = await issues.text();
      expect(
        issues.status(),
        `the tracker read the picker stands on answered (got ${issues.status()}: ${issuesBody.slice(0, 240)})`,
      ).toBe(200);
      const listed = JSON.parse(issuesBody) as {
        items?: { number: number; title: string }[];
      };
      const row = (listed.items ?? []).find((item) => item.number === issueNumber) ?? null;
      expect(
        row,
        `the picker's #${issueNumber} is a row the issues route answers for`,
      ).toBeTruthy();
      issueTitle = row!.title;
      await expect(
        page.getByTestId(`new-run-input-issue-option-${issueNumber}`),
        "the issue row carries the title the tracker gave",
      ).toContainText(issueTitle.slice(0, 24));

      await emu.screen("rcn-1k", "run-form");
    });

    await test.step("Cancel — this journey never starts a run", async () => {
      await page.getByTestId("new-run-cancel").click();
      await expect(page.getByTestId("run-form-dialog")).toBeHidden({ timeout: 15_000 });
      // The dialog owns the page's scroll only while it is up (1k review):
      // closing it hands the wheel back to the repo page.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.style.overflow), {
          timeout: 10_000,
          message: "the closed run form left the page scroll-locked",
        })
        .toBe("");
    });

    // The other half of 1k: a pinned revision that declares no issue input gets
    // the goal/repository/revision form — the same modal, none of the picker.
    await test.step("a revision with no issue input keeps its own capture", async () => {
      await page.goto(`/p/${ids.projectId}/${FILE_REPO}`);
      await expect(page.getByTestId("repo-chat-box"), "the List view is up").toBeVisible({
        timeout: 30_000,
      });
      const row = page
        .locator('[data-testid^="repo-workflow-row-"]')
        .filter({ hasText: WF_NAME })
        .first();
      await expect(row, "the pinned workflow's row is on the page").toBeVisible({
        timeout: 30_000,
      });
      await row.locator('[data-testid^="repo-workflow-run-"]').first().click();
      await expect(
        page.getByTestId("run-form-dialog"),
        "design 1k: Run opens the raised form",
      ).toBeVisible({ timeout: 30_000 });
      // The pinned revision declares goal (long_text → textarea), repository
      // (text → input) and revision (branch → mono text field on its default).
      const goal = page.getByTestId("new-run-input-goal");
      await expect(goal, "design 1k: `goal` is a field built from the inputs").toBeVisible({
        timeout: 15_000,
      });
      expect(
        await goal.evaluate((el) => el.tagName),
        "design 1k: a long_text input renders as a textarea",
      ).toBe("TEXTAREA");
      const revision = page.getByTestId("new-run-input-revision");
      await expect(
        revision,
        "design 1k: a branch input renders as a text field on its default",
      ).toBeVisible();
      await expect(revision).toHaveValue("main");
      // This pin declares no issue input, so 1k's picker is NOT on the form —
      // the fields come from the pinned revision, never from a guess.
      await expect(page.getByTestId("new-run-input-issue-picker")).toHaveCount(0);
      await expect(
        page.getByTestId("new-run-submit"),
        "design 1k: the footer's primary verb is Start run",
      ).toBeVisible();
      await emu.screen("rcn-1k", "run-form-fields");
    });

    await test.step("Cancel — and no run on this pin either", async () => {
      await page.getByTestId("new-run-cancel").click();
      await expect(page.getByTestId("run-form-dialog")).toBeHidden({ timeout: 15_000 });
    });
  });

  test("agent mail — the controller asks the agent in `server` with @ (rcn-3d, ADR-0072)", async ({
    page,
    emu,
  }) => {
    // The ADR-0072 § 9 person-initiated path end to end on the lab's REAL
    // models: the composer @-menu offers the project's other repo, sending
    // `@server <question>` dispatches the ask on the spot (a fresh linked
    // chat bound to `server`, born controller `none`, permission-locked to
    // `ask` — read-only), the card and LINKED CHATS fold in over the chat's
    // own stream, and the asked agent's answer rides back the same way the
    // worker's agent-dispatched answer does. Deterministic by construction:
    // no live model has to EMIT anything for the ask to dispatch — only the
    // asked agent's answer still runs on the real launcher. The
    // agent-initiated fenced-block path is covered by the Go tests
    // (TestParseMailCommands, TestAgentMail*, TestPostMessageMailTo*).
    test.setTimeout(30 * 60_000);

    await test.step("settings — flip agent mail on through the UI", async () => {
      await ensureProject(page);
      await ensureRepos(page);
      const project = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${ids.projectId}`);
      expect(project.status(), "the project read answers").toBe(200);
      expect(
        await project.json(),
        "the Project wire shape carries ADR-0072's agent_mail_enabled (a pre-ADR lab fails HERE, naming itself)",
      ).toHaveProperty("agent_mail_enabled");
      await page.goto(`/p/${ids.projectId}/settings`);
      await expect(
        page.getByTestId("agent-mail-panel"),
        "design 3d: the project settings carry the agent-mail switch",
      ).toBeVisible({ timeout: 30_000 });
      const toggle = page.getByTestId("agent-mail-toggle");
      await expect(
        toggle,
        "alice created this project — its maintainer may flip the switch (off by default, ADR-0072 § 1)",
      ).toBeEnabled({ timeout: 15_000 });
      if (!(await toggle.isChecked())) {
        const patched = page.waitForResponse(
          (res) =>
            res.request().method() === "PATCH" &&
            new URL(res.url()).pathname === `/api/v1/projects/${ids.projectId}`,
          { timeout: 20_000 },
        );
        // The switch is deliberately server-confirmed: `checked` only flips
        // when the PATCH lands (the label reads `Saving…` meanwhile —
        // ADR-0072's optimistic-version write), so Playwright's strict
        // `check()` (an immediate flip demanded in the same tick) is not
        // what the design asks for. Click, then assert it LANDS checked —
        // with the PATCH status and the state line still asserted below.
        await toggle.click();
        await expect(toggle, "the switch lands on once the PATCH is accepted").toBeChecked({
          timeout: 20_000,
        });
        const res = await patched;
        // Browser-side response: a bodyless answer (a 204, or a body the
        // network layer dropped) throws on read, so guard it like the
        // dismissal above.
        const body = res.ok() ? "" : await res.text().catch(() => "<body unavailable>");
        expect(
          res.status(),
          `the settings PATCH lands (got ${res.status()}: ${body.slice(0, 200)})`,
        ).toBe(200);
      }
      await expect(
        page.getByTestId("agent-mail-state"),
        "design 3d: the state line reads on",
      ).toContainText(/on — chats in this project may ask/i, { timeout: 15_000 });
    });

    await test.step("start the chat in `web` and take control", async () => {
      await ensureMailChat(page);
      expect(ids.mailChatId, "the mail chat exists").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/threads/${ids.mailChatId}`);
      await expect(page.getByTestId("conversation-title")).toBeVisible({ timeout: 30_000 });
      const take = page.getByTestId("take-control");
      if (await take.isVisible()) {
        await take.click({ timeout: 20_000 });
      }
      await expect(
        page.getByTestId("controller-badge"),
        "design 2e: the prompter holds control",
      ).toContainText(/control/i, { timeout: 30_000 });
      await expect(
        page.getByTestId("composer-mail-hint"),
        "ADR-0072 § 8: the composer's @ hint renders ONLY while the setting is on — its presence is the switch riding into the chat",
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step("ask `server` from the composer with @", async () => {
      const composer = page.getByTestId("composer-input");
      await expect(composer, "the controller's composer is enabled").toBeEnabled();
      // Typing `@` opens the ds menu over the project's OTHER repos (this
      // chat is bound to `web`); picking `server` completes the token, and
      // the question rides behind it. The ask dispatches on SEND — the mail
      // arm of the messages route (§ 9), not a prompt turn.
      await composer.pressSequentially("@");
      const askItem = page.getByTestId(`composer-mail-repo-${GH_REPO}`);
      await expect(askItem, "the @-menu lists the other repo's agent as askable").toBeVisible({
        timeout: 15_000,
      });
      // Goal item 2 — the @-menu is a ds Menu anchored on the composer, so it
      // carries the shared arrow like every other anchored surface.
      await expect(
        page.getByTestId("composer-mail-menu").getByTestId("menu-arrow"),
        "design: every anchored surface has a pointer arrow",
      ).toBeVisible();
      await expect(page.getByTestId("composer-mail-repo-web")).toHaveCount(0);
      await askItem.click();
      await expect(composer, "picking the repo completes the @ token").toHaveValue(`@${GH_REPO} `);
      // The caret rides the completion: `pickMention` parks it in the SAME
      // synchronous commit that writes `@<repo> ` (AgentConversationPanel.tsx),
      // and only while the field still holds that exact value. It used to wait a
      // `requestAnimationFrame`, which an unthrottled keystroke train outran —
      // the caret jumped back behind the typing and the question rode into the
      // ask out of order (Actions run 41542324484, passes 1–4). So the journey
      // types the way a person does: no throttle, no waiting for the caret.
      await composer.pressSequentially(MAIL_QUESTION);
      // …and the composer is where a lost or moved character is caught, with
      // its own words, rather than three steps later inside the mail card.
      await expect(
        composer,
        "the composer holds the @ token and the question whole before the Ask",
      ).toHaveValue(`@${GH_REPO} ${MAIL_QUESTION}`);
      const send = page.getByTestId("composer-send");
      await expect(
        send,
        "the verb flips to Ask while the composer holds a mail mention",
      ).toHaveText("Ask");
      await send.click();
      await expect(composer, "the ask lands (202) and the composer clears").toHaveValue("", {
        timeout: 30_000,
      });
    });

    await test.step("the inline card appears and LINKED CHATS lists `server`", async () => {
      // The ask is durable the moment the POST lands; the card rides this
      // chat's own event stream — no asking-model turn to wait behind.
      await expect(
        page.getByTestId("mail-card").first(),
        "design 3d: the § 9 @-ask opened the mail card in this chat",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("mail-card-bar").first(),
        "the card's bar names the asked repo",
      ).toContainText(/asked the agent in/i);
      await expect(page.getByTestId("mail-card-bar").first()).toContainText(GH_REPO);
      // The question rides the ASKING CHAT verbatim. Where the transcript
      // prints it is the surface's choice — the § 9 ask is a person's message,
      // and round-5 part A renders it as the person's own line above the card
      // (`ConversationTranscript`'s `mail-ask-<link>` user item, still
      // uncommitted here) rather than a quote inside the card — so the journey
      // holds the whole sentence in the transcript it just sent it into,
      // instead of pinning one component's test id. The full question, not
      // just this pass's token: a reordered or truncated ask fails HERE.
      await expect(
        page.getByTestId("conversation-main"),
        "the question rode through verbatim (it carries this pass's token)",
      ).toContainText(MAIL_QUESTION, { timeout: 30_000 });
      await expect(
        page.getByTestId("side-panel-link-chat-0"),
        "design 3d: LINKED CHATS lists the linked chat for `server`",
      ).toContainText(GH_REPO, { timeout: 30_000 });
      await expect(page.getByTestId("side-panel-link-state-0")).toContainText(/asked|answered/i);
    });

    await test.step("the answer arrives", async () => {
      const link = await waitForMailLink(page, ids.mailChatId, 12 * 60_000);
      expect(link, "the ask created a link with two ends").toBeTruthy();
      ids.mailLinkedChatId = link!.otherConversationId;
      expect(
        link!.state,
        `design 3d: the ask settles 'answered' — it settled '${link!.state}'${
          link!.reason ? ` (${link!.reason})` : ""
        } on linked chat ${ids.mailLinkedChatId} (MailAnswerTimeout is 10 min). Name the cause in the report; do not retry this journey into a fake`,
      ).toBe("answered");
      expect(
        (link!.answer ?? "").trim().length,
        "the answer text rides back on the link (≤ 16 KiB)",
      ).toBeGreaterThan(0);
      await expect(
        page.getByTestId("mail-card-answer").first(),
        "the 3d card prints its '← server · <agent>' answer line",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("mail-card-answer").first()).toContainText(
        new RegExp(`\u2190\\s*${GH_REPO}`),
      );
      await expect(page.getByTestId("side-panel-link-state-0")).toContainText(/answered/i, {
        timeout: 30_000,
      });
      // round-19 defect on 3d: the AGENTS IN THIS CHAT list carried only the
      // profile that RAN turns — the asked agent is a participant too, and
      // the design (3d: "Codex · gpt-5 api, asked once") gives it its own
      // row, derived from the very link LINKED CHATS reads. Assert the row
      // at the desktop rail: the asked repo and the ask count, and no
      // invented model name anywhere on it.
      const askedRow = page.getByTestId("side-panel-asked-row-0");
      await expect(
        askedRow,
        "design 3d: AGENTS IN THIS CHAT lists the asked agent as its own row",
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("side-panel-asked-repo-0")).toHaveText(GH_REPO);
      await expect(askedRow).toContainText(/asked once/i);
      // The pin's width-local check at the capture's live state (rcn-review11):
      // the mail card plus its answer line are NEW transcript rows.
      await expectChatPinLive(page, 1280);
      // The 390 shot keeps the Details sheet CLOSED (see the chat capture):
      // the panel's landmarks accept the toggle as the one tap.
      await page.setViewportSize({ width: 390, height: 844 });
      await expectChatPinLive(page, 390);
      // …and at 390 the panel's one home is the Details sheet — the asked
      // agent's row must ride it (round-19, same defect, phone width).
      await page.getByTestId("chat-details-toggle").click();
      const detailsSheet = page.getByTestId("chat-details-sheet");
      await expect(
        detailsSheet,
        "rcn-chat-rail-390: the Details sheet opens at 390",
      ).toBeVisible({ timeout: 15_000 });
      await expect(
        detailsSheet.getByTestId("side-panel-asked-row-0"),
        "design 3d at 390: the asked agent's row rides the Details sheet",
      ).toContainText(GH_REPO);
      await expect(detailsSheet.getByTestId("side-panel-asked-row-0")).toContainText(
        /asked once/i,
      );
      // Close it for the capture — the sheet mounted and visible HERE is by
      // construction an Esc-listening one (b26f218's flake lesson).
      await expect(detailsSheet).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(detailsSheet, "Esc closes the sheet AT 390").toBeHidden({ timeout: 10_000 });
      await emu.screen("rcn-3d", "mail-card");
      await expectChatPinBothWidths(page);
    });

    await test.step("B's workspace shows no writes (API)", async () => {
      // ADR-0072 § 4's read-only arm, proven off the shipped workspace
      // manifest (workspace_repos.modified_paths — the same read ADR-0072's
      // Verification section names), not off a UI promise.
      const list = await page.request.get(
        `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/workspaces`,
      );
      expect(list.status(), "the workspace list answers").toBe(200);
      const body = (await list.json()) as {
        workspaces?: {
          id: string;
          conversation_id?: string | null;
          repos?: { name: string; modified_paths?: string[] }[];
        }[];
      };
      const mine = (body.workspaces ?? []).filter(
        (w) => w.conversation_id === ids.mailLinkedChatId,
      );
      expect(
        mine.length,
        `the asked chat ${ids.mailLinkedChatId} has a workspace row (its turn ran)`,
      ).toBeGreaterThan(0);
      for (const repo of mine[mine.length - 1].repos ?? []) {
        expect(
          repo.modified_paths ?? [],
          `ADR-0072 read-only: the asked chat's \`${repo.name}\` checkout shows no writes`,
        ).toEqual([]);
      }
    });
  });
});

test.describe("repo-chat-nav (admin: authoring the inputs, rcn-1j)", () => {
  test.describe.configure({ mode: "serial", timeout: 6 * 60_000 });
  test.use({ storageState: EMU_ADMIN_STATE });

  test("the Inputs tab — add the issue input, save the draft, read WHO FILLS", async ({
    page,
    emu,
  }) => {
    await test.step("the tab on the draft (the seeded workflow, published r1)", async () => {
      // Resolve-or-create: a worker restart after an earlier red still
      // stands on THIS pass's published workflow.
      await ensureWorkflow(page);
      expect(ids.pipelineId, "the admin seed published the workflow").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/workflows/${ids.pipelineId}?tab=inputs`);
      await expect(page.getByTestId("inputs-tab"), "design 1j: the Inputs tab renders").toBeVisible(
        {
          timeout: 30_000,
        },
      );
      await expect(page.getByTestId("workflow-tab-inputs")).toHaveAttribute("aria-current", "page");
      await expect(
        page.getByTestId("input-add"),
        "design 1j: '+ add input' is the authoring verb",
      ).toBeVisible();
    });

    await test.step("add `issue`, typed GitHub issue, required, saved", async () => {
      await page.getByTestId("input-add").click();
      await expect(page.getByTestId("input-add-form")).toBeVisible();
      await page.getByTestId("input-add-name").fill("issue");
      await page.getByTestId("input-add-type").selectOption("github_issue");
      await page.getByTestId("input-add-save").click();
      const row = page.getByTestId("input-item-issue");
      await expect(
        row,
        "design 1j: the saved draft carries the new row (the first save opens the draft)",
      ).toBeVisible({ timeout: 30_000 });
      // The add flow opens the row's accent-wash editor itself once the save
      // lands — whenever that is. The row click TOGGLES the editor, so the
      // check-and-click is polled until the editor stands open, never raced.
      const editor = page.getByTestId("input-editor-issue");
      await expect
        .poll(
          async () => {
            if (!(await editor.isVisible().catch(() => false))) {
              await row.locator('[data-testid^="input-row-"]').click({ timeout: 5_000 });
              await editor.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
            }
            return editor.isVisible().catch(() => false);
          },
          {
            timeout: 30_000,
            message: "design 1j: the row expands into the accent-wash editor",
          },
        )
        .toBe(true);
      await page.getByTestId("input-required-issue").click();
      await page.getByTestId("input-save-issue").click();
      await expect(
        page.getByTestId("input-editor-issue"),
        "the editor closes on a saved input",
      ).toBeHidden({ timeout: 30_000 });
      await expect(
        page.getByTestId("input-item-issue"),
        "design 1j: the row says required in the REQUIRED column",
      ).toContainText(/required/i, { timeout: 30_000 });
    });

    await test.step("add `ticket`, plain text, required — the input NO trigger fills", async () => {
      // The warning this journey exists to read (ADR-0066's
      // `input_unfillable_by_trigger`) fires for a REQUIRED input with NO
      // DEFAULT that an assigned trigger cannot fill. It cannot fire for the
      // template's own inputs here: the seeded trigger's `inputs` map carries
      // `goal` and `repository` (ensureTrigger), so the server answers —
      // correctly — that the trigger fills both. The honest way to see the
      // warning is to author the input no trigger names, so the journey does.
      await page.getByTestId("input-add").click();
      await expect(page.getByTestId("input-add-form")).toBeVisible();
      await page.getByTestId("input-add-name").fill("ticket");
      await page.getByTestId("input-add-type").selectOption("text");
      await page.getByTestId("input-add-save").click();
      const row = page.getByTestId("input-item-ticket");
      await expect(row, "design 1j: the second saved input joins the list").toBeVisible({
        timeout: 30_000,
      });
      const editor = page.getByTestId("input-editor-ticket");
      await expect
        .poll(
          async () => {
            if (!(await editor.isVisible().catch(() => false))) {
              await row.locator('[data-testid^="input-row-"]').click({ timeout: 5_000 });
              await editor.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
            }
            return editor.isVisible().catch(() => false);
          },
          {
            timeout: 30_000,
            message: "design 1j: the new row expands into its editor",
          },
        )
        .toBe(true);
      await page.getByTestId("input-required-ticket").click();
      await page.getByTestId("input-save-ticket").click();
      await expect(
        page.getByTestId("input-editor-ticket"),
        "the editor closes on a saved input",
      ).toBeHidden({ timeout: 30_000 });
      await expect(row, "design 1j: `ticket` is required and carries no default").toContainText(
        /required/i,
        { timeout: 30_000 },
      );
    });

    await test.step("WHO FILLS THE INPUTS — by hand, and the labeled-issue trigger", async () => {
      await expect(page.getByTestId("who-fills"), "design 1j: the WHO FILLS panel").toBeVisible();
      await expect(
        page.getByTestId("who-fills-hand-line"),
        "design 1j: by hand, the form asks for the required inputs",
      ).toContainText(/form asks for/i, { timeout: 30_000 });
      await expect(
        page.getByTestId("who-fills-hand-line"),
        "ADR-0066: the hand line names the required input with no default",
      ).toContainText(/ticket/i, { timeout: 15_000 });
      const issueRow = page.locator('[data-testid^="who-fills-issue-"]').first();
      await expect(issueRow, "design 1j: the seeded issue trigger gets its row").toBeVisible({
        timeout: 30_000,
      });
      await expect(
        issueRow,
        "design 1j / ADR-0066: the single issue input is filled by the matched issue",
      ).toContainText(/← the labeled issue/i, { timeout: 15_000 });
      // ADR-0066: the validate the save just re-ran carries ONE server
      // warning per (trigger, required input with no default the trigger
      // cannot fill), and each one gets its own `!` line under the row it
      // names — the rule that covers every trigger kind, not just schedules.
      // `ticket` is the input the server must complain about: no assigned
      // trigger names it and it has no default. (`issue` rides along on the
      // issue trigger's row for its own reason — the pin this trigger fires
      // predates the issue input, so the pinned revision resolves no mapping
      // for it. Asserted nowhere here on purpose: the panel's ✓ line above is
      // the client's own single-issue-input reading.)
      //
      // The line is the panel's OWN sentence built from the warning's
      // structured fields: an id-bearing human sentence, never the server's
      // raw text with its fact id and ADR reference in the member's reading
      // line. Those parts stay one hover away in the title attribute.
      const ticketWarn = page
        .locator('[data-testid^="who-fills-warn-"][data-testid$="-ticket"]')
        .first();
      await expect(
        ticketWarn,
        "ADR-0066: the required input no trigger fills is named in a sentence",
      ).toContainText(/^! ticket is required and the issue trigger/i, { timeout: 30_000 });
      await expect(
        ticketWarn,
        "round-4 defect 3: the sentence carries no fact id, no ADR citation",
      ).not.toContainText(/01[0-9a-f]{7}-|adr-/i);
      // The attribute NAME is a plain string: `toHaveAttribute` takes
      // `name: string` and looks that name up verbatim, so a RegExp name is
      // asked of the element as the literal attribute "/title/i" — Playwright
      // then reports `Received string: ""` / `unexpected value "null"` on a
      // row whose `title` carries the whole server sentence (Actions run
      // 41542324484: this line was red in all six passes with the tooltip
      // visibly present in the resolved DOM node). The contract is unchanged:
      // the raw server sentence rides the row's `title` tooltip.
      await expect(
        ticketWarn,
        "the raw warning stays in the tooltip for whoever debugs the form",
      ).toHaveAttribute("title", /cannot fill required input "ticket".*ADR-0066/i, {
        timeout: 15_000,
      });
      // And the inputs the trigger DOES template get no warning: the panel
      // may not invent one (4aa75fe — the seeded trigger's `inputs` map
      // carries `goal` and `repository`, so both are fillable).
      for (const input of ["goal", "repository"]) {
        await expect(
          page.locator(`[data-testid^="who-fills-warn-"][data-testid$="-${input}"]`),
          `ADR-0066: the trigger templates ${input}, so it earns no warning`,
        ).toHaveCount(0);
      }
      await expect(
        issueRow,
        "ADR-0066: the warnings mark the trigger row waiting-pale",
      ).toHaveClass(/bg-st-waiting-pale-body/);
    });

    await test.step("the draft is the open one, the YAML preview says so", async () => {
      await expect(
        page.getByTestId("workflow-draft-state"),
        "design 1j: the header marks the open draft (nothing of it published)",
      ).toContainText(/unpublished/i, { timeout: 30_000 });
      await expect(
        page.getByTestId("inputs-yaml-preview"),
        "design 1j: the YAML preview carries the inputs block",
      ).toContainText(/issue/i, { timeout: 15_000 });
    });

    await test.step("design 1j: the issue row expands into its editor for the capture", async () => {
      // The design's Inputs tab shows the `issue` row EXPANDED into the
      // accent-wash editor (Label, Type, Help text, Required and the
      // reference line) — the saves above closed their editors, so the
      // row's toggle opens it again. screen() shoots BOTH widths from this
      // one state, and expansion is state, not CSS: the editor stands open
      // at 390 exactly as it does at 1280.
      const toggle = page.getByTestId("input-row-issue");
      await expect(
        toggle,
        "the issue row's toggle stands collapsed after the saves",
      ).toHaveAttribute("aria-expanded", "false", { timeout: 15_000 });
      await toggle.click({ timeout: 15_000 });
      const editor = page.getByTestId("input-editor-issue");
      await expect(editor, "design 1j: the issue row expands into its editor").toBeVisible({
        timeout: 15_000,
      });
      await expect(
        editor.getByTestId("input-label-issue"),
        "the editor's Label field",
      ).toBeVisible();
      await expect(editor.getByTestId("input-type-issue"), "the editor's Type field").toBeVisible();
      await expect(
        editor.getByTestId("input-type-issue"),
        "the Type reads GitHub issue",
      ).toHaveValue("github_issue");
      await expect(
        editor.getByTestId("input-help-issue"),
        "the editor's Help text field",
      ).toBeVisible();
      await expect(
        editor.getByTestId("input-required-issue"),
        "the editor's Required toggle",
      ).toBeVisible();
      await expect(
        editor.getByTestId("input-used-issue"),
        "the reference line naming the steps that read the input",
      ).toBeVisible();
      await expect(
        editor.getByTestId("input-used-issue"),
        "design 1j: the reference line — the steps' reading, or the honest 'not used yet' when no step names it",
      ).toHaveText(/used( as| by any step yet)/i);
      await emu.screen("rcn-1j", "inputs");
    });
  });
});

test.describe("repo-chat-nav (alice: leave the lab quiet)", () => {
  test.describe.configure({ mode: "serial", timeout: 3 * 60_000 });
  test.use({ storageState: EMU_ALICE_STATE });

  test("pause the pass's issue trigger", async ({ page }) => {
    // Same rule as repo-triggers: a trigger left armed keeps polling GitHub
    // from every pass's lab forever. PAUSE it — pass-stamped rows stay.
    // Resolve this pass's rows first (a worker restart clears module state);
    // if the seed never got this far, there is nothing to quiet down.
    await ensureWorkflow(page);
    await ensureTrigger(page);
    test.skip(ids.triggerId === "", "the seed never produced a trigger to pause");
    // Re-read the row: PATCH spends the version the caller last saw.
    const list = await page.request.get(
      `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/issue-triggers`,
    );
    expect(list.status(), "the trigger list answers").toBe(200);
    const rows = (await list.json()) as {
      issue_triggers?: { id: string; version: number }[];
    };
    const row = (rows.issue_triggers ?? []).find((entry) => entry.id === ids.triggerId);
    expect(row, "the seeded trigger is still listed").toBeTruthy();
    const res = await apiMutate(
      page,
      "PATCH",
      `${EMU_BASE_URL}/api/v1/issue-triggers/${ids.triggerId}`,
      { version: row!.version, enabled: false },
    );
    const body = await res.text();
    expect(
      res.status(),
      `pausing the trigger answers 2xx (got ${res.status()}: ${body.slice(0, 240)})`,
    ).toBeLessThan(300);
  });

  test("cancel any run the lanes drag left holding its pin", async ({ page }) => {
    // The lanes journey cancels its own run; this is the net for a pass that
    // died between the drop and that step — a live run would hold the pin's
    // single slot and keep a worker busy for nothing. Read-only resolve: a
    // pass whose seed never reached the pin has nothing of its own to quiet.
    const rows = await resolveDragPin(page);
    test.skip(rows === null, "this pass created no lanes-drag pin, so nothing of it is running");
    const list = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${rows!.projectId}/runs`);
    expect(list.status(), "the project run list answers").toBe(200);
    const runs = (await list.json()) as {
      runs?: { id: string; status: string; assignment_id?: string | null }[];
    };
    const live = (runs.runs ?? []).filter(
      (run) =>
        run.assignment_id === rows!.assignmentId &&
        ["queued", "preparing", "running", "waiting_human", "paused"].includes(run.status),
    );
    for (const run of live) {
      const res = await apiMutate(page, "POST", `${EMU_BASE_URL}/api/v1/runs/${run.id}/cancel`);
      const body = await res.text();
      expect(
        res.status(),
        `cancelling the leftover run ${run.id} answers 2xx (got ${res.status()}: ${body.slice(0, 240)})`,
      ).toBeLessThan(300);
    }
    if (live.length === 0) return;
    await expect
      .poll(
        async () => {
          const after = await page.request.get(
            `${EMU_BASE_URL}/api/v1/projects/${rows!.projectId}/runs`,
          );
          const rowsOut = (await after.json()) as {
            runs?: { id: string; status: string; assignment_id?: string | null }[];
          };
          return (rowsOut.runs ?? []).filter(
            (run) =>
              run.assignment_id === rows!.assignmentId &&
              !["completed", "failed", "cancelled", "interrupted"].includes(run.status),
          ).length;
        },
        {
          timeout: 4 * 60_000,
          message: "the pass's lanes-drag run is still live after its cancel request",
        },
      )
      .toBe(0);
  });
});
