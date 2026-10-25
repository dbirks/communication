/**
 * The 2c dialog on its own: the mono context line (the project and the
 * repository come from where it opened, so there is nothing to pick), the
 * `START IT WHEN` segmented control, the label chips, the cron field with its
 * English reading, the `THE RUN GETS` mapping, and the two refusals the server
 * answers inline (`422 invalid_cron`, a stale-version `409`).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TriggerDialog,
  issueValueInWords,
  numericIssueBinding,
  runGetsValue,
  type TriggerEditing,
} from "./TriggerDialog";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type { RunInputField } from "../m4/NewRunForm";
import type { Assignment, Repository } from "../../api/types";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wireRevision,
} from "../../test/fixtures/m4/wire";

const repository: Repository = {
  id: "01987b22-0002-7000-8000-abcdef012345",
  project_id: projectFixture.id,
  name: "storefront",
  git_url: "https://github.com/northwind/storefront.git",
  default_branch: "main",
  created_at: "2026-07-30T09:00:00Z",
  credential: "none",
};

const assignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: repository.id,
  repository_name: repository.name,
};

const ISSUE_TRIGGER_ID = "01987b24-0009-7000-8000-abcdef012345";

function wireIssueTrigger(overrides: Partial<IssueTrigger> = {}): IssueTrigger {
  return {
    id: ISSUE_TRIGGER_ID,
    project_id: projectFixture.id,
    assignment_id: WIRE_ASSIGNMENT_ID,
    repository_id: repository.id,
    event: "opened",
    labels: [],
    inputs: { goal: "{{issue.title}}\n\n{{issue.body}}", repository: "storefront" },
    enabled: true,
    cursor_at: null,
    last_polled_at: null,
    last_error: "",
    version: 5,
    created_by: meFixture.id,
    created_at: "2026-10-19T09:00:00Z",
    updated_at: "2026-10-20T09:00:00Z",
    my_role: "maintainer",
    ...overrides,
  };
}

/** The fixture's pinned revision with one more declared input: the shipped
 * `issue-to-pr` template's integer `issue_number` (type integer, default 0) is
 * what the typed-binding tests need the form to render. */
function revisionDeclaring(name: string, schema: Record<string, unknown>): unknown {
  const doc = wireRevision.canonical_document as {
    spec: { inputs: { properties: Record<string, unknown>; required?: string[] } };
  };
  return {
    ...wireRevision,
    canonical_document: {
      ...doc,
      spec: {
        ...doc.spec,
        inputs: {
          ...doc.spec.inputs,
          properties: { ...doc.spec.inputs.properties, [name]: schema },
        },
      },
    },
  };
}

function mount(
  editing: TriggerEditing | null = null,
  overrides: RouteStub[] = [],
  revision: unknown = wireRevision,
) {
  const { requests } = mockFetch([
    ...overrides,
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, method: "GET", body: revision as object },
    {
      path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
      method: "GET",
      body: { issue_triggers: [] },
    },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TriggerDialog
          open
          onClose={onClose}
          workflowLabel="plan-with-approval"
          project={{ id: projectFixture.id, name: projectFixture.name }}
          repository={repository}
          assignment={assignment}
          editing={editing}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, onClose };
}

afterEach(cleanup);

