import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { FRAME_BATCH_MS } from "../api/events";
import {
  FakeEventSource,
  envelopeFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { WIRE_RUN_ID, wirePipelineList, wireRun } from "../test/fixtures/m4/wire";
import { testidOf } from "../lib/format";
import type { Member, Project, Repository, User } from "../api/types";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectId = projectFixture.id;
const projectPath = `/api/v1/projects/${projectId}`;
const reposPath = `${projectPath}/repos`;
const membersPath = `${projectPath}/members`;
const approvalsPath = `${projectPath}/approvals`;
const runsPath = `${projectPath}/runs`;
const conversationsPath = `${projectPath}/conversations`;

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
    // The dashboard reads the attention wires; unstubbed they would 404 and the
    // panel would honestly report that rather than show an empty state.
    { path: approvalsPath, method: "GET", body: { approvals: [] } },
    { path: runsPath, method: "GET", body: { runs: [] } },
    { path: conversationsPath, method: "GET", body: { items: [] } },
    { path: "/api/v1/pipelines", method: "GET", body: wirePipelineList },
  ];
}

describe("/projects/:projectId", () => {
  it("mounts the one project nav with Overview current, and no second menu", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });
    await screen.findByTestId("project-name");

    const nav = screen.getByRole("navigation", { name: "Project sections" });
    const items = within(nav).getAllByRole("link");
    expect(items.map((item) => item.textContent)).toEqual([
      "Overview",
      "Runs",
      "Conversations",
      "Pipelines",
      "Artifacts",
      "Settings",
    ]);
    expect(within(nav).getByText("Overview").getAttribute("aria-current")).toBe("true");
    // No `/projects/:id/conversations` route exists, so the item points at the
    // overview's own conversations section rather than a route the app lacks.
    expect(within(nav).getByText("Conversations").getAttribute("href")).toBe(
      `/projects/${projectId}#conversations`,
    );

    // The page's former left menu (Repositories/Members/Workspaces/Activity as
    // nav items) and its header links are gone; only the panels named by the
    // nav remain.
    expect(screen.queryByText("Repositories")).toBeNull();
    expect(screen.queryByText("Workspaces")).toBeNull();
    expect(screen.queryByText("Activity")).toBeNull();
    expect(screen.queryByTestId("project-artifacts-link")).toBeNull();
    expect(screen.queryByTestId("project-settings-link")).toBeNull();
    // The section this nav's Overview page is responsible for still renders.
    expect((await screen.findByRole("heading", { name: "REPOSITORIES" })).textContent).toBe(
      "REPOSITORIES",
    );
  });

  it("lists a failed run of this project under needs attention", async () => {
    const failed = {
      ...wireRun,
      status: "failed",
      failed_cause: "node_execution_failed:/implement",
      finished_at: "2026-07-31T10:20:00Z",
    } as unknown as typeof wireRun;
    renderApp({
      path: `/projects/${projectId}`,
      routes: projectRoutes(projectFixture, [
        { path: runsPath, method: "GET", body: { runs: [failed] } },
      ]),
    });

    const row = await screen.findByTestId(`project-attention-run-${testidOf(WIRE_RUN_ID)}`);
    expect(
      within(row).getByTestId(`project-attention-run-status-${testidOf(WIRE_RUN_ID)}`).textContent,
    ).toBe("failed");
    // Named by the pipeline slug and the short id the wire serves — never an
    // invented run title.
    expect(row.textContent).toContain("feature-development");
    expect(row.getAttribute("href")).toBe(`/projects/${projectId}/runs/${WIRE_RUN_ID}`);
    expect(screen.queryByTestId("project-attention-empty")).toBeNull();
    // The same run is the newest one, so it is the recent list too.
    expect(screen.getByTestId(`recent-run-${testidOf(WIRE_RUN_ID)}`).textContent).toContain(
      "feature-development",
    );
  });

  it("says nothing needs attention when the project has no open work", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });
    expect((await screen.findByTestId("project-attention-empty")).textContent).toBe(
      "Nothing needs attention in this project.",
    );
  });

  it("shows the project name, repositories and members", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: projectRoutes(projectFixture) });

    expect((await screen.findByTestId("project-name")).textContent).toBe("Widgets");

    const repoRow = await screen.findByTestId("repo-row-communication");
    expect(repoRow.textContent).toContain("communication");
    expect(repoRow.textContent).toContain("main");

    const memberRow = await screen.findByTestId("member-row-Ada Lovelace");
    expect(memberRow.textContent).toContain("role: maintainer");

    // The compact row shortens the remote for a 320px column but still carries
    // the whole URL (a screen reader gets it, and so does an operator).
    expect(repoRow.textContent).toContain("github.com/example/communication");
    expect(repoRow.textContent).toContain("https://github.com/example/communication.git");
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

    fireEvent.click(await screen.findByTestId("repo-add-toggle"));
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

    fireEvent.click(await screen.findByTestId("repo-add-toggle"));
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
    // The actor is written as a person's name, never a raw kind + uuid
    // (uncommitted polish finished here: `ui/src/api/actors.ts`).
    expect(item.textContent).toContain("by Ada Lovelace");
    expect(within(item).getByTestId("activity-actor").textContent).toBe("Ada Lovelace");
    expect(
      within(screen.getByTestId("activity-list")).getAllByTestId("activity-item"),
    ).toHaveLength(1);

    // A change made through another replica must show up without a reload —
    // once the feed's coalescing window closes (a journal replay must not
    // refetch once per frame; see `FRAME_BATCH_MS` in `api/events.ts`).
    await waitFor(
      () => expect(requestsTo(requests, reposPath, "GET").length).toBeGreaterThan(before),
      { timeout: FRAME_BATCH_MS + 1_000 },
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
