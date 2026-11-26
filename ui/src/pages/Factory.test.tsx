/**
 * Factory — the index's headline sentence, its empty state, and the two ways
 * into the New workflow sheet. Mounted through a router with and without a
 * project prefix, because the scope decides which workflows the page may show.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Factory, { factorySummaryParts, factorySummaryText } from "./Factory";
import type { FactoryWorkflowItem } from "../components/factory/factoryData";
import type { CrossProjectRunSummary } from "../api/home";
import type { PipelineList, ProjectList } from "../api/types";
import { mockFetch, projectFixture, type RouteStub } from "../test/fakes";

afterEach(cleanup);

/* ------------------------------------------------------------ pure copy */

function item(id: string): FactoryWorkflowItem {
  return {
    pipeline: {
      id,
      slug: `wf-${id}`,
      display_name: `Workflow ${id}`,
      latest_revision_number: 1,
      revision_count: 1,
      archived: false,
    },
    steps: [],
    triggerText: "when you start it",
    liveRuns: [],
    draftCount: 0,
    usedIn: [],
    lastRunAt: null,
  };
}

function run(status: CrossProjectRunSummary["status"]): CrossProjectRunSummary {
  return {
    id: `01987b11-2b5b-7e4c-8f20-3d4e5f6a7b${status.length}c`,
    project_id: projectFixture.id,
    pipeline_id: "a",
    pipeline_revision_id: "rev-1",
    revision_digest: "sha256:1",
    plan_digest: "sha256:2",
    status,
    depth: 0,
    priority: 0,
    created_at: "2026-11-20T10:00:00Z",
    project_name: projectFixture.name,
    pipeline_slug: "wf-a",
    pipeline_display_name: "Workflow a",
    steps: [],
  };
}

describe("factorySummaryText", () => {
  it("names running work first, and counts the rest", () => {
    expect(factorySummaryText([item("a"), item("b")], [run("running")])).toBe(
      "● 1 running · 2 workflows",
    );
  });
  it("keeps the waiting clause only when something waits", () => {
    expect(factorySummaryText([item("a")], [run("running"), run("waiting_human")])).toBe(
      "● 1 running · ! 1 waiting on you · 1 workflow",
    );
  });
  it("says so when nothing is live, rather than a bare count", () => {
    expect(factorySummaryText([item("a"), item("b"), item("c")], [])).toBe(
      "3 workflows · nothing running",
    );
    expect(factorySummaryText([], [])).toBe("0 workflows · nothing running");
  });
  it("carries a glyph with every state word", () => {
    const parts = factorySummaryParts([item("a")], [run("paused")]);
    expect(parts.map((part) => part.glyph)).toEqual(["!", ""]);
    expect(parts[0]?.text).toBe("1 waiting on you");
  });
});

/* -------------------------------------------------------------- mounted */

const PIPELINE_ID = "01987b20-0000-7000-8000-abcdef012345";
const DIGEST = `sha256:${"3f2f".repeat(32)}`;

const pipelineList: PipelineList = {
  pipelines: [
    {
      id: PIPELINE_ID,
      slug: "wf-1",
      display_name: "Workflow One",
      latest_revision_number: 1,
      revision_count: 1,
      archived: false,
    },
  ],
};

const emptyList: PipelineList = { pipelines: [] };

