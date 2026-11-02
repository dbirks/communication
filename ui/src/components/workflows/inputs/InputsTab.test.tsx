/**
 * The Inputs tab (design 1j) against the fake fetch. The contracts with
 * teeth:
 * - the row list reads the OPEN DRAFT's live document (the thing the tab
 *   writes), and the server's `input_specs` only when no draft exists;
 * - expanding a row shows the editor and the `used as ${{ inputs.x }} in
 *   <steps>` line computed from the draft's own bindings;
 * - Save writes the annotation through `PUT /drafts/{id}` and re-validates —
 *   an edit that names the wrong YAML member is a bug the PUT body exposes;
 * - WHO FILLS rows come from the assignments/triggers, and the schedule's
 *   “can't fill it” line is the server's validate warning VERBATIM, never a
 *   client-side guess;
 * - with no draft, a save first clones the newest revision into a draft (the
 *   `Edit workflow` move) and writes through it;
 * - empty and error states say what they are.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(cleanup);
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  wireAssignmentList,
  wireRevision,
} from "../../../test/fixtures/m4/wire";
import { mockFetch, projectFixture, requestsTo, type RouteStub } from "../../../test/fakes";
import type { Draft, PipelineRevision, Repository } from "../../../api/types";
import type { Schedule } from "../../../api/pipelines";
import type { IssueTrigger } from "../../../api/useIssueTriggers";
import type { PipelineDraftSummary } from "../../../lib/pipeline/contract";
import type { UsedInGroup } from "../../../pages/workflow/useUsedIn";
import { InputsTab } from "./InputsTab";

/* ------------------------------------------------------------- fixtures */

/** The 1j workflow, annotated per ADR-0066; `plan` reads the issue input. */
const DRAFT_YAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: issue-to-pr
spec:
  inputs:
    type: object
    required: [issue]
    properties:
      issue:
        type: object
        x-communication-input: {type: github_issue, label: Issue to work on, help: The issue becomes the goal; the PR links back to it.}
      base_branch:
        type: string
        default: main
        x-communication-input: {type: branch, label: Base branch}
      reviewer:
        type: string
        default: prof-codex
        x-communication-input: {type: agent_profile, label: Reviewer}
      notes:
        type: string
        x-communication-input: {type: long_text, label: Notes}
  nodes:
    - id: plan
      kind: agent.acp
      config:
        prompt: |
          Work on \${{ inputs.issue.body }}
