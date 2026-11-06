// M2 exit journey (11-build-roadmap.md, 06-collaboration-identity handoff,
// 12-test-strategy E2E): two signed-in members of one project share a single
// live conversation driven by a REAL Claude session on the worker — one
// controller at a time, and control moves between them.
//
// alice (creator/maintainer) starts the conversation and answers a permission
// request; bob (contributor) watches it live on the second API replica, takes
// control mid-turn (which cancels alice's turn honestly, not silently), writes
// a file through the agent with his own permission decision, and returns
// control. Both API replicas are then restarted and both members' transcripts
// are still identical — the journal, not the process, is the conversation.
//
// THIS SUITE NEEDS A REAL AGENT: it is skipped unless COMMUNICATION_E2E_HARNESS=1
// (CI carries no agent credentials, so CI runs only the M1 suite). See
// e2e/README.md for the harness bring-up. Every wait below is bounded — a hung
// agent fails the suite rather than hanging it.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  AGENT_TURN_TIMEOUT_MS,
  API_A_URL,
  API_B_URL,
  BASE_URL,
  HARNESS_ENABLED,
  PERMISSION_TIMEOUT_MS,
} from "./env.js";
import {
  allowOpenPermission,
  expectTurnStatus,
  gotoApp,
  openPermissionCard,
  restartComposeServices,
  sendPrompt,
  setMember,
  signIn,
  startConversation,
  takeControl,
  waitForOpenPermission,
} from "./helpers.js";
import { IS_PI_LAUNCHER, LAB_LAUNCHER, seedLabPiProfile } from "./lab-launcher.js";

// Throwaway mock-IdP identities with readable profiles (ADR-0012 §4: the app
// takes the display name from the id token's `name` claim). The subjects are
// THIS journey's own: ADR-0012 §4 refreshes the stored profile on every login
// (name → preferred_username → subject), and the lab's other suites re-login
// the bare `alice`/`bob` subjects with email-only claims, which would reset
// their stored display name mid-run to the login (`Controlled by alice`). The
// control-holder badge below is the fact under test, so the journey drives
// identities no other suite writes — the display name it asserts is then
// the name the server really resolved on both replicas.
const STAMP = process.env.E2E_M2_STAMP ?? Date.now().toString(36);
const ALICE = { subject: `m2-alice-${STAMP}`, name: `Alice Andersen ${STAMP}` };
const BOB = { subject: `m2-bob-${STAMP}`, name: `Bob Brennan ${STAMP}` };

const PROJECT_NAME = `Hello World onboarding ${STAMP}`;
const REPO_NAME = "hello-world";
const REPO_GIT_URL = "https://github.com/octocat/Hello-World.git";
const REPO_BRANCH = "master";

// The agent profile this journey drives: the product's default `Claude Code`
// seed under the claude launcher (local runs unchanged), and a pi profile
// seeded the seed.sh way under `pi` (see beforeAll).
const PROFILE = IS_PI_LAUNCHER ? `m2-pi-${STAMP}` : "Claude Code";

// Phrased as instructions to one specific tool with exact content: the journey
// is about who is driving, not about what the model chooses to do. The file is
// named exactly: octocat/Hello-World's only file is `README` with no extension,
// and a prompt that said "the README" sent a real model to read `README.md`,
// whose failed read it papered over with a hallucinated summary.
const FIRST_PROMPT = `Read the file repos/${REPO_NAME}/README (it has no file extension) and summarise it in one sentence.`;
// ~50s of work, so the takeover below lands while the turn is still running.
const LONG_PROMPT =
  "Use the Bash tool to run exactly: for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; " +
  "sleep 5; done then say FINISHED.";
const WRITE_PROMPT = `Use the Write tool to create repos/${REPO_NAME}/NOTES.md containing exactly: handoff ok`;

// A permission card can take a whole upstream stall plus the agent's retry of
// the stalled tool call to appear (issue #28 — see PERMISSION_TIMEOUT_MS in
// env.ts), and a test then still has to decide that card and let the turn close.
// The per-test ceiling is that chain; the waits themselves fail early when the
// turn is over, so this budget is only ever paid to a live agent.
const TEST_TIMEOUT_MS = Number(
  process.env.E2E_M2_TEST_TIMEOUT_MS ?? PERMISSION_TIMEOUT_MS * 2 + AGENT_TURN_TIMEOUT_MS + 120_000,
);

