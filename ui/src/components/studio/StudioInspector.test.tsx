/**
 * StudioInspector: schema-driven editing over the canonical text. Every edit
 * is a captured op run against the fixture text — the component never owns a
 * second copy of the document. Ranges, profiles, read-only and rename
 * refusals are the load-bearing behaviors.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { parseGraph, type OpResult } from "../../lib/pipeline/graphDoc";
import type { AgentProfile } from "../../api/types";
import { StudioInspector } from "./StudioInspector";

const PROFILES = vi.hoisted<AgentProfile[]>(() => [
  {
    id: "01j-profile-atlas",
    name: "Atlas",
    launcher_id: "claude",
    permission_mode: "ask",
    created_at: "2026-01-01T00:00:00Z",
    apm_package_ref: "acme/skills#v1.3.1",
  },
  {
    id: "01j-profile-bolt",
    name: "Bolt",
    launcher_id: "codex",
    permission_mode: "ask",
    created_at: "2026-01-01T00:00:00Z",
    apm_package_ref: null,
  },
]);

vi.mock("../../api/queries", () => ({
  useAgentProfiles: () => ({ data: { items: PROFILES } }),
}));

afterEach(cleanup);

const BASE = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "feature-delivery", description: "inspector fixture" },
  spec: {
    inputs: { type: "object", properties: { repo: { type: "string" } } },
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
    ],
  },
};

const baseYaml = () => stringify(BASE);

function renderInspector(text: string, opts: { nodeId?: string | null; readOnly?: boolean } = {}) {
  const parsed = parseGraph(text);
  if (!parsed.ok) throw new Error(`fixture is not a graph: ${parsed.error}`);
  const model = parsed.model;
  const ops: ((t: string) => OpResult)[] = [];
  const utils = render(
    <MemoryRouter>
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
    </MemoryRouter>,
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

  it("lists the mocked profiles for an agent step, with the launch line", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "build" });
    const select = getByTestId("insp-profile") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toContain("Atlas · claude · acme/skills#v1.3.1");
    expect(options).toContain("Bolt · codex");
    expect(getByTestId("insp-profile-edit")).toBeTruthy();
    expect(screen.getByText(/Model is chosen by the profile.s launcher/)).toBeTruthy();
  });

  it("disables every input when read-only", () => {
    const { getByTestId } = renderInspector(baseYaml(), {
      nodeId: "loop",
      readOnly: true,
    });
    expect((getByTestId("insp-config-passWhen") as HTMLTextAreaElement).disabled).toBe(true);
    expect((getByTestId("insp-config-maxIterations") as HTMLInputElement).disabled).toBe(true);
    expect((getByTestId("insp-node-id") as HTMLInputElement).disabled).toBe(true);
  });

  it("shows a rename refusal when the id is already used", () => {
    const { getByTestId } = renderInspector(baseYaml(), { nodeId: "loop" });
    const idInput = getByTestId("insp-node-id") as HTMLInputElement;
    fireEvent.change(idInput, { target: { value: "plan" } });
    fireEvent.blur(idInput);
    expect(getByTestId("insp-rename-error").textContent).toContain("already used");
  });

  it("shows the pipeline panel when nothing is selected", () => {
    renderInspector(baseYaml());
    expect(screen.getByTestId("insp-pipeline")).toBeTruthy();
    expect((screen.getByTestId("insp-pipeline-name") as HTMLInputElement).value).toBe(
      "feature-delivery",
    );
  });
});
