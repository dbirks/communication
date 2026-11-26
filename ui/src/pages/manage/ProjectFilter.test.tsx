/**
 * The project filter as the three sections use it (redesign R7): the value is
 * `?project=`, in both directions — a bookmarked URL arrives filtered, a chip
 * click rewrites the URL, and "All" clears it. Repositories, People & access
 * and Secrets read the same parameter, so the same three assertions run for
 * each of them.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import RepositoriesSection from "./Repositories";
import PeopleSection from "./People";
import SecretsSection from "./Secrets";
import { ProjectFilter } from "./ProjectFilter";
import { mockFetch, meFixture, type RouteStub } from "../../test/fakes";
import type { Project } from "../../api/types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ONE = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b80";
const TWO = "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81";

const projectOne: Project = {
  id: ONE,
  slug: "project-one",
  name: "Project One",
  description: "",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "maintainer",
};
const projectTwo: Project = { ...projectOne, id: TWO, slug: "project-two", name: "Project Two" };

function stubs(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectOne, projectTwo] } },
    { path: `/api/v1/projects/${ONE}`, body: projectOne },
    { path: `/api/v1/projects/${TWO}`, body: projectTwo },
    { path: `/api/v1/projects/${ONE}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${TWO}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${ONE}/members`, body: { items: [] } },
    { path: `/api/v1/projects/${TWO}/members`, body: { items: [] } },
    { path: `/api/v1/projects/${ONE}/secrets`, body: { secrets: [] } },
    { path: `/api/v1/projects/${TWO}/secrets`, body: { secrets: [] } },
    { path: `/api/v1/projects/${ONE}/secret-mounts`, body: { secret_mounts: [] } },
    { path: `/api/v1/projects/${TWO}/secret-mounts`, body: { secret_mounts: [] } },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
  ];
}

/** Renders `element` at `path` and records every URL it navigates to. */
function renderSection(element: ReactNode, path: string, extra: RouteStub[] = []) {
  mockFetch(stubs(extra));
  const urls: string[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  function Probe() {
    const location = useLocation();
    urls.push(`${location.pathname}${location.search}`);
    return <>{element}</>;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<Probe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return urls;
}

interface Section {
  name: string;
  path: string;
  element: ReactNode;
  filterTestid: string;
  /** A test id that only the filtered view prints. */
  marker: string;
}

const SECTIONS: Section[] = [
  {
    name: "Repositories",
    path: "/manage/repositories",
    element: <RepositoriesSection />,
    filterTestid: "project-filter",
    marker: "manage-repositories-table-empty",
  },
  {
    name: "People",
    path: "/manage/people",
    element: <PeopleSection />,
    filterTestid: "project-filter",
    marker: "member-list-empty",
  },
  {
    name: "Secrets",
    path: "/manage/secrets",
    element: <SecretsSection />,
    filterTestid: "secrets-project-filter",
    marker: `manage-secrets-body-${projectOne.slug}`,
  },
];

describe.each(SECTIONS)("the $name project filter", (section) => {
  it("reads ?project= out of the URL and marks that chip current", async () => {
    renderSection(section.element, `${section.path}?project=${ONE}`);
    const chip = await screen.findByTestId(`${section.filterTestid}-${ONE}`, {}, { timeout: 5000 });
    expect(chip.getAttribute("aria-current")).toBe("true");
    expect(
      screen.getByTestId(`${section.filterTestid}-all`).getAttribute("aria-current"),
    ).toBeNull();
  });

  it("writes ?project= on a chip click and clears it on All", async () => {
    const urls = renderSection(section.element, section.path);
    await screen.findByTestId(`${section.filterTestid}-${ONE}`, {}, { timeout: 5000 });
    fireEvent.click(screen.getByTestId(`${section.filterTestid}-${ONE}`));
    await waitFor(() => expect(urls.at(-1)).toContain(`project=${ONE}`));
    fireEvent.click(screen.getByTestId(`${section.filterTestid}-all`));
    await waitFor(() => expect(urls.at(-1)).not.toContain("project="));
  });

  it("renders the filtered project's own content", async () => {
    renderSection(section.element, `${section.path}?project=${ONE}`);
    await screen.findByTestId(section.marker, {}, { timeout: 5000 });
  });
});

describe("Secrets specifics", () => {
  it("defaults to the first project when the URL names none", async () => {
    renderSection(<SecretsSection />, "/manage/secrets");
    await screen.findByTestId(`manage-secrets-body-${projectOne.slug}`, {}, { timeout: 5000 });
    expect(screen.getByTestId(`secrets-project-filter-${ONE}`).getAttribute("aria-current")).toBe(
      "true",
    );
  });

  it("labels the clear-chip for what it picks, since All is not an answer", async () => {
    renderSection(<SecretsSection />, "/manage/secrets");
    await screen.findByTestId("secrets-project-filter-all", {}, { timeout: 5000 });
    expect(screen.getByTestId("secrets-project-filter-all").textContent).toBe("Pick a project");
  });
});

describe("the chip row itself", () => {
  it("is one group with an accessible name and one current choice", () => {
    render(
      <ProjectFilter
        projects={[
          { id: ONE, name: "Project One" },
          { id: TWO, name: "Project Two" },
        ]}
        value={TWO}
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("group", { name: "Project" });
    expect(group.querySelectorAll("[aria-current='true']")).toHaveLength(1);
    expect(group.textContent).toContain("All projects");
    expect(group.textContent).toContain("Project Two");
  });
});