`;

const WIRE_USER = "01987b10-0000-7000-8000-abcdef012345";
const SCHEDULE_ID = "01987b22-0005-7000-8000-abcdef012345";
const TRIGGER_ID = "01987b22-0006-7000-8000-abcdef012345";
const DRAFT_PATH = `/api/v1/drafts/${WIRE_DRAFT_ID}`;
const VALIDATE_PATH = `${DRAFT_PATH}/validate`;
const DRAFTS_PATH = `/api/v1/pipelines/${WIRE_PIPELINE_ID}/drafts`;

const schedule: Schedule = {
  id: SCHEDULE_ID,
  project_id: projectFixture.id,
  assignment_id: wireAssignmentList.assignments[0].id,
  cron_expr: "0 2 * * *",
  inputs: {},
  enabled: true,
  next_run_at: "2099-01-02T06:00:00Z",
  version: 1,
  created_by: WIRE_USER,
  created_at: "2026-07-01T09:00:00Z",
  updated_at: "2026-07-27T06:00:00Z",
};

const issueTrigger: IssueTrigger = {
  id: TRIGGER_ID,
  project_id: projectFixture.id,
  assignment_id: wireAssignmentList.assignments[0].id,
  repository_id: "01987b22-0002-7000-8000-abcdef012345",
  event: "labeled",
  labels: ["factory"],
  inputs: {},
  issue_input: "issue",
  enabled: true,
  version: 1,
  created_by: WIRE_USER,
  created_at: "2026-07-20T09:00:00Z",
  updated_at: "2026-07-20T09:00:00Z",
};

const group: UsedInGroup = {
  project: projectFixture,
  assignment: wireAssignmentList.assignments[0],
  repositories: [] as Repository[],
  schedules: [schedule],
  issueTriggers: [issueTrigger],
  runs: [],
  triggersArrived: true,
  triggersError: false,
};

const openDraft: PipelineDraftSummary = {
  id: WIRE_DRAFT_ID,
  status: "valid",
  version: 12,
  updated_at: "2026-07-31T08:12:00Z",
  edited_by: WIRE_USER,
};

const scheduleWarning = {
  code: "input_unfillable_by_trigger",
  source: "trigger" as const,
  message:
    'trigger * * * * * (schedule, s-1) cannot fill required input "issue" and it has no ' +
    "default; a run it fires will be refused at the start (ADR-0066)",
  trigger_id: SCHEDULE_ID,
  trigger_kind: "schedule" as const,
  trigger_label: "* * * * *",
  input: "issue",
};

/** One server-shaped `input_unfillable_by_trigger` warning for the tests,
 * with every field the server sends: `trigger_label` is the trigger's own
 * word (the event for an issue trigger, the cron expression for a schedule),
 * which is what the author's sentence names. */
function unfillable(kind: "schedule" | "issue", triggerId: string, input: string) {
  return {
    code: "input_unfillable_by_trigger",
    source: "trigger",
    message: `trigger server #opened (issue, ${triggerId}) cannot fill required input "${input}" and it has no default; a run it fires will be refused at the start (ADR-0066)`,
    trigger_id: triggerId,
    trigger_kind: kind,
    trigger_label: kind === "issue" ? "opened" : "* * * * *",
    input,
  } as const;
}

/** The 1j review's document: goal and repository join `issue` as required
 * inputs with no default — the labeled-issue trigger can fill only one. */
const GOAL_REPO_YAML = DRAFT_YAML.replace(
  "required: [issue]",
  "required: [issue, goal, repository]",
).replace(
  "      issue:",
  `      goal:
        type: string
        x-communication-input: {type: long_text, label: Goal}
      repository:
        type: string
        x-communication-input: {type: text, label: Repository}
      issue:`,
);

function wireDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    id: WIRE_DRAFT_ID,
    pipeline_id: WIRE_PIPELINE_ID,
    status: "valid",
    document_yaml: DRAFT_YAML,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    validation: {
      valid: true,
      warnings: [scheduleWarning],
      digest_scope: "v1alpha1-canonical-1",
      errors: [],
      notes: [],
    },
    digest_scope: "v1alpha1-canonical-1",
    version: 12,
    edited_by: WIRE_USER,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
    ...overrides,
  };
}

/* ---------------------------------------------------------------- mount */

type TabProps = Parameters<typeof InputsTab>[0];

function mountTab({
  routes = [],
  props = {},
}: { routes?: RouteStub[]; props?: Partial<TabProps> } = {}) {
  const { requests } = mockFetch([
    ...routes,
    { path: DRAFT_PATH, method: "GET", body: wireDraft() },
    {
      // A CAS save echoes the sent document back with a bumped `version`,
      // like the real `PUT /drafts/{id}` does.
      path: DRAFT_PATH,
      method: "PUT",
      body: (n: number) => {
        const puts = requests.filter((r) => r.method === "PUT" && r.url === DRAFT_PATH);
        const sent = JSON.parse(puts[n - 1]?.body ?? "{}") as {
          document_yaml?: string;
          version?: number;
        };
        return wireDraft({
          document_yaml: sent.document_yaml ?? "",
          version: (sent.version ?? 1) + 1,
        });
      },
    },
    {
      path: VALIDATE_PATH,
      method: "POST",
      body: { valid: true, digest_scope: "v1alpha1-canonical-1", errors: [], notes: [] },
    },
  ]);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const baseProps: TabProps = {
    pipelineId: WIRE_PIPELINE_ID,
    slug: "issue-to-pr",
    canAuthor: true,
    revision: wireRevision,
    revisionLoading: false,
    revisionError: null,
    onRevisionRetry: () => undefined,
    openDraft,
    groups: [group],
    groupsLoading: false,
    groupsError: false,
    ...props,
  };
  const ui = (p: TabProps) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InputsTab {...p} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  let current = baseProps;
  const utils = render(ui(current));
  return {
    ...utils,
    requests,
    /** Re-render with overridden props — the page feeding a fresh `openDraft`
     * after a create lands (via its drafts-list refetch) is exactly what this
     * stands in for. */
    rerenderWith(next: Partial<TabProps>) {
      current = { ...current, ...next };
      utils.rerender(ui(current));
    },
  };
}

