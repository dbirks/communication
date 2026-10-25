/**
 * The workflow page (`/workflows/:pipelineId`, design 1e/2a/2d) driven against
 * the fake fetch. The contracts with teeth:
 *
 * - the page OPENS on the graph; YAML, Used in and History are ROUTES;
 * - there is no Start run and no trigger editing anywhere on this page —
 *   triggers belong to the repo that uses the workflow (2e, another page);
 * - `Edit workflow` is the one primary verb: it reopens the newest open draft,
 *   and only creates one (from the newest revision, the old “Customize”) when
 *   there is none;
 * - every number and label on the rail and the Used-in rows is the API's own:
 *   the pin's r-number resolves through the revision list, `· latest` is a
 *   digest comparison, the trigger sentences are the arrived schedules and
 *   issue triggers, and a failed read says it failed.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { PipelinePage } from "./Workflow";
import type { Draft, Me, PipelineRevision, PipelineRevisionSummary } from "../api/types";
import type { Assignment, Repository } from "../api/types";
import type { Schedule } from "../api/pipelines";
import type { IssueTrigger } from "../api/useIssueTriggers";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_ASSIGNMENT_ID,
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  WIRE_REVISION_ID,
  wireAssignmentList,
  wireDraftSummaries,
  wirePipeline,
  wireRevision,
  wireUserId,
  wireProjectId,
} from "../test/fixtures/m4/wire";

const admin: Me = { ...meFixture, is_org_admin: true };
const member: Me = { ...meFixture, is_org_admin: false };

const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const revisionsPath = `${pipelinePath}/revisions`;
const draftsPath = `${pipelinePath}/drafts`;
const NEW_DIGEST = wirePipeline.revisions[0].revision_digest;
const OLD_DIGEST = `sha256:${"4a4a".repeat(32)}`;
const detail = `/workflows/${WIRE_PIPELINE_ID}`;

/** A second project the caller maintains, with the older pin. */
const GADGETS_ID = "01987a6c-9999-7f1a-9b2c-3d4e5f6a7b80";
const gadgetsProject = { ...projectFixture, id: GADGETS_ID, name: "Gadgets", slug: "gadgets" };
const gadgetsAssignmentsPath = `/api/v1/projects/${GADGETS_ID}/assignments`;

const REPO_ID = "01987b22-0002-7000-8000-abcdef012345";
const PAYMENTS_REPO_ID = "01987b22-0003-7000-8000-abcdef012345";
const A2_ID = "01987b22-0004-7000-8000-abcdef012345";
const SCHEDULE_ID = "01987b22-0005-7000-8000-abcdef012345";
const ISSUE_TRIGGER_ID = "01987b22-0006-7000-8000-abcdef012345";
const RUN_WAITING_ID = "01987b11-0000-7000-8000-abcdef00009c1e";
const RUN_DONE_ID = "01987b11-0000-7000-8000-abcdef000071aa";

/** r7 — the newest published (the wire revision). */
const revisionRows = (): PipelineRevisionSummary[] => [
  { ...wirePipeline.revisions[0] },
  {
    ...wirePipeline.revisions[0],
    revision_number: 6,
    version_label: "6.0.0",
    revision_digest: OLD_DIGEST,
  },
];

/** The repo pin (ADR-0060): Widgets uses this workflow in `storefront`. */
const widgetsPin: Assignment = {
  ...wireAssignmentList.assignments[0],
  repository_id: REPO_ID,
  repository_name: "storefront",
};

/** Gadgets pinned the older revision project-wide — the `Update to r7` row. */
const gadgetsPin: Assignment = {
  ...wireAssignmentList.assignments[0],
  id: A2_ID,
  project_id: GADGETS_ID,
  pinned_revision_id: "01987b21-6666-7000-8000-abcdef012345",
  pinned_revision_digest: OLD_DIGEST,
  pinned_version_label: "6.0.0",
  repository_id: null,
  repository_name: null,
};

function repo(id: string, projectId: string, name: string): Repository {
  return {
    id,
    project_id: projectId,
    name,
    git_url: `https://example.invalid/${name}.git`,
    default_branch: "main",
    created_at: "2026-07-30T09:00:00Z",
    credential: "none",
  };
}

function wireSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: SCHEDULE_ID,
    project_id: wireProjectId,
    assignment_id: WIRE_ASSIGNMENT_ID,
    cron_expr: "0 6 * * 1",
    inputs: { goal: "weekly sweep", repository: "storefront" },
    enabled: true,
    next_run_at: "2099-01-02T06:00:00Z",
    last_run_at: "2026-07-27T06:00:00Z",
    last_run_id: RUN_WAITING_ID,
    version: 4,
    created_by: wireUserId,
    created_at: "2026-06-01T09:00:00Z",
    updated_at: "2026-07-27T06:00:00Z",
    ...overrides,
  };
}

