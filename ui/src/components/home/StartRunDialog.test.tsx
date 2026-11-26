/**
 * The briefing's empty-state `Start run` dialog (finding 03): the run form
 * opens IN PLACE — `NewRunForm` inside the dialog chrome — with the caller's
 * only project preselected, and Esc / `Cancel` close it. The page keeps the
 * dialog up; these tests assert the dialog asks its owner to close.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { StartRunDialog } from "./StartRunDialog";
import { mockFetch, projectFixture, type RouteStub } from "../../test/fakes";
import {
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipelineList,
  wireProjectId,
  wireRevision,
} from "../../test/fixtures/m4/wire";
import type { ProjectList } from "../../api/types";

const projectList: ProjectList = { items: [projectFixture] };

/** The routes the dialog and the run form read: the project list, then the
 * form's own assignment/pipeline/repo/revision reads. */
function runFormRoutes(extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/projects", body: projectList },
    { path: `/api/v1/projects/${wireProjectId}/assignments`, body: wireAssignmentList },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/projects/${wireProjectId}/repos`, body: { items: [] } },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    ...extra,
  ];
}

function harness(routes: RouteStub[]) {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 }, mutations: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(cleanup);

describe("StartRunDialog", () => {
  it("opens the run form in place with the only project preselected", async () => {
    render(<StartRunDialog onClose={() => {}} />, { wrapper: harness(runFormRoutes()) });

    expect(screen.getByTestId("run-form-dialog")).toBeTruthy();
    const select = (await screen.findByTestId("home-start-run-project")) as HTMLSelectElement;
    expect(select.value).toBe(projectFixture.id);

    // The revision's `spec.inputs` drives the fields — the same free-form
    // body the Runs tab mounts, not a stub of it.
    expect(await screen.findByTestId("new-run-form")).toBeTruthy();
    expect(await screen.findByTestId("new-run-input-goal")).toBeTruthy();
    // Nothing in the dialog navigates to Board/Inbox/Projects (finding 03).
    expect(
      screen
        .queryAllByRole("link")
        .some((link) =>
          ["/board", "/inbox", "/projects"].includes(link.getAttribute("href") ?? ""),
        ),
    ).toBe(false);
  });

  it("Esc and Cancel ask the owner to close", async () => {
    const onClose = vi.fn();
    render(<StartRunDialog onClose={onClose} />, { wrapper: harness(runFormRoutes()) });
    await screen.findByTestId("new-run-form");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("new-run-cancel"));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(2));
  });

  it("keeps the chosen workflow across typed and freeform revisions and gives the wrapper fixed dimensions", async () => {
    const TYPED_REV_ID = "01987b21-1111-7000-8000-abcdef012345";
    const FREEFORM_REV_ID = "01987b21-2222-7000-8000-abcdef012345";
    const TYPED_ASSIGN_ID = "01987b22-1111-7000-8000-abcdef012345";
    const FREEFORM_ASSIGN_ID = "01987b22-2222-7000-8000-abcdef012345";

    const routes: RouteStub[] = [
      { path: "/api/v1/projects", body: projectList },
      {
        path: `/api/v1/projects/${wireProjectId}/assignments`,
        body: {
          assignments: [
            {
              ...wireAssignmentList.assignments[0],
              id: TYPED_ASSIGN_ID,
              pipeline_id: wirePipelineList.pipelines[0].id,
              pinned_revision_id: TYPED_REV_ID,
            },
            {
              ...wireAssignmentList.assignments[0],
              id: FREEFORM_ASSIGN_ID,
              pipeline_id: wirePipelineList.pipelines[1].id,
              pinned_revision_id: FREEFORM_REV_ID,
            },
          ],
        },
      },
      { path: "/api/v1/pipelines", body: wirePipelineList },
      { path: `/api/v1/projects/${wireProjectId}/repos`, body: { items: [] } },
      {
        path: `/api/v1/revisions/${TYPED_REV_ID}`,
        body: {
          ...wireRevision,
          id: TYPED_REV_ID,
          input_specs: [{ name: "topic", type: "text", label: "Topic", required: true }],
          canonical_document: {
            kind: "Pipeline",
            spec: {
              inputs: { type: "object", properties: { topic: { type: "string" } } },
              nodes: [{ id: "step1", kind: "agent.acp" }],
            },
          },
        },
      },
      {
        path: `/api/v1/revisions/${FREEFORM_REV_ID}`,
        body: {
          ...wireRevision,
          id: FREEFORM_REV_ID,
          canonical_document: {
            kind: "Pipeline",
            spec: {
              inputs: { type: "object", properties: { notes: { type: "string" } } },
              nodes: [{ id: "step1", kind: "agent.acp" }],
            },
          },
        },
      },
    ];

    render(<StartRunDialog onClose={() => {}} />, { wrapper: harness(routes) });
    const wrapper = screen.getByTestId("home-start-run-dialog");
    expect(wrapper.className).toContain("fixed");
    expect(wrapper.className).toContain("inset-0");

    // Starts on the typed workflow (first assignment).
    const typedSelect = (await screen.findByTestId(
      "new-run-assignment",
      {},
      { timeout: 400 },
    )) as HTMLSelectElement;
    expect(typedSelect.value).toBe(TYPED_ASSIGN_ID);
    expect(await screen.findByTestId("new-run-input-topic", {}, { timeout: 400 })).toBeTruthy();

    // Switch to the freeform workflow: selection stays on FREEFORM_ASSIGN_ID and does not reset!
    fireEvent.change(typedSelect, { target: { value: FREEFORM_ASSIGN_ID } });
    expect(await screen.findByTestId("new-run-input-notes", {}, { timeout: 400 })).toBeTruthy();
    const freeformSelect = screen.getByTestId("new-run-assignment") as HTMLSelectElement;
    expect(freeformSelect.value).toBe(FREEFORM_ASSIGN_ID);

    // Switch back to typed: selection stays on TYPED_ASSIGN_ID.
    fireEvent.change(freeformSelect, { target: { value: TYPED_ASSIGN_ID } });
    expect(await screen.findByTestId("new-run-input-topic", {}, { timeout: 400 })).toBeTruthy();
    expect((screen.getByTestId("new-run-assignment") as HTMLSelectElement).value).toBe(
      TYPED_ASSIGN_ID,
    );
  });
});
