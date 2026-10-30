// W8 arm of the M5 exit suite (docs/design/wishlist-gap.md "## W8"): a
// permission prompt that alice's turn raises reaches *bob's* Inbox — another
// member's browser, his own session, a fact written entirely by the running
// agent and not seeded for the assertion.
//
// It runs against the M4 lab by env override only, exactly like m5-journey —
// no second compose project:
//   COMMUNICATION_E2E_M5=1 E2E_BASE_URL=http://localhost:18091 \
//     timeout 600 pnpm exec playwright test tests/m5-inbox.spec.ts --reporter=line
// The lab's mock IdP identities and the "M4 Exit" project (alice = maintainer,
// bob = contributor, admin = org admin with no project membership) come from
// docs/compatibility/probes/m4/seed.sh; this suite adds one profile and one
// conversation and resets nothing.
//
// WHY THE PROFILE IS CREATED HERE: ADR-0036 moved all three seeded `m4-*`
// profiles to `preapproved_within_sandbox`, so nothing in the lab asks any more
// — and a prompt that never asks proves nothing. `POST /api/v1/agent-profiles`
// (api/openapi.yaml, ADR-0030 §5) takes only `name` + `launcher_id` and leaves
// `permission_mode` at the column default `ask`, which is precisely the mode
// this arm needs; it is the organization library role that may call it, so
// admin creates it through the product's own /profiles form and the arm then
// reads the served `permission_mode` back off the row.
//
// WHY BOB'S INBOX IS OPENED AFTER THE PROMPT IS PENDING: the three reads behind
// CONVERSATIONS (`ui/src/lib/attention.ts` `useProjectAttention`) carry no
// `refetchInterval`, and `/inbox` subscribes to no event stream, so the pending
// read happens when the section mounts. The page is therefore navigated to once
// and afterwards touched only by polling its DOM — no reload, no re-navigation.
// What is proved is that a fact from alice's turn reaches bob's view of the
// organization; the inbox's own live-push behaviour is NOT claimed here, and
// the live claim this suite does make is bob's conversation page, which keeps
// its decision current with no reload at all.
//
// Every wait is bounded. If no permission request appears within
// E2E_INBOX_PERMISSION_TIMEOUT_MS (the shared permission budget by default —
// one stalled upstream tool call plus the agent's retry, see env.ts) the test
// fails saying exactly that, naming the turn status and the last transcript
// line; and it fails as soon as the turn has ended, without sitting that budget
// out — it cannot pass vacuously, because every later step reads the one request
// id the pending card exposed.
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { BASE_URL, PERMISSION_TIMEOUT_MS } from "./env.js";
import {
  allowOpenPermission,
  expectTurnStatus,
  gotoApp,
  openPermissionCard,
  openProjectBySlug,
  pinPermissionCard,
  pinnedPermissionCard,
  shot,
  signIn,
  startConversation,
  testidOf,
  waitForOpenPermission,
  type PermissionCardRef,
} from "./helpers.js";

// The lab's seeded identities: display names are the bare subjects (seed.sh
// posts only an `email` claim, so no `name` to read off the id token — the same
// rule m5-journey follows, and the reason decisions here are matched by the
// option label rather than by an invented display name).
const ADMIN = { subject: "admin" };
const ALICE = { subject: "alice", projectSlug: "m4-exit" };
const BOB = { subject: "bob" };

/**
 * How long a real claude turn gets to raise its first permission prompt: one
 * stalled upstream tool call plus the agent's retry of it (issue #28), not a
 * nominal "the turn is being built" budget.
 */
const PERMISSION_REQUEST_TIMEOUT_MS = Number(
  process.env.E2E_INBOX_PERMISSION_TIMEOUT_MS ?? PERMISSION_TIMEOUT_MS,
);
/** The brief's bound for a pending prompt showing up on the other member. */
const INBOX_TIMEOUT_MS = Number(process.env.E2E_INBOX_VISIBLE_TIMEOUT_MS ?? 60_000);
/** Closing the turn at the end is cleanup, but it is still a bounded wait. */
const TURN_CLOSE_TIMEOUT_MS = Number(process.env.E2E_INBOX_TURN_CLOSE_TIMEOUT_MS ?? 180_000);

const stamp =
  process.env.E2E_M5_INBOX_STAMP ?? new Date().toISOString().slice(11, 19).replace(/:/g, "");
