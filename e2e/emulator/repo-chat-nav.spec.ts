// Journeys for handoff-repo-chat-nav (docs/design/handoff-repo-chat-nav/) —
// the shell, the repo page (List + Lanes), repo chats, thread → workflow, the
// Inputs tab and the run-by-hand form. The handoff's renders reuse the OLD
// badge numbers (its 2e is not the Workflows Review's 2e), so every badge
// here is namespaced `rcn-` — env.ts `EMU_DESIGN_DIRS` maps `rcn-3a` to
// handoff-repo-chat-nav/png/3a.png without touching anyone's files.
//
// What the journeys play (the handoff's final picks):
//   rcn-3c — the one left sidebar: collapse to the rail, hover a rail project
//            tile for its flyout, the tree row's ⋯ project menu, and the
//            collapsed state surviving a reload (a saved layout pref). Ends
//            EXPANDED so the next journey of any pass starts from the default.
//   rcn-3a — the repo List view: the chat box (type + Start lands in the new
//            repo-scoped chat), the All/Runs/Chats/Mine chips, the WORKFLOWS
//            row (trigger line + latest-result line + Run), and the OPEN
//            ISSUES panel — which on the lab's file:// repo is the honest
//            `Issue hand-offs need a GitHub repository` state, never a fake
//            issue row to Hand off (mockdata rule). Plus the feed's empty
//            state and its runs-read server error, the way empty-error.spec.ts
//            and server-error.spec.ts do theirs.
//   rcn-3b — Lanes: the switch, the four lanes with the WORKFLOWS chip row,
//            the honest empty issues lane (drag-to-start needs real issues,
//            which a file:// repo cannot have), and the choice persisting per
//            repo across a reload. Ends back on List.
//   rcn-2e + rcn-1h — the chat: control handoff, the composer's agent chip
//            ("NEXT TURN RUNS ON"), a real turn on one profile, a switch to
//            another (the transcript divider), a second real turn, and the
//            side panel's AGENTS IN THIS CHAT with its turn ranges.
//   rcn-2f — the side panel's `Make a workflow…` opens the assistant panel
//            with the chat as context. The ask is the app's own canned line;
//            what the model answers with is deliberately NOT asserted.
//   rcn-1j — the Inputs tab: add an input, set its type to GitHub issue,
//            mark it required, save the draft, and the WHO FILLS rows.
//   rcn-1k — Run from the repo's workflow row opens the form whose fields are
//            built from the pinned revision's declared inputs. Cancelled —
//            these journeys never start a run of this pin.
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
// ADR-0066 annotations the forms read); alice creates a project with TWO
// repositories — `web` (the lab's file:// fixture remote) and `server` (a
// real, tiny public github.com repo — the issue trigger's honest home,
// because the server refuses an issue trigger on a non-GitHub repo, and the
// remote must be mirrorable for the chat's turns to run) — pins the workflow,
// authors a labeled issue trigger on `server`, and seeds one repo-scoped
// chat. Everything is pass-stamped and left behind; only the trigger is
// paused at the end so its poller stops with the pass.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, apiMutate } from "./fixtures.js";
import { EMU_ADMIN_STATE, EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID, EMU_REPO_ROOT } from "./env.js";

const WF_NAME = `Emu rcn ${EMU_PASS_ID}`;
const WF_SLUG = `emu-rcn-${EMU_PASS_ID}`.toLowerCase();
const PROJECT_NAME = `Emu rcn ${EMU_PASS_ID}`;
const PROJECT_SLUG = `emu-rcn-${EMU_PASS_ID}`.toLowerCase();
const FILE_REPO = "web";
const GH_REPO = "server";
// The trigger repo's remote is a REAL — and deliberately tiny — public
// repository: the worker mirrors EVERY repository of a chat's project
// before a turn runs, and an unreachable remote fails the turn's workspace
// prep outright (observed with the missing-* shape: `server.git failed:
// could not read Username`). octocat/Hello-World mirrors in a keystroke, its
// issue reads ride the anonymous GitHub budget, and the trigger stays inert
// — no issue of it carries this pass's label, and the pass PAUSES the
// trigger at the end anyway.
const GH_URL = "https://github.com/octocat/Hello-World.git";
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
};

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
    "      revision:\n        type: string\n        default: \"main\"\n        x-communication-input:\n          type: branch\n          label: Revision\n  outputs:",
  );
  expect(
    revisionEdit,
    "the template's inputs block ends where the branch property is added",
  ).not.toBe(text);
  return revisionEdit;
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