const issueTrigger: IssueTrigger = {
  id: ISSUE_TRIGGER_ID,
  project_id: wireProjectId,
  assignment_id: WIRE_ASSIGNMENT_ID,
  repository_id: REPO_ID,
  event: "labeled",
  labels: ["plan"],
  inputs: {},
  enabled: true,
  version: 1,
  created_by: wireUserId,
  created_at: "2026-07-20T09:00:00Z",
  updated_at: "2026-07-20T09:00:00Z",
};

/** A `CrossProjectRunSummary` — the board row shape the pipeline-scoped runs
 * read serves. Only the members the page renders are load-bearing. */
function wireRun(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_WAITING_ID,
    project_id: wireProjectId,
    pipeline_id: WIRE_PIPELINE_ID,
    pipeline_revision_id: WIRE_REVISION_ID,
    assignment_id: WIRE_ASSIGNMENT_ID,
    revision_digest: NEW_DIGEST,
    plan_digest: wirePipeline.revisions[0].plan_digest,
    status: "waiting_human",
    depth: 0,
    priority: 5,
    created_at: "2026-07-31T06:00:00Z",
    project_name: projectFixture.name,
    pipeline_slug: wirePipeline.slug,
    pipeline_display_name: wirePipeline.display_name,
    steps: [],
    ...overrides,
  };
}

const runsBody = {
  runs: [
    wireRun(),
    wireRun({
      id: RUN_DONE_ID,
      status: "completed",
      assignment_id: A2_ID,
      project_id: GADGETS_ID,
      project_name: gadgetsProject.name,
    }),
  ],
  next_cursor: null,
};

function wireDraft(status: Draft["status"]): Draft {
  return {
    id: WIRE_DRAFT_ID,
    pipeline_id: WIRE_PIPELINE_ID,
    status,
    document_yaml: wireRevision.document_text,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: {},
    digest_scope: "v1alpha1-canonical-1",
    version: 12,
    edited_by: wireUserId,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
  };
}

const r6Revision: PipelineRevision = {
  ...wireRevision,
  id: "01987b21-6666-7000-8000-abcdef012345",
  revision_number: 6,
  version_label: "6.0.0",
  revision_digest: OLD_DIGEST,
};

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: admin },
    { path: pipelinePath, body: { ...wirePipeline, folder: "Delivery" } },
    { path: revisionsPath, body: { revisions: revisionRows() } },
    { path: draftsPath, body: wireDraftSummaries },
    { path: `/api/v1/revisions/${NEW_DIGEST}`, body: wireRevision },
    { path: `/api/v1/revisions/${NEW_DIGEST}/document`, body: wireRevision.document_text },
    { path: `/api/v1/revisions/${OLD_DIGEST}`, body: r6Revision },
    { path: `/api/v1/revisions/${OLD_DIGEST}/document`, body: r6Revision.document_text },
    { path: `/api/v1/revisions/${WIRE_REVISION_ID}`, body: wireRevision },
    { path: "/api/v1/projects", body: { items: [projectFixture, gadgetsProject] } },
    { path: `/api/v1/projects/${wireProjectId}/assignments`, body: { assignments: [widgetsPin] } },
    { path: gadgetsAssignmentsPath, body: { assignments: [gadgetsPin] } },
    {
      path: `/api/v1/projects/${wireProjectId}/schedules`,
      body: { schedules: [wireSchedule()] },
    },
    { path: `/api/v1/projects/${GADGETS_ID}/schedules`, body: { schedules: [] } },
    {
      path: `/api/v1/projects/${wireProjectId}/issue-triggers`,
      body: { issue_triggers: [issueTrigger] },
    },
    { path: `/api/v1/projects/${GADGETS_ID}/issue-triggers`, body: { issue_triggers: [] } },
    {
      path: `/api/v1/projects/${wireProjectId}/repos`,
      body: {
        items: [
          repo(REPO_ID, wireProjectId, "storefront"),
          repo(PAYMENTS_REPO_ID, wireProjectId, "payments"),
        ],
      },
    },
    { path: `/api/v1/projects/${GADGETS_ID}/repos`, body: { items: [] } },
    { path: "/api/v1/runs", body: runsBody },
  ];
  return [...overrides, ...base];
}

