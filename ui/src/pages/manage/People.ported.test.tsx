/**
 * Manage → People & access (`/manage/people?project=<id>`, redesign R7): the
 * members list and its add-or-change form, ported from the old
 * `/p/:projectId/members` page (`components/project/ProjectMembersPage.tsx`).
 *
 * The section mounts `components/project/MembersPanel.tsx` — the same panel,
 * the same `PUT` that is both add and role change, the same role table — with
 * the project named in the URL (`?project=` is what `/p/:p/members` redirects
 * to, CONTRACT "Redirects"). So the assertions are the old page's, unchanged:
 * the role the server reports, the CSRF-carrying write, a viewer who reads the
 * list but cannot change it, and the sentence for a project with no members.
 * The old page's Settings/Members tab row is retired with it: Manage's own
 * sub-nav owns destinations now (`pages/Manage.test.tsx`).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import PeopleSection from "./People";
import { setCsrfToken } from "../../api/client";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import type { Member, Project, User } from "../../api/types";

afterEach(() => {
  cleanup();
  setCsrfToken(null);
  vi.unstubAllGlobals();
});

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

function renderPeople(project: Project, extra: RouteStub[] = []) {
  const { requests } = mockFetch([
    { path: "/api/v1/me", body: meFixture },
    ...extra,
    { path: "/api/v1/projects", method: "GET", body: { items: [project] } },
    { path: membersPath, method: "GET", body: { items: [member] } },
    { path: usersPath, method: "GET", body: { items: [directoryUser] } },
    { path: projectPath, method: "GET", body: project },
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/manage/people?project=${projectId}`]}>
        <Routes>
          <Route path="/manage/people" element={<PeopleSection />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

describe("/manage/people?project=<id> — the project's members", () => {
  it("shows the members list with the role the server reports", async () => {
    renderPeople(projectFixture);
    const row = await screen.findByTestId("member-row-Ada Lovelace");
    expect(row.textContent).toContain("role: maintainer");
  });

  it("adds a member with a role from the directory", async () => {
    const { requests } = renderPeople(projectFixture);
    // In the app the token arrives with the shell's `/me` read; this harness
    // mounts one section, so it is handed over the same way.
    setCsrfToken(meFixture.csrf_token);
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
    renderPeople({ ...projectFixture, my_role: "viewer" });
    expect((await screen.findByTestId("member-row-Ada Lovelace")).textContent).toContain(
      "role: maintainer",
    );
    expect(screen.queryByTestId("member-user")).toBeNull();
    expect(screen.getByText("Only project maintainers can change members.")).toBeTruthy();
  });

  it("says there are no members yet", async () => {
    renderPeople(projectFixture, [
      { path: membersPath, method: "GET", body: { items: [] } },
      // With nothing to show the panel opens its form straight away: the first
      // person added is the one moment adding one is the whole point.
      { path: `${membersPath}/${directoryUser.id}`, method: "PUT", body: {} },
    ]);
    expect((await screen.findByTestId("member-list-empty")).textContent).toContain(
      "No members yet.",
    );
  });
});