function routes(stubs: Partial<Record<string, RouteStub>> = {}): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/projects", body: { items: [projectFixture] } satisfies ProjectList },
    { path: "/api/v1/pipelines", body: pipelineList },
    {
      path: `/api/v1/pipelines/${PIPELINE_ID}`,
      body: {
        id: PIPELINE_ID,
        slug: "wf-1",
        display_name: "Workflow One",
        created_by: "01987a61-2345-7000-8000-abcdef012345",
        created_at: "2026-11-01T10:00:00Z",
        latest_revision_number: 1,
        revision_count: 1,
        archived: false,
        revisions: [
          {
            revision_number: 1,
            version_label: "1.0.0",
            revision_digest: DIGEST,
            plan_digest: `sha256:${"0d0c".repeat(32)}`,
            digest_scope: "v1alpha1-canonical-1",
            published_at: "2026-11-02T10:00:00Z",
            published_by: "01987a61-2345-7000-8000-abcdef012345",
            status: "published",
          },
        ],
      },
    },
    { path: `/api/v1/pipelines/${PIPELINE_ID}/drafts`, body: { drafts: [] } },
    {
      path: `/api/v1/revisions/${DIGEST}`,
      body: {
        id: "rev-1",
        pipeline_id: PIPELINE_ID,
        draft_id: "draft-1",
        revision_number: 1,
        version_label: "1.0.0",
        api_version: "communication.dev/v1alpha1",
        canonical_document: {
          apiVersion: "communication.dev/v1alpha1",
          kind: "Pipeline",
          spec: { nodes: [{ id: "plan", kind: "agent.acp" }] },
        },
        document_text: "",
        ui_layout: {},
        revision_digest: DIGEST,
        digest_scope: "v1alpha1-canonical-1",
        compiled_plan: {},
        plan_digest: `sha256:${"0d0c".repeat(32)}`,
        schema_digest: `sha256:${"5a5a".repeat(32)}`,
        cel_env_digest: `sha256:${"6b6b".repeat(32)}`,
        status: "published",
        published_by: "01987a61-2345-7000-8000-abcdef012345",
        published_at: "2026-11-02T10:00:00Z",
      },
    },
    { path: `/api/v1/projects/${projectFixture.id}/assignments`, body: { assignments: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/schedules`, body: { schedules: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/issue-triggers`, body: { issue_triggers: [] } },
    { path: `/api/v1/projects/${projectFixture.id}/repos`, body: { items: [] } },
    { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
  ];
  return base.map((stub) => stubs[stub.path] ?? stub);
}

