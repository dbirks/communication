/**
 * The Workflow Studio route: the header / palette / canvas surface over one
 * draft, the YAML toggle, the stale-canvas fallback on invalid YAML, the
 * read-only rule, and the Save / Validate / Publish actions the inline editor
 * used to own (this file now also asserts the findings and the versioned
 * PUT that the library tests used to exercise through DraftEditor).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Draft, Me, ValidateResponse } from "../api/types";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import {
  WIRE_DRAFT_ID,
  WIRE_PIPELINE_ID,
  wirePipeline,
  wireRevision,
  wireUserId,
} from "../test/fixtures/m4/wire";
import { validValidation, w8DraftYaml, w8Validation } from "../test/fixtures/m4/w8Draft";
import { samplePipelineYaml } from "../test/fixtures/m4/samplePipeline";
import { uiLayoutOfText } from "../components/studio/useStudioDraft";
import { PipelinePage } from "./Library";
import { StudioPage } from "./Studio";

// The canvas is the heaviest child (React Flow) and is covered by its own
// suite; here the stub mirrors the props the page must hand down.
vi.mock("../components/studio/StudioCanvas", () => ({
  StudioCanvas: (props: {
    stale?: boolean;
    staleMessage?: string;
    readOnly?: boolean;
    selectedId?: string | null;
    highlight?: string[];
  }) => (
    <div
      data-testid="studio-canvas"
      data-stale={props.stale ? "true" : "false"}
      data-read-only={props.readOnly ? "true" : "false"}
      data-selected={props.selectedId ?? ""}
      data-highlight-count={props.highlight ? props.highlight.length : 0}
    >
      {props.stale ? props.staleMessage : "canvas"}
    </div>
  ),
}));

const admin: Me = { ...meFixture, is_org_admin: true };
const member: Me = { ...meFixture, is_org_admin: false };
const pipelinePath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;
const draftPath = `/api/v1/drafts/${WIRE_DRAFT_ID}`;
const validatePath = `${draftPath}/validate`;
const publishPath = `${draftPath}/publish`;
const digest = wirePipeline.revisions[0].revision_digest;

/** The draft served with parseable YAML — the canvas renders it live. */
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

