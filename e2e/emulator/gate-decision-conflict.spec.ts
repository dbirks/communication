// Journey: the gate decision the OTHER approver won (acceptance T10; findings
// 04 + 12 — the ONE `DecisionBar`'s conflict sentence).
//
// `DecisionBar` holds a click for ~5 s behind `decision-undo` before it posts
// `POST /api/v1/approvals/{id}/decide`, and the API admits exactly ONE decision
// per gate (ADR-0023 § 9, `12` case 9d). The loser must be told who won in
// WORDS — “<Name> approved this {age} ago. Your decision wasn't recorded.” —
// with the name resolved through the directory the app already reads
// (`GET /api/v1/users`), and the sentence must SURVIVE the race: neither the
// silent 409 of a callout that vanished with the pending list, nor a decided
// summary that swallows the sentence of a page whose reader did click.
//
// Both faces are proven HERE, with the race staged for real and the live
// journal stream OPEN (no blocking, no waiting hacks):
//
//   Face 1 — Today. alice (the browser, user A) clicks Approve on the pass's
//   own scratch gate and the bar folds into its counting-down hold; INSIDE
//   that hold, dan — the lab's second seeded MAINTAINER of the seeded
//   `m4-exit` project (docs/compatibility/probes/m4/seed.sh § 2: “bob
//   contributor, carol dan maintainers (C9b/c/d arms)”, and § 7.1 C9d is
//   exactly these two racing one CAS decision) — decides the SAME gate through
//   the API with his own session and the gate's own current `version`. The
//   `approval.decided` frame refetches the pending list and the gate LEAVES
//   it: the bar sees the shared cache move, cancels the hold and sends
//   nothing (at most one decide POST may ever leave her tab — zero is the
//   watched-cache outcome, one is the 409 the loser learns from), and the
//   callout stays on screen in its conflict state — naming the winner, with
//   no “recorded” status — until dismissed. It does not vanish with the news.
//
//   Face 2 — the Approval page. A second gate, the same race on
//   `/approvals/{id}`: here nothing invalidates the page's own row during the
//   hold, so her POST arrives on the decided gate and the 409 adopts the
//   winner; the decide panel unmounts with the pending row, and the sentence
//   must NOT die with it — it replaces the decided summary's header, the
//   decided details stay below.
//
// The gate is the pass's own workflow: ONE `human.approval` node and nothing
// else. Because the gate is the ROOT node, `waiting_human` costs no worker turn,
// no checkout and no model call — the same scratch-document trick
// `e2e/tests/m5-journey.spec.ts`'s `GATE_TWIN` proves, minus the `process.exec`
// node that test needed. Authoring goes through the library routes the emulator
// already drives (`server-error.spec.ts`'s scratch workflow, as admin — the only
// seeded identity with the library role), the pin through the same assignment
// route `repo-chat-nav.spec.ts` uses, and the start through
// `POST /api/v1/projects/{id}/runs` with a pass-stamped idempotency key, so a
// worker restart replays the same run instead of parking a second gate.
import { expect, test, apiMutate } from "./fixtures.js";
import { signIn, testidOf } from "../tests/helpers.js";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { EMU_ADMIN_STATE, EMU_ALICE_STATE, EMU_BASE_URL, EMU_PASS_ID } from "./env.js";

/** The pass's scratch gate workflow — `metadata.name` must equal the slug. */
const GATE_SLUG = `emu-t10-gate-${EMU_PASS_ID}`.toLowerCase();
const GATE_NAME = `Emu T10 gate ${EMU_PASS_ID}`;

/** The lab's seeded project (seed.sh § 2): the one seeded project with MORE
 * THAN ONE maintainer, which is what makes a two-decider race possible. */
const PROJECT_SLUG = "m4-exit";

/** The seed's other maintainers, in the order this journey tries them. seed.sh
 * logged both in through the mock IdP with `{"email":"<subject>@example.test"}`
 * (its `login()`), and this spec passes the SAME claims, so the directory row
 * the conflict sentence is asserted against is the row the seed wrote. */
const DECIDER_SUBJECTS = ["dan", "carol"];

/** One `Approval` row as the cross-project list serves it (ADR-0047 says the
 * envelope's items ARE the `Approval` schema; these are the fields this journey
 * reads). */
interface ApprovalRow {
  id: string;
  run_id: string;
  state: string;
  version: number;
  decision?: string | null;
  decided_by?: string | null;
  approver_roles?: string[];
}

/** The scratch document. `deadlineSeconds` is generous on purpose: a gate whose
 * deadline passed mid-journey would test the reconciler, not the CAS. */