describe("TriggerDialog — the 2c contract", () => {
  it("names the workflow, project and repository in mono, with nothing to pick", async () => {
    mount();
    const context = await screen.findByTestId("trigger-dialog-context");
    expect(context.textContent).toBe("plan-with-approval · Widgets / storefront");
    expect(screen.getByTestId("trigger-dialog").textContent).toContain("Add a trigger");
    // No assignment/repository selectors: the dialog inherits both.
    expect(screen.queryByTestId("trigger-add-issue-assignment")).toBeNull();
    expect(screen.queryByTestId("trigger-add-issue-repository")).toBeNull();
    // The opening default is the GitHub segment; the footnote is the poll's.
    expect(screen.getByTestId("trigger-dialog-mode-issue").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByTestId("trigger-dialog-note").textContent).toBe("Checked every minute");
    expect(screen.getByTestId("trigger-dialog").textContent).not.toContain(
      "public GitHub repositories only",
    );
  });

  it("holds the segments to their content and weights only the chosen one", async () => {
    mount();
    const group = await screen.findByTestId("trigger-dialog-mode");
    // The control hugs its content (artboard: `width: max-content`), it does
    // not stretch across the dialog.
    expect(group.className).toContain("w-max");
    const issue = screen.getByTestId("trigger-dialog-mode-issue");
    const schedule = screen.getByTestId("trigger-dialog-mode-schedule");
    expect(issue.className).toContain("font-semibold");
    expect(issue.className).toContain("bg-ink");
    expect(schedule.className).toContain("font-normal");
    expect(schedule.className).not.toContain("bg-ink");

    fireEvent.click(schedule);
    expect(schedule.className).toContain("font-semibold");
    expect(issue.className).toContain("font-normal");
  });

  it("shows the fixed repository in THE RUN GETS, never as a select", async () => {
    mount();
    const line = await screen.findByTestId("trigger-dialog-run-gets-repository");
    // The value is the repository the dialog was opened from: mono key, sans
    // value, no quotes around a name that is not free text.
    expect(line.textContent).toBe("repository = storefront");
    // `repository` is not something this dialog can change.
    expect(screen.queryByTestId("new-run-input-repository")).toBeNull();
    // The other declared inputs stay editable.
    expect(screen.getByTestId("new-run-input-goal")).toBeTruthy();
  });

  it("keeps the label chips inside the label field", async () => {
    mount();
    const field = await screen.findByTestId("trigger-dialog-labels-row");
    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "plan" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    const chip = screen.getByTestId("trigger-dialog-label-chip-0");
    // `plan ×` sits inside the bordered input the design draws, not below it.
    expect(field.contains(chip)).toBe(true);
    expect(chip.textContent).toContain("plan");
    // The typing field stays in the same box, ready for the next label.
    expect(field.contains(screen.getByTestId("trigger-dialog-labels"))).toBe(true);
  });

  it("switches the segment to the schedule and reads the cron as it is typed", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("trigger-dialog-mode-schedule"));
    expect(screen.getByTestId("trigger-dialog-mode-schedule").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByTestId("trigger-dialog-labels")).toBeNull();
    expect(screen.getByTestId("trigger-dialog-submit").textContent).toBe("Add schedule");
    fireEvent.change(screen.getByTestId("trigger-dialog-cron"), { target: { value: "* * * * *" } });
    expect(screen.getByTestId("trigger-dialog-cron-words").textContent).toBe("every minute");
  });

  it("posts a labeled trigger with the chips it was given", async () => {
    const { requests } = mount(null, [
      {
        path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
        method: "POST",
        body: wireIssueTrigger({ event: "labeled", labels: ["plan", "now"] }),
      },
    ]);

    expect(await screen.findByTestId("trigger-dialog-event")).toBeTruthy();
    fireEvent.change(screen.getByTestId("trigger-dialog-event"), { target: { value: "labeled" } });
    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "plan" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "now" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    expect(screen.getAllByTestId(/trigger-dialog-label-chip-/)).toHaveLength(2);
    // Drop one chip: the set the server gets is what is left on screen.
    fireEvent.click(screen.getByTestId("trigger-dialog-label-remove-0"));
    expect(screen.getByTestId("trigger-dialog-label-chip-0").textContent).toContain("now");

    // The declared inputs arrive with the pinned revision; the quickfill is
    // only offered once its field is on screen.
    fireEvent.click(await screen.findByTestId("trigger-dialog-quickfill-goal"));
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST")[0].body!,
    );
    expect(body.event).toBe("labeled");
    expect(body.labels).toEqual(["now"]);
    expect(body.assignment_id).toBe(WIRE_ASSIGNMENT_ID);
    expect(body.repository_id).toBe(repository.id);
    expect(body.inputs.goal).toBe("{{issue.title}}\n\n{{issue.body}}");
  });

  it("edits a trigger in the same dialog and keeps its version for the PATCH", async () => {
    const { requests } = mount({ kind: "issue", trigger: wireIssueTrigger({ labels: ["plan"] }) }, [
      {
        path: `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`,
        method: "PATCH",
        body: wireIssueTrigger({ labels: ["plan", "urgent"], version: 6 }),
      },
    ]);

    expect(await screen.findByTestId("trigger-dialog-context")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit trigger" })).toBeTruthy();
    // The declared inputs (and the mapping box) arrive with the revision read.
    const mapping = await screen.findByTestId("trigger-dialog-run-gets-goal");
    // The edited trigger's own labels and goal are on screen, not blanks.
    expect(screen.getByTestId("trigger-dialog-label-chip-0").textContent).toContain("plan");
    expect(mapping.textContent).toBe("goal = the issue title and the issue body");

    fireEvent.change(screen.getByTestId("trigger-dialog-labels"), { target: { value: "urgent" } });
    fireEvent.keyDown(screen.getByTestId("trigger-dialog-labels"), { key: "Enter" });
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH"),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        requestsTo(requests, `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`, "PATCH")[0].body!,
      ),
    ).toMatchObject({ version: 5, labels: ["plan", "urgent"], enabled: true });
  });

  it("binds an integer input to the issue the fire fills", async () => {
    const { requests } = mount(
      null,
      [
        {
          path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
          method: "POST",
          body: wireIssueTrigger({
            inputs: {
              goal: "{{issue.title}}\n\n{{issue.body}}",
              issue_number: "{{issue.number}}",
              repository: "storefront",
            },
          }),
        },
      ],
      revisionDeclaring("issue_number", { type: "integer", minimum: 0, default: 0 }),
    );

    // The number control cannot type a placeholder, so the issue arm offers the
    // binding ADR-0056's amendment renders as a JSON number.
    fireEvent.click(await screen.findByTestId("trigger-dialog-quickfill-issue_number"));
    expect(screen.getByTestId("trigger-dialog-numeric-binding-issue_number").textContent).toBe(
      "the run gets the issue number — type a number to fix it instead",
    );
    expect(screen.getByTestId("trigger-dialog-run-gets-issue_number").textContent).toBe(
      "issue_number = the issue number",
    );

    fireEvent.click(screen.getByTestId("trigger-dialog-quickfill-goal"));
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST")[0].body!,
    );
    // The row carries the token; the fire is what renders it typed.
    expect(body.inputs.issue_number).toBe("{{issue.number}}");
  });

  it("advertises no binding for the fixed number the schema declared", async () => {
    mount(null, [], revisionDeclaring("issue_number", { type: "integer", minimum: 0, default: 0 }));
    await screen.findByTestId("trigger-dialog-quickfill-issue_number");
    // The declared default (0) is a fixed number, not a fire-time binding.
    expect(screen.queryByTestId("trigger-dialog-numeric-binding-issue_number")).toBeNull();
    expect(screen.getByTestId("trigger-dialog-run-gets-issue_number").textContent).toBe(
      "issue_number = 0",
    );
  });

  it("keeps a stale-version 409 inline and the dialog open", async () => {
    mount({ kind: "issue", trigger: wireIssueTrigger({ labels: ["plan"] }) }, [
      {
        path: `/api/v1/issue-triggers/${ISSUE_TRIGGER_ID}`,
        method: "PATCH",
        status: 409,
        body: {
          type: "https://communication.dev/errors/issue_trigger_version_stale",
          title: "Issue trigger version stale",
          status: 409,
          detail: "someone else changed it",
        },
      },
    ]);

    // The submit stays disabled until the pinned revision's inputs have read
    // in, so wait for the mapping box before spending the click.
    await screen.findByTestId("trigger-dialog-run-gets-goal");
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));
    const error = await screen.findByTestId("trigger-dialog-error");
    expect(error.textContent).toContain("Issue trigger version stale");
    expect(screen.getByTestId("trigger-dialog")).toBeTruthy();
  });

  it("closes on Escape and hands focus back to the opener", async () => {
    const { onClose } = mount();
    await screen.findByTestId("trigger-dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("TriggerDialog — the run-input reading", () => {
  const field = (kind: RunInputField["kind"]): RunInputField => ({
    name: "goal",
    kind,
    required: false,
  });

  it("reads a placeholder-only value in words", () => {
    expect(issueValueInWords("{{issue.title}}\n\n{{issue.body}}")).toBe(
      "the issue title and the issue body",
    );
    expect(issueValueInWords("{{issue.number}}")).toBe("the issue number");
    // Prose around a token stays prose: the box never paraphrases a human.
    expect(issueValueInWords("Goal: {{issue.title}}")).toBeNull();
    expect(issueValueInWords("ship it")).toBeNull();
  });

  it("reads a numeric binding only as the exact token the server renders typed", () => {
    expect(numericIssueBinding("{{issue.number}}")).toBe(
      "the run gets the issue number — type a number to fix it instead",
    );
    // Mixed text renders a string the integer input refuses, and a string token
    // is no more a number binding: the dialog advertises only what fires.
    expect(numericIssueBinding("#{{issue.number}}")).toBeNull();
    expect(numericIssueBinding("{{issue.title}}")).toBeNull();
    expect(numericIssueBinding(42)).toBeNull();
    expect(numericIssueBinding(undefined)).toBeNull();
  });

  it("renders each declared input the way the trigger carries it", () => {
    expect(runGetsValue(field("text"), "{{issue.title}}\n\n{{issue.body}}")).toBe(
      "the issue title and the issue body",
    );
    expect(runGetsValue(field("text"), "ship it")).toBe("“ship it”");
    expect(runGetsValue(field("text"), "")).toBe("—");
    expect(runGetsValue(field("boolean"), true)).toBe("yes");
    expect(runGetsValue(field("boolean"), undefined)).toBe("no");
    expect(runGetsValue(field("text"), "x".repeat(60))).toBe(`“${"x".repeat(48)}…”`);
    // A repository is not free text and not a choice here: it is named plain.
    expect(runGetsValue(field("repository"), "storefront")).toBe("storefront");
  });

  it("keeps the pipeline identity out of the body it posts", async () => {
    // The dialog posts the ASSIGNMENT id; the pinned revision is the
    // assignment's own business, never a field the caller can get wrong.
    expect(assignment.pipeline_id).toBe(WIRE_PIPELINE_ID);
    const { requests } = mount(null, [
      {
        path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
        method: "POST",
        body: wireIssueTrigger(),
      },
    ]);
    await screen.findByTestId("trigger-dialog-quickfill-goal");
    fireEvent.click(screen.getByTestId("trigger-dialog-quickfill-goal"));
    fireEvent.click(screen.getByTestId("trigger-dialog-submit"));

    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/projects/${projectFixture.id}/issue-triggers`, "POST")[0].body!,
    );
    expect(Object.keys(body).sort()).toEqual([
      "assignment_id",
      "enabled",
      "event",
      "inputs",
      "labels",
      "repository_id",
    ]);
  });
});
