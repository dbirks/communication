/**
 * `/p/:projectId/pipelines` — the Workflows tab after the review rebuild.
 *
 * The tests that matter now: the tab is ONE panel of the project's workflow
 * uses (no library list, no YAML dump, no definition graph, no validate note),
 * no raw digest or uuid renders anywhere on it, the legacy address still
 * arrives, a refused project still collapses to the one sentence — and the
 * tab's one write, `+ use a library workflow`, still pins the newest
 * published revision by **id** (resolved through route 13) as the whole-
 * project use the store expects.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import { testidOf } from "../lib/format";
import type { Pipeline, PipelineRevision } from "../api/types";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_CHILD_PIPELINE_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
  wireProjectId,
  wireRevision,
} from "../test/fixtures/m4/wire";

const ASSIGNMENTS_PATH = `/api/v1/projects/${wireProjectId}/assignments`;
const rowKey = testidOf(WIRE_ASSIGNMENT_ID);
const PINNED_DIGEST = wireAssignmentList.assignments[0].pinned_revision_digest;

/** `module-check` — the library pipeline this project has NOT used yet. */
const CHILD_REVISION_ID = "01987b21-0001-7000-8000-abcdef012345";
const CHILD_REVISION_DIGEST = `sha256:${"1a2b".repeat(32)}`;
const childPipeline: Pipeline = {
  ...wirePipeline,
  id: WIRE_CHILD_PIPELINE_ID,
  slug: "module-check",
  latest_revision_number: 2,
  revision_count: 2,
  revisions: [
    {
      ...wirePipeline.revisions[0],
      revision_number: 2,
      version_label: "2.0.0",
      revision_digest: CHILD_REVISION_DIGEST,
      status: "published",
    },
  ],
};
const childRevision: PipelineRevision = {
  ...wireRevision,
  id: CHILD_REVISION_ID,
  pipeline_id: WIRE_CHILD_PIPELINE_ID,
  revision_number: 2,
  version_label: "2.0.0",
  revision_digest: CHILD_REVISION_DIGEST,
};

function routes(role: "maintainer" | "viewer", extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: `/api/v1/projects/${wireProjectId}`, body: { ...projectFixture, my_role: role } },
    { path: ASSIGNMENTS_PATH, body: wireAssignmentList },
    { path: "/api/v1/pipelines", body: wirePipelineList },
    { path: `/api/v1/pipelines/${WIRE_PIPELINE_ID}`, body: wirePipeline },
    { path: `/api/v1/pipelines/${WIRE_CHILD_PIPELINE_ID}`, body: childPipeline },
    { path: `/api/v1/revisions/${PINNED_DIGEST}`, body: wireRevision },
    { path: `/api/v1/revisions/${CHILD_REVISION_DIGEST}`, body: childRevision },
    { path: `/api/v1/projects/${wireProjectId}/schedules`, body: { schedules: [] } },
    { path: `/api/v1/projects/${wireProjectId}/issue-triggers`, body: { issue_triggers: [] } },
    {
      path: `/api/v1/projects/${wireProjectId}/repos`,
      body: {
        items: [
          {
            id: "01987b22-0002-7000-8000-abcdef012345",
            project_id: wireProjectId,
            name: "app",
            git_url: "https://github.com/widgets/app.git",
            default_branch: "main",
            created_at: "2026-07-30T09:00:00Z",
          },
        ],
      },
    },
  ];
}

function mount(role: "maintainer" | "viewer", extra: RouteStub[] = []) {
  return renderApp({
    path: `/p/${wireProjectId}/pipelines`,
    routes: routes(role, extra),
  });
}