function mount(path: string, overrides: RouteStub[] = []) {
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workflows/:pipelineId" element={<PipelinePage />} />
          <Route path="/workflows/:pipelineId/yaml" element={<PipelinePage />} />
          <Route path="/workflows/:pipelineId/used-in" element={<PipelinePage />} />
          <Route path="/workflows/:pipelineId/history" element={<PipelinePage />} />
          {/* The Studio route itself is tested in Studio.test.tsx; this page
              only has to land the navigation there. */}
          <Route path="/workflows/:pipelineId/drafts/:draftId" element={<StudioRouteStub />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

/** Names where a draft navigation landed, in place of the real Studio page. */
function StudioRouteStub() {
  const { pipelineId = "", draftId = "" } = useParams();
  return <div data-testid="studio-route">{`${pipelineId} / ${draftId}`}</div>;
}

afterEach(cleanup);

/** Writes plus the fan-out refetches are more than testing-library's 1 s
 * default once the suite is deep (kept under vitest's 5 s per-test timeout). */
const settled = { timeout: 4000 };

describe("/workflows/:pipelineId — the header (1e)", () => {
  it("carries the breadcrumb, H1 + revision chip, the library line and exactly two actions", async () => {
    mount(detail);
    const header = await screen.findByTestId("pipeline-page");
    // Breadcrumb `Workflows / Delivery /` — the folder from the pipeline read,
    // so wait for that read to have arrived before reading the row.
    await screen.findByTestId("pipeline-header-meta");
    const crumb = within(header).getByTestId("workflow-breadcrumb");
    expect(crumb.textContent).toContain("Workflows");
    expect(crumb.textContent).toContain("Delivery");
    expect(crumb.textContent).toMatch(/\/$/);
    // H1 + chip.
    expect(within(header).getByRole("heading", { level: 1 }).textContent).toBe(
      wirePipeline.display_name,
    );
    expect((await screen.findByTestId("workflow-revision-chip")).textContent).toBe("published r7");
    // The pipeline's own description is the subtitle when it has one.
    expect(within(header).getByTestId("workflow-kind-line").textContent).toBe(
      wirePipeline.description,
    );
    // The slug line stays (`pipeline-header-meta`, read by the index test too).
    expect(within(header).getByTestId("pipeline-header-meta").textContent).toContain(
      wirePipeline.slug,
    );
    // The two design actions — and no Start run, and no trigger editing.
    const useButton = within(header).getByTestId("assign-open");
    expect(useButton.textContent).toBe("Use in a repo…");
    expect(within(header).getByTestId("pipeline-customize").textContent).toBe("Edit workflow");
    expect(within(header).queryByText(/Start run/i)).toBeNull();
    expect(within(header).queryByTestId(/trigger-add/)).toBeNull();
    // 390px: the header stacks (breadcrumb, title + chip, description, then
    // the actions in their own row) and only goes beside the title from `md`.
    expect(within(header).getByTestId("workflow-header-top").className).toContain("md:flex-row");
  });

  it("with no description the header carries the library sentence instead", async () => {
    mount(detail, [
      {
        path: pipelinePath,
        body: { ...wirePipeline, folder: "Delivery", description: "" },
      },
    ]);
    const line = await screen.findByTestId("workflow-kind-line");
    expect(line.textContent).toBe(
      "Library workflow. It runs only in the repos that use it, and triggers are set up there.",
    );
  });

  it("a never-published workflow says `· draft · not published` and offers no use path", async () => {
    mount(detail, [
      { path: revisionsPath, body: { revisions: [] } },
      { path: draftsPath, body: { drafts: [] } },
    ]);
    await screen.findByTestId("pipeline-page");
    const chip = await screen.findByTestId("workflow-revision-chip");
    expect(chip.textContent).toBe("· draft · not published");
    expect(screen.queryByTestId("assign-open")).toBeNull();
    // And the graph area says there is nothing to draw, rather than a guess.
    expect(await screen.findByTestId("overview-graph-empty")).toBeTruthy();
  });

  it("without the library role the edit verb is replaced by the one-line reason", async () => {
    mount(detail, [{ path: "/api/v1/me", body: member }]);
    await screen.findByTestId("pipeline-page");
    expect(screen.queryByTestId("pipeline-customize")).toBeNull();
    expect((await screen.findByTestId("workflow-author-hint")).textContent).toBe(
      "authoring needs the library role",
    );
    // Reading the uses is not authoring — the rail's use row is still shown.
    expect(await screen.findByTestId(`overview-used-in-${WIRE_ASSIGNMENT_ID}`)).toBeTruthy();
  });
});

describe("/workflows/:pipelineId — tabs are routes", () => {
  it("each tab link swaps the body without remounting the header", async () => {
    mount(detail);
    await screen.findByTestId("workflow-overview");
    fireEvent.click(screen.getByTestId("workflow-tab-yaml"));
    expect(await screen.findByTestId("workflow-yaml-tab")).toBeTruthy();
    expect(screen.queryByTestId("workflow-overview")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-tab-used-in"));
    expect(await screen.findByTestId("used-in")).toBeTruthy();
    expect(screen.queryByTestId("workflow-yaml-tab")).toBeNull();
    fireEvent.click(screen.getByTestId("workflow-tab-history"));
    expect(await screen.findByTestId("revision-list")).toBeTruthy();
    // The header stays up across the swap.
    expect(screen.getByTestId("pipeline-customize")).toBeTruthy();
  });

  it("a deep link to a tab route opens that tab, and the Used-in count comes from the rows", async () => {
    mount(`${detail}/used-in`);
    const tab = await screen.findByTestId("workflow-tab-used-in");
    expect(tab.getAttribute("aria-current")).toBe("page");
    // Two pins = the design's `Used in 2`.
    await waitFor(() => expect(tab.textContent).toContain("Used in 2"), settled);
  });
});

describe("Overview (1e)", () => {
  it("draws the graph on a full-bleed dotted canvas with the read-only caption", async () => {
    mount(detail);
    // The Overview canvas is the small read-only renderer (design 1e), not the
    // run-screen card: solid white cards, no zoom row, no visible list.
    const graph = await screen.findByTestId("workflow-graph");
    expect(graph).toBeTruthy();
    expect(screen.getByTestId("workflow-graph-node-plan")).toBeTruthy();
    // A scope child is a card too (the layout flattens bodies top-to-bottom).
    expect(screen.getByTestId("workflow-graph-node-build_until_verified-implement")).toBeTruthy();
    expect(screen.queryByTestId("definition-graph-zoom-out")).toBeNull();
    expect(screen.queryByTestId("definition-graph-list")).toBeNull();
    // The caption is the design's exact line, and the node list exists as
    // assistive text only.
    expect(screen.getByTestId("workflow-graph-caption").textContent).toBe(
      "read-only · r7 · Edit workflow opens the canvas on your draft",
    );
    expect(within(graph).getByTestId("workflow-graph-list").className).toContain("sr-only");
    // The dotted field runs behind the cards, edge to edge; the rail is the
    // design's full-height bordered column at its 285px measure. The layout
    // contract jsdom cannot measure is asserted as classes (pass-3): the
    // overview wrapper is a COLUMN flex (a row-direction flex would
    // content-size the grid — the collapsed-canvas bug), the grid fills it
    // with `minmax(0,1fr) 285px`, and the rail pins its own 285px.
    const canvas = screen.getByTestId("overview-canvas");
    expect(canvas.style.backgroundImage).toContain("radial-gradient");
    // Mobile canvas ~360px of dotted field before the rail stacks below.
    expect(canvas.className).toContain("min-h-[360px]");
    const overview = screen.getByTestId("workflow-overview");
    expect(overview.className).toContain("w-full");
    expect(overview.className).toContain("lg:grid-cols-[minmax(0,1fr)_285px]");
    const overviewWrapper = overview.parentElement as HTMLElement;
    expect(overviewWrapper.className).toContain("flex-1");
    expect(overviewWrapper.className).toContain("flex-col");
    expect(overview.className).toContain("flex-1");
    const rail = screen.getByTestId("overview-rail");
    expect(rail.className).toContain("lg:w-[285px]");
    expect(rail.className).toContain("lg:border-l");
    expect(rail.className).toContain("bg-surface");
    // The caption is one line, nowrap, whatever the canvas width.
    expect(screen.getByTestId("workflow-graph-caption").className).toContain(
      "lg:whitespace-nowrap",
    );
  });

  it("the rail answers draft / used-in / inputs / last-runs with the API's own values", async () => {
    mount(detail);
    // OPEN DRAFT: v12 by <name> · <age> · <status>, continuing to the Studio.
    const card = await screen.findByTestId("overview-draft-card");
    expect(within(card).getByTestId("overview-draft-line").textContent).toContain("v12");
    expect(within(card).getByTestId("overview-draft-line").textContent).toContain("Ada Lovelace");
    expect(within(card).getByTestId("overview-draft-line").textContent).toContain("invalid");
    expect(within(card).getByTestId("overview-draft-continue").getAttribute("href")).toBe(
      `/workflows/${WIRE_PIPELINE_ID}/drafts/${WIRE_DRAFT_ID}`,
    );
    // USED IN: project / repo and the trigger sentences.
    const rail = await screen.findByTestId("overview-used-in");
    expect(rail.textContent).toContain("Widgets / storefront");
    expect(rail.textContent).toContain("Gadgets / whole project");
    expect(await within(rail).findByTestId(`used-in-schedule-${SCHEDULE_ID}`)).toBeTruthy();
    expect(await within(rail).findByTestId(`used-in-issue-${ISSUE_TRIGGER_ID}`)).toBeTruthy();
    expect(within(rail).getByTestId(`used-in-manual-${A2_ID}`).textContent).toContain(
      "started by hand",
    );
    // INPUTS: the revision's own spec.inputs, in declared order.
    const goal = await screen.findByTestId("overview-input-goal");
    expect(goal.textContent).toContain("goal");
    expect(screen.getByTestId("overview-input-repository").textContent).toContain("repository");
    // LAST RUNS: the pipeline's runs, newest first — glyph, short id, word.
    const runs = await screen.findByTestId("overview-runs");
    expect(runs.textContent).toContain(`#${RUN_WAITING_ID.slice(-4)}`);
    expect(runs.textContent).toContain("waiting");
    expect(runs.textContent).toContain(`#${RUN_DONE_ID.slice(-4)}`);
    // The rail's assign shortcut opens the same dialog as the header.
    fireEvent.click(within(rail).getByTestId("used-in-rail-assign"));
    expect(await screen.findByTestId("use-in-repo-dialog")).toBeTruthy();
  });

  it("says `No runs yet` only when the runs read came back empty", async () => {
    mount(detail, [{ path: "/api/v1/runs", body: { runs: [], next_cursor: null } }]);
    const runs = await screen.findByTestId("overview-runs");
    const empty = await within(runs).findByTestId("overview-runs-empty", undefined, settled);
    expect(empty.textContent).toContain("No runs yet");
  });

  it("a failed runs read is named as a failure, not as zero runs", async () => {
    mount(detail, [
      {
        path: "/api/v1/runs",
        status: 500,
        body: { title: "Internal Server Error", status: 500 },
      },
    ]);
    const runs = await screen.findByTestId("overview-runs");
    expect(await within(runs).findByTestId("overview-runs-error", undefined, settled)).toBeTruthy();
    expect(within(runs).queryByTestId("overview-runs-empty")).toBeNull();
  });
});

describe("Used in tab (2a)", () => {
  it("one row per repo pin: repo over project, pinned rN, sentences, last run, Open ›", async () => {
    mount(`${detail}/used-in`);
    const row = await screen.findByTestId(`used-in-row-${WIRE_ASSIGNMENT_ID}`);
    expect(within(row).getByTestId(`used-in-repo-${WIRE_ASSIGNMENT_ID}`).textContent).toContain(
      "storefront",
    );
    expect(within(row).getByTestId(`used-in-project-${WIRE_ASSIGNMENT_ID}`).textContent).toContain(
      projectFixture.name,
    );
    // Same digest as the newest published → `· latest`.
    expect(within(row).getByTestId(`used-in-pin-${WIRE_ASSIGNMENT_ID}`).textContent).toContain(
      "pinned r7 · latest",
    );
    expect(within(row).getByTestId(`used-in-issue-${ISSUE_TRIGGER_ID}`).textContent).toContain(
      "issue labeled",
    );
    expect(within(row).getByTestId(`used-in-issue-${ISSUE_TRIGGER_ID}`).textContent).toContain(
      "plan",
    );
    // cronInWords of `0 6 * * 1`.
    expect(within(row).getByTestId(`used-in-schedule-${SCHEDULE_ID}`).textContent).toContain(
      "weekly Monday 06:00 UTC",
    );
    // Last run: the newest row that names this assignment.
    expect(within(row).getByText(new RegExp(`#${RUN_WAITING_ID.slice(-4)} waiting`))).toBeTruthy();
    // Open › goes to the repo page.
    expect(within(row).getByTestId(`used-in-open-${WIRE_ASSIGNMENT_ID}`).getAttribute("href")).toBe(
      `/p/${wireProjectId}/storefront`,
    );
    // The footnoted contract.
    expect((await screen.findByTestId("used-in-footnote")).textContent).toContain(
      "Open › goes to the repo page, where its triggers are edited.",
    );
    // Read-only: no trigger editing anywhere on the tab.
    expect(screen.queryByTestId(/trigger-add/)).toBeNull();
    expect(screen.queryByTestId(/trigger-edit/)).toBeNull();
  });

  it("a pin behind the newest offers Update to r7 and PATCHes the assignment's pinned revision", async () => {
    const patchPath = `/api/v1/assignments/${A2_ID}`;
    const { requests } = mount(`${detail}/used-in`, [
      {
        path: patchPath,
        method: "PATCH",
        body: { ...gadgetsPin, pinned_revision_digest: NEW_DIGEST, pinned_version_label: "7.0.0" },
      },
    ]);
    const row = await screen.findByTestId(`used-in-row-${A2_ID}`);
    expect(within(row).getByTestId(`used-in-pin-${A2_ID}`).textContent).toContain("pinned r6");
    const update = within(row).getByTestId(`used-in-update-${A2_ID}`);
    expect(update.textContent).toBe("Update to r7");
    await waitFor(() => expect((update as HTMLButtonElement).disabled).toBe(false), settled);
    fireEvent.click(update);
    await waitFor(() => expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1), settled);
    // The PATCH carries the uuid, resolved from the newest published digest.
    const body = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}");
    expect(body).toEqual({ pinned_revision_id: WIRE_REVISION_ID });
  });

  it("a project-wide pin links Open › to the project's Pipelines tab", async () => {
    mount(`${detail}/used-in`);
    const row = await screen.findByTestId(`used-in-row-${A2_ID}`);
    expect(within(row).getByTestId(`used-in-open-${A2_ID}`).getAttribute("href")).toBe(
      `/p/${GADGETS_ID}/pipelines`,
    );
  });

  it("unused: the honest empty state", async () => {
    mount(`${detail}/used-in`, [
      { path: `/api/v1/projects/${wireProjectId}/assignments`, body: { assignments: [] } },
      { path: gadgetsAssignmentsPath, body: { assignments: [] } },
    ]);
    const panel = await screen.findByTestId("used-in");
    expect(await within(panel).findByTestId("used-in-empty", undefined, settled)).toBeTruthy();
    expect(within(panel).getByText(/Not used in any repo yet/)).toBeTruthy();
  });
});

describe("YAML tab (2d)", () => {
  it("block style with line numbers, copy · download, and the revision picker", async () => {
    mount(`${detail}/yaml`);
    const view = await screen.findByTestId("yaml-view");
    expect(within(view).getByTestId("yaml-view-line-1").textContent).toContain(
      "apiVersion: communication.dev/v1alpha1",
    );
    // The wire document spells `required` in flow — the tab shows block.
    expect(view.textContent).not.toContain("required: [goal");
    expect(view.textContent).toContain("- goal");
    expect(within(view).getByTestId("yaml-view-line-2").textContent).toContain("kind:");
    expect(screen.getByTestId("yaml-view-copy")).toBeTruthy();
    expect(screen.getByTestId("yaml-view-download")).toBeTruthy();
    expect((await screen.findByTestId("yaml-tab-label")).textContent).toContain("r7 · 7.0.0");
    // The picker switches revisions; the r6 row is its own digest's document.
    const select = (await screen.findByTestId("yaml-revision-select")) as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(["r7 · 7.0.0", "r6 · 6.0.0"]);
    fireEvent.change(select, { target: { value: OLD_DIGEST } });
    await waitFor(
      () => expect(screen.getByTestId("yaml-tab-label").textContent).toContain("r6"),
      settled,
    );
  });

  it("never published: the tab says so instead of an empty dump", async () => {
    mount(`${detail}/yaml`, [{ path: revisionsPath, body: { revisions: [] } }]);
    expect(await screen.findByTestId("yaml-empty")).toBeTruthy();
  });
});

describe("History tab (1e)", () => {
  it("carries the REVISIONS and DRAFTS panels; a revision row opens its YAML", async () => {
    mount(`${detail}/history`);
    const list = await screen.findByTestId("revision-list");
    const rows = await within(list).findAllByTestId(/^revision-row-/, undefined, settled);
    expect(rows).toHaveLength(2);
    const row = within(list).getByTestId("revision-row-7");
    expect(row.textContent).toContain("r7 7.0.0");
    fireEvent.click(row);
    expect(await screen.findByTestId("workflow-yaml-tab", undefined, settled)).toBeTruthy();
    expect(await screen.findByTestId("yaml-view")).toBeTruthy();
  });

  it("draft rows hand the draft to the Studio; the flood collapses to five", async () => {
    const flood = Array.from({ length: 8 }, (_, index) => ({
      id: `${WIRE_DRAFT_ID.slice(0, 18)}${String(index).padStart(4, "0")}`,
      status: "invalid" as const,
      version: 1,
      updated_at: `2026-07-${String(28 - index).padStart(2, "0")}T08:00:00Z`,
      edited_by: wireUserId,
    }));
    mount(`${detail}/history`, [{ path: draftsPath, body: { drafts: flood } }]);
    await screen.findByTestId(`draft-row-${flood[0].id}`);
    const list = await screen.findByTestId("draft-list");
    expect(within(list).getAllByTestId(/^draft-row-/)).toHaveLength(5);
    expect(within(list).getByTestId(`draft-edited-by-${flood[0].id}`).textContent).toContain(
      "Ada Lovelace",
    );
    fireEvent.click(screen.getByTestId("draft-list-more"));
    expect(within(list).getAllByTestId(/^draft-row-/)).toHaveLength(8);
    fireEvent.click(within(list).getByTestId(`draft-row-${flood[2].id}`));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(flood[2].id);
  });

  it("New draft clones the newest revision's document and lands on the Studio route", async () => {
    const { requests } = mount(`${detail}/history`, [
      { path: draftsPath, method: "POST", status: 201, body: wireDraft("draft") },
      { path: draftsPath, body: { drafts: [] } },
    ]);
    fireEvent.click(await screen.findByTestId("pipeline-new-draft"));
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1), settled);
    expect(requestsTo(requests, draftsPath, "POST")[0].body).toContain(
      "apiVersion: communication.dev/v1alpha1",
    );
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
  });
});