function mount(path: string, overrides: RouteStub[] = []) {
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/library/:pipelineId" element={<PipelinePage />} />
          <Route path="/library/:pipelineId/drafts/:draftId" element={<StudioPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

const studioPath = `/library/${WIRE_PIPELINE_ID}/drafts/${WIRE_DRAFT_ID}`;

afterEach(cleanup);

describe("/library/:pipelineId/drafts/:draftId", () => {
  it("renders the header, the palette and the canvas over the draft", async () => {
    mount(studioPath, [
      { path: draftPath, body: parseableDraft(w8Validation as ValidateResponse) },
    ]);
    const header = await screen.findByTestId("studio-header");
    expect((await screen.findByTestId("studio-title")).textContent).toBe("Feature development");
    // The version the draft read served, and the server's last verdict.
    expect((await screen.findByTestId("studio-draft-version")).textContent).toBe("draft v12");
    expect((await screen.findByTestId("studio-validation-chip")).textContent).toContain("invalid");
    // The authoring columns: palette on the left, the canvas in the middle,
    // the inspector's pipeline view when nothing is selected.
    expect(await screen.findByTestId("studio-palette")).toBeTruthy();
    expect((await screen.findByTestId("studio-canvas")).getAttribute("data-stale")).toBe("false");
    expect(await screen.findByTestId("insp-pipeline")).toBeTruthy();
    expect(within(header).getByTestId("studio-save")).toBeTruthy();
  });

  it("replaces the old ?draft= URL shape through to the Studio route", async () => {
    mount(`/library/${WIRE_PIPELINE_ID}?draft=${WIRE_DRAFT_ID}`);
    expect(await screen.findByTestId("studio-page")).toBeTruthy();
    // The replace happened: the pipeline page is no longer what's rendered.
    await waitFor(() => expect(screen.queryByTestId("pipeline-page")).toBeNull());
    expect((await screen.findByTestId("studio-draft-version")).textContent).toBe("draft v12");
  });

  it("switches the canvas for the YAML text and back", async () => {
    mount(studioPath);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(await screen.findByTestId("studio-view-yaml"));
    const box = (await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement;
    expect(box.value).toContain("apiVersion: communication.dev/v1alpha1");
    expect(screen.queryByTestId("studio-canvas")).toBeNull();
    fireEvent.click(screen.getByTestId("studio-view-canvas"));
    expect(await screen.findByTestId("studio-canvas")).toBeTruthy();
    expect(screen.queryByTestId("studio-yaml")).toBeNull();
  });

  it("keeps invalid YAML, names the line, and stalls the canvas on lastGood", async () => {
    mount(studioPath);
    await screen.findByTestId("studio-canvas");
    fireEvent.click(await screen.findByTestId("studio-view-yaml"));
    const box = (await screen.findByTestId("studio-yaml")) as HTMLTextAreaElement;
    fireEvent.change(box, {
      target: { value: `apiVersion: communication.dev/v1alpha1\nspec: [broken` },
    });
    // The text stays (the parse error, with its line, names the problem)…
    const error = await screen.findByTestId("studio-yaml-error");
    expect(error.textContent).toContain("line");
    expect((screen.getByTestId("studio-yaml") as HTMLTextAreaElement).value).toContain("broken");
    // … and the canvas goes stale, saying the graph edits are paused.
    fireEvent.click(screen.getByTestId("studio-view-canvas"));
    const canvas = await screen.findByTestId("studio-canvas");
    expect(canvas.getAttribute("data-stale")).toBe("true");
    expect(canvas.textContent).toContain("graph editing is paused");
  });

  it("hides Save and Publish without the library role, and says why", async () => {
    mount(studioPath, [{ path: "/api/v1/me", body: member }]);
    await screen.findByTestId("studio-header");
    expect((await screen.findByTestId("studio-read-only-note")).textContent).toContain(
      "library role",
    );
    expect(screen.queryByTestId("studio-save")).toBeNull();
    expect(screen.queryByTestId("studio-publish")).toBeNull();
    // The same answer reaches the canvas: no handles, no edits.
    expect((await screen.findByTestId("studio-canvas")).getAttribute("data-read-only")).toBe(
      "true",
    );
  });

  it("Validates against the server and renders the findings with go-to-node", async () => {
    const { requests } = mount(studioPath, [{ path: draftPath, body: parseableDraft() }]);
    await screen.findByTestId("studio-header");
    fireEvent.click(await screen.findByTestId("studio-validate"));
    await waitFor(() => expect(requestsTo(requests, validatePath, "POST")).toHaveLength(1));
    // The § 2.2 body, rendered: the verdict line and every finding…
    const drawer = await screen.findByTestId("studio-validate-drawer");
    expect((await screen.findByTestId("studio-validate-verdict")).textContent).toContain("invalid");
    const findings = await screen.findAllByTestId(/^studio-validate-finding-/);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].textContent).toContain("duplicate_key");
    // … and the one whose pointer names a node offers the jump.
    fireEvent.click(within(drawer).getByTestId("studio-goto-node-0"));
    expect(await screen.findByTestId("insp-node")).toBeTruthy();
  });

  it("Save posts the version and bakes the layout into the YAML's metadata.ui", async () => {
    const layout = { nodes: { plan: { x: 114.25, y: 203.485 } } };
    const { requests } = mount(studioPath, [
      {
        path: draftPath,
        body: wireDraft("invalid", validValidation as ValidateResponse, samplePipelineYaml, layout),
      },
    ]);
    await screen.findByTestId("studio-header");
    fireEvent.click(await screen.findByTestId("studio-save"));
    await waitFor(() => expect(requestsTo(requests, draftPath, "PUT")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, draftPath, "PUT")[0].body ?? "{}") as {
      version?: number;
      document_yaml?: string;
      ui_layout?: unknown;
    };
    // The frozen wire body is exactly {document_yaml, version}: positions ride
    // the bytes as the digest-excluded metadata.ui block (ADR-0021 § 5), they
    // never travel as a separate member.
    expect(body.version).toBe(12);
    expect(body).not.toHaveProperty("ui_layout");
    expect(body.document_yaml).toContain("apiVersion: communication.dev/v1alpha1");
    expect(uiLayoutOfText(body.document_yaml ?? "")).toEqual(layout);
  });

  it("Publish posts only on the server's valid verdict, and names the revision", async () => {
    const { requests } = mount(studioPath, [
      { path: draftPath, body: wireDraft("valid", validValidation as ValidateResponse) },
      {
        path: draftPath,
        method: "PUT",
        body: wireDraft("invalid", w8Validation as ValidateResponse),
      },
    ]);
    await screen.findByTestId("studio-header");
    // Valid verdict, clean bytes: publish is live (no visible reason).
    const publish = (await screen.findByTestId("studio-publish")) as HTMLButtonElement;
    expect(publish.disabled).toBe(false);
    expect(screen.queryByTestId("studio-publish-reason")).toBeNull();
    fireEvent.click(publish);
    await waitFor(() => expect(requestsTo(requests, publishPath, "POST")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, publishPath, "POST")[0].body ?? "{}") as {
      version?: number;
    };
    expect(body.version).toBe(12);
    expect((await screen.findByTestId("studio-published")).textContent).toContain("r7");
  });

  it("multi-selects in the outline and wraps the selection in a Repeat until scope", async () => {
    // The outline (checkbox multi-select) only renders narrow — stub the
    // media query so the page takes the <1024px path without a canvas.
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }));
    const wrapYaml = `kind: Pipeline
spec:
  nodes:
    - id: plan
      kind: agent.acp
    - id: check
      kind: process.exec
      dependsOn: [plan]
`;
    mount(studioPath, [{ path: draftPath, body: wireDraft("invalid", undefined, wrapYaml) }]);
    const outline = await screen.findByTestId("step-outline");
    // No selection yet: no actions. Then check both steps.
    expect(screen.queryByTestId("outline-selection-actions")).toBeNull();
    fireEvent.click(within(outline).getByTestId("step-outline-select-plan"));
    fireEvent.click(within(outline).getByTestId("step-outline-select-check"));
    const actions = await screen.findByTestId("outline-selection-actions");
    fireEvent.click(within(actions).getByTestId("outline-wrap-until"));
    // The wrap went through apply: the YAML now holds the until scope with
    // both members as its body, and the scope is selected for the inspector.
    await screen.findByText("Pass when (CEL)");
    fireEvent.click(screen.getByTestId("studio-view-yaml"));
    const box = await screen.findByTestId("studio-yaml");
    const text = (box as HTMLTextAreaElement).value;
    expect(text).toContain("kind: until");
    expect(text).toContain("body:");
    expect(text).toContain("id: plan");
    expect(text).toContain("id: check");
    expect(text).toContain("passWhen");
    vi.unstubAllGlobals();
  });

  it("says the diff has nothing to compare on a zero-revision pipeline", async () => {
    mount(studioPath, [
      {
        path: pipelinePath,
        body: { ...wirePipeline, revisions: [], revision_count: 0 },
      },
    ]);
    await screen.findByTestId("studio-header");
    fireEvent.click(await screen.findByTestId("studio-diff"));
    expect((await screen.findByTestId("studio-diff-drawer")).textContent).toContain(
      "nothing to compare",
    );
  });
});