function gateYaml(slug: string): string {
  return `# scratch race gate (e2e/emulator/gate-decision-conflict.spec.ts): ONE
# human.approval node at the root, so waiting_human costs no worker turn.
apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: ${slug}
  description: >-
    Scratch: one maintainer approval gate and nothing else, for the emulator's
    two-decider conflict journey. No model.chat, no agent.acp, no process.exec.
spec:
  inputs:
    type: object
    required: [goal]
    properties:
      goal:
        type: string
        minLength: 1
        description: What the gate is asking about.
  policies:
    maxConcurrentNodes: 1
    maxDurationSeconds: 7200
    maxNodeExecutions: 10
    maxChildDepth: 0
    cancelPolicy: cascade
  nodes:
  - id: gate
    kind: human.approval
    retry:
      maxAttempts: 1
    config:
      summary: |
        Scratch race gate for \${{ inputs.goal }} — two maintainers, one decision.
      approverRoles: [maintainer]
      deadlineSeconds: 900
      onTimeout: fail
`;
}

/** The seeded project's id, read from the caller's own list (never a hard-coded
 * uuid) — the pattern every emulator journey uses. */
async function m4ExitId(page: Page): Promise<string> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/projects`);
  expect(res.status(), "the lab answers GET /api/v1/projects").toBe(200);
  const body = (await res.json()) as { items?: { id: string; slug: string }[] };
  const id = body.items?.find((project) => project.slug === PROJECT_SLUG)?.id ?? "";
  expect(id, `the seeded '${PROJECT_SLUG}' project exists`).toMatch(/^[0-9a-f-]{36}$/);
  return id;
}

/**
 * admin (the library role — the only seeded identity holding it): the pass's
 * scratch gate workflow, published, returning its newest revision.
 * Resolve-or-create on the pass-stamped slug: Playwright restarts the worker
 * after a failure, and the fresh process must reuse the dead one's rows.
 */
async function ensureGateWorkflow(admin: Page): Promise<string> {
  const list = await admin.request.get(`${EMU_BASE_URL}/api/v1/pipelines`);
  expect(list.status(), "the library list answers").toBe(200);
  const pipelines = (await list.json()) as { pipelines?: { id: string; slug: string }[] };
  const found = (pipelines.pipelines ?? []).find((entry) => entry.slug === GATE_SLUG) ?? null;
  if (found !== null) {
    const revisions = await admin.request.get(
      `${EMU_BASE_URL}/api/v1/pipelines/${found.id}/revisions`,
    );
    expect(revisions.status(), "the revision list answers").toBe(200);
    const rows = (await revisions.json()) as { revisions?: { id: string }[] };
    expect(
      (rows.revisions ?? []).length,
      "the scratch workflow carries its published revision",
    ).toBeGreaterThan(0);
    return (rows.revisions ?? [])[0].id;
  }

  const pipeline = await apiMutate(admin, "POST", `${EMU_BASE_URL}/api/v1/pipelines`, {
    slug: GATE_SLUG,
    display_name: GATE_NAME,
    description: "emulator decision-conflict journey scratch workflow",
  });
  const pipelineBody = await pipeline.text();
  expect(
    pipeline.status(),
    `creating the scratch workflow answers 201 (got ${pipeline.status()}: ${pipelineBody.slice(0, 240)})`,
  ).toBe(201);
  const pipelineId = (JSON.parse(pipelineBody) as { id: string }).id;

  const draft = await apiMutate(
    admin,
    "POST",
    `${EMU_BASE_URL}/api/v1/pipelines/${pipelineId}/drafts`,
    { document_yaml: gateYaml(GATE_SLUG) },
  );
  const draftBody = await draft.text();
  expect(
    draft.status(),
    `seeding the scratch draft answers 201 (got ${draft.status()}: ${draftBody.slice(0, 300)})`,
  ).toBe(201);
  const draftJson = JSON.parse(draftBody) as { id: string; version: number };

  const validated = await apiMutate(
    admin,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/validate`,
  );
  const validBody = await validated.text();
  expect(
    (JSON.parse(validBody) as { valid?: boolean }).valid,
    `the scratch draft validates (${validBody.slice(0, 400)})`,
  ).toBe(true);

  const published = await apiMutate(
    admin,
    "POST",
    `${EMU_BASE_URL}/api/v1/drafts/${draftJson.id}/publish`,
    { version: draftJson.version },
  );
  const publishedBody = await published.text();
  expect(
    published.status(),
    `publishing the scratch workflow answers 2xx (got ${published.status()}: ${publishedBody.slice(0, 300)})`,
  ).toBeLessThan(300);
  const revisionId = (JSON.parse(publishedBody) as { id: string }).id;
  expect(revisionId, "the publish answers with the revision").toMatch(/^[0-9a-f-]{36}$/);
  return revisionId;
}

/** alice (maintainer of the seeded project): the pin the run starts through —
 * one assignment per (project, pipeline), resolved before it is created (the
 * `ensureAssignment` pattern of repo-chat-nav.spec.ts). */
