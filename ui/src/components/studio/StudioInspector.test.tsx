/**
 * StudioInspector: schema-driven editing over the canonical text. Every edit
 * is a captured op run against the fixture text — the component never owns a
 * second copy of the document. Ranges, profiles, read-only and rename
 * refusals are the load-bearing behaviors.
 *
 * 4b additions: the profile select's SUGGESTED default (nearest upstream
 * agent node's profile), the per-option sandbox chip (glyph + words, from
 * the launchers × system/sandbox join), the `+ New profile…` row (opens the
 * NewProfileDialog; the draft is only written when a profile is created),
 * the "What should it do?" label and the "Also save as a reusable step"
 * POST to the node-template registry.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { parseGraph, type OpResult } from "../../lib/pipeline/graphDoc";
import type { AgentProfile, SystemSandbox } from "../../api/types";
import type { components } from "../../api/schema";
import { StudioInspector } from "./StudioInspector";

type LauncherList = components["schemas"]["LauncherList"];
type NodeTemplate = components["schemas"]["NodeTemplate"];

const PROFILES = vi.hoisted<AgentProfile[]>(() => [
  {
    id: "01j-profile-atlas",
    name: "Atlas",
    launcher_id: "claude",
    permission_mode: "ask",
    created_at: "2026-01-01T00:00:00Z",
    apm_package_ref: "acme/skills#v1.3.1",
    version: 1,
  },
  {
    id: "01j-profile-bolt",
    name: "Bolt",
    launcher_id: "codex",
    permission_mode: "ask",
    created_at: "2026-01-01T00:00:00Z",
    apm_package_ref: null,
    version: 1,
  },
]);

// claude: registered + a recorded nono probe, with a verified worker → green.
// codex: registered but no recorded probe → amber "NOT VERIFIED".
const LAUNCHERS = vi.hoisted<LauncherList>(() => ({
  launchers: [
    {
      id: "claude",
      display_name: "Claude Code",
      registered: true,
      workers_online: 1,
      capabilities: [
        {
          capability: "acp_session",
          result: "observed",
          observed_at: "2026-01-02",
          evidence: "docs/compatibility/acp.md",
        },
        { capability: "resume", result: "not_tested", observed_at: null, evidence: null },
        {
          capability: "permission_prompts",
          result: "not_tested",
          observed_at: null,
          evidence: null,
        },
        {
          capability: "nono_required",
          result: "observed",
          observed_at: "2026-01-03",
          evidence: "docs/compatibility/nono.md",
        },
      ],
    },
    {
      id: "codex",
      display_name: "Codex",
      registered: true,
      workers_online: 1,
      capabilities: [
        {
          capability: "acp_session",
          result: "observed",
          observed_at: "2026-01-02",
          evidence: "docs/compatibility/acp.md",
        },
        { capability: "resume", result: "not_tested", observed_at: null, evidence: null },
        {
          capability: "permission_prompts",
          result: "not_tested",
          observed_at: null,
          evidence: null,
        },
        { capability: "nono_required", result: "not_tested", observed_at: null, evidence: null },
      ],
    },
  ],
}));

const SANDBOX = vi.hoisted<SystemSandbox>(() => ({
  workers: [{ worker_id: "w1", backend: "nono", enforcement: "required", verified: true }],
  pinned_backend_version: "0.80.0",
  policy_digest: "sha256:0000",
}));

const apiFetchMock = vi.hoisted(() => vi.fn());
const MockApiError = vi.hoisted(
  () =>
    class MockApiError extends Error {
      status: number;
      constructor(status: number, message: string) {
        super(message);
        this.status = status;
      }
    },
);

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useAgentProfiles: () => ({ data: { items: PROFILES } }),
  useSystemSandbox: () => ({ data: SANDBOX }),
}));
vi.mock("../../api/launchers", () => ({
  useLaunchers: () => ({ data: LAUNCHERS }),
}));
vi.mock("../../api/client", () => ({
  apiFetch: apiFetchMock,
  ApiError: MockApiError,
}));
vi.mock("../profiles/NewProfileDialog", () => ({
  NewProfileDialog: (props: {
    open: boolean;
    onClose(): void;
    onCreated(p: { id: string; name: string; launcher_id: string }): void;
    forStep?: string;
  }) =>
    props.open ? (
      <div data-testid="mock-profile-dialog" data-forstep={props.forStep ?? ""}>
        <button
          type="button"
          data-testid="mock-profile-create"
          onClick={() => props.onCreated({ id: "01j-nova", name: "Nova", launcher_id: "claude" })}
        >
          create
        </button>
      </div>
    ) : null,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* The workflow record the NAME field reads and writes (routes 3 and 4). */
