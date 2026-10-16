/**
 * The run-input form is *derived*: these tests assert the fields follow the
 * pinned revision's `spec.inputs` — swap the fixture's schema and the rendered
 * controls swap with it — and that submitting honours idempotency (one POST,
 * one key) and the run route on success.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import { renderApp } from "../../test/render";
import {
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
  wireRunList,
} from "../../test/fixtures/m4/wire";
import type { Repository } from "../../api/types";

const ASSIGNMENTS_PATH = `/api/v1/projects/${wireProjectId}/assignments`;
const REPOS_PATH = `/api/v1/projects/${wireProjectId}/repos`;
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;
const REVISION_PATH = `/api/v1/revisions/${WIRE_REVISION_ID}`;
const NEW_RUN_ID = "01987b30-0000-7000-8000-abcdef012345";

/** The project's two repos (`§ 7.2 W1`): the repository select lists these. */
const repos: Repository[] = [
  {
    id: "01987b40-0000-7000-8000-abcdef012345",
    project_id: wireProjectId,
    name: "app",
    git_url: "https://github.com/example/app.git",
    default_branch: "main",
    created_at: "2026-07-29T18:00:00Z",
  },
  {
    id: "01987b40-0001-7000-8000-abcdef012345",
    project_id: wireProjectId,
    name: "docs",
    git_url: "https://github.com/example/docs.git",
    default_branch: "main",
    created_at: "2026-07-29T18:00:00Z",
  },
];

function createResponse(status = 201, body: unknown = { run_id: NEW_RUN_ID, status: "queued" }) {
  return { path: RUNS_PATH, method: "POST", status, body } satisfies RouteStub;
}

/** Open the New run panel on the project's runs page. */
async function openForm(routes: RouteStub[] = []) {
  const mounted = renderApp({
    path: `/projects/${wireProjectId}/runs`,
    routes: [
      ...routes,
      { path: "/api/v1/me", body: meFixture },
      { path: `/api/v1/projects/${wireProjectId}`, body: projectFixture },
      { path: "/api/v1/pipelines", body: wirePipelineList },
      { path: RUNS_PATH, method: "GET", body: wireRunList },
      { path: ASSIGNMENTS_PATH, body: wireAssignmentList },
      { path: REPOS_PATH, body: { items: repos } },
      { path: REVISION_PATH, body: wireRevision },
      { path: `/api/v1/runs/${NEW_RUN_ID}`, body: wireRun },
      createResponse(),
    ],
  });
  fireEvent.click(await screen.findByTestId("runs-new"));
  await screen.findByTestId("new-run-form");
  return mounted;
}

/** Fill the two required inputs of the sample revision. */
async function fillRequired() {
  fireEvent.change(await screen.findByTestId("new-run-input-goal"), {
    target: { value: "Document and fix add() in hello.py" },
  });
  fireEvent.change(await screen.findByTestId("new-run-input-repository"), {
    target: { value: "app" },
  });
}

/** The label a field renders — `*` marks what `spec.inputs.required` names. */
function labelTextOf(controlTestId: string): string {
  const id = controlTestId.replace(/^new-run-input-/, "");
  const label = document.querySelector(`label[for="new-run-input-${id}"]`);
  return label?.textContent ?? "";
}