async function ensurePin(page: Page, projectId: string, revisionId: string): Promise<string> {
  const pipelines = await page.request.get(`${EMU_BASE_URL}/api/v1/pipelines`);
  expect(pipelines.status(), "the library list answers for alice").toBe(200);
  const pipelineId =
    ((await pipelines.json()) as { pipelines?: { id: string; slug: string }[] }).pipelines?.find(
      (entry) => entry.slug === GATE_SLUG,
    )?.id ?? "";
  expect(pipelineId, "the scratch workflow is in the library").toMatch(/^[0-9a-f-]{36}$/);

  const list = await page.request.get(`${EMU_BASE_URL}/api/v1/projects/${projectId}/assignments`);
  expect(list.status(), "the assignment list answers").toBe(200);
  const assignments = (await list.json()) as {
    assignments?: { id: string; pipeline_id: string }[];
  };
  const found =
    (assignments.assignments ?? []).find((entry) => entry.pipeline_id === pipelineId) ?? null;
  if (found !== null) return found.id;

  const assignment = await apiMutate(
    page,
    "POST",
    `${EMU_BASE_URL}/api/v1/projects/${projectId}/assignments`,
    { pipeline_id: pipelineId, pinned_revision_id: revisionId },
  );
  const body = await assignment.text();
  expect(
    assignment.status(),
    `pinning the scratch workflow answers 201 (got ${assignment.status()}: ${body.slice(0, 300)})`,
  ).toBe(201);
  return (JSON.parse(body) as { id: string }).id;
}

/** The pending gate of one run, read from the caller's own cross-project list. */
async function pendingGateOf(page: Page, runId: string): Promise<ApprovalRow | null> {
  const res = await page.request.get(`${EMU_BASE_URL}/api/v1/approvals`, {
    params: { status: "pending" },
  });
  expect(res.status(), "GET /api/v1/approvals (pending) answers").toBe(200);
  const body = (await res.json()) as { approvals?: ApprovalRow[] };
  const mine = (body.approvals ?? []).filter((row) => row.run_id === runId);
  expect(
    mine.length,
    `exactly one pending gate may belong to run ${runId.slice(0, 8)}… (` +
      `approval_requests admits one pending row per node execution, ADR-0023 § 9)`,
  ).toBeLessThanOrEqual(1);
  return mine[0] ?? null;
}

interface Decider {
  subject: string;
  page: Page;
  userId: string;
}

/**
 * Sign one seeded subject in through the mock IdP in HIS OWN browser context
 * (the same `signIn` door setup.spec.ts uses for its storage states — a second
 * session, never a second cookie jar in the loser's context). Null when this
 * subject is not one of the gate's approvers, so the caller can try the next.
 */
