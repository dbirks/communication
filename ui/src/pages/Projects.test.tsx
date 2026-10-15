import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import type { Project } from "../api/types";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };

const otherProject: Project = {
  ...projectFixture,
  id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81",
  slug: "other-app",
  name: "Other App",
  description: "",
  my_role: "viewer",
};

function projectDetailRoutes(project: Project): RouteStub[] {
  return [
    { path: `/api/v1/projects/${project.id}`, body: project },
    { path: `/api/v1/projects/${project.id}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${project.id}/members`, body: { items: [] } },
  ];
}

describe("/ projects index", () => {
  it("lists the visible projects with the caller's role", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: [
        me,
        {
          path: "/api/v1/projects",
          method: "GET",
          body: { items: [projectFixture, otherProject] },
        },
      ],
    });

    const list = await screen.findByTestId("project-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const widgets = screen.getByTestId("project-link-widgets");
    expect(widgets.getAttribute("href")).toBe(`/projects/${projectFixture.id}`);
    expect(widgets.textContent).toContain("Widgets");
    expect(widgets.textContent).toContain("role: maintainer");
    expect(screen.getByTestId("project-link-other-app").textContent).toContain("role: viewer");

    expect(requestsTo(requests, "/api/v1/projects", "GET")).toHaveLength(1);
  });

  it("shows an empty state when there are no projects", async () => {
    renderApp({
      path: "/",
      routes: [me, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    await screen.findByText("No projects yet");
  });

  it("creates a project with the CSRF header and opens it", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: [
        me,
        { path: "/api/v1/projects", method: "GET", body: { items: [] } },
        { path: "/api/v1/projects", method: "POST", status: 201, body: projectFixture },
        ...projectDetailRoutes(projectFixture),
      ],
    });

    fireEvent.change(await screen.findByTestId("create-project-name"), {
      target: { value: "Widgets" },
    });
    fireEvent.change(screen.getByTestId("create-project-description"), {
      target: { value: "Widget incubator" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    // Navigation to the new project proves the 201 was handled and the list invalidated.
    expect((await screen.findByTestId("project-name")).textContent).toBe("Widgets");

    const [request] = requestsTo(requests, "/api/v1/projects", "POST");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
    expect(JSON.parse(request.body ?? "{}")).toEqual({
      name: "Widgets",
      description: "Widget incubator",
    });
    expect(requestsTo(requests, "/api/v1/projects", "GET").length).toBeGreaterThan(1);
  });

  it("shows the problem detail inline when the slug is taken (409)", async () => {
    renderApp({
      path: "/",
      routes: [
        me,
        { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
        {
          path: "/api/v1/projects",
          method: "POST",
          status: 409,
          body: {
            type: "https://communication.dev/errors/slug-taken",
            title: "Slug already taken",
            status: 409,
            detail: 'An organization project with slug "widgets" already exists.',
          },
        },
      ],
    });

    fireEvent.change(await screen.findByTestId("create-project-name"), {
      target: { value: "Widgets" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    const error = await screen.findByTestId("form-error");
    expect(error.textContent).toContain("Slug already taken");
    expect(error.textContent).toContain("already exists");
    // Still on the projects index — nothing was created.
    expect(screen.queryByTestId("project-name")).toBeNull();
  });

  it("shows the problem detail inline for a validation failure (422)", async () => {
    renderApp({
      path: "/",
      routes: [
        me,
        { path: "/api/v1/projects", method: "GET", body: { items: [] } },
        {
          path: "/api/v1/projects",
          method: "POST",
          status: 422,
          body: {
            type: "https://communication.dev/errors/validation-failed",
            title: "Validation failed",
            status: 422,
            detail: "name is required.",
          },
        },
      ],
    });

    fireEvent.change(await screen.findByTestId("create-project-name"), {
      target: { value: "Widgets" },
    });
    fireEvent.click(screen.getByTestId("create-project-submit"));

    expect((await screen.findByTestId("form-error")).textContent).toContain("name is required.");
  });
});