describe("NewRunForm — fields come from spec.inputs", () => {
  it("renders the assignment's pipeline and one control per declared input", async () => {
    await openForm();

    // The run is created against an assignment, which names the pinned revision.
    expect(screen.getByTestId("new-run-assignment").textContent).toContain("feature-development");

    // `goal: {type: string, minLength: 1}` — a textarea, required.
    const goal = await screen.findByTestId("new-run-input-goal");
    expect(goal.tagName).toBe("TEXTAREA");
    expect(labelTextOf("new-run-input-goal")).toBe("goal *");

    // `repository: {type: string}` — a select of the project's repositories.
    const repository = screen.getByTestId("new-run-input-repository");
    expect(repository.tagName).toBe("SELECT");
    expect(within(repository).getByRole("option", { name: "app" })).toBeTruthy();
    expect(within(repository).getByRole("option", { name: "docs" })).toBeTruthy();

    // `acceptance_criteria` is optional and arrives carrying its declared default.
    const criteria = screen.getByTestId("new-run-input-acceptance_criteria");
    expect(criteria.tagName).toBe("TEXTAREA");
    expect((criteria as HTMLTextAreaElement).value).toBe(
      "Tests pass, the plan is followed, and the reviewer approves.",
    );
    expect(labelTextOf("new-run-input-acceptance_criteria")).toBe("acceptance_criteria");
  });

  it("changes the fields when the revision's spec.inputs changes", async () => {
    const other = structuredClone(wireRevision.canonical_document) as {
      spec: { inputs: Record<string, unknown> };
    };
    other.spec.inputs = {
      type: "object",
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["fast", "thorough"], default: "fast" },
        iterations: { type: "integer", minimum: 1, maximum: 5 },
        dry_run: { type: "boolean", description: "Do not publish anything." },
      },
    };
    await openForm([{ path: REVISION_PATH, body: { ...wireRevision, canonical_document: other } }]);

    expect(await screen.findByTestId("new-run-input-mode")).toBeTruthy();
    expect(screen.queryByTestId("new-run-input-goal")).toBeNull();
    expect(screen.queryByTestId("new-run-input-repository")).toBeNull();
    expect(screen.getByTestId("new-run-input-mode").tagName).toBe("SELECT");
    expect(within(screen.getByTestId("new-run-input-mode")).getByText("thorough")).toBeTruthy();
    expect(screen.getByTestId("new-run-input-iterations").tagName).toBe("INPUT");
    expect(screen.getByTestId("new-run-input-dry_run").tagName).toBe("INPUT");
    expect(screen.getByTestId("new-run-input-dry_run-hint").textContent).toContain(
      "Do not publish anything.",
    );
  });

  it("names an input it cannot render instead of faking a control", async () => {
    const other = structuredClone(wireRevision.canonical_document) as {
      spec: { inputs: Record<string, unknown> };
    };
    other.spec.inputs = {
      type: "object",
      required: ["matrix"],
      properties: { matrix: { type: "array", items: { type: "string" } } },
    };
    await openForm([{ path: REVISION_PATH, body: { ...wireRevision, canonical_document: other } }]);

    expect((await screen.findByTestId("new-run-input-matrix-unsupported")).textContent).toContain(
      "array",
    );
  });
});

describe("NewRunForm — submit is one run", () => {
  it("blocks submit while a required input is empty", async () => {
    const { requests } = await openForm();
    const submit = screen.getByTestId("new-run-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(await screen.findByTestId("new-run-input-goal"), {
      target: { value: "fix add()" },
    });
    // `repository` is still empty — the schema says it is required.
    expect((screen.getByTestId("new-run-submit") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("new-run-submit"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestsTo(requests, RUNS_PATH, "POST")).toHaveLength(0);
  });

  it("sends one POST with one idempotency key for two rapid clicks", async () => {
    const { requests } = await openForm();
    await fillRequired();
    expect((screen.getByTestId("new-run-submit") as HTMLButtonElement).disabled).toBe(false);

    const submit = screen.getByTestId("new-run-submit");
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(requestsTo(requests, RUNS_PATH, "POST")).toHaveLength(1));
    fireEvent.click(submit);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const [post] = requestsTo(requests, RUNS_PATH, "POST");
    const key = post.headers.get("idempotency-key");
    expect(key).toMatch(/^newrun-/);
    expect(JSON.parse(post.body ?? "{}")).toMatchObject({
      assignment_id: wireAssignmentList.assignments[0].id,
      inputs: {
        goal: "Document and fix add() in hello.py",
        repository: "app",
        acceptance_criteria: "Tests pass, the plan is followed, and the reviewer approves.",
      },
      idempotency: key,
    });
  });

  it("navigates to the created run", async () => {
    const { requests } = await openForm();
    await fillRequired();
    fireEvent.click(screen.getByTestId("new-run-submit"));

    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/runs/${NEW_RUN_ID}`, "GET").length).toBeGreaterThan(0),
    );
  });

  it("shows the control plane's problem verbatim when the ceiling refuses the run", async () => {
    const { requests } = await openForm([
      createResponse(409, {
        type: "https://communication.dev/errors/max_concurrent_runs",
        title: "Conflict",
        status: 409,
        detail: "assignment 01987b22 already has 1 of 1 allowed runs in flight",
      }),
    ]);
    await fillRequired();
    fireEvent.click(screen.getByTestId("new-run-submit"));

    const error = await screen.findByTestId("new-run-error");
    expect(error.textContent).toContain(
      "assignment 01987b22 already has 1 of 1 allowed runs in flight",
    );
    // Retrying re-uses the same key, so it cannot mint a second run.
    const key = screen.getByTestId("new-run-idempotency-key").textContent;
    fireEvent.click(screen.getByTestId("new-run-submit"));
    await waitFor(() => expect(requestsTo(requests, RUNS_PATH, "POST")).toHaveLength(2));
    const [first, second] = requestsTo(requests, RUNS_PATH, "POST");
    expect(second.headers.get("idempotency-key")).toBe(first.headers.get("idempotency-key"));
    expect(second.headers.get("idempotency-key")).toMatch(/^newrun-/);
    expect(screen.getByTestId("new-run-idempotency-key").textContent).toBe(key);
  });
});