/* ---------------------------------------------------------------- tests */

describe("InputsTab — the row list (1j)", () => {
  it("shows NAME · TYPE · REQUIRED · DEFAULT from the draft's own document", async () => {
    mountTab();
    const panel = await screen.findByTestId("inputs-tab");
    expect(within(panel).getByText("INPUTS · 4")).toBeTruthy();

    const issue = screen.getByTestId("input-row-issue");
    expect(issue.textContent).toContain("GitHub issue");
    expect(issue.textContent).toContain("required");
    expect(issue.textContent).toContain("—"); // issue has no default
    const branch = screen.getByTestId("input-row-base_branch");
    expect(branch.textContent).toContain("Branch");
    expect(branch.textContent).toContain("optional");
    expect(branch.textContent).toContain("main");
    expect(screen.getByTestId("input-row-reviewer").textContent).toContain("Agent profile");
    expect(screen.getByTestId("input-row-notes").textContent).toContain("Long text");
    // Design header row: NAME TYPE REQUIRED DEFAULT.
    expect(screen.getByTestId("inputs-header-row").textContent).toContain("name");
  });

  it("the YAML panel previews the inputs block", async () => {
    mountTab();
    const preview = await screen.findByTestId("inputs-yaml-preview");
    expect(preview.textContent).toContain("inputs:");
    expect(preview.textContent).toContain("  issue:");
    expect(preview.textContent).toContain("type: github_issue");
    expect(preview.textContent).toContain("required: true");
    expect(preview.textContent).toContain("default: main");
  });

  it("an inputless workflow offers the empty state, not a blank panel", async () => {
    mountTab({
      routes: [
        {
          path: DRAFT_PATH,
          method: "GET",
          body: wireDraft({ document_yaml: "apiVersion: v\nkind: Pipeline\nspec:\n  nodes: []\n" }),
        },
      ],
    });
    const empty = await screen.findByTestId("inputs-empty");
    expect(empty.textContent).toBe("No inputs yet. Add one so runs can ask for what they need.");
  });

  it("a failed draft read is the card with Retry, not an empty list", async () => {
    mountTab({ routes: [{ path: DRAFT_PATH, method: "GET", status: 500 }] });
    const card = await screen.findByTestId("inputs-error-card");
    expect(card.textContent).toMatch(/draft/i);
    expect(screen.getByTestId("inputs-error-retry")).toBeTruthy();
  });
});

