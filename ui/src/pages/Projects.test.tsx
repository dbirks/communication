import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { wireApproval, wireRun } from "../test/fixtures/m4/wire";
import {
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { Project } from "../api/types";
import { routes } from "../lib/routes";

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
      path: "/projects",
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
    expect(widgets.getAttribute("href")).toBe(routes.project(projectFixture.id));
    expect(widgets.textContent).toContain("Widgets");
    expect(widgets.textContent).toContain("role: maintainer");
    expect(screen.getByTestId("project-link-other-app").textContent).toContain("role: viewer");

    // The page's own data is one org-wide list read — never a per-project
    // fan-out. The shell's sidebar tree may add at most one more read of the
    // same list (same query key), so at most two requests are legitimate.
    expect(requestsTo(requests, "/api/v1/projects", "GET").length).toBeLessThanOrEqual(2);
  });

  it("shows an empty state when there are no projects", async () => {
    renderApp({
      path: "/projects",
      routes: [me, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    await screen.findByText("No projects yet");
  });

  it("creates a project with the CSRF header and opens it", async () => {
    const { requests } = renderApp({
      path: "/projects",
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
      path: "/projects",
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

    fireEvent.click(await screen.findByTestId("new-project-toggle"));
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
      path: "/projects",
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

/* --------------------------------------------------- the board (design 6b) */

/** A second project with no attention at all, to sit behind `otherProject`. */
const quietProject: Project = {
  ...projectFixture,
  id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b82",
  slug: "quiet-app",
  name: "Quiet App",
};

const failedRun = {
  ...wireRun,
  status: "failed",
  failed_cause: "node_execution_failed:/implement",
} as unknown as typeof wireRun;

const secondGate = {
  ...wireApproval,
  id: "01987b26-0000-7000-8000-abcdef012346",
  created_at: "2026-07-31T09:44:02Z",
  summary: "Approve spec: claims export v2",
} as unknown as typeof wireApproval;

/** A gate whose summary holds one token no line break can take — the shape
 * that pushed `/` past a phone viewport once (m5-layout live). */
const gateWithLongToken = {
  ...wireApproval,
  summary:
    "Approve the pinned revision sha256:fef2dabd990533ccebed8c824d1274353febd08e34814fdcaa6785a70d483b59",
} as unknown as typeof wireApproval;

interface AttentionStub {
  approvals?: unknown;
  runs?: unknown;
  conversations?: unknown;
}

/** The wires `lib/attention.ts` reads for every listed project, so a card's
 * counts come from a real fan-out rather than a page-local guess. */
function boardStub(projects: Project[], perProject: Record<string, AttentionStub> = {}) {
  const routes: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", method: "GET", body: { items: projects } },
  ];
  for (const project of projects) {
    const stub = perProject[project.id] ?? {};
    routes.push(
      {
        path: `/api/v1/projects/${project.id}/approvals`,
        body: stub.approvals ?? { approvals: [] },
      },
      { path: `/api/v1/projects/${project.id}/runs`, body: stub.runs ?? { runs: [] } },
      {
        path: `/api/v1/projects/${project.id}/conversations`,
        body: stub.conversations ?? { items: [] },
      },
    );
  }
  return renderApp({ path: "/projects", routes });
}

function cards(): string[] {
  return screen
    .getAllByTestId(/^project-card-/)
    .map((card) => (card.getAttribute("data-testid") ?? "").replace("project-card-", ""));
}

describe("/ projects board", () => {
  it("counts what each project still asks of you", async () => {
    boardStub([projectFixture, quietProject], {
      [projectFixture.id]: {
        approvals: { approvals: [wireApproval] },
        runs: { runs: [failedRun] },
        conversations: { items: [conversationSummaryFixture] },
      },
    });

    await screen.findByTestId("project-list");
    expect(screen.getByTestId("project-count-widgets-decisions").textContent).toContain("1");
    expect(screen.getByTestId("project-count-widgets-stalled").textContent).toContain("1");
    expect(screen.getByTestId("project-count-widgets-conversations").textContent).toContain("1");
    expect(screen.getByTestId("project-count-widgets-running").textContent).toContain("0");

    // The board-wide tally is the same arithmetic summed across projects.
    expect(screen.getByTestId("projects-tally").textContent).toContain("1 decisions");
    expect(screen.getByTestId("projects-tally").textContent).toContain("1 stalled");

    // A card shows at most two items, gates before stalls — the live
    // conversation is real attention, but it is third, so it stays off the card.
    const items = screen.getAllByTestId(/^project-item-/);
    expect(items).toHaveLength(2);
    expect(items[0]?.getAttribute("data-testid")).toBe(`project-item-decision-${wireApproval.id}`);
    expect(items[1]?.getAttribute("data-testid")).toBe(`project-item-stalled-${wireRun.id}`);
  });

  it("says so on a card with nothing outstanding", async () => {
    boardStub([quietProject]);
    await screen.findByTestId("project-quiet-quiet-app");
    expect(screen.getByTestId("project-quiet-quiet-app").textContent).toBe("Nothing needs you.");
  });

  it("drops the plan JSON a gate's summary carries and clamps what is left", async () => {
    const planGate = {
      ...wireApproval,
      summary:
        'Plan for Document and fix add() in hello.py\n{"acceptance":["pytest passes in app/ with both tests green"],"goal":"Document and fix add() in app/hello.py","steps":[{"action":"Add a docstring to add().","file":"app/hello.py","id":1}]}',
    } as unknown as typeof wireApproval;
    boardStub([projectFixture], { [projectFixture.id]: { approvals: { approvals: [planGate] } } });

    await screen.findByTestId("project-list");
    const item = screen.getByTestId(`project-item-decision-${wireApproval.id}`);
    expect(item.textContent).toContain("Plan for Document and fix add() in hello.py");
    expect(item.textContent).not.toContain('"acceptance"');
    expect(item.textContent).not.toContain("{");
    // Two lines, with the whole summary behind the tooltip.
    const title = screen.getByTestId(`item-title-decision-${wireApproval.id}`);
    expect(title.className).toContain("line-clamp-2");
    expect(title.getAttribute("title")).toBe(planGate.summary);
    expect(title.textContent).toBe("Plan for Document and fix add() in hello.py");
  });

  it("sizes the board's track to the viewport, not to a card's longest word", async () => {
    // m5-layout live: `/` at 390x844 measured scrollWidth 403 — the card's own
    // `<li>` 387px wide. With no base `grid-cols-*` the board's single column is
    // an implicit `auto` track, sized to its widest item's min-content, so one
    // unbreakable token in a gate summary (`sha256:…`, a URL) moves the whole
    // page sideways. `grid-cols-1` is `repeat(1,minmax(0,1fr))`: the track stops
    // listening to the content. Vitest cannot measure layout — the live spec is
    // the proof; this guards the class name that produced it.
    boardStub([projectFixture], {
      [projectFixture.id]: { approvals: { approvals: [gateWithLongToken] } },
    });
    const list = await screen.findByTestId("project-list");
    expect(list.className).toContain("grid-cols-1");
    expect(screen.getByTestId("project-card-widgets").className).toContain("min-w-0");
    const title = screen.getByTestId(`item-title-decision-${wireApproval.id}`);
    // And the token wraps inside the card instead of being clipped by it.
    expect(title.className).toContain("break-words");
  });

  it("orders needs-me first by default and alphabetically on a–z", async () => {
    boardStub([projectFixture, otherProject, quietProject], {
      [projectFixture.id]: { approvals: { approvals: [wireApproval] } },
      [otherProject.id]: {
        approvals: { approvals: [wireApproval, secondGate] },
        runs: { runs: [failedRun] },
      },
    });

    await screen.findByTestId("project-list");
    expect(cards()).toEqual(["other-app", "widgets", "quiet-app"]);

    fireEvent.click(screen.getByTestId("projects-sort-az"));
    expect(cards()).toEqual(["other-app", "quiet-app", "widgets"]);

    fireEvent.click(screen.getByTestId("projects-sort-needs-me"));
    expect(cards()).toEqual(["other-app", "widgets", "quiet-app"]);
  });
});