function mount(stubs: Partial<Record<string, RouteStub>> = {}, path = "/factory") {
  mockFetch(routes(stubs));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/factory" element={<Factory />} />
          <Route path="/p/:projectId/factory" element={<Factory />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Factory", () => {
  it("lists the org's workflows as cards under a live summary", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("factory-index")).toBeTruthy());
    const card = await screen.findByTestId(`workflow-card-${PIPELINE_ID}`);
    expect(card.textContent).toContain("Workflow One");
    expect(screen.getByTestId("factory-summary").textContent).toBe("1 workflow · nothing running");
  });

  // Review 07-1280-4: the prototype puts the live sentence to the RIGHT of the
  // heading, on its line, led by a state-coloured glyph.
  it("rides the summary on the heading's line, with a state-coloured glyph", async () => {
    mount({
      "/api/v1/runs": {
        path: "/api/v1/runs",
        body: {
          runs: [
            {
              id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
              project_id: projectFixture.id,
              pipeline_id: PIPELINE_ID,
              pipeline_revision_id: "rev-1",
              revision_digest: "sha256:1",
              plan_digest: "sha256:2",
              status: "running",
              depth: 0,
              priority: 0,
              created_at: "2026-11-20T10:00:00Z",
              project_name: projectFixture.name,
              pipeline_slug: "wf-1",
              pipeline_display_name: "Workflow One",
              steps: [{ node_id: "plan", kind: "agent.acp", state: "running" }],
            },
          ],
          next_cursor: null,
        },
      },
    });
    const summary = await screen.findByTestId("factory-summary");
    await waitFor(() => expect(summary.textContent).toBe("● 1 running · 1 workflow"));
    // One line, to the right of the heading — not a paragraph under it.
    expect(summary.previousElementSibling?.tagName).toBe("H2");
    // The glyph carries the state colour; the words stay the sentence.
    const glyph = summary.querySelector("span");
    expect(glyph?.textContent).toBe("● ");
    expect(glyph?.className).toContain("text-st-running-tag-fg");
  });

  it("counts a live run into the headline, glyph and word", async () => {
    mount({
      "/api/v1/runs": {
        path: "/api/v1/runs",
        body: {
          runs: [
            {
              id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
              project_id: projectFixture.id,
              pipeline_id: PIPELINE_ID,
              pipeline_revision_id: "rev-1",
              revision_digest: "sha256:1",
              plan_digest: "sha256:2",
              status: "running",
              depth: 0,
              priority: 0,
              created_at: "2026-11-20T10:00:00Z",
              project_name: projectFixture.name,
              pipeline_slug: "wf-1",
              pipeline_display_name: "Workflow One",
              steps: [{ node_id: "plan", kind: "agent.acp", state: "running" }],
            },
          ],
          next_cursor: null,
        },
      },
    });
    const summary = await screen.findByTestId("factory-summary");
    await waitFor(() => expect(summary.textContent).toBe("● 1 running · 1 workflow"));
  });

  it("offers the empty factory as an invitation, with the dashed card alone", async () => {
    mount({ "/api/v1/pipelines": { path: "/api/v1/pipelines", body: emptyList } });
    const empty = await screen.findByTestId("factory-empty");
    expect(empty.textContent).toBe(
      "No workflows yet. Describe one and it gets sketched on the canvas.",
    );
    expect(screen.getByTestId("factory-new-card")).toBeTruthy();
    expect(screen.queryAllByTestId(/^workflow-card-/)).toHaveLength(0);
  });

  it("opens the sheet from the header button and from the dashed card", async () => {
    mount();
    await screen.findByTestId(`workflow-card-${PIPELINE_ID}`);
    expect(screen.queryByTestId("new-workflow-sheet")).toBeNull();
    fireEvent.click(screen.getByTestId("factory-new"));
    expect(screen.getByTestId("new-workflow-sheet")).toBeTruthy();
    fireEvent.click(screen.getByTestId("new-workflow-close"));
    expect(screen.queryByTestId("new-workflow-sheet")).toBeNull();
    fireEvent.click(screen.getByTestId("factory-new-card"));
    expect(screen.getByTestId("new-workflow-sheet")).toBeTruthy();
    // the sheet copies the org's real workflows, not a fake gallery
    expect(screen.getByTestId(`new-workflow-copy-${PIPELINE_ID}`).textContent).toBe("Workflow One");
  });

  it("shows one problem banner when the list cannot be read", async () => {
    mount({ "/api/v1/pipelines": { path: "/api/v1/pipelines", status: 500, body: null } });
    expect(await screen.findByTestId("factory-load-error")).toBeTruthy();
    expect(screen.queryAllByTestId(/^workflow-card-/)).toHaveLength(0);
  });

  it("keeps a card whose own read failed, and says the strip shows less", async () => {
    mount({
      [`/api/v1/pipelines/${PIPELINE_ID}`]: {
        path: `/api/v1/pipelines/${PIPELINE_ID}`,
        status: 500,
        body: null,
      },
    });
    const card = await screen.findByTestId(`workflow-card-${PIPELINE_ID}`);
    expect(card.textContent).toContain("Workflow One");
    // No steps are drawn for a document that never arrived…
    expect(
      card.ownerDocument.querySelectorAll('[data-testid^="workflow-thumb-chip-"]').length,
    ).toBe(1);
    // …and the page owns up to that.
    expect(screen.getByTestId("factory-rows-incomplete").textContent).toContain(
      "could not be read in full",
    );
    expect(screen.queryByTestId("factory-load-error")).toBeNull();
  });

  it("lists nothing the scoped project does not pin", async () => {
    mount({}, `/p/${projectFixture.id}/factory`);
    const empty = await screen.findByTestId("factory-empty");
    expect(empty.textContent).toContain("No workflows yet.");
  });

  it("renders SCHEDULES AND TRIGGERS HERE (project-pipelines) in a project scope and omits it in All scope", async () => {
    mount({}, "/factory");
    await screen.findByTestId(`workflow-card-${PIPELINE_ID}`);
    expect(screen.queryByTestId("project-pipelines")).toBeNull();

    cleanup();
    mount({}, `/p/${projectFixture.id}/factory`);
    const section = await screen.findByTestId("project-pipelines");
    expect(section.textContent).toContain("SCHEDULES AND TRIGGERS HERE");
    expect(await screen.findByTestId("project-workflows")).toBeTruthy();
  });

  it("opens UseInRepoDialog from the unused line / … menu and updates the card after assigning", async () => {
    let assigned = false;
    const repo = {
      id: "repo-1",
      project_id: projectFixture.id,
      name: "widgets",
      default_branch: "main",
      enabled: true,
    };
    const assignment = {
      id: "assign-1",
      project_id: projectFixture.id,
      pipeline_id: PIPELINE_ID,
      pinned_revision_id: "rev-1",
      pinned_revision_digest: DIGEST,
      repository_id: repo.id,
      repository_name: repo.name,
      max_concurrent_runs: 1,
      enabled: true,
    };
    mockFetch([
      // The POST stub goes first: a stub without a method answers any verb.
      {
        path: `/api/v1/projects/${projectFixture.id}/assignments`,
        method: "POST",
        status: 201,
        body: () => {
          assigned = true;
          return assignment;
        },
      },
      ...routes({
        [`/api/v1/projects/${projectFixture.id}/assignments`]: {
          path: `/api/v1/projects/${projectFixture.id}/assignments`,
          body: () => ({ assignments: assigned ? [assignment] : [] }),
        },
        [`/api/v1/projects/${projectFixture.id}/repos`]: {
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [repo] },
        },
      }),
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/factory"]}>
          <Routes>
            <Route path="/factory" element={<Factory />} />
            <Route path="/p/:projectId/factory" element={<Factory />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const unused = await screen.findByTestId(`workflow-card-unused-${PIPELINE_ID}`);
    expect(unused.textContent).toBe("Not used in any project yet · Use in a project");
    fireEvent.click(screen.getByTestId(`workflow-card-unused-use-${PIPELINE_ID}`));

    const dialog = await screen.findByTestId("use-in-repo-dialog");
    expect(dialog).toBeTruthy();
    const projectSelect = (await screen.findByTestId("assign-project-select")) as HTMLSelectElement;
    await waitFor(() => expect(projectSelect.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(projectSelect, { target: { value: projectFixture.id } });
    const repoSelect = (await screen.findByTestId("assign-repo-select")) as HTMLSelectElement;
    await waitFor(() => expect(repoSelect.querySelectorAll("option").length).toBeGreaterThan(1));
    fireEvent.change(repoSelect, { target: { value: repo.id } });
    fireEvent.click(screen.getByTestId("assign-confirm"));

    await screen.findByTestId("assign-success-panel");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() =>
      expect(screen.getByTestId(`workflow-card-meta-${PIPELINE_ID}`).textContent).toContain(
        `used in ${projectFixture.name}`,
      ),
    );
    expect(screen.queryByTestId(`workflow-card-unused-${PIPELINE_ID}`)).toBeNull();
  });

  it("preselects the scoped project when opening Use in a project… from /p/:projectId/factory", async () => {
    const repo = {
      id: "repo-1",
      project_id: projectFixture.id,
      name: "widgets",
      default_branch: "main",
      enabled: true,
    };
    const assignment = {
      id: "assign-1",
      project_id: projectFixture.id,
      pipeline_id: PIPELINE_ID,
      pinned_revision_id: "rev-1",
      pinned_revision_digest: DIGEST,
      repository_id: repo.id,
      repository_name: repo.name,
      max_concurrent_runs: 1,
      enabled: true,
    };
    mount(
      {
        [`/api/v1/projects/${projectFixture.id}/assignments`]: {
          path: `/api/v1/projects/${projectFixture.id}/assignments`,
          body: { assignments: [assignment] },
        },
        [`/api/v1/projects/${projectFixture.id}/repos`]: {
          path: `/api/v1/projects/${projectFixture.id}/repos`,
          body: { items: [repo] },
        },
      },
      `/p/${projectFixture.id}/factory`,
    );

    await screen.findByTestId(`workflow-card-${PIPELINE_ID}`);
    fireEvent.click(screen.getByTestId("workflow-card-menu"));
    fireEvent.click(screen.getByTestId("workflow-card-use"));

    const projectSelect = (await screen.findByTestId("assign-project-select")) as HTMLSelectElement;
    await waitFor(() => expect(projectSelect.value).toBe(projectFixture.id));
  });
});
