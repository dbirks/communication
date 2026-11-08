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
});
