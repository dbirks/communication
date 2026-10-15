import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import {
  FakeEventSource,
  envelopeFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { Member, Project, Repository, User } from "../api/types";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const reposPath = `${projectPath}/repos`;
const membersPath = `${projectPath}/members`;

const repository: Repository = {
  id: "01987a6f-7a8b-7c9d-a0e1-f2b3c4d5e6f0",
  project_id: projectId,
  name: "communication",
  git_url: "https://github.com/example/communication.git",
  default_branch: "main",
  created_at: "2026-10-14T18:00:00Z",
};

const member: Member = { user_id: meFixture.id, display_name: "Ada Lovelace", role: "maintainer" };
const directoryUser: User = {
  id: "01987a61-2345-7000-8000-abcdef012399",
  display_name: "Grace Hopper",
  email: null,
};

function projectRoutes(project: Project, extra: RouteStub[] = []): RouteStub[] {
  // `extra` is searched first, so a POST stub can shadow the GET one.
  return [
    me,
    ...extra,
    { path: projectPath, method: "GET", body: project },
    { path: reposPath, method: "GET", body: { items: [repository] } },
    { path: membersPath, method: "GET", body: { items: [member] } },
    { path: "/api/v1/users", method: "GET", body: { items: [directoryUser] } },
  ];
}

describe("/projects/:projectId", () => {
  it("shows the project name, repositories and members", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });

    expect((await screen.findByTestId("project-name")).textContent).toBe("Widgets");

    const repoRow = await screen.findByTestId("repo-row-communication");
    expect(repoRow.textContent).toContain("communication");
    expect(repoRow.textContent).toContain("https://github.com/example/communication.git");
    expect(repoRow.textContent).toContain("main");

    const memberRow = await screen.findByTestId("member-row-Ada Lovelace");
    expect(memberRow.textContent).toContain("role: maintainer");
  });

  it("hides the add-repository form for a viewer", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes({ ...projectFixture, my_role: "viewer" }),
    });

    await screen.findByTestId("repo-row-communication");
    expect(screen.queryByTestId("repo-name")).toBeNull();
    expect(screen.queryByTestId("repo-submit")).toBeNull();
    expect(screen.queryByTestId("member-user")).toBeNull();
    expect(screen.getByText("Only project maintainers can add repositories.")).toBeTruthy();
    // The read-only data is still shown.
    expect((await screen.findByTestId("member-row-Ada Lovelace")).textContent).toContain(
      "role: maintainer",
    );
  });

  it("shows the add-repository form for a maintainer and posts it", async () => {
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes(projectFixture, [
        { path: reposPath, method: "POST", status: 201, body: { ...repository, name: "web" } },
      ]),
    });

    fireEvent.change(await screen.findByTestId("repo-name"), { target: { value: "web" } });
    fireEvent.change(screen.getByTestId("repo-git-url"), {
      target: { value: "https://github.com/example/web.git" },
    });
    expect(screen.getByTestId("repo-default-branch").getAttribute("placeholder")).toBe("main");
    fireEvent.click(screen.getByTestId("repo-submit"));

    await waitFor(() => {
      const [request] = requestsTo(requests, reposPath, "POST");
      expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
      expect(JSON.parse(request.body ?? "{}")).toEqual({
        name: "web",
        git_url: "https://github.com/example/web.git",
        default_branch: "main",
      });
    });
    // Success invalidates the repositories query.
    await waitFor(() => expect(requestsTo(requests, reposPath, "GET").length).toBeGreaterThan(1));
  });

  it("shows an inline problem detail for an invalid git_url (422)", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes(projectFixture, [
        {
          path: reposPath,
          method: "POST",
          status: 422,
          body: {
            type: "https://communication.dev/errors/validation-failed",
            title: "Validation failed",
            status: 422,
            detail: "git_url must be https://, ssh://, git@host:path or file://.",
          },
        },
      ]),
    });

    fireEvent.change(await screen.findByTestId("repo-name"), { target: { value: "web" } });
    fireEvent.change(screen.getByTestId("repo-git-url"), {
      target: { value: "ftp://example.com/web.git" },
    });
    fireEvent.click(screen.getByTestId("repo-submit"));

    expect((await screen.findByTestId("form-error")).textContent).toContain("git_url must be");
  });

  it("adds a member with a role from the directory", async () => {
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes(projectFixture),
    });

    await screen.findByTestId("project-name");
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

  it("renders an incoming SSE repository.added event and refetches repositories", async () => {
    const { requests } = renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes(projectFixture),
    });

    await screen.findByTestId("project-name");
    const status = screen.getByTestId("activity-status");
    expect(status.textContent).toBe("reconnecting");

    const source = FakeEventSource.last();
    expect(source.url).toBe(`/api/v1/projects/${projectId}/events`);
    const before = requestsTo(requests, reposPath, "GET").length;

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
    expect(item.textContent).toContain("human:");
    expect(
      within(screen.getByTestId("activity-list")).getAllByTestId("activity-item"),
    ).toHaveLength(1);

    // A change made through another replica must show up without a reload.
    await waitFor(() =>
      expect(requestsTo(requests, reposPath, "GET").length).toBeGreaterThan(before),
    );
    expect(requestsTo(requests, membersPath, "GET").length).toBeGreaterThan(0);
    expect(screen.getByTestId("activity-status").textContent).toBe("live");
  });

  it("keeps the newest event first and does not duplicate a replayed event", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });
    await screen.findByTestId("project-name");

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

  it("reports the feed as reconnecting when the stream drops", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });
    await screen.findByTestId("project-name");

    const source = FakeEventSource.last();
    act(() => source.open());
    expect(screen.getByTestId("activity-status").textContent).toBe("live");

    act(() => source.fail());
    expect(screen.getByTestId("activity-status").textContent).toBe("reconnecting");
  });

  it("says the project was not found when the API returns 404", async () => {
    renderApp({
      path: `/projects/${projectId}`,
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

    await screen.findByTestId("project-not-found");
    expect(screen.getByTestId("project-not-found").textContent).toBe(
      "Project not found or you do not have access",
    );
  });
});