describe("Edit workflow — the one primary verb", () => {
  it("reopens the newest open draft without a POST", async () => {
    const { requests } = mount(detail);
    fireEvent.click(await screen.findByTestId("pipeline-customize"));
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
    expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(0);
  });

  it("with no open draft it creates one from the newest revision", async () => {
    const { requests } = mount(detail, [
      { path: draftsPath, method: "POST", status: 201, body: wireDraft("draft") },
      { path: draftsPath, body: { drafts: [] } },
    ]);
    fireEvent.click(await screen.findByTestId("pipeline-customize"));
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1), settled);
    expect(requestsTo(requests, draftsPath, "POST")[0].body).toContain(
      "apiVersion: communication.dev/v1alpha1",
    );
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
  });
});

describe("Use in a repo… (ADR-0060)", () => {
  async function openDialog() {
    fireEvent.click(await screen.findByTestId("assign-open"));
    return screen.findByTestId("use-in-repo-dialog");
  }

  it("a repo pin POSTs the assignment with repository_id and the newest revision uuid", async () => {
    const createPath = `/api/v1/projects/${wireProjectId}/assignments`;
    const { requests } = mount(detail, [
      {
        path: createPath,
        method: "POST",
        status: 201,
        body: {
          ...widgetsPin,
          id: "01987b22-0009-7000-8000-abcdef012345",
          repository_id: PAYMENTS_REPO_ID,
          repository_name: "payments",
        },
      },
    ]);
    const dialog = await openDialog();
    // The pin line states the truth about what gets pinned — the newest row.
    expect(within(dialog).getByTestId("assign-pin-line").textContent).toContain("r7");
    // Both projects already use the workflow somewhere and still have a free
    // pair; their arrived state is stated, not hidden.
    expect(within(dialog).getByTestId(`assign-project-pin-${wireProjectId}`).textContent).toContain(
      "storefront pins r7",
    );
    expect(within(dialog).getByTestId(`assign-project-pin-${GADGETS_ID}`).textContent).toContain(
      "whole project pins r6 (an older revision)",
    );
    fireEvent.change(within(dialog).getByTestId("assign-project-select"), {
      target: { value: wireProjectId },
    });
    const repoSelect = (await within(dialog).findByTestId(
      "assign-repo-select",
    )) as HTMLSelectElement;
    // The already-pinned repo is not offered; the whole-project slot still is.
    await waitFor(() =>
      expect([...repoSelect.options].map((o) => o.textContent)).toEqual([
        "— select a repository —",
        "whole project (every repo in it)",
        "payments",
      ]),
    );
    fireEvent.change(repoSelect, { target: { value: PAYMENTS_REPO_ID } });
    const confirm = within(dialog).getByTestId("assign-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false), settled);
    fireEvent.click(confirm);
    await waitFor(() => expect(requestsTo(requests, createPath, "POST")).toHaveLength(1), settled);
    const body = JSON.parse(requestsTo(requests, createPath, "POST")[0].body ?? "{}");
    expect(body.pipeline_id).toBe(WIRE_PIPELINE_ID);
    expect(body.pinned_revision_id).toBe(WIRE_REVISION_ID);
    expect(body.repository_id).toBe(PAYMENTS_REPO_ID);
    expect(body.max_concurrent_runs).toBe(1);
    // Success names the new use and links to the Used-in tab.
    const panel = await screen.findByTestId("assign-success-panel", undefined, settled);
    expect(within(panel).getByTestId("assign-success-label").textContent).toContain(
      "Used in Widgets / payments",
    );
  });

  it("`whole project` posts repository_id null (ADR-0060)", async () => {
    const createPath = `/api/v1/projects/${wireProjectId}/assignments`;
    const { requests } = mount(detail, [
      {
        path: createPath,
        method: "POST",
        status: 201,
        body: {
          ...widgetsPin,
          id: "01987b22-0008-7000-8000-abcdef012345",
          repository_id: null,
          repository_name: null,
        },
      },
    ]);
    const dialog = await openDialog();
    // Gadgets is used whole-project already and owns no repositories — its
    // only pair is taken, so it is not offered; Widgets still has its
    // whole-project slot free.
    const projectSelect = (await screen.findByTestId("assign-project-select")) as HTMLSelectElement;
    await waitFor(() =>
      expect([...projectSelect.options].map((o) => o.textContent)).toEqual([
        "— select a project —",
        projectFixture.name,
      ]),
    );
    fireEvent.change(projectSelect, { target: { value: wireProjectId } });
    const repoSelect = (await within(dialog).findByTestId(
      "assign-repo-select",
    )) as HTMLSelectElement;
    // storefront is pinned already — only the whole-project slot and the free
    // repository are offered.
    await waitFor(() =>
      expect([...repoSelect.options].map((o) => o.textContent)).toEqual([
        "— select a repository —",
        "whole project (every repo in it)",
        "payments",
      ]),
    );
    fireEvent.change(repoSelect, { target: { value: "__whole__" } });
    const confirm = within(dialog).getByTestId("assign-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false), settled);
    fireEvent.click(confirm);
    await waitFor(() => expect(requestsTo(requests, createPath, "POST")).toHaveLength(1), settled);
    const body = JSON.parse(requestsTo(requests, createPath, "POST")[0].body ?? "{}");
    expect(body.repository_id).toBeNull();
  });

  it("the store's `409` (that pair already exists) keeps the server's words inline", async () => {
    const createPath = `/api/v1/projects/${wireProjectId}/assignments`;
    mount(detail, [
      {
        path: createPath,
        method: "POST",
        status: 409,
        body: {
          title: "Conflict",
          status: 409,
          detail: "assignment already exists for this project, pipeline and repository",
        },
      },
    ]);
    const dialog = await openDialog();
    await screen.findByTestId("assign-project-select", undefined, settled);
    fireEvent.change(within(dialog).getByTestId("assign-project-select"), {
      target: { value: wireProjectId },
    });
    const repoSelect = (await within(dialog).findByTestId(
      "assign-repo-select",
    )) as HTMLSelectElement;
    fireEvent.change(repoSelect, { target: { value: "__whole__" } });
    const confirm = within(dialog).getByTestId("assign-confirm");
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false), settled);
    fireEvent.click(confirm);
    const error = await screen.findByTestId("assign-error", undefined, settled);
    expect(error.textContent).toContain("assignment already exists");
  });

  it("no maintainer project: the dead end says so and links to the projects list", async () => {
    mount(detail, [{ path: "/api/v1/projects", body: { items: [projectFixture] } }]);
    // Re-point the one project at a non-maintainer role.
    cleanup();
    mount(detail, [
      {
        path: "/api/v1/projects",
        body: {
          items: [{ ...projectFixture, my_role: "viewer" as const }],
        },
      },
    ]);
    fireEvent.click(await screen.findByTestId("assign-open"));
    const line = await screen.findByTestId("assign-no-maintainer");
    expect(line.textContent).toContain("You maintain no project");
    expect(screen.getByTestId("assign-projects-link").getAttribute("href")).toBe("/");
  });
});