const PIPELINE_ID = "01j-pipeline";
const PIPELINE_SLUG = "feature-delivery";

function pipelineRecord(path: string, displayName?: string): unknown {
  if (path !== `/api/v1/pipelines/${PIPELINE_ID}`) throw new Error(`unexpected call ${path}`);
  return {
    id: PIPELINE_ID,
    slug: PIPELINE_SLUG,
    display_name: displayName ?? "Feature delivery",
    archived: false,
    revisions: [],
  };
}

const BASE = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "feature-delivery", description: "inspector fixture" },
  spec: {
    inputs: {
      type: "object",
      required: ["goal"],
      properties: {
        goal: { type: "string", minLength: 1, description: "What the plan should accomplish" },
        repo: { type: "string" },
      },
    },
    nodes: [
      {
        id: "plan",
        kind: "model.chat",
        config: { model: "gpt-x", messages: [{ role: "user", content: "plan" }] },
      },
      {
        id: "build",
        kind: "agent.acp",
        dependsOn: ["plan"],
        config: { profile: "Atlas", prompt: "Implement the change." },
      },
      {
        id: "loop",
        kind: "until",
        dependsOn: ["build"],
        config: {
          passWhen: "nodes.fix.outputs.ok == true",
          maxIterations: 4,
          body: { nodes: [{ id: "fix", kind: "process.exec" }] },
        },
      },
      {
        // A NEW agent step (4b): no profile yet — SUGGESTED comes from build.
        id: "docs",
        kind: "agent.acp",
        dependsOn: ["loop"],
        config: { prompt: "Check that README and docs/ match the change." },
      },
    ],
  },
};

const baseYaml = () => stringify(BASE);

function renderInspector(
  text: string,
  opts: { nodeId?: string | null; readOnly?: boolean; pipelineId?: string } = {},
) {
  const parsed = parseGraph(text);
  if (!parsed.ok) throw new Error(`fixture is not a graph: ${parsed.error}`);
  const model = parsed.model;
  const ops: ((t: string) => OpResult)[] = [];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const inspector = (
    <StudioInspector
      model={model}
      nodeId={opts.nodeId ?? null}
      document={parse(text)}
      text={text}
      readOnly={opts.readOnly ?? false}
      apply={(op) => {
        ops.push(op);
      }}
    />
  );
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={
          opts.pipelineId ? [`/workflows/${opts.pipelineId}/drafts/01j-draft`] : ["/"]
        }
      >
        {opts.pipelineId ? (
          <Routes>
            <Route path="/workflows/:pipelineId/drafts/:draftId" element={inspector} />
          </Routes>
        ) : (
          inspector
        )}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, ops };
}