/** alice: `web` on the lab's file:// fixture remote, `server` on a real
 * public GitHub repo (the issue trigger's honest home — the server refuses
 * one on a non-GitHub repo with `not_a_github_repository`, which is exactly
 * the List view's asserted empty state on `web`). */
async function ensureRepos(page: Page): Promise<void> {
  if (ids.fileRepoId !== "" && ids.ghRepoId !== "") return;
  const list = await page.request.get(
    `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos`,
  );
  expect(list.status(), "the repository list answers").toBe(200);
  const repos = (await list.json()) as { items?: { id: string; name: string }[] };
  const find = (name: string): string =>
    (repos.items ?? []).find((entry) => entry.name === name)?.id ?? "";
  const create = async (name: string, gitUrl: string): Promise<string> => {
    const res = await apiMutate(
      page,
      "POST",
      `${EMU_BASE_URL}/api/v1/projects/${ids.projectId}/repos`,
      { name, git_url: gitUrl, default_branch: "main" },
    );
    const body = await res.text();
    expect(
      res.status(),
      `adding ${name} answers 201 (got ${res.status()}: ${body.slice(0, 240)})`,
    ).toBe(201);
    return (JSON.parse(body) as { id: string }).id;
  };
  ids.fileRepoId =
    find(FILE_REPO) !== "" ? find(FILE_REPO) : await create(FILE_REPO, "file:///srv/m4/fixtures/app.git");
  ids.ghRepoId = find(GH_REPO) !== "" ? find(GH_REPO) : await create(GH_REPO, GH_URL);
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
  const profiles = await page.request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
  expect(profiles.status(), "the lab serves its agent profiles").toBe(200);
  const profileList = (await profiles.json()) as { items?: { id: string }[] };
  const firstProfile = profileList.items?.[0]?.id ?? "";
  expect(firstProfile, "the lab seeds at least one agent profile").toMatch(/^[0-9a-f-]{36}$/);
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
  const profiles = await page.request.get(`${EMU_BASE_URL}/api/v1/agent-profiles`);
  expect(profiles.status(), "the lab serves its agent profiles").toBe(200);
  const profileList = (await profiles.json()) as { items?: { id: string }[] };
  const firstProfile = profileList.items?.[0]?.id ?? "";
  expect(firstProfile, "the lab seeds at least one agent profile").toMatch(/^[0-9a-f-]{36}$/);
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

    await test.step("the repo-scoped chat (ADR-0067: born bound to `web`)", async () => {
      await ensureSeedChat(page);
    });
  });

  test("shell — one sidebar, the rail, the flyout, the ⋯ menu, persisted collapse", async ({
    page,
    emu,
  }) => {
    // A GH-page leg fans out to the real tracker's issues read; the
    // lab's own 502s on it are scratch noise, declared (see issuesReadOf).
    emu.expectFailure(issuesReadOf(ids.projectId));
    await test.step("expanded (2c): New chat, Today, My chats, PROJECTS, LIBRARY", async () => {
      await page.goto(`/p/${ids.projectId}`);
      await expect(page.getByTestId("sidebar"), "design 2c: the one left column renders").toBeVisible(
        { timeout: 30_000 },
      );
      await expect(page.getByTestId("new-chat"), "design 2c: New chat").toBeVisible();
      await expect(
        page.getByTestId("sidebar-link-home"),
        "design 2c: the row is Today (was Home)",
      ).toContainText(/today/i);
      await expect(
        page.getByTestId("sidebar-link-threads"),
        "design 2c: My chats",
      ).toContainText(/my chats/i);
      await expect(
        page.getByTestId(`sidebar-project-toggle-${ids.projectId}`),
        "design 2c: the PROJECTS tree carries the project",
      ).toBeVisible();
      await expect(
        page.getByTestId("sidebar-link-workflows"),
        "design 2c: the LIBRARY section leads with Workflows",
      ).toBeVisible();
      await emu.screen("rcn-3c", "expanded");
    });

    await test.step("the tree row's ⋯ opens the project menu", async () => {
      const row = page.getByTestId(`sidebar-project-toggle-${ids.projectId}`);
      await row.hover();
      const menuButton = page.getByTestId(`sidebar-project-menu-${ids.projectId}`);
      await expect(
        menuButton,
        "design 2c: the ⋯ appears on hover/focus of a project row",
      ).toBeVisible();
      await menuButton.click();
      const menu = page.getByTestId("sidebar-project-menu");
      await expect(menu, "design 2c: the ⋯ menu opens").toBeVisible({ timeout: 10_000 });
      // The menu took the tree's configuration rows out of the tree (DECISIONS).
      for (const testid of [
        "project-menu-settings",
        "project-menu-members",
        "project-menu-add-repository",
        "project-menu-workflows",
      ]) {
        await expect(
          menu.getByTestId(testid),
          `design 2c: the ⋯ menu carries its ${testid.replace("project-menu-", "")} entry`,
        ).toBeVisible();
      }
      // Review round 2: design 3c's LEFT panel is this exact state — the ⋯
      // menu OPEN, its pointer arrow aimed at the project row — captured at
      // both widths (the phone's documented reflow replaces the column with
      // its strip, exactly as for `expanded`/`rail`; see the `rcn-3c menu`
      // landmarks). screen() resizes through 390 on its way back to 1280,
      // which unmounts the column and its menu with it, so the Esc step
      // below reads a menu that is closed — the honest answer either way.
      await emu.screen("rcn-3c", "menu");
      await page.keyboard.press("Escape");
      await expect(menu, "design 2c: Esc closes the menu").toBeHidden();
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
      await expect(page.getByTestId("sidebar-rail-library"), "design 3c: Library").toBeVisible();
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
    // The GH_REPO capture reads a real GitHub tracker on the lab's anonymous
    // budget; a refusal (502 github_rate_limited) is honest state, declared
    // so it never counts as harness noise (see issuesReadOf).
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
      await expect(empty).toContainText(/say something in the chat box/i);
      await emu.screen("rcn-3a", "repo-feed-empty");
    });

    await test.step("3a — the chat box, the WORKFLOWS row, the honest OPEN ISSUES", async () => {
      await page.goto(`/p/${ids.projectId}/${FILE_REPO}`);
      await expect(page.getByTestId("repo-chat-box")).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByTestId("repo-chat-input"),
        "design 3a: the chat box names the repo it chats in",
      ).toHaveAttribute("aria-label", new RegExp(`chat in ${FILE_REPO}`, "i"));
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
        .filter({ hasText: /runs could not be loaded/i })
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
      await emu.screen("rcn-2e", "chat");
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
      const list = ((await profiles.json()) as { items?: { id: string; name: string }[] }).items ?? [];
      const next = list.find((profile) => profile.id !== currentProfileId);
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
      await menu.getByTestId(`composer-agent-profile-${next!.id}`).click();
      await expect(
        chip,
        `the chip moves to ${next!.name}`,
      ).toContainText(next!.name, { timeout: 30_000 });
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
      await emu.screen("rcn-2e", "switched");
    });

    await test.step("the picker, captured with the menu open (rcn-1h)", async () => {
      await chip.click();
      const menu = page.getByTestId("composer-agent-menu");
      await expect(menu, "design 1h: the picker opens over the composer").toBeVisible({
        timeout: 10_000,
      });
      await emu.screen("rcn-1h", "next-turn-menu");
      await page.keyboard.press("Escape");
      await expect(menu, "Esc closes the picker").toBeHidden({ timeout: 10_000 });
    });
  });

  test("thread → workflow — Make a workflow… opens the assistant with the chat", async ({
    page,
    emu,
  }) => {
    await test.step("the side panel's note and its Make a workflow… action", async () => {
      expect(ids.chatId, "the chat journey left its thread").toMatch(/^[0-9a-f-]{36}$/);
      await page.goto(`/threads/${ids.chatId}`);
      const note = page.getByTestId("assistant-note-workflow");
      await expect(
        note,
        "design 2e: the panel's ASSISTANT slot carries the workflow suggestion note",
      ).toBeVisible({ timeout: 30_000 });
      await expect(note).toContainText(/make a workflow/i);
    });

    await test.step("the assistant panel opens with the chat as context (2f)", async () => {
      await page.getByTestId("assistant-note-workflow-action-make_workflow").click();
      await expect(
        page.getByTestId("assistant-popover"),
        "design 2f: Make a workflow… opens the assistant panel",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        // The app's canned ask for a TITLED chat is `Turn the chat “title”
        // into a workflow` (the 2f review — pinned by the ui unit tests);
        // the title-less chat keeps `Turn this chat into a workflow`. Match
        // either form of the app's own line; the model's answer is never
        // asserted.
        page.getByText(/turn (the chat [^\n]*|this chat) into a workflow/i).first(),
        "the note's ask travels to the panel (the app's own canned line — the model's answer is never asserted)",
      ).toBeVisible({ timeout: 30_000 });
      await emu.screen("rcn-2f", "workflow-draft");
      await page.keyboard.press("Escape");
    });
  });

  // The 3d agent-mail journey sits at the END of this group (below the run
  // form): it is the file's longest leg — two real-model turns plus the
  // asked chat's — and nothing queues behind it.

  test("run by hand — the form is built from the pinned revision's inputs", async ({
    page,
    emu,
  }) => {
    await test.step("Run from the repo's workflow row", async () => {
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
    });

    await test.step("the fields are the declared inputs", async () => {
      await expect(
        page.getByTestId("run-form-title"),
        "design 1k: the title names the run",
      ).toContainText(/run /i);
      await expect(
        page.getByTestId("run-form-subtitle"),
        "design 1k: the mono subtitle names the pin",
      ).toContainText(/pinned r\d+/);
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
      await expect(
        page.getByTestId("new-run-submit"),
        "design 1k: the footer's primary verb is Start run",
      ).toBeVisible();
      await emu.screen("rcn-1k", "run-form");
    });

    await test.step("Cancel — this journey never starts a run", async () => {
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
        const body = await res.text();
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
      await expect(
        askItem,
        "the @-menu lists the other repo's agent as askable",
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("composer-mail-repo-web")).toHaveCount(0);
      await askItem.click();
      await expect(composer, "picking the repo completes the @ token").toHaveValue(
        `@${GH_REPO} `,
      );
      await composer.type(MAIL_QUESTION);
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
      await expect(
        page.getByTestId("mail-card-question").first(),
        "the question rode through verbatim (it carries this pass's token)",
      ).toContainText(MAIL_QUESTION_TOKEN);
      await expect(
        page.getByTestId("side-panel-link-chat-0"),
        "design 3d: LINKED CHATS lists the linked chat for `server`",
      ).toContainText(GH_REPO, { timeout: 30_000 });
      await expect(page.getByTestId("side-panel-link-state-0")).toContainText(
        /asked|answered/i,
      );
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
      await emu.screen("rcn-3d", "mail-card");
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
      await expect(page.getByTestId("inputs-tab"), "design 1j: the Inputs tab renders").toBeVisible({
        timeout: 30_000,
      });
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
        .poll(async () => {
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
      ).toBe(true);
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

    await test.step("WHO FILLS THE INPUTS — by hand, and the labeled-issue trigger", async () => {
      await expect(page.getByTestId("who-fills"), "design 1j: the WHO FILLS panel").toBeVisible();
      await expect(
        page.getByTestId("who-fills-hand-line"),
        "design 1j: by hand, the form asks for the required inputs",
      ).toContainText(/form asks for/i, { timeout: 30_000 });
      const issueRow = page.locator('[data-testid^="who-fills-issue-"]').first();
      await expect(
        issueRow,
        "design 1j: the seeded issue trigger gets its row",
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        issueRow,
        "design 1j / ADR-0066: the single issue input is filled by the matched issue",
      ).toContainText(/← the labeled issue/i, { timeout: 15_000 });
      // Review round 2: the seeded trigger fills only the issue input, and
      // this workflow's `goal` and `repository` are required with no default
      // — the validate the save just re-ran carries ONE server warning per
      // (trigger, input), and each one gets its own `!` line on the row
      // (ADR-0066's `input_unfillable_by_trigger`, the rule that covers
      // every trigger kind, not just schedules).
      for (const input of ["goal", "repository"]) {
        await expect(
          page.locator(`[data-testid^="who-fills-warn-"][data-testid$="-${input}"]`).first(),
          `ADR-0066: the unfilled required input ${input} shows the server's warning`,
        ).toContainText(/^! .*(cannot fill required input|can't fill)/, { timeout: 15_000 });
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
});