describe("legacy and layout", () => {
  it("`?draft=` replace-navigates to the Studio route (the old URL shape)", async () => {
    mount(`${detail}?draft=${WIRE_DRAFT_ID}`);
    expect((await screen.findByTestId("studio-route")).textContent).toContain(WIRE_DRAFT_ID);
    expect(screen.queryByTestId("pipeline-page")).toBeNull();
  });

  it("bleeds to the shell's content column, never under the sidebar", async () => {
    // Repeats the desktop shell's geometry — a 240px sticky sidebar, then the
    // content column that holds the page's <main> — as the old library page
    // test did; jsdom does no layout, so the rects are stubbed.
    mockFetch(routes());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[detail]}>
          <div data-testid="content-column">
            <main>
              <Routes>
                <Route path="/workflows/:pipelineId" element={<PipelinePage />} />
              </Routes>
            </main>
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const page = (await screen.findByTestId("pipeline-page")) as HTMLElement;
    const mainEl = page.parentElement as HTMLElement;
    const column = mainEl.parentElement as HTMLElement;
    const rect = (left: number, width: number) =>
      ({
        left,
        right: left + width,
        top: 0,
        bottom: 0,
        width,
        height: 0,
        x: left,
        y: 0,
      }) as DOMRect;
    Object.defineProperty(column, "clientWidth", { value: 1260, configurable: true });
    column.getBoundingClientRect = () => rect(240, 1260);
    mainEl.getBoundingClientRect = () => rect(370, 1000);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(page.getAttribute("data-full-width")).toBe("1260"));
    // The negative margin pulls the page to the column's left edge (240px, the
    // sidebar's right edge); nothing runs under the sidebar.
    expect(page.style.marginLeft).toBe("-130px");
    expect(page.style.width).toBe("1260px");
    // And the mobile-safe primitives are in place: the tab row scrolls inside
    // itself, the body stacks below lg.
    const tabs = screen.getByTestId("workflow-tabs");
    expect(tabs.className).toContain("overflow-x-auto");
    expect(screen.getByTestId("workflow-overview").className).toContain("grid-cols-1");
  });
});
