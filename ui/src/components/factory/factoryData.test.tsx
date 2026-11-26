/**
 * factoryData — the Factory index's mapping, tested in the two halves it has:
 * the pure document → chips → states pipeline (no fetch, no clock), and the
 * hook against the fake fetch (which reads fire, and what a scope keeps).
 */
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  applyRunStates,
  capStepChips,
  documentStepChips,
  thumbAriaLabel,
  thumbStateOfRunStep,
  thumbStepKind,
  triggerSentence,
  useFactoryWorkflows,
} from "./factoryData";
import type { CrossProjectRunSummary } from "../../api/home";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import type { Pipeline, PipelineList, ProjectList } from "../../api/types";
import type { AssignmentList } from "../../api/types";
import type { ScheduleList } from "../../api/pipelines";
import type { IssueTriggerList } from "../../api/useIssueTriggers";
import { mockFetch, projectFixture, type RouteStub } from "../../test/fakes";

afterEach(cleanup);

/* ------------------------------------------------------- pure mapping */

function doc(
  nodes: { id: string; kind: string; body?: { id: string; kind: string }[] }[],
): DefinitionDocument {
  return {
    apiVersion: "communication.dev/v1alpha1",
    kind: "Pipeline",
    spec: {
      nodes: nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        ...(node.body ? { config: { body: { nodes: node.body } } } : {}),
      })),
    },
  };
}

describe("thumbStepKind", () => {
  it("maps the catalogue onto the five shapes, and nothing else", () => {
    expect(thumbStepKind("agent.acp")).toBe("agent");
    expect(thumbStepKind("model.chat")).toBe("agent");
    expect(thumbStepKind("process.exec")).toBe("command");
    expect(thumbStepKind("human.approval")).toBe("approval");
    expect(thumbStepKind("git.publish")).toBe("git");
    // A kind the catalogue does not name is `other`, never an invented shape.
    expect(thumbStepKind("quanta.measure")).toBe("other");
    expect(thumbStepKind("condition")).toBe("other");
  });
});

describe("documentStepChips", () => {
  it("keeps the document's own order and ids", () => {
    const chips = documentStepChips(
      doc([
        { id: "plan", kind: "agent.acp" },
        { id: "test", kind: "process.exec" },
        { id: "approve", kind: "human.approval" },
      ]),
    );
    expect(chips.map((chip) => chip.id)).toEqual(["plan", "test", "approve"]);
    expect(chips.map((chip) => chip.kind)).toEqual(["agent", "command", "approval"]);
  });

  it("folds a scope node to one loop chip naming its own children", () => {
    const chips = documentStepChips(
      doc([
        { id: "plan", kind: "agent.acp" },
        {
          id: "loop",
          kind: "until",
          body: [
            { id: "implement", kind: "agent.acp" },
            { id: "test", kind: "process.exec" },
          ],
        },
      ]),
    );
    // The body's nodes never appear as their own chips.
    expect(chips.map((chip) => chip.label)).toEqual(["plan", "loop: implement · test"]);
  });

  it("says nothing for a workflow that has no document", () => {
    expect(documentStepChips(null)).toEqual([]);
  });
});

describe("capStepChips", () => {
  it("shows six chips, the last one the overflow it hides", () => {
    const many = doc(
      Array.from({ length: 9 }, (_unused, index) => ({
        id: `step${index}`,
        kind: "process.exec",
      })),
    );
    const chips = capStepChips(documentStepChips(many));
    expect(chips).toHaveLength(6);
    expect(chips[5]?.label).toBe("+4");
    expect(chips.slice(0, 5).map((chip) => chip.id)).toEqual([
      "step0",
      "step1",
      "step2",
      "step3",
      "step4",
    ]);
  });

  it("leaves a short chain alone", () => {
    const few = capStepChips(documentStepChips(doc([{ id: "plan", kind: "agent.acp" }])));
    expect(few.map((chip) => chip.label)).toEqual(["plan"]);
  });
});