test.describe("M2 shared conversation and control handoff", () => {
  test.describe.configure({ mode: "serial", timeout: TEST_TIMEOUT_MS });
  test.skip(
    !HARNESS_ENABLED,
    "Needs the harness stack with a real agent login — run with COMMUNICATION_E2E_HARNESS=1",
  );

  let aliceContext: BrowserContext;
  let bobContext: BrowserContext;
  let alice: Page;
  let bob: Page;
  let projectPath = "";
  let conversationPath = "";

  test.beforeAll(async ({ browser }) => {
    // Two contexts = two cookie jars = two logged-in users against the same
    // shared stack (ADR-0006: the browser is never the only proof).
    aliceContext = await browser.newContext();
    bobContext = await browser.newContext();
    alice = await aliceContext.newPage();
    // bob's page lives on replica B from the start: reading a conversation
    // from a different API replica than the one that wrote it is the point.
    bob = await bobContext.newPage();
    // Under the lab launcher `pi` (COMMUNICATION_LAB_LAUNCHER=pi) the product
    // API can only write `ask` profiles (ADR-0030) and pi is never-asks
    // (ADR-0069), so the journey's profile arrives the way seed.sh seeds it:
    // the stack's own postgres, launcher pi + autonomous_within_sandbox +
    // sandbox required. Under claude the journey keeps the product's default
    // seeded `Claude Code` profile and touches no SQL.
    if (IS_PI_LAUNCHER) seedLabPiProfile(PROFILE);
  });

  test.afterAll(async () => {
    for (const context of [aliceContext, bobContext]) {
      if (context) await context.close();
    }
  });

  test("alice and bob sign in with readable profiles", async () => {
    // bob first: the member picker can only offer users who already exist.
    await signIn(bob, BOB.subject, { name: BOB.name, email: "bob@example.invalid" });
    await expect(bob.getByTestId("user-badge")).toContainText(BOB.name);
    await signIn(alice, ALICE.subject, { name: ALICE.name, email: "alice@example.invalid" });
    await expect(alice.getByTestId("user-badge")).toContainText(ALICE.name);
  });

  test("the harness worker is registered and online", async () => {
    // Precondition for every turn below: with no worker claiming turns, the
    // first prompt would simply sit in `queued — waiting for a worker`. The
    // stack this journey is named for brought exactly one worker, the
    // `worker-e2e` of e2e/compose.e2e-harness.yml; the M4 lab stack this run
    // targets brings worker-a and worker-b (compose.m4.yml, § 6.2: two
    // workers by design). So the honest precondition is the API's own, read
    // off the ops page: SOME registered worker of the stack under test is
    // online — never a hardcoded name the stack may not have.
    await gotoApp(alice, "/settings/operations");
    const onlineWorker = alice.locator('[data-testid^="worker-row-"]').filter({
      hasText: /status: online/,
    });
    await expect(onlineWorker.first()).toBeVisible({ timeout: 30_000 });
  });

  test("alice creates the project, its repository, and adds bob", async () => {
    // The create form lives on the projects index (app-shell redesign), not
    // the Home briefing; open it if it is collapsed behind the toggle.
    await gotoApp(alice, "/projects");
    const nameField = alice.getByTestId("create-project-name");
    const toggle = alice.getByTestId("new-project-toggle");
    // On a fresh account the form is already open, so both the field and the
    // ("Close") toggle are visible: take the first match to satisfy strict mode.
    await expect(nameField.or(toggle).first()).toBeVisible();
    if (!(await nameField.isVisible())) await toggle.click();
    await nameField.fill(PROJECT_NAME);
    await alice.getByTestId("create-project-submit").click();
    // Idempotent re-run (the m1/home-cluster rule): on a stack this journey
    // already wrote to, the create meets the slug conflict — the existing
    // project IS the fact the create would have made, so open it and ride on.
    const conflict = alice.getByRole("alert").filter({ hasText: /already exists/i });
    if (
      await conflict
        .waitFor({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    ) {
      await gotoApp(alice, "/projects");
      await alice
        .getByTestId(`project-link-${PROJECT_NAME.toLowerCase().replace(/ +/g, "-")}`)
        .click();
    }
    await expect(alice.getByTestId("project-name")).toHaveText(PROJECT_NAME);
    projectPath = new URL(alice.url()).pathname;

    const projectUrl = `${BASE_URL}${projectPath}`;
    // The repository add is the same story: an existing row is the proof, and
    // re-adding only earns a duplicate refusal. On a REUSED project the add
    // form is collapsed and the rows mount with the overview's data fetch —
    // wait for either to exist before deciding which path to take.
    const repoRow = alice.getByTestId(`repo-row-${REPO_NAME}`);
    const repoToggle = alice.getByTestId("repo-add-toggle");
    const repoNameField = alice.getByTestId("repo-name");
    // Give the overview's own fetch a beat to mount rows or form, then decide.
    await expect
      .poll(
        async () =>
          (await repoRow.count()) + (await repoNameField.count()) + (await repoToggle.count()),
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);
    if ((await repoRow.count()) === 0) {
      await alice.waitForTimeout(1_500); // rows mounting with the fetch beat the toggle
      if ((await repoRow.count()) === 0) {
        if (!(await repoNameField.isVisible().catch(() => false))) {
          await repoToggle.waitFor({ state: "visible", timeout: 30_000 });
          await repoToggle.click();
          await expect(repoNameField).toBeVisible({ timeout: 15_000 });
        }
        await repoNameField.fill(REPO_NAME);
        await alice.getByTestId("repo-git-url").fill(REPO_GIT_URL);
        await alice.getByTestId("repo-default-branch").fill(REPO_BRANCH);
        await alice.getByTestId("repo-submit").click();
      }
    }
    await expect(repoRow).toContainText(REPO_GIT_URL);
    // Idempotent: bob is already a contributor once a prior run added him —
    // setMember takes the fast path then and corrects the role otherwise.
    await setMember(alice, projectUrl, BOB.name, "contributor");
  });

  test(`alice starts a ${LAB_LAUNCHER} conversation and the first turn completes`, async () => {
    conversationPath = await startConversation(alice, `${BASE_URL}${projectPath}`, {
      title: "Hello World onboarding",
      profile: PROFILE,
      prompt: FIRST_PROMPT,
    });
    expect(conversationPath).toMatch(/^\/threads\/[0-9a-f-]{36}$/);

    // Alice is the controller of her own conversation and the agent is real:
    // the session binding is reported, not assumed. The binding names the
    // lab's launcher (ADR-0069: on `pi` this is the never-asks launcher).
    await expect(alice.getByTestId("controller-badge")).toHaveText("you're in control");
    await expect(alice.getByTestId("agent-session")).toContainText(`agent: ${LAB_LAUNCHER}`, {
      timeout: PERMISSION_TIMEOUT_MS,
    });
    await expectTurnStatus(alice, /completed/);
    await expect(alice.getByTestId("transcript")).toContainText(FIRST_PROMPT);
    // A shallow clone of the real repository, then a real answer about it.
    await expect(alice.getByTestId("transcript")).toContainText("Hello World");
    await expect(alice.getByTestId("transcript")).not.toContainText("clone of hello-world");
    // One turn, closed: the composer is hers and idle.
    await expect(alice.getByTestId("composer-input")).toBeEnabled();
    await expect(alice.getByTestId("composer-send")).toBeDisabled();
  });

  test("bob sees the same conversation live on replica B, read-only", async () => {
    // The replica badge moved from the sidebar footer to Settings →
    // "About this server" (#5); read it from /settings/layout on a direct
    // replica URL, then return to the conversation page.
    await bob.goto(`${API_B_URL}/settings/layout`);
    await expect(bob.getByTestId("replica-badge")).toHaveText("replica: api-b");
    await bob.goto(`${API_B_URL}${conversationPath}`);
    await expect(bob.getByTestId("conversation-title")).toHaveText("Hello World onboarding");
    await expect(bob.getByTestId("controller-badge")).toHaveText(`Controlled by ${ALICE.name}`);
    // Watching is allowed, driving is not: the composer is inert and says why.
    await expect(bob.getByTestId("composer-input")).toBeDisabled();
    await expect(bob.getByTestId("composer-explainer")).toContainText(ALICE.name);
    await expect(bob.getByTestId("take-control")).toBeVisible();
    // Live: alice's first turn is on bob's screen without bob reloading.
    await expect(bob.getByTestId("transcript")).toContainText(FIRST_PROMPT);
    await expect(bob.getByTestId("turn-status")).toContainText(/completed/);
  });

  test(
    IS_PI_LAUNCHER
      ? "the never-asks launcher raises no permission request on either replica (ADR-0069)"
      : "a permission request is actionable for alice and read-only for bob",
    async () => {
      if (IS_PI_LAUNCHER) {
        // ADR-0069's honest pi arm: the same long turn runs under
        // autonomous_within_sandbox — "runs without asking; the sandbox is
        // the boundary". No card mounts on the controller's screen or the
        // watcher's, the turn completes on its own, and the journal carries
        // no verdict line: the transcript never says "awaiting a decision"
        // and no decision is ever "answered" by a person or a policy.
        await sendPrompt(alice, LONG_PROMPT);
        await expect(openPermissionCard(alice)).toHaveCount(0);
        await expect(openPermissionCard(bob)).toHaveCount(0);
        await expectTurnStatus(alice, /completed/);
        for (const viewer of [alice, bob]) {
          await expect(viewer.getByTestId("transcript")).not.toContainText("awaiting a decision");
          await expect(viewer.getByTestId("transcript")).not.toContainText("answered");
          await expect(viewer.getByTestId("transcript")).not.toContainText("approved");
        }
        // The profile row carries the mode the launch honoured (the UI's
        // ADR-0069 chip), read back off the product's own page.
        await gotoApp(alice, "/profiles");
        const profileRow = alice
          .getByTestId("agent-list")
          .locator('[data-testid^="agent-item-"]')
          .filter({ hasText: PROFILE });
        await expect(profileRow.first()).toBeVisible({ timeout: 30_000 });
        const rowId = ((await profileRow.first().getAttribute("data-testid")) ?? "").replace(
          /^agent-item-/,
          "",
        );
        await alice.getByTestId(`agent-row-${rowId}`).click();
        await expect(alice.getByTestId(`agent-permission-${rowId}`)).toHaveText(
          /^permission: autonomous_within_sandbox$/,
        );
        // Back to the thread: the takeover test below drives alice's composer.
        await gotoApp(alice, conversationPath);
        return;
      }
      await sendPrompt(alice, LONG_PROMPT);
      const card = await waitForOpenPermission(alice, { timeout: PERMISSION_TIMEOUT_MS });
      await expect(card).toContainText("for i in 1 2 3 4 5 6 7 8 9 10");
      await expect(card.getByRole("button", { name: /yes|allow/i }).first()).toBeVisible();

      // The same card on bob's replica: visible, and explicitly not his to answer.
      const bobCard = await waitForOpenPermission(bob, { timeout: PERMISSION_TIMEOUT_MS });
      await expect(bobCard.getByTestId("permission-readonly")).toContainText(ALICE.name);
      await expect(bobCard.getByRole("button")).toHaveCount(0);

      // Alice allows; the decision is journalled with her name on it.
      const label = await allowOpenPermission(alice, undefined, ALICE.name);
      expect(label.length).toBeGreaterThan(0);
      await expect(alice.getByTestId("transcript")).toContainText(
        `answered "${label}" by ${ALICE.name}`,
      );
    },
  );

  test("bob takes control, and alice's open turn ends cancelled", async () => {
    // While the ticks are still running: a takeover requests cancellation of
    // the in-flight turn rather than pretending it finished (ADR-0014 §9).
    if (IS_PI_LAUNCHER) {
      // The claude arm inherits its live turn from the permission card the
      // previous test left open; the pi arm's turn completed autonomously,
      // so this arm opens a fresh long turn itself and catches it in
      // flight — the takeover must have a running turn to cancel.
      await sendPrompt(alice, LONG_PROMPT);
      await expect
        .poll(
          async () =>
            (
              (await alice
                .getByTestId("turn-status")
                .innerText()
                .catch(() => "")) ?? ""
            )
              .replace(/\s+/g, " ")
              .trim(),
          { timeout: AGENT_TURN_TIMEOUT_MS, message: "the pi turn never went in-flight" },
        )
        .toMatch(/queued|starting|running/i);
    }
    await takeControl(bob);
    await expect(bob.getByTestId("controller-badge")).toHaveText("you're in control");
    await expectTurnStatus(bob, /cancelled/);

    // Alice, without reloading, learns she is no longer driving and that her
    // turn was cancelled — not completed, not failed.
    await expect(alice.getByTestId("controller-badge")).toHaveText(`Controlled by ${BOB.name}`, {
      timeout: PERMISSION_TIMEOUT_MS,
    });
    await expect(alice.getByTestId("turn-status")).toContainText(/cancelled/);
    await expect(alice.getByTestId("composer-input")).toBeDisabled();
    await expect(alice.getByTestId("transcript")).toContainText("Turn cancelled");
    await expect(alice.getByTestId("take-control")).toBeVisible();
  });

  test(
    IS_PI_LAUNCHER
      ? "bob prompts a file write and the turn completes with no verdict row (ADR-0069)"
      : "bob prompts a file write, approves it, and the turn completes",
    async () => {
      await sendPrompt(bob, WRITE_PROMPT);
      if (IS_PI_LAUNCHER) {
        // No card mounts and the transcript carries no verdict line: the
        // autonomy is the sandbox plus the audit, never an approval claim.
        await expect(openPermissionCard(bob)).toHaveCount(0);
        await expectTurnStatus(bob, /completed/);
        const writeTranscript = bob.getByTestId("transcript");
        await expect(writeTranscript).toContainText(`repos/${REPO_NAME}/NOTES.md`);
        await expect(writeTranscript).not.toContainText("answered");
        await expect(writeTranscript).not.toContainText("approved");
        await expect(alice.getByTestId("transcript")).toContainText(WRITE_PROMPT);
        return;
      }
      const card = await waitForOpenPermission(bob, { timeout: PERMISSION_TIMEOUT_MS });
      await expect(card.getByTestId("permission-readonly")).toHaveCount(0);
      const label = await allowOpenPermission(bob, undefined, BOB.name);
      await expectTurnStatus(bob, /completed/);

      // The write happened in the conversation's workspace and the transcript
      // says so, on bob's replica; bob answered, not alice.
      const transcript = bob.getByTestId("transcript");
      await expect(transcript).toContainText(`repos/${REPO_NAME}/NOTES.md`);
      await expect(transcript).toContainText(`answered "${label}" by ${BOB.name}`);
      await expect(alice.getByTestId("transcript")).toContainText(WRITE_PROMPT);
    },
  );

  test("bob returns control to alice", async () => {
    await bob.getByTestId("return-control").click();
    await expect(bob.getByTestId("controller-badge")).toHaveText(`Controlled by ${ALICE.name}`);
    await expect(bob.getByTestId("composer-input")).toBeDisabled();
    await expect(alice.getByTestId("controller-badge")).toHaveText("you're in control", {
      timeout: PERMISSION_TIMEOUT_MS,
    });
    await expect(alice.getByTestId("composer-input")).toBeEnabled();
    await expect(alice.getByTestId("transcript")).toContainText("Control returned");
  });

  test("both replicas restart and both transcripts are still identical", async ({ request }) => {
    restartComposeServices("api-a", "api-b");
    for (const url of [API_A_URL, API_B_URL]) {
      await expect
        .poll(
          async () => {
            try {
              return (await request.get(`${url}/api/v1/system/readiness`)).ok();
            } catch {
              return false;
            }
          },
          { timeout: 90_000, intervals: [1_000] },
        )
        .toBe(true);
    }

    // Re-navigate rather than reload: for a few seconds after both replicas
    // restart, the load balancer has no healthy upstream yet and answers 502
    // (caddy's own health interval), and a blank error page is what makes a
    // later locator hang instead of failing. gotoApp waits for a real 200.
    await gotoApp(alice, conversationPath);
    await gotoApp(bob, `${API_B_URL}${conversationPath}`);
    await expect(alice.getByTestId("user-badge")).toContainText(ALICE.name);
    await expect(bob.getByTestId("user-badge")).toContainText(BOB.name);
    await expect(alice.getByTestId("controller-badge")).toHaveText("you're in control");
    await expect(bob.getByTestId("controller-badge")).toHaveText(`Controlled by ${ALICE.name}`);

    // Same journal, same fold: the two transcripts must read the same, and
    // both handoffs must be in them.
    const aliceText = (await alice.getByTestId("transcript").innerText()).trim();
    const bobText = (await bob.getByTestId("transcript").innerText()).trim();
    expect(aliceText.length).toBeGreaterThan(200);
    expect(aliceText).toBe(bobText);
    for (const expected of [
      FIRST_PROMPT,
      LONG_PROMPT,
      WRITE_PROMPT,
      "Turn cancelled",
      "Turn completed",
      // The control-event copy names the people (4681dce: `Control taken by
      // <name>` / `Control returned to <name>`) — assert the full sentence.
      `Control taken by ${BOB.name}`,
      `Control returned to ${ALICE.name}`,
    ]) {
      await expect(alice.getByTestId("transcript")).toContainText(expected);
      await expect(bob.getByTestId("transcript")).toContainText(expected);
    }
    await expect(alice.getByTestId("turn-status")).toHaveText(/completed/);
  });
});
