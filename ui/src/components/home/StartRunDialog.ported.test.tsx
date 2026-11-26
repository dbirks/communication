/**
 * Starting a run from the redesigned project home, ported from
 * `components/m4/NewRunForm.test.tsx`.
 *
 * The old door was the project's Runs page (`/projects/<p>/runs?new=1`), which
 * now replace-redirects to `/p/<p>/factory` and no longer mounts the form. The
 * hand start lives here instead: the project home's `or run a workflow` chip
 * opens `StartRunDialog`, whose body is the same `NewRunForm`, and the run it
 * creates is the page the app lands on. The form's own field contract stays
 * beside the component (`NewRunForm.test.tsx`); what is asserted at the route
 * is the door and the landing.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderApp } from "../../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import type { Repository } from "../../api/types";
import {
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipelineList,
  wireProjectId,
  wireRevision,
  wireRun,
} from "../../test/fixtures/m4/wire";

// The prompt box owns a conversation create and its own project/repo chips;
// this page only hands it the extra chip, so the mock renders the chip back.
vi.mock("./HomePrompt", () => ({
  HomePrompt: ({ extraChips }: { extraChips?: ReactNode }) => (
    <div data-testid="home-prompt">{extraChips}</div>
  ),
}));
vi.mock("./SinceYouLeft", () => ({
  SinceYouLeft: () => null,
}));

const NEW_RUN_ID = "01987b30-0000-7000-8000-abcdef012345";
const RUNS_PATH = `/api/v1/projects/${wireProjectId}/runs`;

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

/** The project home's reads, plus the run form's own reads behind the chip. */
function routes(extra: RouteStub[] = []): RouteStub[] {
  const projectPath = `/api/v1/projects/${wireProjectId}`;
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: projectPath, body: projectFixture },
    { path: `${projectPath}/repos`, body: { items: repos } },
    { path: `${projectPath}/conversations`, body: { items: [] } },
    { path: `${projectPath}/assignments`, body: wireAssignmentList },
    { path: `${projectPath}/schedules`, body: { schedules: [] } },
    { path: `${projectPath}/issue-triggers`, body: { issue_triggers: [] } },
    { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
    { path: RUNS_PATH, method: "GET", body: { runs: [] } },
    {
      path: RUNS_PATH,
      method: "POST",
      status: 201,
      body: { run_id: NEW_RUN_ID, status: "queued" },
    },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    {
      path: "/api/v1/catch-up/items",
      body: { items: [], total_unseen: 0, oldest_unseen_at: null },
    },
    { path: "/api/v1/catch-up/brief", body: { headline: { state: "ready", text: "" } } },
    { path: `/api/v1/runs/${NEW_RUN_ID}`, body: wireRun },
  ];
}

describe("Start run from the project home", () => {
  it("the chip opens the run form, and the run it creates is where the app lands", async () => {
    const { requests } = renderApp({ path: `/p/${wireProjectId}`, routes: routes() });

    // The door: the project home's one hand-start, opening the form in place.
    fireEvent.click(await screen.findByTestId("home-prompt-run"));
    expect(await screen.findByTestId("home-start-run-dialog")).toBeTruthy();
    const goal = await screen.findByTestId("new-run-input-goal");
    expect(goal.tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("run-form-dialog")).toBeTruthy();

    // The form's fields still come from the pinned revision's `spec.inputs`.
    fireEvent.change(goal, { target: { value: "Document and fix add() in hello.py" } });
    fireEvent.change(screen.getByTestId("new-run-input-repository"), { target: { value: "app" } });
    fireEvent.click(screen.getByTestId("new-run-submit"));

    await waitFor(() => expect(requestsTo(requests, RUNS_PATH, "POST")).toHaveLength(1));
    expect(JSON.parse(requestsTo(requests, RUNS_PATH, "POST")[0].body ?? "{}")).toMatchObject({
      assignment_id: wireAssignmentList.assignments[0].id,
      inputs: { goal: "Document and fix add() in hello.py", repository: "app" },
    });
    // The created run is the destination: `/runs/<id>`, the workbench's read.
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/runs/${NEW_RUN_ID}`, "GET").length).toBeGreaterThan(0),
    );
    expect(screen.queryByTestId("home-prompt")).toBeNull();
  });
});