function liveRun(overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary {
  return {
    id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
    project_id: projectFixture.id,
    pipeline_id: "pipe-1",
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
    steps: [
      { node_id: "plan", kind: "agent.acp", state: "succeeded" },
      { node_id: "test", kind: "process.exec", state: "running" },
      { node_id: "approve", kind: "human.approval", state: "pending" },
    ],
    ...overrides,
  };
}

const steps = [
  { id: "trigger", label: "manual", kind: "trigger" as const, state: "idle" as const },
  { id: "plan", label: "plan", kind: "agent" as const, state: "idle" as const },
  { id: "test", label: "test", kind: "command" as const, state: "idle" as const },
  { id: "approve", label: "approve", kind: "approval" as const, state: "idle" as const },
];

describe("applyRunStates", () => {
  it("leaves every chip idle when no run is live", () => {
    expect(applyRunStates(steps, null)).toEqual(steps);
  });

  it("paints the run's own projection onto the chips", () => {
    const painted = applyRunStates(steps, liveRun());
    expect(painted.map((step) => step.state)).toEqual(["running", "done", "running", "idle"]);
  });

  it("reads a held run as waiting, the gate included", () => {
    const held = liveRun({
      status: "waiting_human",
      steps: [
        { node_id: "plan", kind: "agent.acp", state: "succeeded" },
        { node_id: "test", kind: "process.exec", state: "waiting" },
        { node_id: "approve", kind: "human.approval", state: "pending" },
      ],
    });
    const painted = applyRunStates(steps, held);
    expect(painted.map((step) => step.state)).toEqual(["waiting", "done", "waiting", "idle"]);
  });

  it("maps the wire's seven step states onto the five", () => {
    expect(thumbStateOfRunStep("skipped")).toBe("done");
    expect(thumbStateOfRunStep("cancelled")).toBe("failed");
    expect(thumbStateOfRunStep("pending")).toBe("idle");
  });
});

describe("thumbAriaLabel", () => {
  it("counts the steps and names the one that needs the eye", () => {
    expect(thumbAriaLabel(applyRunStates(steps, liveRun()))).toBe(
      "3 steps; step 'test' is running",
    );
  });
  it("prefers the gate a run is waiting on", () => {
    const held = applyRunStates(
      steps,
      liveRun({
        status: "waiting_human",
        steps: [
          { node_id: "plan", kind: "agent.acp", state: "succeeded" },
          { node_id: "test", kind: "process.exec", state: "skipped" },
          { node_id: "approve", kind: "human.approval", state: "waiting" },
        ],
      }),
    );
    expect(thumbAriaLabel(held)).toBe("3 steps; step 'approve' is waiting on an approval");
  });
  it("says only the count with nothing live", () => {
    expect(thumbAriaLabel(steps)).toBe("3 steps");
  });
});

describe("triggerSentence", () => {
  it("words a labeled issue trigger first, in lower case", () => {
    expect(triggerSentence([], [{ event: "labeled", labels: ["ready"] }])).toEqual({
      text: "when an issue gets 'ready'",
      word: "issue",
    });
  });
  it("falls back to the trigger's event words when it watches every issue", () => {
    expect(triggerSentence([], [{ event: "opened", labels: [] }])).toEqual({
      text: "when an issue is opened",
      word: "issue",
    });
  });
  it("reads a cron with the app's one cron reader, never its own", () => {
    expect(triggerSentence(["0 9 * * 1-5"], []).text).toBe("every weekday at 09:00 UTC");
    expect(triggerSentence([null, "0 9 * * 1-5"], []).word).toBe("schedule");
  });
  it("names the hand start when nothing fires it", () => {
    expect(triggerSentence([null], [])).toEqual({ text: "when you start it", word: "manual" });
    expect(triggerSentence([], [])).toEqual({ text: "when you start it", word: "manual" });
  });
});

/* ------------------------------------------------------------- the hook */

const PIPELINE_ID = "01987b20-0000-7000-8000-abcdef012345";
const OTHER_PIPELINE_ID = "01987b20-0001-7000-8000-abcdef012345";
const PROJECT_TWO = {
  ...projectFixture,
  id: "01987a6c-4d5e-7f1a-9b2c-3d4e5f6a7b81",
  name: "Project Two",
};
const DIGEST = `sha256:${"3f2f".repeat(32)}`;

function pipelineFixture(id: string, slug: string): Pipeline {
  return {
    id,
    slug,
    display_name: slug,
    description: "",
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
  };
}

const pipelinesList: PipelineList = {
  pipelines: [
    {
      id: PIPELINE_ID,
      slug: "wf-1",
      display_name: "Workflow One",
      latest_revision_number: 1,
      revision_count: 1,
      archived: false,
    },
    {
      id: OTHER_PIPELINE_ID,
      slug: "wf-2",
      display_name: "Workflow Two",
      latest_revision_number: 0,
      revision_count: 0,
      archived: false,
    },
  ],
};

const assignments: AssignmentList = {
  assignments: [
    {
      id: "assign-1",
      project_id: projectFixture.id,
      pipeline_id: PIPELINE_ID,
      pinned_revision_id: "rev-1",
      pinned_revision_digest: DIGEST,
      max_concurrent_runs: 1,
      budget_overrides: {},
      effective_budgets: {},
      enabled: true,
      version: 1,
      created_at: "2026-11-03T10:00:00Z",
      updated_at: "2026-11-03T10:00:00Z",
    },
  ],
};

function routesFor(stubs: Partial<Record<string, RouteStub>> = {}): RouteStub[] {
  const base: RouteStub[] = [
    {
      path: "/api/v1/projects",
      body: { items: [projectFixture, PROJECT_TWO] } satisfies ProjectList,
    },
    { path: "/api/v1/pipelines", body: pipelinesList },
    { path: `/api/v1/pipelines/${PIPELINE_ID}`, body: pipelineFixture(PIPELINE_ID, "wf-1") },
    {
      path: `/api/v1/pipelines/${OTHER_PIPELINE_ID}`,
      body: {
        ...pipelineFixture(OTHER_PIPELINE_ID, "wf-2"),
        revisions: [],
        latest_revision_number: 0,
        revision_count: 0,
      },
    },
    { path: `/api/v1/pipelines/${PIPELINE_ID}/drafts`, body: { drafts: [] } },
    { path: `/api/v1/pipelines/${OTHER_PIPELINE_ID}/drafts`, body: { drafts: [] } },
    {
      path: `/api/v1/revisions/${DIGEST}`,
      body: {
        id: "rev-1",
        pipeline_id: PIPELINE_ID,
        draft_id: "draft-1",
        revision_number: 1,
        version_label: "1.0.0",
        api_version: "communication.dev/v1alpha1",
        canonical_document: doc([
          { id: "plan", kind: "agent.acp" },
          { id: "test", kind: "process.exec" },
        ]),
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
    { path: `/api/v1/projects/${projectFixture.id}/assignments`, body: assignments },
    { path: `/api/v1/projects/${PROJECT_TWO.id}/assignments`, body: { assignments: [] } },
    {
      path: `/api/v1/projects/${projectFixture.id}/schedules`,
      body: { schedules: [] } satisfies ScheduleList,
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/issue-triggers`,
      body: {
        issue_triggers: [
          {
            id: "trig-1",
            project_id: projectFixture.id,
            assignment_id: "assign-1",
            repository_id: "repo-1",
            event: "labeled",
            labels: ["ready"],
            inputs: {},
            enabled: true,
            version: 1,
            created_by: "01987a61-2345-7000-8000-abcdef012345",
            created_at: "2026-11-03T10:00:00Z",
            updated_at: "2026-11-03T10:00:00Z",
          },
        ],
      } satisfies IssueTriggerList,
    },
    {
      path: "/api/v1/runs",
      body: {
        runs: [
          {
            ...liveRun(),
            pipeline_id: PIPELINE_ID,
            steps: [
              { node_id: "plan", kind: "agent.acp", state: "succeeded" },
              { node_id: "test", kind: "process.exec", state: "running" },
            ],
          },
          {
            ...liveRun({ id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a0000", status: "completed" }),
            pipeline_id: PIPELINE_ID,
          },
        ],
        next_cursor: null,
      },
    },
  ];
  return base.map((stub) => stubs[stub.path] ?? stub);
}

function wrapper(routes: RouteStub[]) {
  const { fetchMock } = mockFetch(routes);
  void fetchMock;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useFactoryWorkflows", () => {
  it("builds a strip whose first chip is the trigger, from the published document", async () => {
    const { result } = renderHook(() => useFactoryWorkflows(null), {
      wrapper: wrapper(routesFor()),
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    const item = result.current.items.find((entry) => entry.pipeline.id === PIPELINE_ID);
    expect(item?.steps.map((step) => step.label)).toEqual(["issue", "plan", "test"]);
    expect(item?.triggerText).toBe("when an issue gets 'ready'");
    expect(item?.steps[0]?.kind).toBe("trigger");
    expect(item?.steps[2]?.state).toBe("running");
  });

  it("keeps only the workflows the scoped project pins, and its own runs", async () => {
    const { result } = renderHook(() => useFactoryWorkflows(projectFixture.id), {
      wrapper: wrapper(routesFor()),
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.items.map((entry) => entry.pipeline.id)).toEqual([PIPELINE_ID]);
    expect(result.current.liveRuns.every((run) => run.project_id === projectFixture.id)).toBe(true);
  });

  it("lists every workflow the person can see with no scope", async () => {
    const { result } = renderHook(() => useFactoryWorkflows(null), {
      wrapper: wrapper(routesFor()),
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
    expect(result.current.items.map((entry) => entry.pipeline.id)).toEqual([
      PIPELINE_ID,
      OTHER_PIPELINE_ID,
    ]);
    // The unassigned one has nothing to word but the hand start, and nothing
    // to draw but the trigger: a draft-only workflow invents no steps.
    const other = result.current.items[1];
    expect(other?.triggerText).toBe("when you start it");
    expect(other?.steps.map((step) => step.state)).toEqual(["idle"]);
    expect(other?.steps[0]?.label).toBe("manual");
  });

  it("reports a failed list read instead of an empty factory", async () => {
    const broken = routesFor({
      "/api/v1/pipelines": { path: "/api/v1/pipelines", status: 500, body: null },
    });
    const { result } = renderHook(() => useFactoryWorkflows(null), { wrapper: wrapper(broken) });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.items).toEqual([]);
  });
});