describe("the assistant proposal lifecycle", () => {
  const proposalPath = "/api/v1/assistant/draft-proposals";
  // insert_after against the terminal root step of the parseable fixture —
  // the same shape the ADR-0044 closed set carries and proposalOps.test.ts
  // proves applies cleanly.
  const proposalOp = {
    op: "insert_after",
    after: "publish_needs_attention",
    kind: "agent.acp",
    id: "assistant_note",
    config: { profile: "m4-reviewer", prompt: "Summarise the approved plan for the log." },
  };

  /** Mount, ask the assistant, and land on the preview (highlight + caption). */
  async function mountPreviewing(overrides: RouteStub[] = []) {
    const { requests } = mount(studioPath, [
      // `overrides` lead: the methodless GET draft stub in `routes()` would
      // otherwise shadow a PUT-specific stub (mockFetch's first match wins).
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
    await screen.findByTestId("studio-header");
    fireEvent.change(screen.getByTestId("assistant-proposal-input"), {
      target: { value: "Add a note agent at the end" },
    });
    fireEvent.click(screen.getByTestId("assistant-proposal-submit"));
    await screen.findByTestId("assistant-proposal-caption");
    // The preview rings the proposed node on the canvas and shows the page's
    // review caption.
    const canvas = screen.getByTestId("studio-canvas");
    expect(canvas.getAttribute("data-highlight-count")).toBe("1");
    expect(screen.getByTestId("studio-proposal-caption")).toBeTruthy();
    return { requests };
  }

  it("clears the highlight and the preview when Apply saves", async () => {
    const { requests } = await mountPreviewing();
    fireEvent.click(screen.getByTestId("assistant-proposal-apply"));
    // The adopted text went out through the version-checked PUT.
    await waitFor(() => expect(requestsTo(requests, draftPath, "PUT").length).toBe(1));
    // No reload, no error: the highlight is gone and the box is back to the
    // plain form (no caption, input present again).
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("0");
    expect(screen.queryByTestId("assistant-proposal-caption")).toBeNull();
    expect(screen.queryByTestId("studio-proposal-caption")).toBeNull();
    expect(screen.queryByTestId("assistant-proposal-apply")).toBeNull();
    expect(screen.getByTestId("assistant-proposal-input")).toBeTruthy();
  });

  it("keeps the preview and shows the error when the Apply save fails", async () => {
    await mountPreviewing([
      {
        path: draftPath,
        method: "PUT",
        status: 500,
        body: { type: "server_error", title: "Internal server error", detail: "boom" },
      },
    ]);
    fireEvent.click(screen.getByTestId("assistant-proposal-apply"));
    // The save failed, so the banner explains it and the proposal is still on
    // the canvas, still apply-able.
    expect(await screen.findByTestId("studio-save-error")).toBeTruthy();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("1");
    expect(screen.getByTestId("assistant-proposal-caption")).toBeTruthy();
    expect(screen.getByTestId("studio-proposal-caption")).toBeTruthy();
    expect(screen.getByTestId("assistant-proposal-apply")).toBeTruthy();
  });

  it("clears the highlight and the preview when the proposal is discarded", async () => {
    await mountPreviewing();
    fireEvent.click(screen.getByTestId("assistant-proposal-discard"));
    // Undo lands: the highlight is cleared and the box is back to the plain
    // form. Nothing was saved.
    expect(screen.queryByTestId("assistant-proposal-caption")).toBeNull();
    expect(screen.queryByTestId("studio-proposal-caption")).toBeNull();
    expect(screen.getByTestId("studio-canvas").getAttribute("data-highlight-count")).toBe("0");
    expect(screen.getByTestId("assistant-proposal-input")).toBeTruthy();
  });
});
