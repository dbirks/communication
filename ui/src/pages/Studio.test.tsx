/**
 * The Workflow Studio route: TopBarLeft breadcrumb & draft status, top-right
 * Versions / Try it / Make live / "..." actions, 800ms debounced autosave,
 * GoalFrame / WrapPanel callbacks, AgentStepCard overlay, ?run= live state,
 * synthetic Trigger node, phone sheets, and assistant proposal lifecycle.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft, Me, ValidateResponse } from "../api/types";
import {
  claudeProfile,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  wirePipeline,
  wireDraftSummaries,
  wireRevision,
  wireUserId,
} from "../test/fixtures/m4/wire";
import { validValidation, w8DraftYaml, w8Validation } from "../test/fixtures/m4/w8Draft";
import { samplePipelineYaml } from "../test/fixtures/m4/samplePipeline";
import { uiLayoutOfText } from "../components/studio/useStudioDraft";
import type { GoalSpec } from "../components/studio/wrap/wrapModel";
import type { VerdictRound } from "../components/studio/wrap/VerdictStack";
import { StudioPage } from "./Studio";

// The canvas is the heaviest child (React Flow) and is covered by its own
// suite; here the stub mirrors the props the page hands down and exposes
// callback hooks for integration assertions.
vi.mock("../components/studio/StudioCanvas", () => ({
  StudioCanvas: (props: {
    showToolIsland?: boolean;
    onIslandAdd?: (kind: string, pos: { x: number; y: number }) => void;
    stale?: boolean;
    staleMessage?: string;
    readOnly?: boolean;
    selectedId?: string | null;
    selectedIds?: string[];
    highlight?: string[];
    direction?: string;
    tool?: string;
    phone?: boolean;
    statusOverlay?: Record<string, { state: string; label: string }>;
    verdictsByScope?: Record<string, VerdictRound[]>;
    trigger?: { subline: string; onClick: () => void } | null;
    onSelectionChange?: (ids: string[]) => void;
    onSelect?: (id: string | null) => void;
    onWrapRepeat?: (ids: string[], goal: GoalSpec) => void;
    onWrapSideBySide?: (ids: string[]) => void;
    onEditGoal?: (scopeId: string, goal: GoalSpec) => void;
    onUnwrap?: (scopeId: string) => void;
    onOpenInspector?: (nodeId: string) => void;
    renderNodeOverlay?: (arg: {
      nodeId: string;
      placement: { left: number; top: number; side: "right" | "left" };
      sheet: boolean;
    }) => React.ReactNode;
  }) => {
    const statusObj = props.statusOverlay ?? {};
    return (
      <div
        data-testid="studio-canvas"
        data-direction={props.direction ?? "TB"}
        data-tool={props.tool ?? "select"}
        data-phone={props.phone ? "true" : "false"}
        data-stale={props.stale ? "true" : "false"}
        data-read-only={props.readOnly ? "true" : "false"}
        data-selected={props.selectedId ?? ""}
        data-selected-count={props.selectedIds ? props.selectedIds.length : 0}
        data-highlight-count={props.highlight ? props.highlight.length : 0}
        data-trigger-subline={props.trigger?.subline ?? ""}
      >
        {props.stale ? props.staleMessage : "canvas"}
        <div data-testid="mock-status-overlay">{JSON.stringify(statusObj)}</div>
        <div data-testid="mock-verdicts">{JSON.stringify(props.verdictsByScope ?? {})}</div>
        {props.trigger ? (
          <button type="button" data-testid="mock-trigger-node" onClick={props.trigger.onClick}>
            Trigger: {props.trigger.subline}
          </button>
        ) : null}
        {props.showToolIsland && (
          <button
            type="button"
            data-testid="tool-island"
            onClick={() => props.onIslandAdd?.("agent.acp", { x: 20, y: 40 })}
          >
            Add Agent
          </button>
        )}
        <button
          type="button"
          data-testid="mock-select-plan"
          onClick={() => props.onSelectionChange?.(["plan"])}
        >
          Select plan
        </button>
        <button
          type="button"
          data-testid="mock-select-pair"
          onClick={() => props.onSelectionChange?.(["plan", "check"])}
        >
          Select steps
        </button>
        <button
          type="button"
          data-testid="mock-wrap-repeat"
          onClick={() =>
            props.onWrapRepeat?.(["plan", "check"], {
              kind: "judge",
              text: "tests pass and diff is clean",
              maxRounds: 3,
            })
          }
        >
          Wrap repeat
        </button>
        <button
          type="button"
          data-testid="mock-wrap-side"
          onClick={() => props.onWrapSideBySide?.(["plan", "check"])}
        >
          Wrap side
        </button>
        <button
          type="button"
          data-testid="mock-edit-goal"
          onClick={() =>
            props.onEditGoal?.("until", {
              kind: "command",
              text: "npm test",
              maxRounds: 5,
            })
          }
        >
          Edit goal
        </button>
        <button type="button" data-testid="mock-unwrap" onClick={() => props.onUnwrap?.("until")}>
          Unwrap scope
        </button>
        <button
          type="button"
          data-testid="mock-open-inspector"
          onClick={() => props.onOpenInspector?.("until")}
        >
          Open inspector
        </button>
        {props.selectedId
          ? props.renderNodeOverlay?.({
              nodeId: props.selectedId,
              placement: { left: 320, top: 80, side: "right" },
              sheet: Boolean(props.phone),
            })
          : null}
      </div>
    );
  },
}));

const admin: Me = { ...meFixture, is_org_admin: true };
const member: Me = { ...meFixture, is_org_admin: false };
const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const draftPath = `/api/v1/drafts/${WIRE_DRAFT_ID}`;
const validatePath = `${draftPath}/validate`;
const publishPath = `${draftPath}/publish`;
const digest = wirePipeline.revisions[0].revision_digest;

function parseableDraft(validation?: ValidateResponse): Draft {
  return wireDraft("invalid", validation, samplePipelineYaml);
}

function wireDraft(
  status: Draft["status"],
  validation?: ValidateResponse,
  yaml: string = w8DraftYaml,
  uiLayout: Draft["ui_layout"] = {},
): Draft {
  return {
    id: WIRE_DRAFT_ID,
    pipeline_id: WIRE_PIPELINE_ID,
    status,
    document_yaml: yaml,
    source_kind: "manual",
    source_sha256: "0".repeat(64),
    ui_layout: uiLayout,
    digest_scope: "v1alpha1-canonical-1",
    ...(validation ? { validation } : {}),
    version: 12,
    edited_by: wireUserId,
    created_at: "2026-07-31T08:00:00Z",
    updated_at: "2026-07-31T08:12:00Z",
  };
}

function routes(overrides: RouteStub[] = []): RouteStub[] {
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: admin },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/projects", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: pipelinePath, body: wirePipeline },
    { path: draftPath, body: wireDraft("invalid", w8Validation as ValidateResponse) },
    {
      path: draftPath,
      method: "PUT",
      body: wireDraft("invalid", w8Validation as ValidateResponse),
    },
    { path: validatePath, method: "POST", body: w8Validation },
    { path: publishPath, method: "POST", status: 201, body: wireRevision },
    { path: `/api/v1/revisions/${digest}`, body: wireRevision },
    { path: `/api/v1/revisions/${digest}/document`, body: wireRevision.document_text },
  ];
  return [...overrides, ...base];
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname + location.search}</output>;
}

function mount(path: string, overrides: RouteStub[] = [], withTopBarSlot = false) {
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      {withTopBarSlot ? <div id="top-bar-left-slot" data-testid="top-bar-left-slot" /> : null}
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/factory/:pipelineId" element={<StudioPage />} />
          <Route path="/p/:projectId/factory/:pipelineId" element={<StudioPage />} />
          <Route path="/workflows/:pipelineId/drafts/:draftId" element={<StudioPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

const studioPath = `/workflows/${WIRE_PIPELINE_ID}/drafts/${WIRE_DRAFT_ID}`;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Workflow editor (rx-editor R5)", () => {
  it("renders LR canvas, TopBarLeft breadcrumb, top-right controls, and hides StudioHeader/StudioStatusBar", async () => {
    mount(
      studioPath,
      [{ path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) }],
      true,
    );

    const slot = await screen.findByTestId("top-bar-left-slot");
    expect((await within(slot).findByTestId("studio-title")).textContent).toBe(
      "Feature development",
    );
    expect(within(slot).getByTestId("studio-breadcrumb-workflows").getAttribute("href")).toBe(
      "/factory",
    );
    // Review-1 09-1280-3: ONE line — the scope segment is present in an
    // unscoped editor as “All projects” and links to that scope's home.
    const scopeLink = within(slot).getByTestId("studio-breadcrumb-project");
    expect(scopeLink.textContent).toBe("All projects");
    expect(scopeLink.getAttribute("href")).toBe("/");
    // The draft status rides the SAME line (never a second line under the
    // breadcrumb): the container does not wrap.
    expect(scopeLink.closest("div")?.className).toContain("flex-nowrap");
    // Review-1 09-1280-6: the trigger step is always drawn first — a
    // workflow with no assignment or schedule starts “when you start it”.
    const triggerNode = await screen.findByTestId("mock-trigger-node");
    expect(triggerNode.textContent).toContain("when you start it");
    expect(within(slot).getByTestId("studio-draft-status").textContent).toContain("Your draft");

    expect(screen.queryByTestId("studio-header")).toBeNull();
    expect(screen.queryByTestId("studio-status-bar")).toBeNull();
    expect(screen.queryByTestId("studio-palette")).toBeNull();
    expect(screen.queryByTestId("studio-view-canvas")).toBeNull();
    expect(screen.queryByTestId("studio-view-yaml")).toBeNull();

    expect(screen.getByTestId("editor-versions-btn")).toBeTruthy();
    expect(screen.getByTestId("editor-try-it-btn")).toBeTruthy();
    expect(screen.getByTestId("studio-publish").textContent).toBe("Make live");
    expect(screen.getByTestId("editor-more-btn")).toBeTruthy();

    const canvas = await screen.findByTestId("studio-canvas");
    expect(canvas.getAttribute("data-direction")).toBe("LR");
    expect(canvas.getAttribute("data-stale")).toBe("false");
    expect(screen.getByTestId("tool-island")).toBeTruthy();
  });

  it("opens AgentStepCard beside an agent step and switches to full inspector via More settings", async () => {
    const simpleAgentYaml = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
      config:
        profile: reviewer
        prompt: Inspect recent changes.
`;
    mount(studioPath, [
      { path: draftPath, body: wireDraft("invalid", undefined, simpleAgentYaml) },
    ]);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(screen.getByTestId("mock-select-plan"));

    const card = await screen.findByTestId("agent-step-card");
    expect(card.textContent).toContain("AGENT STEP");
    expect((screen.getByTestId("agent-card-name") as HTMLInputElement).value).toBe("plan");
    const promptBox = screen.getByTestId("agent-card-prompt") as HTMLTextAreaElement;
    expect(promptBox.rows).toBeGreaterThanOrEqual(6);
    expect(promptBox.value).toBe("Inspect recent changes.");

    // Edit prompt via card (commits on blur) -> YAML panel reflects it
    fireEvent.change(promptBox, { target: { value: "Review unit test coverage first." } });
    fireEvent.blur(promptBox);
    fireEvent.click(screen.getByTestId("agent-card-more-settings"));
    expect(await screen.findByTestId("editor-inspector-panel")).toBeTruthy();
    expect(screen.queryByTestId("agent-step-card")).toBeNull();

    // Close inspector and open Edit as YAML via "..." menu
    fireEvent.click(screen.getByTestId("editor-inspector-close"));
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    expect(screen.getByTestId("editor-menu-yaml").textContent).toBe("Edit as YAML");
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(await screen.findByTestId("editor-panel-yaml")).toBeTruthy();
    expect((screen.getByTestId("studio-yaml") as HTMLTextAreaElement).value).toContain(
      "Review unit test coverage first.",
    );
  });

  it("adds an agent from ToolIsland, selects it, and preserves long titles safely", async () => {
    const longName = "Long workflow title that keeps its full title attribute";
    mount(studioPath, [
      { path: pipelinePath, body: { ...wirePipeline, display_name: longName } },
      { path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) },
    ]);
    const title = await screen.findByTestId("studio-title");
    expect(title.textContent).toBe(longName);
    expect(title.getAttribute("title")).toBe(longName);

    fireEvent.click(await screen.findByTestId("tool-island"));
    expect(screen.queryByTestId("studio-op-error")).toBeNull();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-selected")).toBeTruthy();
    expect(await screen.findByTestId("agent-step-card")).toBeTruthy();
  });

  it("starts a new agent step on the project's default agent (ADR-0086)", async () => {
    const projectId = projectFixture.id;
    const defaultProfile = {
      id: "prof-project-default",
      name: "Team default",
      launcher_id: "claude",
      permission_mode: "ask",
      created_at: "2026-11-20T10:00:00Z",
      version: 1,
    };
    mount(`/p/${projectId}/factory/${WIRE_PIPELINE_ID}?draft=${WIRE_DRAFT_ID}`, [
      { path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) },
      {
        path: `/api/v1/projects/${projectId}`,
        body: {
          ...projectFixture,
          default_agent_profile_id: defaultProfile.id,
          default_agent_profile_name: defaultProfile.name,
        },
      },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, defaultProfile] } },
    ]);

    await screen.findByTestId("studio-canvas");
    fireEvent.click(screen.getByTestId("tool-island"));

    // The card the new step opens with already carries the project's default.
    const card = await screen.findByTestId("agent-step-card");
    await waitFor(() =>
      expect(within(card).getByTestId("agent-card-picker").textContent).toContain(
        defaultProfile.name,
      ),
    );
  });

  it("with no project scope a new agent step still starts on no profile", async () => {
    // No `/p/` prefix and no remembered scope: there is no project to ask.
    window.sessionStorage.removeItem("communication.scope");
    mount(studioPath, [
      { path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    ]);

    await screen.findByTestId("studio-canvas");
    fireEvent.click(screen.getByTestId("tool-island"));

    const card = await screen.findByTestId("agent-step-card");
    expect(within(card).getByTestId("agent-card-picker").textContent).toContain("Choose agent");
  });

  it("debounces autosave by 800ms after edits and bakes layout into metadata.ui", async () => {
    const layout = { nodes: { plan: { x: 114.25, y: 203.485 } } };
    const simpleYaml = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
      config:
        profile: reviewer
        prompt: Initial prompt
`;
    const { requests } = mount(studioPath, [
      {
        path: draftPath,
        body: wireDraft("invalid", validValidation as ValidateResponse, simpleYaml, layout),
      },
    ]);
    await screen.findByTestId("studio-canvas");
    vi.useFakeTimers();

    fireEvent.click(screen.getByTestId("tool-island"));
    // Before 800ms elapses, no PUT has fired
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(0);

    // At 800ms+, the debounced autosave fires with the version and metadata.ui
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(1);
    const body = JSON.parse(requestsTo(requests, draftPath, "PUT")[0].body ?? "{}") as {
      version?: number;
      document_yaml?: string;
      ui_layout?: unknown;
    };
    expect(body.version).toBe(12);
    expect(body).not.toHaveProperty("ui_layout");
    expect(uiLayoutOfText(body.document_yaml ?? "")?.nodes?.plan).toEqual(layout.nodes.plan);
  });

  it("hides Make live and editing affordances without the library role", async () => {
    mount(studioPath, [{ path: "/api/v1/me", body: member }]);
    expect((await screen.findByTestId("studio-read-only-note")).textContent).toContain(
      "library role",
    );
    expect(screen.queryByTestId("studio-publish")).toBeNull();
    expect((await screen.findByTestId("studio-canvas")).getAttribute("data-read-only")).toBe(
      "true",
    );
  });

  it("Make live runs validation when invalid and renders findings with go-to-node", async () => {
    const { requests } = mount(studioPath, [{ path: draftPath, body: parseableDraft() }]);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(await screen.findByTestId("studio-publish"));

    await waitFor(() => expect(requestsTo(requests, validatePath, "POST")).toHaveLength(1));
    expect(requestsTo(requests, publishPath, "POST")).toHaveLength(0);

    const drawer = await screen.findByTestId("studio-validate-drawer");
    expect(screen.getByTestId("studio-validate-verdict").textContent).toContain("invalid");
    const findings = within(drawer).getAllByTestId(/^studio-validate-finding-/);
    expect(findings[0].textContent).toContain("duplicate_key");

    fireEvent.click(within(drawer).getByTestId("studio-goto-node-0"));
    await waitFor(() => expect(screen.queryByTestId("studio-validate-drawer")).toBeNull());
    expect(screen.getByTestId("studio-canvas").getAttribute("data-selected")).toBeTruthy();
  });

  it("Make live publishes when server verdict is already valid and prints the revision", async () => {
    const { requests } = mount(studioPath, [
      { path: draftPath, body: wireDraft("valid", validValidation as ValidateResponse) },
    ]);
    const publishBtn = (await screen.findByTestId("studio-publish")) as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(false);
    fireEvent.click(publishBtn);

    await waitFor(() => expect(requestsTo(requests, publishPath, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, publishPath, "POST")[0].body ?? "{}") as {
      version?: number;
    };
    expect(body.version).toBe(12);
    expect((await screen.findByTestId("studio-published")).textContent).toContain("r7");
  });

  it("opens Versions panel, previews an older revision read-only with banner, and restores as draft", async () => {
    const { requests } = mount(studioPath, [
      {
        path: `/api/v1/runs`,
        body: {
          runs: [
            {
              id: "run-1",
              pipeline_id: WIRE_PIPELINE_ID,
              revision_digest: digest,
              status: "completed",
            },
          ],
        },
      },
      { path: draftPath, body: parseableDraft(validValidation as ValidateResponse) },
    ]);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(screen.getByTestId("editor-versions-btn"));

    const panel = await screen.findByTestId("versions-panel");
    expect(within(panel).getByTestId("versions-row-draft")).toBeTruthy();
    const revRow = within(panel).getByTestId(`versions-row-v${wireRevision.revision_number}`);
    expect(revRow.textContent).toContain("LIVE");
    await waitFor(() => expect(revRow.textContent).toContain("ran 1 time"));

    // Click revision to preview read-only
    fireEvent.click(within(panel).getByTestId(`versions-select-v${wireRevision.revision_number}`));
    const banner = await screen.findByTestId("version-viewing-banner");
    expect(banner.textContent).toContain(`Viewing v${wireRevision.revision_number}`);
    expect(screen.getByTestId("studio-canvas").getAttribute("data-read-only")).toBe("true");

    // Restore revision back into the draft
    fireEvent.click(within(panel).getByTestId(`versions-restore-v${wireRevision.revision_number}`));
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/revisions/${digest}`).length).toBeGreaterThanOrEqual(2),
    );
    await waitFor(() => expect(screen.queryByTestId("version-viewing-banner")).toBeNull());
  });

  it("wraps selection in Repeat until, updates goal, unwraps, and wraps Side by side", async () => {
    const wrapYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: wrap-test
spec:
  nodes:
    - id: plan
      kind: agent.acp
    - id: check
      kind: process.exec
      dependsOn: [plan]
`;
    mount(studioPath, [{ path: draftPath, body: wireDraft("invalid", undefined, wrapYaml) }]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("mock-wrap-repeat"));
    await waitFor(() =>
      expect(screen.getByTestId("studio-canvas").getAttribute("data-selected")).toBe("until"),
    );
    expect(screen.queryByTestId("editor-inspector-panel")).toBeNull();

    // Open full inspector explicitly (via GoalFrame "More settings" or node menu).
    fireEvent.click(screen.getByTestId("mock-open-inspector"));
    expect(await screen.findByTestId("editor-inspector-panel")).toBeTruthy();

    // Open YAML panel to verify the until scope + goal judge step
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(((await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement).value).toContain(
      "kind: until",
    );
    expect((screen.getByTestId("studio-yaml") as HTMLTextAreaElement).value).toContain("GOAL_MET");
    fireEvent.click(screen.getByTestId("editor-panel-close"));

    // Edit goal to command kind, then unwrap
    fireEvent.click(screen.getByTestId("mock-edit-goal"));
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(((await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement).value).toContain(
      "executable: npm",
    );
    fireEvent.click(screen.getByTestId("editor-panel-close"));

    fireEvent.click(screen.getByTestId("mock-unwrap"));
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(((await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement).value).not.toContain(
      "kind: until",
    );
    fireEvent.click(screen.getByTestId("editor-panel-close"));

    // Side by side wrap keeps the new scope selected without opening the inspector
    fireEvent.click(screen.getByTestId("mock-wrap-side"));
    await waitFor(() =>
      expect(screen.getByTestId("studio-canvas").getAttribute("data-selected")).toBe("parallel"),
    );
    expect(screen.queryByTestId("editor-inspector-panel")).toBeNull();
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(((await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement).value).toContain(
      "kind: parallel",
    );
  });

  it("renders ?run=<runId> read-only overlay, VerdictStack judge reason, and top-center run banner", async () => {
    const runId = "01987a61-1111-7000-8000-aaaaaaaaaaaa";
    const judgeLoopYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: run-test
spec:
  nodes:
    - id: build_loop
      kind: until
      config:
        maxIterations: 4
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
              config:
                profile: coder
                prompt: Implement feature.
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                profile: judge
                prompt: 'Decide whether this goal is met: "All tests pass". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
`;
    const runRecord = {
      id: runId,
      project_id: "proj-1",
      pipeline_id: WIRE_PIPELINE_ID,
      pipeline_revision_id: wireRevision.id,
      revision_digest: digest,
      plan_digest: "0".repeat(64),
      digest_scope: "v1alpha1-canonical-1",
      status: "running",
      depth: 0,
      placement: { scheduled: true },
      expression_evaluations: 0,
      created_at: "2026-07-31T08:00:00Z",
    };
    const runNodes = {
      run_id: runId,
      revision_digest: digest,
      node_executions: [
        {
          id: "ne-0",
          run_id: runId,
          node_id: "build_loop",
          node_instance_key: "/build_loop",
          scope_key: "",
          kind: "until",
          execution_location: "server",
          status: "running",
          attempt_count: 1,
          attempt_limit: 1,
          in_flight: true,
          artifact_refs: [],
        },
        {
          id: "ne-1",
          run_id: runId,
          node_id: "code",
          node_instance_key: "/build_loop[1]/code",
          scope_key: "/build_loop[1]",
          kind: "agent.acp",
          execution_location: "worker",
          status: "succeeded",
          attempt_count: 1,
          attempt_limit: 1,
          in_flight: false,
          artifact_refs: [],
        },
        {
          id: "ne-2",
          run_id: runId,
          node_id: "judge",
          node_instance_key: "/build_loop[1]/judge",
          scope_key: "/build_loop[1]",
          kind: "agent.acp",
          execution_location: "worker",
          status: "succeeded",
          attempt_count: 1,
          attempt_limit: 1,
          in_flight: false,
          artifact_refs: [],
        },
        {
          id: "ne-3",
          run_id: runId,
          node_id: "code",
          node_instance_key: "/build_loop[2]/code",
          scope_key: "/build_loop[2]",
          kind: "agent.acp",
          execution_location: "worker",
          status: "running",
          attempt_count: 1,
          attempt_limit: 1,
          in_flight: true,
          artifact_refs: [],
        },
      ],
    };

    mount(`/factory/${WIRE_PIPELINE_ID}?run=${runId}`, [
      {
        path: `/api/v1/revisions/${digest}`,
        body: { ...wireRevision, canonical_document: undefined, document_text: judgeLoopYaml },
      },
      {
        path: `/api/v1/revisions/${wireRevision.id}`,
        body: { ...wireRevision, canonical_document: undefined, document_text: judgeLoopYaml },
      },
      { path: `/api/v1/runs/${runId}`, body: runRecord },
      { path: `/api/v1/runs/${runId}/nodes`, body: runNodes },
      { path: `/api/v1/runs/${runId}/events`, body: { items: [] } },
      {
        path: `/api/v1/runs/${runId}/nodes/ne-2`,
        body: {
          execution: runNodes.node_executions[1],
          attempts: [
            {
              id: "att-2",
              attempt_number: 1,
              status: "succeeded",
              outputs: { text: "NOT_YET\nUnit suite failed on auth middleware." },
            },
          ],
          artifacts: [],
        },
      },
    ]);

    const banner = await screen.findByTestId("studio-run-banner");
    expect(banner.textContent).toContain("Run");
    await waitFor(() => expect(banner.textContent).toContain("running"));
    expect(screen.getByTestId("studio-run-open").getAttribute("href")).toBe(`/runs/${runId}`);

    const canvas = screen.getByTestId("studio-canvas");
    expect(canvas.getAttribute("data-read-only")).toBe("true");
    await waitFor(() =>
      expect(screen.getByTestId("mock-verdicts").textContent).toContain(
        "Unit suite failed on auth middleware.",
      ),
    );
    expect(screen.getByTestId("mock-status-overlay").textContent).toContain("build_loop");
  });

  // A run leaves steps behind it that it never produced a row for: the branch
  // a `verdict` skipped, everything after a failed step, the body of a loop the
  // run never entered. The canvas has to say so — a box with no glyph and no
  // word reads as "no state", which is not a state a reader can act on.
  it("marks a step the run never produced as not started, and names the run's state up top", async () => {
    const runId = "01987a61-2222-7000-8000-aaaaaaaaaaaa";
    const loopYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: run-unreached
spec:
  nodes:
    - id: build_loop
      kind: until
      config:
        maxIterations: 3
        passWhen: 'nodes.judge.outputs.text.contains("GOAL_MET")'
        body:
          nodes:
            - id: code
              kind: agent.acp
              config:
                profile: coder
                prompt: Implement feature.
            - id: judge
              kind: agent.acp
              dependsOn: [code]
              config:
                profile: judge
                prompt: 'Decide whether this goal is met: "All tests pass". Answer with exactly GOAL_MET or NOT_YET on the first line, then one sentence why.'
`;
    const row = (id: string, nodeId: string, key: string, kind: string, status: string) => ({
      id,
      run_id: runId,
      node_id: nodeId,
      node_instance_key: key,
      scope_key: "",
      kind,
      execution_location: kind === "agent.acp" ? "worker" : "server",
      status,
      attempt_count: 1,
      attempt_limit: 1,
      in_flight: status === "running",
      artifact_refs: [],
    });
    const runRecord = {
      id: runId,
      project_id: "proj-1",
      pipeline_id: WIRE_PIPELINE_ID,
      pipeline_revision_id: wireRevision.id,
      revision_digest: digest,
      plan_digest: "0".repeat(64),
      digest_scope: "v1alpha1-canonical-1",
      status: "failed",
      depth: 0,
      placement: { scheduled: true },
      expression_evaluations: 0,
      created_at: "2026-07-31T08:00:00Z",
    };
    const runNodes = {
      run_id: runId,
      revision_digest: digest,
      // The loop started; its judge step never got a row at all.
      node_executions: [
        row("ne-0", "build_loop", "/build_loop", "until", "running"),
        row("ne-1", "code", "/build_loop[1]/code", "agent.acp", "failed"),
      ],
    };

    mount(`/factory/${WIRE_PIPELINE_ID}?run=${runId}`, [
      {
        path: `/api/v1/revisions/${wireRevision.id}`,
        body: { ...wireRevision, canonical_document: undefined, document_text: loopYaml },
      },
      { path: `/api/v1/runs/${runId}`, body: runRecord },
      { path: `/api/v1/runs/${runId}/nodes`, body: runNodes },
      { path: `/api/v1/runs/${runId}/events`, body: { items: [] } },
    ]);

    await screen.findByTestId("studio-run-banner");
    // The overlay arrives with the run reads; wait for the shape rather than
    // the first paint (an un-overlaid canvas is a legitimate intermediate).
    const overlay = await waitFor(() => {
      const parsed = JSON.parse(
        screen.getByTestId("mock-status-overlay").textContent ?? "{}",
      ) as Record<string, { state: string; label: string }>;
      expect(parsed.judge).toBeDefined();
      return parsed;
    });
    expect(overlay.judge).toEqual({ state: "queued", label: "not started", executionId: null });
    // The boxes the run did produce keep their real state.
    expect(overlay.code?.label).toBe("failed");

    // The top bar says which run this is and what became of it — never "Your
    // draft", which is a claim about a draft the reader is not looking at.
    const status = await screen.findByTestId("studio-draft-status");
    expect(status.textContent).toContain(`Run ${runId.slice(-8)}`);
    expect(status.textContent).toContain("failed");
    expect(status.textContent).not.toContain("draft");
    expect(screen.getByTestId("studio-run-banner").textContent).toContain("×");
  });

  // Observed on a real three-round loop whose `check` step never passed: the
  // rounds all ran clean, so the scope's roll-up was `done`, and the card beside
  // the frame said "✓ goal met" about a run that FAILED. The loop's own row is
  // the last word on its goal.
  it("says a loop that gave up is not met, whatever its rounds look like", async () => {
    const runId = "01987a61-3333-7000-8000-aaaaaaaaaaaa";
    const cmdLoopYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: run-gave-up
spec:
  nodes:
    - id: prove_loop
      kind: until
      config:
        maxIterations: 2
        passWhen: 'nodes.check.outputs.exit_code == 0'
        body:
          nodes:
            - id: check
              kind: process.exec
              config:
                executable: "false"
                args: []
`;
    const row = (id: string, key: string, status: string) => ({
      id,
      run_id: runId,
      node_id: id === "ne-loop" ? "prove_loop" : "check",
      node_instance_key: key,
      scope_key: "",
      kind: key === "/prove_loop" ? "until" : "process.exec",
      execution_location: "worker",
      status,
      attempt_count: 1,
      attempt_limit: 1,
      in_flight: false,
      artifact_refs: [],
    });
    const runNodes = {
      run_id: runId,
      revision_digest: digest,
      node_executions: [
        row("ne-loop", "/prove_loop", "failed"),
        row("ne-1", "/prove_loop[1]/check", "succeeded"),
        row("ne-2", "/prove_loop[2]/check", "succeeded"),
      ],
    };
    const checkDetail = (outputs: Record<string, unknown>) => ({
      execution: { ...row("ne-1", "/prove_loop[1]/check", "succeeded") },
      attempts: [{ id: "att-1", attempt_number: 1, status: "succeeded", outputs }],
      artifacts: [],
    });

    mount(`/factory/${WIRE_PIPELINE_ID}?run=${runId}`, [
      {
        path: `/api/v1/revisions/${wireRevision.id}`,
        body: { ...wireRevision, canonical_document: undefined, document_text: cmdLoopYaml },
      },
      {
        path: `/api/v1/runs/${runId}`,
        body: {
          id: runId,
          project_id: "proj-1",
          pipeline_id: WIRE_PIPELINE_ID,
          pipeline_revision_id: wireRevision.id,
          revision_digest: digest,
          plan_digest: "0".repeat(64),
          digest_scope: "v1alpha1-canonical-1",
          status: "failed",
          depth: 0,
          placement: { scheduled: true },
          expression_evaluations: 0,
          created_at: "2026-07-31T08:00:00Z",
        },
      },
      { path: `/api/v1/runs/${runId}/nodes`, body: runNodes },
      { path: `/api/v1/runs/${runId}/events`, body: { items: [] } },
      {
        path: `/api/v1/runs/${runId}/nodes/ne-1`,
        body: checkDetail({ exit_code: 1 }),
      },
      {
        path: `/api/v1/runs/${runId}/nodes/ne-2`,
        body: checkDetail({ exit_code: 1 }),
      },
    ]);

    const verdicts = await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId("mock-verdicts").textContent ?? "{}") as Record<
        string,
        { n: number; verdict: string }[]
      >;
      expect(parsed.prove_loop?.length).toBe(2);
      return parsed;
    });
    expect(verdicts.prove_loop?.map((r) => r.verdict)).toEqual(["not_yet", "not_yet"]);
  });

  // A round whose verdict step has not answered yet is not a round that failed.
  // The pending row used to fall through to "× not yet", so a loop in flight
  // showed two losses before its second judge had even started.
  it("says a round still in flight is judging, not lost", async () => {
    const runId = "01987a61-4444-7000-8000-aaaaaaaaaaaa";
    const cmdLoopYaml = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: run-in-flight
spec:
  nodes:
    - id: prove_loop
      kind: until
      config:
        maxIterations: 3
        passWhen: 'nodes.check.outputs.exit_code == 0'
        body:
          nodes:
            - id: check
              kind: process.exec
              config:
                executable: "false"
                args: []
`;
    const row = (id: string, nodeId: string, key: string, status: string) => ({
      id,
      run_id: runId,
      node_id: nodeId,
      node_instance_key: key,
      scope_key: "",
      kind: nodeId === "prove_loop" ? "until" : "process.exec",
      execution_location: "worker",
      status,
      attempt_count: 1,
      attempt_limit: 1,
      in_flight: status === "leased",
      artifact_refs: [],
    });

    mount(`/factory/${WIRE_PIPELINE_ID}?run=${runId}`, [
      {
        path: `/api/v1/revisions/${wireRevision.id}`,
        body: { ...wireRevision, canonical_document: undefined, document_text: cmdLoopYaml },
      },
      {
        path: `/api/v1/runs/${runId}`,
        body: {
          id: runId,
          project_id: "proj-1",
          pipeline_id: WIRE_PIPELINE_ID,
          pipeline_revision_id: wireRevision.id,
          revision_digest: digest,
          plan_digest: "0".repeat(64),
          digest_scope: "v1alpha1-canonical-1",
          status: "running",
          depth: 0,
          placement: { scheduled: true },
          expression_evaluations: 0,
          created_at: "2026-07-31T08:00:00Z",
        },
      },
      {
        path: `/api/v1/runs/${runId}/nodes`,
        body: {
          run_id: runId,
          revision_digest: digest,
          node_executions: [
            row("ne-loop", "prove_loop", "/prove_loop", "leased"),
            row("ne-1", "check", "/prove_loop[1]/check", "succeeded"),
            row("ne-2", "check", "/prove_loop[2]/check", "pending"),
          ],
        },
      },
      { path: `/api/v1/runs/${runId}/events`, body: { items: [] } },
      {
        path: `/api/v1/runs/${runId}/nodes/ne-1`,
        body: {
          execution: row("ne-1", "check", "/prove_loop[1]/check", "succeeded"),
          attempts: [{ id: "a1", attempt_number: 1, status: "succeeded", outputs: {} }],
          artifacts: [],
        },
      },
    ]);

    const verdicts = await waitFor(() => {
      const parsed = JSON.parse(screen.getByTestId("mock-verdicts").textContent ?? "{}") as Record<
        string,
        { n: number; verdict: string }[]
      >;
      expect(parsed.prove_loop?.length).toBe(2);
      return parsed;
    });
    expect(verdicts.prove_loop?.map((r) => [r.n, r.verdict])).toEqual([
      [1, "not_yet"],
      [2, "running"],
    ]);
  });

  it("surfaces synthetic Trigger node from project schedules and opens TriggersDialog on click", async () => {
    mount(studioPath, [
      { path: draftPath, body: parseableDraft() },
      {
        path: "/api/v1/projects",
        body: { items: [{ id: "proj-1", slug: "backend", name: "Backend", description: "" }] },
      },
      {
        path: "/api/v1/projects/proj-1/assignments",
        body: {
          assignments: [
            {
              id: "assign-1",
              project_id: "proj-1",
              pipeline_id: WIRE_PIPELINE_ID,
              pipeline_revision_id: wireRevision.id,
            },
          ],
        },
      },
      {
        path: "/api/v1/projects/proj-1/schedules",
        body: {
          schedules: [
            {
              id: "sched-1",
              project_id: "proj-1",
              pipeline_id: WIRE_PIPELINE_ID,
              assignment_id: "assign-1",
              cron_expr: "0 9 * * 1-5",
              timezone: "UTC",
              enabled: true,
            },
          ],
        },
      },
      { path: "/api/v1/projects/proj-1/repositories", body: { items: [] } },
      { path: "/api/v1/projects/proj-1/issue-triggers", body: { issue_triggers: [] } },
    ]);

    const triggerBtn = await screen.findByTestId("mock-trigger-node");
    expect(triggerBtn.textContent).toContain("every weekday");
    fireEvent.click(triggerBtn);
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  });

  it("renders icon-only controls and phone bottom sheets below 768px", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    mount(studioPath, [
      { path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) },
    ]);
    const page = await screen.findByTestId("studio-page");
    expect(page.getAttribute("data-phone")).toBe("true");
    expect(screen.getByTestId("studio-canvas").getAttribute("data-phone")).toBe("true");
    // Open YAML panel as a fixed bottom sheet on phone
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    const yamlSheet = await screen.findByTestId("editor-panel-yaml");
    expect(yamlSheet.className).toContain("bottom-0");
  });

  it("keeps the page heading over a failed draft read", async () => {
    mount(studioPath, [
      {
        path: draftPath,
        status: 500,
        body: { type: "server_error", title: "Internal server error", detail: "draft gone" },
      },
    ]);
    expect(await screen.findByTestId("studio-breadcrumb")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Feature development" })).toBeTruthy();
    const alert = await screen.findByTestId("studio-draft-error");
    expect(alert.textContent).toContain("draft gone");
    expect(screen.getByTestId("studio-draft-retry").textContent).toBe("Retry");
    expect(screen.queryByTestId("studio-canvas")).toBeNull();
  });

  it("opens the current user's open draft on /factory/:pipelineId and creates one on first edit", async () => {
    const factoryPath = `/factory/${WIRE_PIPELINE_ID}`;
    const draftsPath = `${pipelinePath}/drafts`;

    const { requests } = mount(factoryPath, [
      { path: draftsPath, method: "GET", body: { drafts: [] } },
      {
        path: draftsPath,
        method: "POST",
        body: wireDraft("invalid", undefined, wireRevision.document_text),
      },
    ]);
    await screen.findByTestId("studio-canvas");
    expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("tool-island"));
    await waitFor(() => expect(requestsTo(requests, draftsPath, "POST")).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toContain(`?draft=${WIRE_DRAFT_ID}`),
    );

    cleanup();
    const second = mount(factoryPath, [
      { path: "/api/v1/me", body: { ...admin, id: wireUserId } },
      { path: draftsPath, body: wireDraftSummaries },
    ]);
    expect((await screen.findByTestId("studio-draft-status")).textContent).toContain("Your draft");
    expect(requestsTo(second.requests, draftPath)).toHaveLength(1);
  });
});

describe("the assistant proposal lifecycle (via Workflow settings)", () => {
  const proposalPath = "/api/v1/assistant/draft-proposals";
  const proposalOp = {
    op: "insert_after",
    after: "publish_needs_attention",
    kind: "agent.acp",
    id: "assistant_note",
    config: { profile: "m4-reviewer", prompt: "Summarise the approved plan for the log." },
  };

  async function mountPreviewing(overrides: RouteStub[] = []) {
    const { requests } = mount(studioPath, [
      ...overrides,
      { path: draftPath, body: parseableDraft() },
      {
        path: proposalPath,
        method: "POST",
        body: {
          op: proposalOp,
          node_ids: ["assistant_note"],
          summary: "inserted assistant_note after publish_needs_attention",
          version: 12,
        },
      },
    ]);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-settings"));
    fireEvent.click(await screen.findByTestId("assistant-proposal-footer"));
    fireEvent.change(screen.getByTestId("assistant-proposal-input"), {
      target: { value: "Add a note agent at the end" },
    });
    fireEvent.click(screen.getByTestId("assistant-proposal-submit"));
    await screen.findByTestId("assistant-proposal-caption");
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("1");
    expect(screen.getByTestId("studio-proposal-caption")).toBeTruthy();
    return { requests };
  }

  it("clears the highlight when Apply saves", async () => {
    const { requests } = await mountPreviewing();
    fireEvent.click(screen.getByTestId("assistant-proposal-apply"));
    await waitFor(() => expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(1));
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("0");
    expect(screen.queryByTestId("assistant-proposal-caption")).toBeNull();
  });

  it("keeps the preview and shows the error when Apply fails", async () => {
    await mountPreviewing([
      {
        path: draftPath,
        method: "PUT",
        status: 500,
        body: { type: "server_error", title: "Internal server error", detail: "boom" },
      },
    ]);
    fireEvent.click(screen.getByTestId("assistant-proposal-apply"));
    expect(await screen.findByTestId("studio-save-error")).toBeTruthy();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("1");
  });

  it("clears the highlight when discarded", async () => {
    await mountPreviewing();
    fireEvent.click(screen.getByTestId("assistant-proposal-discard"));
    expect(screen.queryByTestId("assistant-proposal-caption")).toBeNull();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("0");
  });
});

describe("editor gaps: Edit as YAML, Run inputs, Use in a project", () => {
  it("edits YAML through the draft save path and keeps lastGood canvas on parse error", async () => {
    const { requests } = mount(studioPath, [{ path: draftPath, body: parseableDraft() }]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    expect(screen.getByTestId("editor-menu-yaml").textContent).toBe("Edit as YAML");
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));

    const textarea = (await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement;
    expect(screen.getByTestId("editor-panel-yaml").className).toContain("w-[520px]");

    // Parse error keeps the canvas on the last good document and shows studio-yaml-error
    fireEvent.change(textarea, { target: { value: "kind: Pipeline\nspec: [" } });
    const err = await screen.findByTestId("studio-yaml-error");
    expect(err.textContent?.length).toBeGreaterThan(0);
    expect(screen.getByTestId("studio-canvas").getAttribute("data-stale")).toBe("true");
    expect(screen.getByTestId("studio-canvas").getAttribute("data-read-only")).toBe("true");

    // Valid edit restores canvas and saves via debounced autosave PUT
    vi.useFakeTimers();
    fireEvent.change(textarea, {
      target: {
        value: `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: updated-yaml
spec:
  nodes:
    - id: plan
      kind: agent.acp
      config:
        profile: reviewer
        prompt: Updated via YAML.
`,
      },
    });
    expect(screen.queryByTestId("studio-yaml-error")).toBeNull();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-stale")).toBe("false");

    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(1);
    expect(requestsTo(requests, draftPath, "PUT")[0].body).toContain("Updated via YAML.");
  });

  it("stays read-only View YAML when viewing an older version", async () => {
    mount(studioPath, [
      { path: `/api/v1/runs`, body: { runs: [] } },
      { path: draftPath, body: parseableDraft(validValidation as ValidateResponse) },
    ]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-versions-btn"));
    const panel = await screen.findByTestId("versions-panel");
    fireEvent.click(within(panel).getByTestId(`versions-select-v${wireRevision.revision_number}`));
    await screen.findByTestId("version-viewing-banner");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    expect(screen.getByTestId("editor-menu-yaml").textContent).toBe("View YAML");
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    expect(await screen.findByTestId("yaml-view")).toBeTruthy();
    expect(screen.queryByTestId("studio-yaml")).toBeNull();
  });

  it("carries the W8 Validate disclosure at the foot of the YAML panel, in both views", async () => {
    // The panel contract § 7.2 row W8 names moved here with the YAML tab the
    // redesign retired (docs/design/redesign/CONTRACT.md: YAML is an editor
    // panel now). The disclosure is the line the W8 driver opens; the panel
    // behind it is `components/m4/ValidatePanel`, pinned to this workflow.
    mount(studioPath, [{ path: draftPath, body: parseableDraft() }]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    await screen.findByTestId("studio-yaml");

    // Closed by default, one line, named exactly as the contract words it.
    const disclosure = screen.getByTestId("yaml-validate-disclosure");
    expect(disclosure.textContent).toContain("Validate a YAML document");
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("validate-panel-input")).toBeNull();

    // Opening mounts the pinned panel: no picker, the workflow named, the box
    // seeded with the document the panel is already showing.
    fireEvent.click(disclosure);
    expect(await screen.findByTestId("yaml-validate-panel-open")).toBeTruthy();
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("validate-panel-pipeline").textContent).toContain(
      "Feature development",
    );
    expect(screen.getByTestId("validate-panel-pinned").textContent).toContain("pinned");
    expect(screen.getByTestId("validate-panel-not-editor").textContent).toContain("not an editor");
    const box = screen.getByTestId("validate-panel-input") as HTMLTextAreaElement;
    expect(box.value).toContain("apiVersion: communication.dev/v1alpha1");
    expect(screen.getByTestId("validate-panel-submit").hasAttribute("disabled")).toBe(false);
  });

  it("keeps the Validate disclosure on the read-only revision view of the YAML panel", async () => {
    mount(studioPath, [
      { path: `/api/v1/runs`, body: { runs: [] } },
      { path: draftPath, body: parseableDraft(validValidation as ValidateResponse) },
    ]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-versions-btn"));
    const versions = await screen.findByTestId("versions-panel");
    fireEvent.click(
      within(versions).getByTestId(`versions-select-v${wireRevision.revision_number}`),
    );
    await screen.findByTestId("version-viewing-banner");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    await screen.findByTestId("yaml-view");

    fireEvent.click(screen.getByTestId("yaml-validate-disclosure"));
    expect(await screen.findByTestId("validate-panel-input")).toBeTruthy();
    // Seeded from the revision under view, not from the open draft.
    const box = screen.getByTestId("validate-panel-input") as HTMLTextAreaElement;
    expect(box.value).toBe(wireRevision.document_text);
  });

  it("hides the Validate disclosure from a caller without the library role", async () => {
    mount(studioPath, [
      { path: "/api/v1/me", body: member },
      { path: draftPath, body: parseableDraft() },
    ]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-yaml"));
    await screen.findByTestId("yaml-view");
    expect(screen.queryByTestId("yaml-validate-disclosure")).toBeNull();
  });

  it("mounts Run inputs… panel from the … menu and from the inspector Who fills these → link", async () => {
    mount(studioPath, [
      { path: draftPath, body: parseableDraft() },
      { path: `/api/v1/runs`, body: { runs: [] } },
    ]);
    await screen.findByTestId("studio-canvas");

    // Open Workflow settings inspector and click "Who fills these →"
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-settings"));
    const link = await screen.findByTestId("insp-inputs-who-fills");
    expect(link.textContent).toBe("Who fills these →");
    fireEvent.click(link);

    const panel = await screen.findByTestId("editor-panel-inputs");
    expect(panel.className).toContain("w-[520px]");
    expect(await within(panel).findByTestId("inputs-tab")).toBeTruthy();
    expect(within(panel).getByTestId("who-fills")).toBeTruthy();

    // Also reachable directly from the "…" menu
    fireEvent.click(screen.getByTestId("editor-panel-close"));
    expect(screen.queryByTestId("editor-panel-inputs")).toBeNull();
    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-inputs"));
    expect(await screen.findByTestId("editor-panel-inputs")).toBeTruthy();
  });

  it("opens UseInRepoDialog from the editor … menu, preselected in a project scope", async () => {
    mount(`/p/proj-1/factory/${WIRE_PIPELINE_ID}?draft=${WIRE_DRAFT_ID}`, [
      { path: draftPath, body: parseableDraft() },
      {
        path: "/api/v1/projects/proj-1",
        body: { id: "proj-1", slug: "p1", name: "Project One", my_role: "maintainer" },
      },
      {
        path: "/api/v1/projects",
        body: { items: [{ id: "proj-1", slug: "p1", name: "Project One", my_role: "maintainer" }] },
      },
      { path: "/api/v1/projects/proj-1/assignments", body: { assignments: [] } },
      { path: "/api/v1/projects/proj-1/repos", body: { items: [] } },
    ]);
    await screen.findByTestId("studio-canvas");

    fireEvent.click(screen.getByTestId("editor-more-btn"));
    fireEvent.click(screen.getByTestId("editor-menu-use"));

    await screen.findByTestId("use-in-repo-dialog");
    const select = (await screen.findByTestId("assign-project-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("proj-1"));
  });
});
