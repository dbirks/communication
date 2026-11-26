/**
 * The project's Manage page (`/manage/projects/:projectId`, redesign R7).
 *
 * Two old pages emptied into this one, and their tests come with them:
 * - the ADR-0072 agent-mail switch `pages/ProjectSettings.tsx` mounted
 *   (`AgentMailPanel` is the same component, mounted unchanged);
 * - the live activity feed and the honest refusal `components/project/
 *   ProjectMembersPage.tsx` carried — `ProjectDetail` mounts `ActivityFeed`
 *   and `MembersPanel` in its ACTIVITY and PEOPLE blocks.
 *
 * So the assertions travel unchanged: agent mail is off by default, its write
 * is the project's optimistic PATCH (a stale `version` names the CAS loss,
 * never a silent overwrite), a read-only role sees the state without being able
 * to move it, and the fresh state is read back rather than assumed. The old
 * pages' tab row and full-bleed padding retired with them: Manage's own
 * sub-nav names the destinations now (`pages/Manage.test.tsx`).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectDetail from "./ProjectDetail";
import { FRAME_BATCH_MS } from "../../api/events";
import {
  FakeEventSource,
  envelopeFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";
import type { Member, Project } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
});

const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const membersPath = `${projectPath}/members`;

const member: Member = { user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" };

function renderDetail(project: Project, extra: RouteStub[] = []) {
  const { requests } = mockFetch([
    { path: "/api/v1/me", body: meFixture },
    ...extra,
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: membersPath, method: "GET", body: { items: [member] } },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/workspaces`, method: "GET", body: { workspaces: [] } },
    { path: projectPath, method: "GET", body: project },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/manage/projects/${projectId}`]}>
        <Routes>
          <Route path="/manage/projects/:itemId" element={<ProjectDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("/manage/projects/:projectId — the agent-mail setting (ADR-0072)", () => {
  it("shows the default off, PATCHes the switch with the project version, and reports the fresh state", async () => {
    const enabled: Project = { ...projectFixture, agent_mail_enabled: true, version: 2 };
    // The project route answers GETs; make the refetch after the PATCH return
    // the patched project, as the server would (the stub body function counts
    // this route's requests, 1-based).
    const { requests } = renderDetail(projectFixture, [
      { path: projectPath, method: "PATCH", body: enabled },
      { path: projectPath, method: "GET", body: (n: number) => (n > 1 ? enabled : projectFixture) },
    ]);
    const panel = await screen.findByTestId("agent-mail-panel");
    expect(within(panel).getByTestId("agent-mail-state").textContent).toContain("off");
    const toggle = within(panel).getByTestId("agent-mail-toggle") as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(
      () =>
        expect(screen.getByTestId("agent-mail-state").textContent).toContain(
          "on — threads in this project may ask",
        ),
      { timeout: 2000 },
    );
    const calls = requestsTo(requests, projectPath, "PATCH");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].body))).toEqual({ agent_mail_enabled: true, version: 1 });
  });

  it("a read-only role sees the state but cannot move it", async () => {
    renderDetail({ ...projectFixture, my_role: "viewer", agent_mail_enabled: true });
    const panel = await screen.findByTestId("agent-mail-panel");
    expect((within(panel).getByTestId("agent-mail-toggle") as HTMLInputElement).disabled).toBe(
      true,
    );
    expect(within(panel).getByTestId("agent-mail-locked").textContent).toContain("maintainer");
    expect(within(panel).getByTestId("agent-mail-state").textContent).toContain("on");
  });

  it("a lost CAS race says so instead of pretending the write landed", async () => {
    renderDetail(projectFixture, [{ path: projectPath, method: "PATCH", status: 409 }]);
    fireEvent.click(await screen.findByTestId("agent-mail-toggle"));
    const error = await screen.findByTestId("agent-mail-error");
    expect(error.textContent).toContain("beneath you");
  });
});

describe("/manage/projects/:projectId — the feed and the members list the members page carried", () => {
  it("renders an incoming SSE repository.added event and refetches members", async () => {
    const { requests } = renderDetail(projectFixture);
    await screen.findByTestId("detail-name");

    const status = screen.getByTestId("activity-status");
    expect(status.textContent).toBe("reconnecting");

    const source = FakeEventSource.last();
    expect(source.url).toBe(`/api/v1/projects/${projectId}/events`);
    const before = requestsTo(requests, membersPath, "GET").length;

    act(() => {
      source.emit(
        envelopeFixture({
          payload: { name: "communication", git_url: "https://example.com/c.git" },
        }),
      );
    });

    const item = await screen.findByTestId("activity-item");
    expect(item.textContent).toContain("repository.added");
    expect(item.textContent).toContain("repository communication");
    // The actor is written as a person's name, never a raw kind + uuid
    // (`ui/src/api/actors.ts`).
    expect(within(item).getByTestId("activity-actor").textContent).toBe("Ada Lovelace");
    // A change made through another replica must show up without a reload, once
    // the feed's coalescing window closes (`FRAME_BATCH_MS` in `api/events.ts`).
    await waitFor(
      () => expect(requestsTo(requests, membersPath, "GET").length).toBeGreaterThan(before),
      { timeout: FRAME_BATCH_MS + 1_000 },
    );
    expect(screen.getByTestId("activity-status").textContent).toBe("live");
  });

  it("keeps the newest event first and does not duplicate a replayed event", async () => {
    renderDetail(projectFixture);
    await screen.findByTestId("detail-name");

    const source = FakeEventSource.last();
    act(() => {
      source.emit(
        envelopeFixture({ global_seq: 10, type: "project.created", payload: { slug: "widgets" } }),
      );
    });
    const list = await screen.findByTestId("activity-list");
    expect(within(list).getAllByTestId("activity-item")).toHaveLength(1);

    act(() => {
      source.emit(
        envelopeFixture({
          global_seq: 11,
          type: "project.member.updated",
          payload: { role: "contributor" },
        }),
      );
      // Replayed at the same sequence: ignored.
      source.emit(
        envelopeFixture({
          global_seq: 11,
          type: "project.member.updated",
          payload: { role: "viewer" },
        }),
      );
    });

    const items = within(list).getAllByTestId("activity-item");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("project.member.updated");
    expect(items[1].textContent).toContain("project.created");
  });

  it("refuses a project the caller cannot open with the same sentence", async () => {
    renderDetail(projectFixture, [
      {
        path: projectPath,
        status: 404,
        body: {
          type: "https://communication.dev/errors/not-found",
          title: "Not found",
          status: 404,
          detail: "No such project.",
        },
      },
    ]);
    expect((await screen.findByTestId("detail-not-found")).textContent).toContain(
      "Project not found or you do not have access",
    );
    expect(screen.queryByTestId("member-list")).toBeNull();
  });
});