describe("InputsTab — the row editor (1j)", () => {
  it("expands into Label · Type · Help · Required · Default and the used-as line", async () => {
    mountTab();
    fireEvent.click(await screen.findByTestId("input-row-issue"));
    const editor = await screen.findByTestId("input-editor-issue");

    expect((screen.getByTestId("input-label-issue") as HTMLInputElement).value).toBe(
      "Issue to work on",
    );
    expect((screen.getByTestId("input-type-issue") as HTMLSelectElement).value).toBe(
      "github_issue",
    );
    expect((screen.getByTestId("input-help-issue") as HTMLInputElement).value).toBe(
      "The issue becomes the goal; the PR links back to it.",
    );
    expect((screen.getByTestId("input-required-issue") as HTMLInputElement).checked).toBe(true);
    // The steps the DRAFT's bindings name.
    expect(screen.getByTestId("input-used-issue").textContent).toBe(
      "used as `${{ inputs.issue }}` in plan",
    );
    // github_issue exposes no text default.
    expect(screen.queryByTestId("input-default-issue")).toBeNull();
    expect(editor).toBeTruthy();
  });

  it("says when nothing reads an input yet", async () => {
    mountTab();
    fireEvent.click(await screen.findByTestId("input-row-notes"));
    await screen.findByTestId("input-editor-notes");
    expect(screen.getByTestId("input-used-notes").textContent).toBe("not used by any step yet");
    expect((screen.getByTestId("input-default-notes") as HTMLInputElement).value).toBe("");
  });

  it("saves the annotation through the draft PUT and re-validates", async () => {
    const { requests } = mountTab();
    fireEvent.click(await screen.findByTestId("input-row-base_branch"));
    fireEvent.change(screen.getByTestId("input-label-base_branch"), {
      target: { value: "Target branch" },
    });
    fireEvent.change(screen.getByTestId("input-type-base_branch"), {
      target: { value: "text" },
    });
    fireEvent.change(screen.getByTestId("input-default-base_branch"), {
      target: { value: "trunk" },
    });
    fireEvent.click(screen.getByTestId("input-save-base_branch"));

    await waitFor(() => expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(1));
    const [put] = requestsTo(requests, DRAFT_PATH, "PUT");
    expect(JSON.parse(put.body ?? "{}")).toMatchObject({ version: 12 });
    const saved = JSON.parse(put.body ?? "{}").document_yaml as string;
    expect(saved).toMatch(
      /base_branch:\s*\n\s*type: string\s*\n\s*default: trunk\s*\n\s*x-communication-input:\s*\n\s*type: text\s*\n\s*label: Target branch/,
    );
    // `issue` keeps its required-array member; the save is not a rewrite.
    expect(saved).toMatch(/required:\s*\[?\s*-?\s*issue/);
    // And the server judges the saved bytes (the warnings rail reads that).
    await waitFor(() => expect(requestsTo(requests, VALIDATE_PATH, "POST")).toHaveLength(1));
  });

  it("the Required toggle writes through the required array", async () => {
    const { requests } = mountTab();
    fireEvent.click(await screen.findByTestId("input-row-notes"));
    fireEvent.click(screen.getByTestId("input-required-notes"));
    fireEvent.click(screen.getByTestId("input-save-notes"));
    await waitFor(() => expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(1));
    const saved = JSON.parse(requestsTo(requests, DRAFT_PATH, "PUT")[0].body ?? "{}")
      .document_yaml as string;
    expect(saved).toMatch(/notes:\s*\n\s*type: string/);
    expect(saved).toMatch(/required:[\s\S]*notes/);
  });

  it("adds an input with the chosen type, and removes one", async () => {
    const { requests } = mountTab();
    fireEvent.click(await screen.findByTestId("input-add"));
    await screen.findByTestId("input-add-form");
    fireEvent.change(screen.getByTestId("input-add-name"), { target: { value: "goal" } });
    fireEvent.click(screen.getByTestId("input-add-save"));
    await waitFor(() => expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(1));
    let saved = JSON.parse(requestsTo(requests, DRAFT_PATH, "PUT")[0].body ?? "{}")
      .document_yaml as string;
    expect(saved).toMatch(
      /goal:\s*\n\s*type: string\s*\n\s*x-communication-input:\s*\n\s*type: text/,
    );

    fireEvent.click(screen.getByTestId("input-row-notes"));
    fireEvent.click(await screen.findByTestId("input-remove-notes"));
    await waitFor(() => expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(2));
    saved = JSON.parse(requestsTo(requests, DRAFT_PATH, "PUT")[1].body ?? "{}")
      .document_yaml as string;
    expect(saved).not.toMatch(/notes:/);
  });

  it("a non-author reads rows and the used-as line but writes nothing", async () => {
    const { requests } = mountTab({ props: { canAuthor: false } });
    expect(screen.queryByTestId("input-add")).toBeNull();
    fireEvent.click(await screen.findByTestId("input-row-issue"));
    await screen.findByTestId("input-editor-issue");
    expect(screen.queryByTestId("input-save-issue")).toBeNull();
    expect(screen.getByTestId("input-readonly-issue").textContent).toMatch(/view/i);
    expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(0);
  });
});

describe("InputsTab — who fills the inputs (1j)", () => {
  it("words the by-hand row from the required-no-default inputs", async () => {
    mountTab();
    const line = await screen.findByTestId("who-fills-hand-line");
    expect(line.textContent).toBe("Form asks for issue; others prefilled.");
  });

  it("the issue trigger names the input the labeled issue fills", async () => {
    mountTab();
    const line = await screen.findByTestId(`who-fills-issue-line-${TRIGGER_ID}`);
    expect(line.textContent).toBe("✓ issue ← the labeled issue");
    // The label rides the row title as the design's chip.
    expect(screen.getByTestId(`who-fills-issue-${TRIGGER_ID}`).textContent).toContain("factory");
  });

  it("an unmapped trigger fills the single issue input implicitly, and says so when there are several", async () => {
    const unmappedGroups = [
      { ...group, issueTriggers: [{ ...issueTrigger, issue_input: undefined }] },
    ];
    const single = mountTab({ props: { groups: unmappedGroups } });
    const line = await screen.findByTestId(`who-fills-issue-line-${TRIGGER_ID}`);
    expect(line.textContent).toBe("✓ issue ← the labeled issue");
    single.unmount();

    // A second `github_issue` input makes the fill ambiguous — the panel
    // refuses to pick, it does not guess.
    const twoIssues = DRAFT_YAML.replace(
      "notes:\n        type: string\n        x-communication-input: {type: long_text, label: Notes}",
      "notes:\n        type: object\n        x-communication-input: {type: github_issue, label: Notes}",
    );
    mountTab({
      routes: [{ path: DRAFT_PATH, method: "GET", body: wireDraft({ document_yaml: twoIssues }) }],
      props: { groups: unmappedGroups },
    });
    const second = await screen.findByTestId(`who-fills-issue-line-${TRIGGER_ID}`);
    expect(second.textContent).toBe("the trigger maps no issue input yet");
  });

  it("a schedule with an unfillable required input shows the server's warning, pale row", async () => {
    mountTab();
    const row = await screen.findByTestId(`who-fills-schedule-${SCHEDULE_ID}`);
    expect(row.className).toContain("bg-st-waiting-pale-body");
    expect(row.textContent).toContain("! issue is required and a schedule can't fill it");
    expect(row.textContent).toMatch(/Schedule ·/);
  });

  it("ONE warning line per warning: a schedule that fills no goal and no repository gets both", async () => {
    // ADR-0066: the rule is per (trigger, input) — two unfillable required
    // inputs are two server warnings and the row shows both, never the
    // first one alone.
    const two: (typeof scheduleWarning)[] = [
      scheduleWarning,
      {
        ...scheduleWarning,
        message: "goal is required and a schedule can't fill it",
        input: "goal",
      },
    ];
    mountTab({
      routes: [
        {
          path: DRAFT_PATH,
          method: "GET",
          body: wireDraft({
            validation: {
              valid: true,
              warnings: two,
              digest_scope: "v1alpha1-canonical-1",
              errors: [],
              notes: [],
            },
          }),
        },
      ],
    });
    const row = await screen.findByTestId(`who-fills-schedule-${SCHEDULE_ID}`);
    const lines = within(row).getAllByTestId(/^who-fills-warn-/);
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe("! issue is required and a schedule can't fill it");
    expect(lines[1].textContent).toBe("! goal is required and a schedule can't fill it");
  });

  it("the issue trigger shows the server's warnings too: ✓ its fill, one ! per unfillable input", async () => {
    // The reviewed 1j gap: goal and repository are required with no default,
    // the labeled-issue trigger fills only `issue`, and the server warned
    // once per unfillable input — every one of those warnings is a row here
    // (they used to show on schedules only).
    const goalRepoDraft = wireDraft({
      document_yaml: GOAL_REPO_YAML,
      validation: {
        valid: true,
        warnings: [
          unfillable("issue", TRIGGER_ID, "goal"),
          unfillable("issue", TRIGGER_ID, "repository"),
        ],
        digest_scope: "v1alpha1-canonical-1",
        errors: [],
        notes: [],
      },
    });
    mountTab({ routes: [{ path: DRAFT_PATH, method: "GET", body: goalRepoDraft }] });
    const row = await screen.findByTestId(`who-fills-issue-${TRIGGER_ID}`);
    // The fill it CAN do still reads as a ✓…
    expect(screen.getByTestId(`who-fills-issue-line-${TRIGGER_ID}`).textContent).toBe(
      "✓ issue ← the labeled issue",
    );
    // …and each warning the server named gets its own `!` line, verbatim.
    //
    // rcn-1j review defect 3: the line used to be the server's OPERATOR
    // sentence verbatim — `trigger server #opened (issue, 01a1…) cannot fill
    // required input "goal" … (ADR-0066)` — an internal uuid, a repository
    // handle and an ADR number set in front of the author. It is now one
    // sentence composed from the warning's own fields (`input`,
    // `trigger_kind`, `trigger_label`), and the server's line still rides the
    // tooltip rather than being thrown away.
    const goalLine = await screen.findByTestId(`who-fills-warn-${TRIGGER_ID}-goal`);
    const repoLine = await screen.findByTestId(`who-fills-warn-${TRIGGER_ID}-repository`);
    expect(goalLine.textContent).toBe(
      "! goal is required and the issue trigger 'opened' can't fill it",
    );
    expect(repoLine.textContent).toBe(
      "! repository is required and the issue trigger 'opened' can't fill it",
    );
    for (const line of [goalLine, repoLine]) {
      expect(line.getAttribute("title")).toContain("cannot fill required input");
      expect(line.getAttribute("title")).toContain("ADR-0066");
    }
    // The row itself shows neither the uuid nor the repository handle.
    expect(row.textContent).not.toContain("ADR-0066");
    expect(row.textContent).not.toContain("server #opened");
    // The warning marks the whole row pale, as the schedule's does.
    expect(row.className).toContain("bg-st-waiting-pale-body");
  });

  it("never claims an input filled and unfilled on the same row", async () => {
    // rcn-1j review defect 3, second half: the reviewed row printed
    // "✓ issue ← the labeled issue" directly above a server warning that the
    // SAME input is unfilled. The ✓ is this panel reading the DRAFT's mapping;
    // the warning is the server's answer about the revision the assignment is
    // PINNED to, and the server is the authority (ADR-0066) — so the ✓ for
    // that input goes quiet and the warning stands.
    const issueDraft = wireDraft({
      document_yaml: GOAL_REPO_YAML,
      validation: {
        valid: true,
        warnings: [unfillable("issue", TRIGGER_ID, "issue")],
        digest_scope: "v1alpha1-canonical-1",
        errors: [],
        notes: [],
      },
    });
    mountTab({ routes: [{ path: DRAFT_PATH, method: "GET", body: issueDraft }] });
    const row = await screen.findByTestId(`who-fills-issue-${TRIGGER_ID}`);
    expect(row.textContent).not.toContain("\u2713");
    expect(screen.getByTestId(`who-fills-issue-line-${TRIGGER_ID}`).textContent).toContain(
      "issue is not filled by the pinned revision",
    );
    expect(await screen.findByTestId(`who-fills-warn-${TRIGGER_ID}-issue`)).toBeTruthy();
  });

  it("a warning whose trigger no longer reads is shown, not dropped", async () => {
    const gone = unfillable("schedule", "s-deleted", "issue");
    mountTab({
      routes: [
        {
          path: DRAFT_PATH,
          method: "GET",
          body: wireDraft({
            validation: {
              valid: true,
              warnings: [scheduleWarning, gone],
              digest_scope: "v1alpha1-canonical-1",
              errors: [],
              notes: [],
            },
          }),
        },
      ],
    });
    // The live schedule row keeps its own warning; the stale one still gets
    // a line of its own under the panel's warnings-without-a-row block.
    expect(await screen.findByTestId(`who-fills-warn-${SCHEDULE_ID}-issue`)).toBeTruthy();
    const orphans = await screen.findByTestId("who-fills-orphans");
    // The stale warning still gets its line — in the author's sentence, with
    // the server's operator line behind the tooltip rather than on it.
    expect(orphans.textContent).toContain("! issue is required and a schedule can't fill it");
    expect(orphans.textContent).not.toContain("ADR-0066");
    expect(screen.getByTestId("who-fills-warn-s-deleted-issue").getAttribute("title")).toContain(
      "ADR-0066",
    );
  });

  it("without a server warning the schedule row states the fact, not a guess", async () => {
    mountTab({
      routes: [
        {
          path: DRAFT_PATH,
          method: "GET",
          body: wireDraft({
            validation: {
              valid: true,
              digest_scope: "v1alpha1-canonical-1",
              errors: [],
              notes: [],
            },
          }),
        },
      ],
    });
    const line = await screen.findByTestId(`who-fills-schedule-line-${SCHEDULE_ID}`);
    expect(line.textContent).toBe("fills no inputs — required ones start on defaults");
    expect(screen.getByTestId(`who-fills-schedule-${SCHEDULE_ID}`).className).not.toContain(
      "bg-st-waiting-pale-body",
    );
  });

  it("a workflow nothing has adopted says nothing can start it yet", async () => {
    mountTab({ props: { groups: [] } });
    const emptyNote = await screen.findByTestId("who-fills-empty");
    expect(emptyNote.textContent).toMatch(/Nothing can start it yet/);
  });
});

describe("InputsTab — no draft yet", () => {
  const revision: PipelineRevision = {
    ...wireRevision,
    document_text: DRAFT_YAML,
    input_specs: [
      {
        name: "base_branch",
        type: "branch",
        label: "Base branch",
        required: false,
        default: "main",
      },
      { name: "issue", type: "github_issue", label: "Issue to work on", required: true },
    ],
  };

  it("reads the revision's server-derived input_specs", async () => {
    mountTab({ props: { openDraft: null, revision } });
    expect(await screen.findByTestId("input-row-issue")).toBeTruthy();
    expect(screen.getByTestId("input-row-base_branch").textContent).toContain("main");
  });

  it("editing creates the draft the way Studio does — clone newest, then PUT, then validate", async () => {
    const created = wireDraft({ version: 1 });
    const { requests, rerenderWith } = mountTab({
      routes: [
        { path: DRAFTS_PATH, method: "POST", body: created },
        { path: DRAFT_PATH, method: "GET", body: created },
      ],
      props: { openDraft: null, revision },
    });
    fireEvent.click(await screen.findByTestId("input-row-notes"));
    await screen.findByTestId("input-editor-notes");
    fireEvent.change(screen.getByTestId("input-label-notes"), {
      target: { value: "Notes for the run" },
    });
    fireEvent.click(screen.getByTestId("input-save-notes"));

    // 1) the clone: the newest revision's own bytes, the `Edit workflow` seed.
    await waitFor(() => expect(requestsTo(requests, DRAFTS_PATH, "POST")).toHaveLength(1));
    const clone = JSON.parse(requestsTo(requests, DRAFTS_PATH, "POST")[0].body ?? "{}");
    expect(clone.document_yaml).toBe(DRAFT_YAML);

    // 2) the queued edit lands once the page's `openDraft` names the new
    //    draft (production: the drafts-list refetch this rerender stands for).
    rerenderWith({ openDraft: { ...openDraft, version: 1 } });
    await waitFor(() => expect(requestsTo(requests, DRAFT_PATH, "PUT")).toHaveLength(1));
    const saved = JSON.parse(requestsTo(requests, DRAFT_PATH, "PUT")[0].body ?? "{}")
      .document_yaml as string;
    expect(saved).toMatch(/label: Notes for the run/);
    await waitFor(() => expect(requestsTo(requests, VALIDATE_PATH, "POST")).toHaveLength(1));
  });
});