describe("StudioInspector", () => {
  it("commits a passWhen edit on blur as an op that rewrites the YAML", () => {
    const text = baseYaml();
    const { getByTestId, ops } = renderInspector(text, { nodeId: "loop" });
    const area = getByTestId("insp-config-passWhen") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: "nodes.fix.outputs.ok" } });
    fireEvent.blur(area);
    expect(ops.length).toBe(1);
    const res = ops[0](text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.text).toContain("passWhen: nodes.fix.outputs.ok");
      expect(res.text).toContain("id: loop");
    }
  });

  it("refuses a number outside the schema range and shows the range", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "loop" });
    const input = getByTestId("insp-config-maxIterations") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.blur(input);
    expect(screen.getByText(/out of range/).textContent).toContain("1–32");
    expect(screen.queryByText("99")).toBeNull(); // the op never ran
  });

  it("lists the profiles with the sandbox chip (glyph + words) per launcher", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "build" });
    const select = getByTestId("insp-profile") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    // claude: verified worker + recorded probe → the only green claim.
    expect(options).toContain("Atlas · claude · acme/skills#v1.3.1 ✓ REQUIRED · VERIFIED");
    // codex: registered but no recorded probe → never green.
    expect(options).toContain("Bolt · codex ! NOT VERIFIED");
    expect(options).toContain("+ New profile…");
    expect(getByTestId("insp-profile-edit")).toBeTruthy();
    expect(screen.getByText(/Model is chosen by the profile.s launcher/)).toBeTruthy();
    // An existing profiled node shows no SUGGESTED note.
    expect(screen.queryByTestId("insp-profile-suggested")).toBeNull();
  });

  it("defaults a NEW agent node to the nearest upstream agent profile, marked SUGGESTED", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "docs" });
    const select = getByTestId("insp-profile") as HTMLSelectElement;
    expect(select.value).toBe("Atlas"); // suggested from `build`, through `loop`
    expect(screen.getByTestId("insp-profile-suggested").textContent).toBe(
      "SUGGESTED · same as build",
    );
    const suggestedOption = Array.from(select.options).find((o) => o.value === "Atlas");
    expect(suggestedOption?.textContent).toContain("SUGGESTED · same as build — ");
  });

  it("+ New profile… opens the dialog without mutating the draft; creation writes config.profile", async () => {
    const text = baseYaml();
    const { getByTestId, ops } = renderInspector(text, { nodeId: "docs" });
    const select = getByTestId("insp-profile") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__new_profile__" } });
    const dialog = await screen.findByTestId("mock-profile-dialog");
    expect(dialog.getAttribute("data-forstep")).toBe("docs");
    expect(ops.length).toBe(0); // choosing the row itself never touches the draft
    fireEvent.click(getByTestId("mock-profile-create"));
    expect(ops.length).toBe(1);
    const res = ops[0](text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain("profile: Nova");
    // Re-render the draft with the committed text: the select now shows the
    // created profile, and the SUGGESTED note is gone (the node has a profile).
    cleanup();
    const r2 = renderInspector(res.text, { nodeId: "docs" });
    expect((r2.getByTestId("insp-profile") as HTMLSelectElement).value).toBe("Nova");
    expect(r2.queryByTestId("insp-profile-suggested")).toBeNull();
  });

  it('labels the agent prompt field "What should it do?" (label only)', () => {
    renderInspector(baseYaml(), { nodeId: "docs" });
    expect(screen.getByText("What should it do?")).toBeTruthy();
    const prompt = screen.getByTestId("insp-config-prompt") as HTMLTextAreaElement;
    expect(prompt.value).toBe("Check that README and docs/ match the change.");
  });

  it("save-as-step: unchecked by default; armed + clicked POSTs kind+config (slug=node id, v1.0.0)", async () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "build" });
    const toggle = getByTestId("insp-save-step-toggle") as HTMLInputElement;
    const button = getByTestId("insp-save-step-button") as HTMLButtonElement;
    expect(toggle.checked).toBe(false);
    expect(button.disabled).toBe(true); // unarmed: no POST possible
    fireEvent.click(toggle);
    expect(button.disabled).toBe(false);
    const template: NodeTemplate = {
      id: "01j-tpl-build",
      slug: "build",
      display_name: "Coding agent · build",
      kind: "agent.acp",
      description: "",
      status: "active",
      latest_revision: {
        revision_id: "01j-rev1",
        revision_number: 1,
        version_label: "1.0.0",
        revision_digest: "sha256:abcd",
        created_at: "2026-01-01T00:00:00Z",
      },
      used_in_count: 0,
      created_by: "01j-admin",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    apiFetchMock.mockResolvedValueOnce(template);
    fireEvent.click(button);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/node-templates");
    expect(init.method).toBe("POST");
    expect(init.json).toMatchObject({
      slug: "build",
      kind: "agent.acp",
      parameters: {},
      config: { profile: "Atlas", prompt: "Implement the change." },
      version_label: "1.0.0",
    });
    const done = await screen.findByTestId("insp-save-step-done");
    expect(done.textContent).toContain("Saved as step “build” v1.0.0.");
    expect(getByTestId("insp-save-step-link").getAttribute("href")).toBe("/steps/01j-tpl-build");
  });

  it("save-as-step: shows the API error (403 for a non-library caller)", async () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "build" });
    fireEvent.click(getByTestId("insp-save-step-toggle"));
    apiFetchMock.mockRejectedValueOnce(new MockApiError(403, "forbidden: library role required"));
    fireEvent.click(getByTestId("insp-save-step-button"));
    const error = await screen.findByTestId("insp-save-step-error");
    expect(error.textContent).toContain("403");
    expect(screen.queryByTestId("insp-save-step-done")).toBeNull();
  });

  it("disables every input when read-only (profile select, save-as-step, common fields)", () => {
    const { getByTestId } = renderInspector(baseYaml(), {
      nodeId: "docs",
      readOnly: true,
    });
    expect((getByTestId("insp-profile") as HTMLSelectElement).disabled).toBe(true);
    expect((getByTestId("insp-node-id") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("insp-save-step-toggle") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("insp-save-step-button") as HTMLButtonElement).disabled).toBe(true);
    const loop = renderInspector(baseYaml(), { nodeId: "loop", readOnly: true });
    expect((loop.getByTestId("insp-config-passWhen") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("shows a rename refusal when the id is already used", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "loop" });
    const idInput = getByTestId("insp-node-id") as HTMLInputElement;
    fireEvent.change(idInput, { target: { value: "plan" } });
    fireEvent.blur(idInput);
    expect(getByTestId("insp-rename-error").textContent).toContain("already used");
  });

  it("shows the workflow's own name, with the slug as a read-only id line", async () => {
    apiFetchMock.mockImplementation(async (path: unknown) => pipelineRecord(String(path)));
    renderInspector(baseYaml(), { pipelineId: PIPELINE_ID });
    const name = (await screen.findByTestId("insp-pipeline-name")) as HTMLInputElement;
    // The record arrives on its own tick; the field is only writable once it has.
    await waitFor(() => expect(name.disabled).toBe(false));
    // The review's defect: this box held `feature-delivery`, the id, because
    // the panel only ever read the document's own `metadata.name`.
    expect(name.value).toBe("Feature delivery");
    expect(screen.getByTestId("insp-pipeline-id").textContent).toBe(`id: ${PIPELINE_SLUG}`);
    expect(screen.getByTestId("insp-pipeline")).toBeTruthy();
  });

  it("NAME writes the display name to the workflow, not to the draft", async () => {
    apiFetchMock.mockImplementation(async (path: unknown, init?: unknown) => {
      const call = init as { method?: string; json?: unknown } | undefined;
      if (call?.method === "PATCH")
        return pipelineRecord(String(path), (call.json as { display_name?: string }).display_name);
      return pipelineRecord(String(path));
    });
    const { ops } = renderInspector(baseYaml(), { pipelineId: PIPELINE_ID });
    const name = (await screen.findByTestId("insp-pipeline-name")) as HTMLInputElement;
    await waitFor(() => expect(name.disabled).toBe(false));
    fireEvent.change(name, { target: { value: "Feature delivery, take two" } });
    fireEvent.blur(name);
    await waitFor(() =>
      expect(
        apiFetchMock.mock.calls.some(
          (call) => (call[1] as { method?: string } | undefined)?.method === "PATCH",
        ),
      ).toBe(true),
    );
    const patchCall = apiFetchMock.mock.calls.find(
      (call) => (call[1] as { method?: string } | undefined)?.method === "PATCH",
    ) as [string, { json: { display_name: string } }];
    expect(patchCall[0]).toBe(`/api/v1/pipelines/${PIPELINE_ID}`);
    expect(patchCall[1].json.display_name).toBe("Feature delivery, take two");
    // A metadata write is not a draft edit: the YAML never moved.
    expect(ops.length).toBe(0);
  });

  it("keeps NAME read-only with no workflow record to write to", () => {
    renderInspector(baseYaml());
    expect((screen.getByTestId("insp-pipeline-name") as HTMLInputElement).disabled).toBe(true);
    // The document's own name is still on screen, and it is labelled as such.
    expect((screen.getByTestId("insp-pipeline-name") as HTMLInputElement).value).toBe(
      "feature-delivery",
    );
    expect(screen.getByTestId("insp-pipeline-id").textContent).toBe("id: feature-delivery");
  });

  it("reads the run inputs as rows, not as the document's JSON Schema", () => {
    const { getByTestId } = renderInspector(baseYaml());
    const rows = getByTestId("insp-pipeline-inputs");
    expect(rows.textContent).not.toContain('"type"');
    expect(rows.textContent).not.toContain("minLength");
    expect(rows.textContent).not.toContain("properties");
    // One row per declared input, in the document's own order, carrying the
    // sentence the author wrote for it.
    expect((getByTestId("insp-pipeline-inputs-name-0") as HTMLInputElement).value).toBe("goal");
    expect((getByTestId("insp-pipeline-inputs-description-0") as HTMLTextAreaElement).value).toBe(
      "What the plan should accomplish",
    );
    expect((getByTestId("insp-pipeline-inputs-row-0-required") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((getByTestId("insp-pipeline-inputs-name-1") as HTMLInputElement).value).toBe("repo");
    expect((getByTestId("insp-pipeline-inputs-row-1-required") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(getByTestId("insp-pipeline-inputs-add")).toBeTruthy();
  });

  it("adds an input and writes the same schema back", () => {
    const text = baseYaml();
    const { getByTestId, ops } = renderInspector(text);
    fireEvent.click(getByTestId("insp-pipeline-inputs-add"));
    const name = getByTestId("insp-pipeline-inputs-name-2") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "ticket" } });
    fireEvent.blur(name);
    expect(ops.length).toBe(1);
    const res = ops[0](text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const written = parse(res.text) as { spec: { inputs: Record<string, unknown> } };
    expect(written.spec.inputs.properties).toEqual({
      goal: { type: "string", minLength: 1, description: "What the plan should accomplish" },
      repo: { type: "string" },
      ticket: { type: "string" },
    });
    expect(written.spec.inputs.required).toEqual(["goal"]); // the new row is not required
  });

  it("edits an input's sentence and keeps the keywords the rows do not show", () => {
    const text = baseYaml();
    const { getByTestId, ops } = renderInspector(text);
    const description = getByTestId("insp-pipeline-inputs-description-0") as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "What the run should achieve" } });
    fireEvent.blur(description);
    expect(ops.length).toBe(1);
    const res = ops[0](text);
    if (!res.ok) throw new Error("the op refused: " + ("error" in res ? res.error : ""));
    const written = parse(res.text) as {
      spec: { inputs: { properties: Record<string, Record<string, unknown>> } };
    };
    expect(written.spec.inputs.properties.goal).toEqual({
      type: "string",
      minLength: 1,
      description: "What the run should achieve",
    });
  });

  it("removes an input from both properties and required", () => {
    const text = baseYaml();
    const { getByTestId, ops } = renderInspector(text);
    fireEvent.click(getByTestId("insp-pipeline-inputs-row-0-del"));
    expect(ops.length).toBe(1);
    const res = ops[0](text);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const written = parse(res.text) as { spec: { inputs: Record<string, unknown> } };
    expect(written.spec.inputs.properties).toEqual({ repo: { type: "string" } });
    expect(written.spec.inputs.required).toBeUndefined();
  });

  it("refuses an input name a run could not select, and leaves the document alone", () => {
    const { getByTestId, ops } = renderInspector(baseYaml());
    const name = getByTestId("insp-pipeline-inputs-name-1") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Bad Name" } });
    fireEvent.blur(name);
    expect(getByTestId("insp-pipeline-inputs-row-1-problem").textContent).toContain(
      "lower-case letter",
    );
    expect(ops.length).toBe(0);
  });

  it("refuses two inputs with one name", () => {
    const { getByTestId, ops } = renderInspector(baseYaml());
    const name = getByTestId("insp-pipeline-inputs-name-1") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "goal" } });
    fireEvent.blur(name);
    expect(getByTestId("insp-pipeline-inputs-row-1-problem").textContent).toContain(
      "cannot share a name",
    );
    expect(ops.length).toBe(0);
  });

  it("says there is nothing to fill in when the workflow declares no inputs", () => {
    const { getByTestId } = renderInspector(
      stringify({
        apiVersion: "communication.dev/v1alpha1",
        kind: "Pipeline",
        metadata: { name: "feature-delivery" },
        spec: {
          inputs: { type: "object", properties: {} },
          nodes: [{ id: "plan", kind: "model.chat", config: { model: "gpt-x" } }],
        },
      }),
    );
    expect(getByTestId("insp-pipeline-inputs-none").textContent).toContain("no inputs declared");
  });

  it("keeps the JSON box for an inputs shape the rows would have to lie about", () => {
    const { getByTestId } = renderInspector(
      stringify({
        apiVersion: "communication.dev/v1alpha1",
        kind: "Pipeline",
        metadata: { name: "feature-delivery" },
        spec: {
          inputs: {
            type: "object",
            properties: { goal: { oneOf: [{ type: "string" }, { type: "integer" }] } },
          },
          nodes: [{ id: "plan", kind: "model.chat", config: { model: "gpt-x" } }],
        },
      }),
    );
    // The rule is never a hidden field: this shape is not a list of named
    // values, so the box that writes it verbatim stays.
    expect(getByTestId("insp-pipeline-inputs-json")).toBeTruthy();
  });
});
