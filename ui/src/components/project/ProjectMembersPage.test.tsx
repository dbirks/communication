/**
 * `/p/:projectId/members` — the page the overview's Members panel and live event
 * feed moved to (Projects Review design 1b). The tests here are the overview's
 * own members and activity tests, moved with the panels: the assertions are the
 * same because the panels are the same, only their place on the screen changed.
 */
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render";
import { FRAME_BATCH_MS } from "../../api/events";
import {
  FakeEventSource,
  claudeProfile,
  envelopeFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";
import type { Member, Project, User } from "../../api/types";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const membersPath = `${projectPath}/members`;
const usersPath = "/api/v1/users";

const member: Member = { user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" };
const directoryUser: User = {
  id: "01987a61-2345-7000-8000-abcdef012399",
  display_name: "Grace Hopper",
  email: null,
};

function memberRoutes(project: Project, extra: RouteStub[] = []): RouteStub[] {
  return [
    me,
    ...extra,
    { path: projectPath, method: "GET", body: project },
    { path: membersPath, method: "GET", body: { items: [member] } },
    { path: usersPath, method: "GET", body: { items: [directoryUser] } },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: [claudeProfile] } },
  ];
}

const mounted = (extra: RouteStub[] = [], project: Project = projectFixture) =>
  renderApp({ path: `/p/${projectId}/members`, routes: memberRoutes(project, extra) });

describe("/p/:projectId/members", () => {
  it("shows the members list with the role the server reports", async () => {
    mounted();
    const row = await screen.findByTestId("member-row-Ada Lovelace");
    expect(row.textContent).toContain("role: maintainer");
    // The tab row has no current item: this page is a section of its own, not
    // one of the six tabs.
    const nav = screen.getByRole("navigation", { name: "Project sections" });
    expect(within(nav).getByTestId("project-tab-overview").getAttribute("aria-current")).toBeNull();
  });

  it("adds a member with a role from the directory", async () => {
    const { requests } = mounted();
    await screen.findByTestId("member-row-Ada Lovelace");

    fireEvent.click(screen.getByTestId("member-add-toggle"));
    const userSelect = await screen.findByTestId("member-user");
    await waitFor(() => expect(within(userSelect).getAllByRole("option").length).toBe(2));

    fireEvent.change(userSelect, { target: { value: directoryUser.id } });
    fireEvent.change(screen.getByTestId("member-role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByTestId("member-submit"));

    await waitFor(() => {
      const [request] = requestsTo(requests, `${membersPath}/${directoryUser.id}`, "PUT");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({ role: "viewer" });
    });
  });

  it("tells a viewer they cannot change members, without hiding the list", async () => {
    mounted([], { ...projectFixture, my_role: "viewer" });
    expect((await screen.findByTestId("member-row-Ada Lovelace")).textContent).toContain(
      "role: maintainer",
    );
    expect(screen.queryByTestId("member-user")).toBeNull();
    expect(screen.getByText("Only project maintainers can change members.")).toBeTruthy();
  });

  it("says there are no members yet", async () => {
    mounted([{ path: membersPath, method: "GET", body: { items: [] } }]);
    expect((await screen.findByTestId("member-list-empty")).textContent).toContain(
      "No members yet.",
    );
  });

  it("renders an incoming SSE repository.added event and refetches members", async () => {
    const { requests } = mounted();
    await screen.findByTestId("member-row-Ada Lovelace");

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
    mounted();
    await screen.findByTestId("member-row-Ada Lovelace");

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

  it("refuses a project the caller cannot open with the overview's sentence", async () => {
    renderApp({
      path: `/p/${projectId}/members`,
      routes: [
        me,
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
      ],
    });
    expect((await screen.findByTestId("project-not-found")).textContent).toBe(
      "Project not found or you do not have access",
    );
    expect(screen.queryByTestId("member-list")).toBeNull();
  });
});