describe("/p/:projectId/pipelines — one panel, not a shelf of legacy ones", () => {
  it("keeps the legacy /projects/:id/pipelines address alive as a redirect", async () => {
    // The pre-move address still renders the same surface: App.tsx turns it
    // into a replace-navigate to the canonical /p/:id/pipelines.
    renderApp({ path: `/projects/${wireProjectId}/pipelines`, routes: routes("maintainer") });
    const row = await screen.findByTestId(`project-workflow-row-${rowKey}`);
    expect(row.textContent).toContain("Feature development");
  });

  it("mounts the 1b frame with this tab marked, and nothing else's furniture", async () => {
    mount("maintainer");
    await screen.findByTestId(`project-workflow-row-${rowKey}`);

    expect(await screen.findByTestId("project-header", undefined, { timeout: 5_000 })).toBeTruthy();
    expect(screen.getByTestId("project-name").textContent).toBe(projectFixture.name);
    const tabs = screen.getByTestId("project-tabs");
    expect(
      tabs.querySelector(`[data-testid="project-tab-workflows"]`)?.getAttribute("aria-current"),
    ).toBe("page");
    // The old page's own H1 ("Pipelines") and its word are gone; the screen
    // speaks the product's.
    expect(screen.queryByRole("heading", { name: /^Pipelines$/ })).toBeNull();
  });

  it("is ONE panel: no library list, no YAML dump, no definition graph, no validate note", async () => {
    mount("maintainer");
    await screen.findByTestId(`project-workflow-row-${rowKey}`);

    const words = document.body.textContent ?? "";
    expect(screen.queryByRole("heading", { name: /^LIBRARY/i })).toBeNull();
    expect(words).not.toMatch(/in the library\b/);
    expect(screen.queryByTestId("yaml-view")).toBeNull();
    expect(words).not.toContain("YAML (READ-ONLY)");
    expect(screen.queryByTestId("definition-graph")).toBeNull();
    expect(words).not.toMatch(/nodes? · ·?\s*\d+ edges?/);
    expect(words).not.toContain("VALIDATE YAML");
    expect(words).not.toMatch(/when to run/i);
    // The library is a click away, and the pinned document one row-name click
    // beyond that: the workflow page owns both.
    expect(screen.getByTestId(`project-workflow-name-${rowKey}`).getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}`,
    );
  });

  it("says the revision as r7 — no digest, no uuid, no short-id fragment", async () => {
    mount("maintainer");
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    await waitFor(() =>
      expect(screen.getByTestId(`project-workflow-revision-${rowKey}`).textContent).toBe("r7"),
    );

    const words = document.body.textContent ?? "";
    expect(words).not.toContain(WIRE_REVISION_ID);
    expect(words).not.toContain(WIRE_ASSIGNMENT_ID);
    expect(words).not.toContain(PINNED_DIGEST);
    expect(words).not.toMatch(/sha256:/);
    // The pass review's exact offenders: `pinned r1 · 0a09bab23de4`,
    // `id d778fa6d`, `newest run 300abcbf · …`.
    expect(words).not.toMatch(/pinned [rt]?\d+ · [0-9a-f]{6,}/);
    expect(words).not.toMatch(/\bid [0-9a-f]{6,}\b/);
    expect(words).not.toMatch(/newest run [0-9a-f]{6,}/);
  });

  it("shows a viewer the rows with no writing affordances", async () => {
    mount("viewer");
    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    expect(screen.queryByTestId("project-workflow-library")).toBeNull();
    expect(screen.queryByTestId(`project-workflow-add-${rowKey}`)).toBeNull();
    expect(screen.queryByTestId("project-library-dialog")).toBeNull();
  });

  it("collapses to the one sentence when the project refuses the assignments read", async () => {
    mount("viewer", [
      {
        path: ASSIGNMENTS_PATH,
        status: 403,
        body: { type: "about:blank", title: "Forbidden", status: 403, detail: "Nope." },
      },
    ]);

    expect((await screen.findByTestId("project-pipelines-not-found")).textContent).toContain(
      "Project not found or you do not have access",
    );
    // The shell is the leak: no rows, no library, no assign affordances.
    expect(screen.queryAllByTestId(/project-workflow-row-/)).toHaveLength(0);
    expect(screen.queryAllByTestId(/project-workflow-add-/)).toHaveLength(0);
  });
});

describe("/p/:projectId/pipelines — + use a library workflow", () => {
  it("pins the newest published revision as the whole-project use", async () => {
    const created = {
      ...wireAssignmentList.assignments[0],
      id: "01987b22-0001-7000-8000-abcdef012345",
      pipeline_id: WIRE_CHILD_PIPELINE_ID,
      pinned_revision_id: CHILD_REVISION_ID,
      pinned_revision_digest: CHILD_REVISION_DIGEST,
      pinned_version_label: "2.0.0",
    };
    const { requests } = mount("maintainer", [
      { path: ASSIGNMENTS_PATH, method: "POST", status: 201, body: created },
    ]);

    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    fireEvent.click(screen.getByTestId("project-workflow-library"));
    await screen.findByTestId("project-library-dialog");
    // The context names the scope in words, and the row names the pin.
    expect(screen.getByTestId("project-library-context").textContent).toContain(
      "every repository in the project",
    );
    expect(screen.getByTestId("project-library-row-feature-development").textContent).toContain(
      "used in the project",
    );

    fireEvent.click(await screen.findByTestId("project-library-use-module-check"));
    await waitFor(() => expect(requestsTo(requests, ASSIGNMENTS_PATH, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, ASSIGNMENTS_PATH, "POST")[0].body ?? "{}");
    // The pin is the resolved *id* route 18 demands, posted after route 13
    // resolves the newest published digest; no repository member means the
    // whole-project use (ADR-0060's `null`).
    expect(body).toEqual({
      pipeline_id: WIRE_CHILD_PIPELINE_ID,
      pinned_revision_id: CHILD_REVISION_ID,
      max_concurrent_runs: 1,
    });
    expect(requestsTo(requests, `/api/v1/revisions/${CHILD_REVISION_DIGEST}`)).toHaveLength(1);
    // The list and the tab's rows read the same key: the invalidation refetches it.
    await waitFor(() =>
      expect(requestsTo(requests, ASSIGNMENTS_PATH).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByTestId("project-library-dialog")).toBeNull());
  });

  it("keeps the server's 409 inline instead of pretending the pin took", async () => {
    mount("maintainer", [
      {
        path: ASSIGNMENTS_PATH,
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "this pipeline is already assigned to this project",
        },
      },
    ]);

    await screen.findByTestId(`project-workflow-row-${rowKey}`);
    fireEvent.click(screen.getByTestId("project-workflow-library"));
    fireEvent.click(await screen.findByTestId("project-library-use-module-check"));

    const alert = await screen.findByTestId("project-library-error");
    expect(alert.textContent).toContain("already assigned");
    expect(screen.getByTestId("project-library-dialog")).toBeTruthy();
  });
});
