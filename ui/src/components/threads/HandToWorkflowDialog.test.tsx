/**
 * The "Hand to a workflow" dialog against the fake fetch: the pinned
 * revision's declared `spec.inputs` are rendered as form fields (the same
 * projection the New run form uses), the summary prefills the first
 * free-text input, the create body carries `inputs`, and a 422 answers
 * inline with the problem detail — a workflow that declares REQUIRED inputs
 * no longer 422s the create (it used to seed none of them).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import HandToWorkflowDialog from "./HandToWorkflowDialog";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import type { Assignment } from "../../api/types";

const projectId = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const conversationId = "01987a70-1111-7000-8000-abcdef012345";
const pipelineId = "01987a7e-3333-7000-8000-abcdef012345";
const assignmentId = "01987a6d-5555-7000-8000-abcdef012345";
const revisionId = "01987a7e-4444-7000-8000-abcdef012345";
const postPath = `/api/v1/projects/${projectId}/runs`;

const assignment: Assignment = {
  id: assignmentId,
  project_id: projectId,
  pipeline_id: pipelineId,
  pinned_revision_id: revisionId,
  pinned_revision_digest: "1234567890abcdef1234567890abcdef12345678",
  pinned_version_label: "stable r4",
  max_concurrent_runs: 2,
  budget_overrides: {},
  effective_budgets: {},
  enabled: true,
  version: 1,
  created_at: "2026-10-14T18:00:00Z",
  updated_at: "2026-10-14T18:00:00Z",
};

/** A revision whose `spec.inputs` declares a REQUIRED goal and an optional
 * repository — the shape that used to 422 the handoff create. */
const revisionWithInputs = {
  id: revisionId,
  canonical_document: {
    spec: {
      inputs: {
        type: "object",
        properties: {
          goal: { type: "string", description: "What should the run do?" },
          repository: { type: "string" },
        },
        required: ["goal"],
      },
    },
  },
};

function routesFor(
  revisionBody: unknown,
  runPost: RouteStub = { path: postPath, body: { run_id: "run-1" }, status: 201 },
): RouteStub[] {
  return [
    { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [assignment] } },
    {
      path: "/api/v1/pipelines",
      body: { pipelines: [{ id: pipelineId, slug: "feature-development" }] },
    },
    { path: `/api/v1/projects/${projectId}/workspaces`, body: { workspaces: [] } },
    { path: `/api/v1/projects/${projectId}/artifacts`, body: { artifacts: [] } },
    {
      path: `/api/v1/projects/${projectId}/repos`,
      body: { items: [{ id: "repo-1", name: "acme-api" }] },
    },
    { path: `/api/v1/revisions/${revisionId}`, body: revisionBody },
    runPost,
  ];
}

function harness(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { requests, wrapper };
}

afterEach(cleanup);

async function renderDialog(wrapper: (props: { children: ReactNode }) => ReactNode) {
  const onStarted = vi.fn();
  render(
    <HandToWorkflowDialog
      open
      onClose={() => {}}
      conversation={{ id: conversationId, project_id: projectId, title: "Why is CI slow?" }}
      onStarted={onStarted}
    />,
    { wrapper },
  );
  await screen.findByTestId("handoff-workflow-select");
  return { onStarted };
}