async function signInDecider(
  browser: Browser,
  subject: string,
  approverIds: Set<string>,
): Promise<Decider | null> {
  const context = await browser.newContext({ baseURL: EMU_BASE_URL });
  try {
    const page = await context.newPage();
    await signIn(page, subject, { email: `${subject}@example.test` });
    const me = await page.request.get(`${EMU_BASE_URL}/api/v1/me`);
    if (me.status() !== 200) {
      throw new Error(`GET /api/v1/me as ${subject} answered ${me.status()}`);
    }
    const userId = String(((await me.json()) as { id?: string }).id ?? "");
    if (!approverIds.has(userId)) {
      await context.close().catch(() => undefined);
      return null;
    }
    return { subject, page, userId };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

/**
 * The gate's second approver: the first seeded subject who holds the role the
 * gate asks for. A journey with no second identity cannot lose a race, so this
 * says so in words rather than returning nothing.
 */
async function secondApprover(browser: Browser, approverIds: Set<string>): Promise<Decider> {
  for (const subject of DECIDER_SUBJECTS) {
    const found = await signInDecider(browser, subject, approverIds);
    if (found !== null) return found;
  }
  throw new Error(
    `none of the seeded subjects (${DECIDER_SUBJECTS.join(", ")}) holds the gate's approver ` +
      `role in ${PROJECT_SLUG} — user A alone cannot lose a decision race`,
  );
}

test.describe("gate-decision-conflict (alice holds Approve; the other maintainer wins)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: EMU_ALICE_STATE });

  test("T10a — Today: the loser's callout names the winner and never vanishes", async ({
    browser,
    page,
    emu,
  }) => {
    // Its own budget (the pattern the appended proofs of catchup.spec.ts set):
    // one run start, one gate wait, two IdP sign-ins and one 5 s hold.
    test.setTimeout(420_000);

    // The refusal this journey may STAGE (the loser's held POST, if the frame
    // is slower than her hold) is exercised on purpose, so it is declared
    // rather than filed as an api defect. The journal stream is NOT blocked:
    // this face proves the live-update arm of the fix.
    emu.expectFailure(/\/api\/v1\/approvals\/[0-9a-f-]{36}\/decide$/, 409);

    let projectId = "";
    let runId = "";
    let gateId = "";
    let winnerDecided = false;
    let winner: Decider | null = null;
    let adminContext: BrowserContext | null = null;

    try {
      await test.step("the pass's scratch gate is published, pinned and started", async () => {
        adminContext = await browser.newContext({
          baseURL: EMU_BASE_URL,
          storageState: EMU_ADMIN_STATE,
        });
        const admin = await adminContext.newPage();
        projectId = await m4ExitId(page);
        const revisionId = await ensureGateWorkflow(admin);
        const assignmentId = await ensurePin(page, projectId, revisionId);

        const created = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/projects/${projectId}/runs`,
          {
            assignment_id: assignmentId,
            inputs: { goal: `emu T10 decision race ${EMU_PASS_ID}` },
            // The body member (the header would need a header-carrying fetch):
            // one create is one run, so a worker restart cannot park a second
            // gate on this pin — which is also what run-gate-artifacts.spec.ts
            // depends on from the shared single-run ceiling.
            idempotency: `emu-t10-${EMU_PASS_ID}`.toLowerCase(),
          },
        );
        const body = await created.text();
        expect(
          created.status(),
          `starting the scratch run answers 2xx (got ${created.status()}: ${body.slice(0, 300)})`,
        ).toBeLessThan(300);
        runId = String((JSON.parse(body) as { run_id?: string }).run_id ?? "");
        expect(runId, "the run create answers with the run id").toMatch(/^[0-9a-f-]{36}$/);
      });

      await test.step("the gate waits, and BOTH of these identities may decide it", async () => {
        // The gate is the run's root node: the control plane parks the run
        // itself, so this is a seconds-long wait and not a model leg at all.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${runId}`);
              if (res.status() !== 200) return `http-${res.status()}`;
              return String(((await res.json()) as { status?: string }).status ?? "unknown");
            },
            {
              message:
                "the scratch run parks in waiting_human (its only node is the approval gate)",
              timeout: 180_000,
              intervals: [2_000],
            },
          )
          .toBe("waiting_human");

        await expect
          .poll(async () => (await pendingGateOf(page, runId))?.id ?? "", {
            message: "the waiting run has a pending gate in alice's own approvals read",
            timeout: 60_000,
            intervals: [2_000],
          })
          .toMatch(/^[0-9a-f-]{36}$/);
        const gate = await pendingGateOf(page, runId);
        expect(gate, "the pending gate read returned a row").not.toBeNull();
        gateId = String((gate as ApprovalRow).id);
        expect(
          ((gate as ApprovalRow).approver_roles ?? []).includes("maintainer"),
          `the gate asks a MAINTAINER (approver_roles=${JSON.stringify(
            (gate as ApprovalRow).approver_roles,
          )}) — the role seed.sh § 2 gives alice, carol AND dan on ${PROJECT_SLUG}`,
        ).toBe(true);

        // …and the second identity really holds that role NOW: the decide route
        // evaluates authorization at decision time (C9c), so “two identities may
        // decide this gate” is proven from the rows, not assumed from seed.sh.
        const members = await page.request.get(
          `${EMU_BASE_URL}/api/v1/projects/${projectId}/members`,
        );
        expect(members.status(), "the member list answers").toBe(200);
        const rows = (await members.json()) as {
          items?: { user_id: string; role: string; display_name: string }[];
        };
        const approverIds = new Set(
          (rows.items ?? [])
            .filter((member) => member.role === "maintainer")
            .map((member) => member.user_id),
        );
        expect(
          approverIds.size,
          `${PROJECT_SLUG} has ${approverIds.size} maintainer(s); the race needs two`,
        ).toBeGreaterThanOrEqual(2);

        const alice = await page.request.get(`${EMU_BASE_URL}/api/v1/me`);
        const aliceId = String(((await alice.json()) as { id?: string }).id ?? "");
        expect(
          approverIds.has(aliceId),
          "user A (alice) holds the gate's approver role in her own project",
        ).toBe(true);

        winner = await secondApprover(browser, approverIds);
      });

      let conflictText = "";
      let winnerName = "";
      let loserDecidePosts = 0;
      await test.step("alice holds Approve while the other maintainer decides inside the hold", async () => {
        const decider = winner as Decider;
        // The winner's read of the gate comes FIRST and through HIS OWN session:
        // the CAS token he posts must be the row's current version, and one
        // request out of the 5 s window is what keeps the window intact.
        const asDecider = await decider.page.request.get(
          `${EMU_BASE_URL}/api/v1/approvals/${gateId}`,
        );
        expect(
          asDecider.status(),
          `${decider.subject} may read the gate he is about to decide`,
        ).toBe(200);
        const gateRow = (await asDecider.json()) as ApprovalRow;
        expect(gateRow.state, "the gate is still pending before the hold opens").toBe("pending");
        expect(
          gateRow.version,
          "the winner decides with the gate's current CAS version",
        ).toBeGreaterThanOrEqual(1);

        // The name the sentence must carry, read the way the BAR reads it.
        const directory = await page.request.get(`${EMU_BASE_URL}/api/v1/users`);
        expect(directory.status(), "GET /api/v1/users answers the directory").toBe(200);
        const users = (await directory.json()) as {
          items?: { id: string; display_name: string }[];
        };
        winnerName =
          (users.items ?? []).find((user) => user.id === decider.userId)?.display_name ?? "";
        expect(
          winnerName,
          `GET /api/v1/users names ${decider.subject} (${decider.userId}) — the bar may not ` +
            `print a uuid where a person belongs`,
        ).not.toBe("");

        await page.goto("/");
        await expect(page.getByTestId("home-page"), "Today renders").toBeVisible({
          timeout: 30_000,
        });
        const callout = page.getByTestId(`home-callout-${testidOf(gateId)}`);
        if (!(await callout.isVisible().catch(() => false))) {
          // The briefing previews three callouts and expands the rest IN PLACE
          // (finding 03) — a busy lab may hold more gates than this one.
          const more = page.getByTestId("home-show-more");
          if (await more.isVisible().catch(() => false)) {
            await more.click({ timeout: 10_000 });
          }
        }
        await expect(
          callout,
          "design 2a: the gate alice may decide is on her Today briefing",
        ).toBeVisible({ timeout: 30_000 });
        const bar = callout.getByTestId("decision-bar");
        const approve = bar.getByTestId("decision-approve");
        await expect(
          approve,
          "design finding 04: the ONE bar offers Approve, no confirm step",
        ).toBeVisible({ timeout: 30_000 });
        await expect(approve, "Approve is enabled for the approver").toBeEnabled({
          timeout: 15_000,
        });

        const held = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            new URL(response.url()).pathname === `/api/v1/approvals/${gateId}/decide`,
          { timeout: 30_000 },
        );
        // Every decide POST alice's tab sends, counted at the wire: the
        // watched-cache arm sends NONE, the 409 arm exactly one — a second
        // POST (a retry after the sentence, a double flush on unmount) is the
        // bug this counts.
        page.on("request", (request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname === `/api/v1/approvals/${gateId}/decide`
          ) {
            loserDecidePosts += 1;
          }
        });
        await approve.click({ timeout: 15_000 });
        // The hold, not an instant POST — without this line there is no window
        // to lose, and the pass would be proving a coincidence.
        await expect(
          bar.getByTestId("decision-status"),
          "the click holds the decision ~5s behind Undo",
        ).toContainText(/Approved\. The run continues in \d+s\./, { timeout: 15_000 });

        const decided = await apiMutate(
          decider.page,
          "POST",
          `${EMU_BASE_URL}/api/v1/approvals/${gateId}/decide`,
          { decision: "approved", version: gateRow.version },
        );
        const decidedBody = await decided.text();
        expect(
          decided.status(),
          `${decider.subject}'s decide inside alice's hold window answers 200 ` +
            `(got ${decided.status()}: ${decidedBody.slice(0, 300)})`,
        ).toBe(200);
        winnerDecided = true;
        expect(
          (JSON.parse(decidedBody) as ApprovalRow).decided_by ?? "",
          "the winner's own answer names him as the decider",
        ).toBe(decider.userId);

        // Both arms of the fixed bar end at the same line, with the stream
        // OPEN: the `approval.decided` frame usually moves the shared cache
        // before her hold expires — the bar cancels the hold, sends nothing,
        // and Today keeps the callout (a silent 409 on a vanished row is
        // finding 04's gap (a)); when the frame loses the race against 5 s,
        // her POST arrives on the decided gate and the 409 says the same
        // words. Either way the sentence names the winner.
        const line = bar.getByTestId("decision-conflict");
        await expect(
          line,
          "design finding 12: the loser is told who won, in words — live, with the journal stream unblocked",
        ).toBeVisible({ timeout: 25_000 });
        // The watched-cache arm first owns only the disappearance (the name
        // arrives with the single gate-row read + directory lookup), so the
        // capture waits for the NAMED sentence, not for its first paint.
        await expect
          .poll(
            async () =>
              ((await line.innerText({ timeout: 5_000 }).catch(() => "")) ?? "").replace(
                /\s+/g,
                " ",
              ),
            {
              message: "the kept callout ends up naming the winner, never `Someone`",
              timeout: 20_000,
              intervals: [500],
            },
          )
          .toMatch(new RegExp(`(?!.*\\bsomeone\\b.*)${escapeForRegex(winnerName)}`, "i"));
        conflictText = ((await line.innerText({ timeout: 10_000 })) ?? "").replace(/\s+/g, " ");
        await held
          .then((response) => {
            expect(
              response.status(),
              "if alice's hold beat the frame, the held POST arrives on a decided gate — the CAS refuses it with 409",
            ).toBe(409);
          })
          .catch(() => {
            // The watched-cache arm: the hold was cancelled and no POST was
            // ever sent. That is the NEW default; the sentence above is what
            // the reader is owed.
          });
      });

      await test.step("the sentence names the winner, and NOTHING claims it was recorded", async () => {
        const decider = winner as Decider;
        // `DecisionBar`'s own shape (ui/src/components/ds/DecisionBar.tsx): `× `,
        // the directory's name (upper-cased only because the subject opens the
        // sentence), the winner's verb, the age the body serves, and the honest
        // tail. The conflict summary carries no timestamp, so the age is the
        // component's own “a moment”; a body that did serve one prints `12s`.
        expect(conflictText, "the loser's line is the conflict sentence").toContain(
          "approved this",
        );
        expect(conflictText, "…and it says the click did not land").toContain(
          "Your decision wasn't recorded.",
        );
        expect(
          conflictText,
          `…and it names the winner exactly as GET /api/v1/users shows him (${winnerName})`,
        ).toMatch(new RegExp(`\\b${escapeForRegex(winnerName)}\\s+approved\\b`, "i"));
        expect(conflictText, "the age is a human age, never an empty span").toMatch(
          /approved this (\d+[smhd]|a moment) ago\./,
        );
        expect(
          conflictText,
          "no uuid leaks into the sentence — the whole point of the directory read",
        ).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(
          conflictText,
          "a person the directory knows beats the `Someone` fallback",
        ).not.toMatch(/\bsomeone\b/i);

        // `done` means the server said so, and the server said the OPPOSITE: no
        // recorded status on her bar, and no second bar printing one.
        const callout = page.getByTestId(`home-callout-${testidOf(gateId)}`);
        // Finding 04 (gap (a)): the pending list HAS dropped the gate by now
        // (the same frame that proved the race live refetches it, batched at
        // `FRAME_BATCH_MS`) — and the callout is still there, kept by Today's
        // own "recently lost" list until dismissed.
        await expect(
          callout,
          "the callout survives the pending list that dropped it, still carrying the sentence",
        ).toBeVisible({ timeout: 15_000 });
        await expect(
          callout.getByTestId("decision-conflict"),
          "…the conflict sentence, not a vanishing bar…",
        ).toBeVisible();
        await expect(
          callout.getByTestId("decision-approve"),
          "…and the lost row never offers the verbs again",
        ).toHaveCount(0);
        expect(
          loserDecidePosts,
          "at most ONE decide POST ever leaves alice's tab (zero = the hold was cancelled)",
        ).toBeLessThanOrEqual(1);
        await expect(
          callout.getByTestId("decision-status"),
          "the loser's bar carries no 'Your decision is recorded' status line",
        ).toHaveCount(0);
        await expect(callout, "the callout never claims a recording").not.toContainText(
          /Your decision is recorded/,
        );
        // Finding 12: every error ends in an action — the way to the decision
        // that DID land.
        await expect(
          callout.getByTestId("decision-conflict-run"),
          "the conflict line links to the run the winner moved on",
        ).toHaveAttribute("href", new RegExp(`/runs/${runId}$`));

        // The wire agrees with the sentence: one decision, and it is the
        // winner's — `12` case 9d's “exactly one 200 and both callers see one
        // truth”, read from the server rather than from the ink.
        const afterRes = await page.request.get(`${EMU_BASE_URL}/api/v1/approvals/${gateId}`);
        expect(afterRes.status(), "the decided gate still reads back to alice").toBe(200);
        const after = (await afterRes.json()) as ApprovalRow;
        expect(after.state, "the gate reads decided").toBe("decided");
        expect(after.decision, "the recorded decision is an approve").toBe("approved");
        expect(after.decided_by ?? "", "recorded by the winner, not by alice").toBe(decider.userId);
      });
    } finally {
      // Widened assertion, not a null check: `winner` is assigned inside nested
      // steps, so the flow type at this point is the initial `null`.
      const decider = winner as Decider | null;
      if (decider !== null)
        await decider.page
          .context()
          .close()
          .catch(() => undefined);
      const admin = adminContext as BrowserContext | null;
      if (admin !== null) await admin.close().catch(() => undefined);
      // Nothing may leave the lab holding an undecided gate: a leg that died
      // before the winner's decide would otherwise park a run on this pin
      // forever, and the pin's single concurrent-run slot is a shared resource
      // (see run-gate-artifacts.spec.ts' ceiling refusal).
      if (!winnerDecided && runId !== "") {
        const cancelled = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/runs/${runId}/cancel`,
        ).catch(() => null);
        console.log(
          `gate-decision-conflict cleanup: run ${runId} cancel -> ` +
            `${cancelled === null ? "FAILED (the run may still be parked)" : cancelled.status()}`,
        );
      }
    }
  });

  test("T10b — the Approval page: the sentence replaces the decided summary's header", async ({
    browser,
    page,
    emu,
  }) => {
    // Gap (b) proven with live updates on: on THIS page nothing invalidates
    // the row during the hold, so her own POST arrives on the decided gate,
    // the 409 adopts the winner, the decide panel unmounts with the pending
    // row — and the sentence must outlive it, in place of the decided
    // summary's header, details below. (Same budget shape as T10a: the run
    // start additionally waits for T10a's run to settle off the shared pin.)
    test.setTimeout(420_000);
    emu.expectFailure(/\/api\/v1\/approvals\/[0-9a-f-]{36}\/decide$/, 409);

    let projectId = "";
    let runId = "";
    let gateId = "";
    let winnerDecided = false;
    let winner: Decider | null = null;
    let adminContext: BrowserContext | null = null;

    try {
      await test.step("a second scratch gate is started once the shared pin is free", async () => {
        adminContext = await browser.newContext({
          baseURL: EMU_BASE_URL,
          storageState: EMU_ADMIN_STATE,
        });
        const admin = await adminContext.newPage();
        projectId = await m4ExitId(page);
        const revisionId = await ensureGateWorkflow(admin);
        const assignmentId = await ensurePin(page, projectId, revisionId);

        // One run per pin (run-gate-artifacts.spec.ts' ceiling): T10a's gate
        // was approved, so its run is finishing — wait it out rather than
        // stack a second gate onto a pin that refuses it.
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs`);
              if (res.status() !== 200) return `http-${res.status()}`;
              const body = (await res.json()) as {
                runs?: { pipeline_slug?: string; status?: string }[];
              };
              const active = (body.runs ?? []).filter(
                (run) =>
                  run.pipeline_slug === GATE_SLUG &&
                  ["queued", "preparing", "running", "waiting_human", "paused"].includes(
                    String(run.status),
                  ),
              );
              return active.length;
            },
            {
              message: "no scratch-gate run is still holding the shared pin",
              timeout: 240_000,
              intervals: [2_000],
            },
          )
          .toBe(0);

        const created = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/projects/${projectId}/runs`,
          {
            assignment_id: assignmentId,
            inputs: { goal: `emu T10b decision race on the approval page ${EMU_PASS_ID}` },
            idempotency: `emu-t10b-${EMU_PASS_ID}`.toLowerCase(),
          },
        );
        const body = await created.text();
        expect(
          created.status(),
          `starting the second scratch run answers 2xx (got ${created.status()}: ${body.slice(0, 300)})`,
        ).toBeLessThan(300);
        runId = String((JSON.parse(body) as { run_id?: string }).run_id ?? "");
        expect(runId, "the run create answers with the run id").toMatch(/^[0-9a-f-]{36}$/);
      });

      await test.step("the second gate waits, and both identities may decide it", async () => {
        await expect
          .poll(
            async () => {
              const res = await page.request.get(`${EMU_BASE_URL}/api/v1/runs/${runId}`);
              if (res.status() !== 200) return `http-${res.status()}`;
              return String(((await res.json()) as { status?: string }).status ?? "unknown");
            },
            {
              message: "the scratch run parks in waiting_human",
              timeout: 180_000,
              intervals: [2_000],
            },
          )
          .toBe("waiting_human");
        await expect
          .poll(async () => (await pendingGateOf(page, runId))?.id ?? "", {
            message: "the waiting run has a pending gate",
            timeout: 60_000,
            intervals: [2_000],
          })
          .toMatch(/^[0-9a-f-]{36}$/);
        const gate = await pendingGateOf(page, runId);
        gateId = String((gate as ApprovalRow).id);

        const members = await page.request.get(
          `${EMU_BASE_URL}/api/v1/projects/${projectId}/members`,
        );
        const rows = (await members.json()) as {
          items?: { user_id: string; role: string }[];
        };
        const approverIds = new Set(
          (rows.items ?? [])
            .filter((member) => member.role === "maintainer")
            .map((member) => member.user_id),
        );
        winner = await secondApprover(browser, approverIds);
      });

      await test.step("alice holds Approve on /approvals/:id while he decides", async () => {
        const decider = winner as Decider;
        const asDecider = await decider.page.request.get(
          `${EMU_BASE_URL}/api/v1/approvals/${gateId}`,
        );
        expect(asDecider.status(), "the winner may read the gate").toBe(200);
        const gateRow = (await asDecider.json()) as ApprovalRow;
        expect(gateRow.state, "the gate is pending before the hold opens").toBe("pending");

        const directory = await page.request.get(`${EMU_BASE_URL}/api/v1/users`);
        const users = (await directory.json()) as {
          items?: { id: string; display_name: string }[];
        };
        const winnerName =
          (users.items ?? []).find((user) => user.id === decider.userId)?.display_name ?? "";
        expect(winnerName, `the directory names ${decider.subject}`).not.toBe("");

        // The reader CLICKED on the gate's own page: this is where gap (b)
        // bit — the 409's adopted row closed the decide panel under her.
        await page.goto(`/approvals/${gateId}`);
        const approve = page.getByTestId("decision-approve");
        await expect(
          approve,
          "design finding 04: the gate page decides through the ONE bar",
        ).toBeVisible({ timeout: 30_000 });

        let decidePosts = 0;
        page.on("request", (request) => {
          if (
            request.method() === "POST" &&
            new URL(request.url()).pathname === `/api/v1/approvals/${gateId}/decide`
          ) {
            decidePosts += 1;
          }
        });
        await approve.click({ timeout: 15_000 });
        await expect(
          page.getByTestId("decision-status"),
          "the click holds the decision ~5s behind Undo",
        ).toContainText(/Approved\. The run continues in \d+s\./, { timeout: 15_000 });

        const decided = await apiMutate(
          decider.page,
          "POST",
          `${EMU_BASE_URL}/api/v1/approvals/${gateId}/decide`,
          { decision: "approved", version: gateRow.version },
        );
        const decidedBody = await decided.text();
        expect(
          decided.status(),
          `${decider.subject}'s decide inside the hold answers 200 (got ${decided.status()}: ${decidedBody.slice(0, 300)})`,
        ).toBe(200);
        winnerDecided = true;
        expect(
          (JSON.parse(decidedBody) as ApprovalRow).decided_by ?? "",
          "the winner's own answer names him as the decider",
        ).toBe(decider.userId);

        // Her POST goes out at the end of the hold and the 409 says who won;
        // at most ONE decide POST may ever leave her tab.
        const line = page.getByTestId("decision-conflict");
        await expect(
          line,
          "the 409 names the winner, in words, on the gate's own page",
        ).toBeVisible({ timeout: 20_000 });
        expect(decidePosts, "at most ONE decide POST ever leaves alice's tab").toBeLessThanOrEqual(
          1,
        );

        // Gap (b) proper: the adopted row reads DECIDED — and the sentence
        // does not vanish with the decide panel. It replaces the decided
        // summary's header; Dismiss is the only way it leaves.
        const testid = testidOf(gateId);
        await expect(
          page.getByTestId(`approval-detail-strip-${testid}`),
          "the page's strip shows the winner's truth",
        ).toContainText("DECIDED", { timeout: 20_000 });
        await expect(
          page.getByTestId(`approval-detail-lost-${testid}`),
          "the lost-race sentence stays, in place of the decided summary's header",
        ).toBeVisible({ timeout: 20_000 });
        await expect
          .poll(
            async () =>
              (
                (await page
                  .getByTestId("decision-conflict")
                  .innerText({ timeout: 5_000 })
                  .catch(() => "")) ?? ""
              ).replace(/\s+/g, " "),
            {
              message: "…and it names the winner",
              timeout: 20_000,
              intervals: [500],
            },
          )
          .toMatch(new RegExp(`(?!.*\\bsomeone\\b.*)${escapeForRegex(winnerName)}.*approved`, "i"));
        const sentence = ((await page.getByTestId("decision-conflict").innerText()) ?? "").replace(
          /\s+/g,
          " ",
        );
        expect(sentence, "the honest tail").toContain("Your decision wasn't recorded.");
        expect(sentence, "no uuid in the sentence").not.toMatch(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
        );
        await expect(
          page.getByTestId("decision-status"),
          "no 'recorded' status anywhere on her bar",
        ).toHaveCount(0);
        await expect(page.locator("main")).not.toContainText(/Your decision is recorded/);

        // Dismiss clears the sentence and restores the plain decided summary
        // (the decided details were never the thing at stake).
        await page.getByTestId(`approval-detail-lost-dismiss-${testid}`).click({ timeout: 10_000 });
        await expect(
          page.getByTestId(`approval-detail-lost-${testid}`),
          "Dismiss clears the sentence",
        ).toHaveCount(0);
        await expect(
          page.getByTestId(`approval-detail-closed-${testid}`),
          "the decided summary reads normally afterwards",
        ).toBeVisible();
      });

      await test.step("the wire agrees: one decision, and it is the winner's", async () => {
        const decider = winner as Decider;
        const afterRes = await page.request.get(`${EMU_BASE_URL}/api/v1/approvals/${gateId}`);
        expect(afterRes.status(), "the decided gate reads back to alice").toBe(200);
        const after = (await afterRes.json()) as ApprovalRow;
        expect(after.state, "the gate reads decided").toBe("decided");
        expect(after.decision, "the recorded decision is an approve").toBe("approved");
        expect(after.decided_by ?? "", "recorded by the winner, not by alice").toBe(decider.userId);
      });
    } finally {
      const decider = winner as Decider | null;
      if (decider !== null)
        await decider.page
          .context()
          .close()
          .catch(() => undefined);
      const admin = adminContext as BrowserContext | null;
      if (admin !== null) await admin.close().catch(() => undefined);
      if (!winnerDecided && runId !== "") {
        const cancelled = await apiMutate(
          page,
          "POST",
          `${EMU_BASE_URL}/api/v1/runs/${runId}/cancel`,
        ).catch(() => null);
        console.log(
          `gate-decision-conflict T10b cleanup: run ${runId} cancel -> ` +
            `${cancelled === null ? "FAILED (the run may still be parked)" : cancelled.status()}`,
        );
      }
    }
  });
});

function escapeForRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