const PROFILE_NAME = `m5-inbox-ask-${stamp}`;
const TITLE = `inbox two-context ${stamp}`;
// One tool call with exact content, so the request is the subject of the test
// and not a model that happens to wander: `ask` puts this in front of a human.
const PROMPT =
  "Use the Write tool to create a file named INBOX-NOTES.md in the repository " +
  "checkout containing exactly: ping from alice. Then stop.";

const M5_ENABLED = process.env.COMMUNICATION_E2E_M5 === "1";

test.describe("M5 inbox: a pending prompt reaches another member's Inbox", () => {
  test.describe.configure({
    mode: "serial",
    timeout: PERMISSION_REQUEST_TIMEOUT_MS + INBOX_TIMEOUT_MS * 3 + TURN_CLOSE_TIMEOUT_MS + 180_000,
  });
  test.skip(!M5_ENABLED, "Needs the M4 lab stack (port 18091) — run with COMMUNICATION_E2E_M5=1");

  let adminContext: BrowserContext;
  let aliceContext: BrowserContext;
  let bobContext: BrowserContext;
  let admin: Page;
  let alice: Page;
  let bob: Page;
  let projectPath = ""; // /p/{M4 Exit id}
  let conversationPath = ""; // /threads/{conversation id}
  let conversationId = "";
  /** The request the pending card exposed; every later step reads this one. */
  let permissionLabel = "";
  /** Bob's view of that same card, pinned while it was open on his screen. */
  let permissionCard: PermissionCardRef | null = null;

  test.beforeAll(async ({ browser }) => {
    // Three contexts = three cookie jars = three signed-in members of one lab
    // (ADR-0006: the browser is never the only proof — every step below reads a
    // served fact off the page the server gave that identity).
    adminContext = await browser.newContext();
    aliceContext = await browser.newContext();
    bobContext = await browser.newContext();
    admin = await adminContext.newPage();
    alice = await aliceContext.newPage();
    bob = await bobContext.newPage();
  });

  test.afterAll(async () => {
    for (const context of [adminContext, aliceContext, bobContext]) {
      if (context) await context.close();
    }
  });

  test("the lab answers readiness and all three identities sign in", async ({ request }) => {
    await test.step("the M4 lab answers readiness", async () => {
      await expect
        .poll(
          async () => {
            try {
              return (await request.get(`${BASE_URL}/api/v1/system/readiness`)).ok();
            } catch {
              return false;
            }
          },
          { timeout: 120_000, intervals: [2_000] },
        )
        .toBe(true);
    });
    await test.step("alice (maintainer), bob (contributor) and admin (org admin) sign in", async () => {
      // The seed's claim shape exactly: a re-login must not rewrite the lab's
      // stored profiles, so no `name` claim is invented here.
      for (const [page, who] of [
        [alice, ALICE],
        [bob, BOB],
        [admin, ADMIN],
      ] as const) {
        await signIn(page, who.subject, { email: `${who.subject}@example.test` });
        await expect(page.getByTestId("user-badge")).toHaveText(who.subject);
      }
      await shot(alice, "m5-inbox-00-signed-in");
    });
  });

  test("admin creates an ask-mode profile and the row serves ask", async () => {
    await test.step("/profiles → NEW AGENT (the route takes a name and a launcher, nothing else)", async () => {
      await gotoApp(admin, "/profiles");
      await expect(admin.getByTestId("agents-page")).toBeVisible();
      // The library role is what the New profile button's presence means
      // (ADR-0030); the form itself now lives in the dialog it opens.
      await expect(admin.getByTestId("agents-new-open")).toBeVisible();
      const row = profileRow(admin);
      if ((await row.count()) === 0) {
        await admin.getByTestId("agents-new-open").click();
        await expect(admin.getByTestId("agents-new-form")).toBeVisible();
        await admin.getByTestId("agents-new-name-input").fill(PROFILE_NAME);
        // The new dialog picks the launcher by agent card (radio), not a select;
        // `agents-new-launcher-select` is the disabled "Other ACP agent" catch-all.
        await admin.getByTestId("new-profile-card-claude").click();
        await admin.getByTestId("agents-new-submit").click();
      }
      // The created row, read back from the served list. The permission mode
      // is served by the profile's detail panel — the row opens it — and it
      // says `ask`, because the route has no field to make it anything else.
      await expect(row).toHaveCount(1, { timeout: 30_000 });
      const rowId = ((await row.first().getAttribute("data-testid")) ?? "").replace(
        /^agent-item-/,
        "",
      );
      await admin.getByTestId(`agent-row-${rowId}`).click();
      await expect(admin.getByTestId(`agent-permission-${rowId}`)).toHaveText(/\bask\b/);
      await shot(admin, "m5-inbox-01-ask-profile");
    });
  });

  test("alice starts the conversation and the agent raises a permission request", async () => {
    await test.step("alice opens a conversation on the ask profile", async () => {
      projectPath = await openProjectBySlug(alice, ALICE.projectSlug);
      conversationPath = await startConversation(alice, `${BASE_URL}${projectPath}`, {
        title: TITLE,
        profile: PROFILE_NAME,
        prompt: PROMPT,
      });
      conversationId = conversationPath.split("/").pop() ?? "";
      expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(alice.getByTestId("conversation-title")).toHaveText(TITLE);
      // The profile the page says it launched, in the mode the row served.
      // The new thread meta renders the profile name as its own `·`-separated
      // field (no `profile:` prefix), so assert the name itself.
      await expect(alice.getByTestId("conversation-meta")).toContainText(PROFILE_NAME);
      // A real session on a real worker, or there is nothing to wait for.
      await expect(alice.getByTestId("agent-session")).toContainText("agent: claude", {
        timeout: PERMISSION_REQUEST_TIMEOUT_MS,
      });
    });
    await test.step("the turn asks a human within the permission budget, or the arm says so itself", async () => {
      // Bounded AND self-announcing: the helper fails the moment the turn ends
      // terminal with no card, naming the status and the last transcript line.
      const pending = await waitForOpenPermission(alice, {
        timeout: PERMISSION_REQUEST_TIMEOUT_MS,
        context:
          `the agent never raised a permission request on profile ${PROFILE_NAME} ` +
          `(permission mode ask) on ${conversationPath} — check the lab worker's agent turn ` +
          `(ask mode must reach a human)`,
      });
      // The request is the one the prompt asked for: the journal names the file,
      // and the card is labelled as the permission request it is.
      const card = pending.first();
      await expect(card).toContainText("awaiting a decision");
      await expect(card).toContainText("PERMISSION REQUEST");
      await expect(alice.getByTestId("transcript")).toContainText(/INBOX-NOTES\.md/i, {
        timeout: 30_000,
      });
      // The option the controller is offered, recorded so the decision below is
      // named by the same label the card showed.
      const offered = await card
        .getByTestId("permission-allow")
        .textContent()
        .catch(() => null);
      const fallback = await card
        .getByRole("button")
        .first()
        .textContent()
        .catch(() => null);
      permissionLabel = (offered ?? fallback ?? "").trim();
      expect(permissionLabel.length).toBeGreaterThan(0);
      await shot(alice, "m5-inbox-02-pending-permission");
    });
  });

  test("bob's /inbox carries the conversation with a PERMISSION tag, and nothing reloads", async () => {
    await test.step("bob's inbox is opened once, then only polled", async () => {
      await gotoApp(bob, "/inbox");
      await expect(bob.getByTestId("inbox-greeting")).toBeVisible({ timeout: 30_000 });
      await markDocument(bob);
    });
    await test.step("the row and its PERMISSION tag appear within 60s", async () => {
      const id = testidOf(conversationId);
      const row = bob.getByTestId(`inbox-conversation-${id}`);
      // Bounded: a prompt that never reaches his inbox fails here saying so.
      await expect(row).toHaveCount(1, { timeout: INBOX_TIMEOUT_MS });
      await expect(bob.getByTestId(`inbox-conversation-tag-${id}`)).toHaveText(/permission/i, {
        timeout: INBOX_TIMEOUT_MS,
      });
      await expect(bob.locator("#inbox-conversations-heading")).toContainText(/CONVERSATIONS/);
      // The row names the conversation the wire carries it under.
      await expect(row).toContainText(TITLE);
      expect(bob.url()).toContain("/inbox");
      // No reload, proved rather than claimed: the marker set on this exact
      // document is still there.
      expect(await markerSurvived(bob)).toBe(true);
      await shot(bob, "m5-inbox-03-bob-inbox-permission");
    });
  });

  test("bob opens it and sees the pending request — one he is not offered to answer", async () => {
    await test.step("the inbox's own Open link, not a hand-built url", async () => {
      await bob.getByTestId(`inbox-open-conversation-${testidOf(conversationId)}`).click();
      // The inbox's Open link goes to the standalone thread page (C1).
      await bob.waitForURL(/\/threads\/[0-9a-f-]{36}/, { timeout: 30_000 });
      await expect(bob.getByTestId("conversation-title")).toHaveText(TITLE);
    });
    await test.step("the pending request is on the conversation page", async () => {
      // Same guarantee as alice's wait: bounded by INBOX_TIMEOUT_MS, and dead
      // the moment the turn itself has ended with no card to mirror.
      const card = await waitForOpenPermission(bob, { timeout: INBOX_TIMEOUT_MS });
      await expect(card.first()).toContainText("awaiting a decision");
      // Pin THIS card (by request id, positional on older markup) while it is
      // open, so the decision step below can follow the same card to decided
      // instead of counting answered cards transcript-wide.
      permissionCard = await pinPermissionCard(bob, card.first());
    });
    await test.step("answering is not offered to him, so he does not answer", async () => {
      // The honest arm of "do not answer as bob unless the UI offers it": the
      // card tells him who owns the decision and gives him no control at all.
      await expect(bob.getByTestId("permission-readonly")).toContainText("Only the controller");
      await expect(openPermissionCard(bob).getByRole("button")).toHaveCount(0);
      expect(bob.url()).toContain(conversationPath);
      expect(await markerSurvived(bob)).toBe(true);
      await shot(bob, "m5-inbox-04-bob-sees-pending");
    });
  });

  test("alice answers it, and bob's open page learns so with no reload", async () => {
    await test.step("the controller decides", async () => {
      const label = await allowOpenPermission(alice);
      expect(label.length).toBeGreaterThan(0);
      if (!permissionCard) throw new Error("bob's pinned permission card is missing");
      // The exact card bob was looking at learned the decision — not a
      // transcript-wide count of answered cards, which earlier turns could
      // contaminate.
      const decided = pinnedPermissionCard(bob, permissionCard);
      await expect(decided).toHaveCount(1, { timeout: INBOX_TIMEOUT_MS });
      await expect(decided).toContainText("decided", { timeout: INBOX_TIMEOUT_MS });
      await expect(decided).toContainText(`answered "${label}"`, { timeout: INBOX_TIMEOUT_MS });
      // The open request is gone from bob's screen, and it is the same document
      // he was looking at a minute ago: no reload, only the journal arriving.
      await expect(openPermissionCard(bob)).toHaveCount(0, { timeout: INBOX_TIMEOUT_MS });
      expect(await markerSurvived(bob)).toBe(true);
      await shot(bob, "m5-inbox-05-decision-live");
    });
    await test.step("close cleanly: the turn is left terminal, not abandoned in flight", async () => {
      const terminal = /completed|cancelled|failed|interrupted/;
      const closed = await expectTurnStatus(alice, terminal, TURN_CLOSE_TIMEOUT_MS)
        .then(() => true)
        .catch(() => false);
      if (!closed) {
        // Press the page's own Stop rather than leaving an open turn holding
        // the conversation (and the worker's agent session) behind us.
        await alice.getByTestId("stop-turn").click();
        await expectTurnStatus(alice, /cancelled|completed|failed|interrupted/, INBOX_TIMEOUT_MS);
      }
      await expect(alice.getByTestId("composer-input")).toBeEnabled({ timeout: 30_000 });
    });
  });
});

/**
 * The `agent_profiles` row for this run's profile, named by its served `name`.
 */
function profileRow(page: Page) {
  return page
    .getByTestId("agent-list")
    .locator('[data-testid^="agent-item-"]')
    .filter({ hasText: PROFILE_NAME });
}

/** Key stashed on the live window; a document reload wipes it. */
const MARK_KEY = "__m5InboxDocumentMounted";

/** Mark the document a navigation produced. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate((key) => {
    (window as unknown as Record<string, string>)[key] = "mounted";
  }, MARK_KEY);
}

/** Still the same document? (A reload would answer false.) */
async function markerSurvived(page: Page): Promise<boolean> {
  return page.evaluate(
    (key) => (window as unknown as Record<string, string>)[key] === "mounted",
    MARK_KEY,
  );
}