describe("HandToWorkflowDialog", () => {
  it("renders one control per declared input of the pinned revision and gates the submit on the required goal", async () => {
    const { requests, wrapper } = harness(routesFor(revisionWithInputs));
    const { onStarted } = await renderDialog(wrapper);

    // goal (string) renders a textarea; repository (a string whose name
    // declares it) renders the project's repository select.
    await screen.findByTestId("handoff-inputs");
    expect(screen.getByTestId("new-run-input-goal").tagName).toBe("TEXTAREA");
    const repository = screen.getByTestId("new-run-input-repository");
    expect(repository.tagName).toBe("SELECT");
    expect(
      Array.from(repository.querySelectorAll("option")).map((option) => option.value),
    ).toContain("acme-api");

    // The required goal is empty, so the submit is refused before the request
    // leaves — the exact 422 this dialog used to ship.
    const submit = screen.getByTestId("handoff-submit");
    expect(submit.hasAttribute("disabled")).toBe(true);

    // Typing the goal clears the gate; the create carries `inputs`.
    fireEvent.change(screen.getByTestId("new-run-input-goal"), {
      target: { value: "Fix the cache key" },
    });
    await waitFor(() => expect(submit.hasAttribute("disabled")).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(requestsTo(requests, postPath, "POST")).toHaveLength(1));
    const posts = requestsTo(requests, postPath, "POST");
    const body = JSON.parse(posts[0].body ?? "{}");
    expect(body.assignment_id).toBe(assignmentId);
    expect(body.inputs).toEqual({ goal: "Fix the cache key" });
    expect(body.source.conversation_id).toBe(conversationId);
    // An empty summary is not seeded; the idempotency key travels once.
    expect("summary" in body.source).toBe(false);
    expect(typeof body.idempotency).toBe("string");
    expect(body.idempotency.startsWith("handoff-")).toBe(true);
    await waitFor(() => expect(onStarted).toHaveBeenCalledWith("run-1"));
    expect(screen.getByTestId("handoff-started")).toBeTruthy();
  });

  it("prefills the first free-text input with the summary, and says so", async () => {
    const { wrapper } = harness(routesFor(revisionWithInputs));
    await renderDialog(wrapper);
    await screen.findByTestId("handoff-inputs");

    const goal = screen.getByTestId("new-run-input-goal");
    expect((goal as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByTestId("handoff-summary"), {
      target: { value: "The cache key includes the lockfile path" },
    });
    await screen.findByTestId("handoff-input-prefill-note");
    expect((goal as HTMLTextAreaElement).value).toBe("The cache key includes the lockfile path");

    // What the person typed in the input itself is never overwritten.
    fireEvent.change(goal, { target: { value: "edited by hand" } });
    fireEvent.change(screen.getByTestId("handoff-summary"), {
      target: { value: "a longer summary" },
    });
    await waitFor(() => expect((goal as HTMLTextAreaElement).value).toBe("edited by hand"));
  });

  it("shows a 422 problem detail inline when the server still refuses", async () => {
    const { requests, wrapper } = harness(
      routesFor(revisionWithInputs, {
        path: postPath,
        status: 422,
        body: {
          type: "https://communication.dev/errors/validation",
          title: "Validation failed",
          status: 422,
          errors: [
            { instance_location: "#/inputs", code: "required", message: "goal is required" },
          ],
        },
      }),
    );
    await renderDialog(wrapper);
    await screen.findByTestId("handoff-inputs");

    fireEvent.change(screen.getByTestId("new-run-input-goal"), { target: { value: "short" } });
    fireEvent.click(screen.getByTestId("handoff-submit"));
    const problem = await screen.findByTestId("handoff-problem");
    expect(problem.textContent).toContain("Validation failed");
    expect(problem.textContent).toContain("#/inputs [required] goal is required");
    expect(requestsTo(requests, postPath, "POST")).toHaveLength(1);
    expect(screen.queryByTestId("handoff-started")).toBeNull();
  });

  it("starts without an inputs member when the revision declares no spec.inputs", async () => {
    const { requests, wrapper } = harness(
      routesFor({
        id: revisionId,
        canonical_document: { spec: {} },
      }),
    );
    await renderDialog(wrapper);

    expect(await screen.findByTestId("handoff-no-inputs")).toBeTruthy();
    expect(screen.queryByTestId("handoff-inputs")).toBeNull();
    const submit = screen.getByTestId("handoff-submit");
    expect(submit.hasAttribute("disabled")).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(requestsTo(requests, postPath, "POST")).toHaveLength(1));
    const posts = requestsTo(requests, postPath, "POST");
    const body = JSON.parse(posts[0].body ?? "{}");
    expect("inputs" in body).toBe(false);
  });
});
