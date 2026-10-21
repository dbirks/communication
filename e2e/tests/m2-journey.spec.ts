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
  addMember,
  allowOpenPermission,
  expectTurnStatus,
  gotoApp,
  openPermissionCard,
  restartComposeServices,
  sendPrompt,
  signIn,
  startConversation,
  takeControl,
} from "./helpers.js";

// Throwaway mock-IdP identities with readable profiles (ADR-0012 §4: the app
// takes the display name from the id token's `name` claim).
const ALICE = { subject: "alice", name: "Alice Andersen" };
const BOB = { subject: "bob", name: "Bob Brennan" };

const PROJECT_NAME = "Hello World onboarding";
const REPO_NAME = "hello-world";
const REPO_GIT_URL = "https://github.com/octocat/Hello-World.git";
const REPO_BRANCH = "master";

// Phrased as instructions to one specific tool with exact content: the journey
// is about who is driving, not about what the model chooses to do.
const FIRST_PROMPT = `Read the README in repos/${REPO_NAME} and summarise it in one sentence.`;
// ~50s of work, so the takeover below lands while the turn is still running.
const LONG_PROMPT =
  "Use the Bash tool to run exactly: for i in 1 2 3 4 5 6 7 8 9 10; do echo tick $i; " +
  "sleep 5; done then say FINISHED.";
const WRITE_PROMPT = `Use the Write tool to create repos/${REPO_NAME}/NOTES.md containing exactly: handoff ok`;

test.describe("M2 shared conversation and control handoff", () => {
  test.describe.configure({ mode: "serial", timeout: AGENT_TURN_TIMEOUT_MS });
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
    // first prompt would simply sit in `queued — waiting for a worker`.
    await gotoApp(alice, "/ops");
    await expect(alice.getByTestId("worker-row-worker-e2e")).toContainText(/status: online/, {
      timeout: 30_000,
    });
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
    await expect(alice.getByTestId("project-name")).toHaveText(PROJECT_NAME);
    projectPath = new URL(alice.url()).pathname;

    const projectUrl = `${BASE_URL}${projectPath}`;
    await alice.getByTestId("repo-name").fill(REPO_NAME);
    await alice.getByTestId("repo-git-url").fill(REPO_GIT_URL);
    await alice.getByTestId("repo-default-branch").fill(REPO_BRANCH);
    await alice.getByTestId("repo-submit").click();
    await expect(alice.getByTestId(`repo-row-${REPO_NAME}`)).toContainText(REPO_GIT_URL);
    await addMember(alice, projectUrl, BOB.name, "contributor");
  });

  test("alice starts a Claude Code conversation and the first turn completes", async () => {
    conversationPath = await startConversation(alice, `${BASE_URL}${projectPath}`, {
      title: "Hello World onboarding",
      profile: "Claude Code",
      prompt: FIRST_PROMPT,
    });
    expect(conversationPath).toMatch(/^\/threads\/[0-9a-f-]{36}$/);

    // Alice is the controller of her own conversation and the agent is real:
    // the session binding is reported, not assumed.
    await expect(alice.getByTestId("controller-badge")).toHaveText("You are in control");
    await expect(alice.getByTestId("agent-session")).toContainText("agent: claude", {
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
    await bob.goto(`${API_B_URL}${conversationPath}`);
    await expect(bob.getByTestId("replica-badge")).toHaveText("replica: api-b");
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

  test("a permission request is actionable for alice and read-only for bob", async () => {
    await sendPrompt(alice, LONG_PROMPT);
    const card = openPermissionCard(alice);
    await expect(card).toHaveCount(1, { timeout: PERMISSION_TIMEOUT_MS });
    await expect(card).toContainText("for i in 1 2 3 4 5 6 7 8 9 10");
    await expect(card.getByRole("button", { name: /yes|allow/i }).first()).toBeVisible();

    // The same card on bob's replica: visible, and explicitly not his to answer.
    const bobCard = openPermissionCard(bob);
    await expect(bobCard).toHaveCount(1, { timeout: PERMISSION_TIMEOUT_MS });
    await expect(bobCard.getByTestId("permission-readonly")).toContainText(ALICE.name);
    await expect(bobCard.getByRole("button")).toHaveCount(0);

    // Alice allows; the decision is journalled with her name on it.
    const label = await allowOpenPermission(alice);
    expect(label.length).toBeGreaterThan(0);
    await expect(alice.getByTestId("transcript")).toContainText(
      `answered "${label}" by ${ALICE.name}`,
    );
  });

  test("bob takes control, and alice's open turn ends cancelled", async () => {
    // While the ticks are still running: a takeover requests cancellation of
    // the in-flight turn rather than pretending it finished (ADR-0014 §9).
    await takeControl(bob);
    await expect(bob.getByTestId("controller-badge")).toHaveText("You are in control");
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

  test("bob prompts a file write, approves it, and the turn completes", async () => {
    await sendPrompt(bob, WRITE_PROMPT);
    const card = openPermissionCard(bob);
    await expect(card).toHaveCount(1, { timeout: PERMISSION_TIMEOUT_MS });
    await expect(card.getByTestId("permission-readonly")).toHaveCount(0);
    const label = await allowOpenPermission(bob);
    await expectTurnStatus(bob, /completed/);

    // The write happened in the conversation's workspace and the transcript
    // says so, on bob's replica; bob answered, not alice.
    const transcript = bob.getByTestId("transcript");
    await expect(transcript).toContainText(`repos/${REPO_NAME}/NOTES.md`);
    await expect(transcript).toContainText(`answered "${label}" by ${BOB.name}`);
    await expect(alice.getByTestId("transcript")).toContainText(WRITE_PROMPT);
  });

  test("bob returns control to alice", async () => {
    await bob.getByTestId("return-control").click();
    await expect(bob.getByTestId("controller-badge")).toHaveText(`Controlled by ${ALICE.name}`);
    await expect(bob.getByTestId("composer-input")).toBeDisabled();
    await expect(alice.getByTestId("controller-badge")).toHaveText("You are in control", {
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
    await expect(alice.getByTestId("controller-badge")).toHaveText("You are in control");
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
      `Control taken (by`,
      `Control returned (to`,
    ]) {
      await expect(alice.getByTestId("transcript")).toContainText(expected);
      await expect(bob.getByTestId("transcript")).toContainText(expected);
    }
    await expect(alice.getByTestId("turn-status")).toHaveText(/completed/);
  });
});
