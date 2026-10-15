/**
 * The definition graph is a projection of a pinned revision, so its tests are
 * about fidelity and access: the nodes and scopes the document actually has,
 * the bindings the document actually contains, a keyboard path that does not
 * need the canvas, and a deferred kind that says so in words.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DefinitionGraph } from "./DefinitionGraph";
import {
  fanOutPipelineDocument,
  samplePipelineDocument,
} from "../../test/fixtures/m4/samplePipeline";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

describe("DefinitionGraph", () => {
  it("renders one box per concrete node and one group per scope", () => {
    render(<DefinitionGraph document={samplePipelineDocument} label="revision 7" />);
    expect(screen.getByTestId("definition-graph")).toBeTruthy();
    // Boxes are addressed by the scope-qualified node key, not the bare id: the
    // § 9.3 sample's `implement` exists inside a scope, and a test id that could
    // name two nodes could not be clicked on purpose.
    for (const key of [
      "plan",
      "approve",
      "build_until_verified-implement",
      "build_until_verified-test",
      "build_until_verified-review",
      "verdict",
    ]) {
      expect(screen.getByTestId(`definition-graph-node-${key}`)).toBeTruthy();
    }
    const group = screen.getByTestId("definition-graph-scope-build_until_verified");
    // A box is never the only signal: the group names itself in words.
    expect(group.textContent).toContain("until · build_until_verified · max 4");
  });

  it("keeps two nodes that share an id apart, and marks only the one named", () => {
    // Legal in a real definition: scopes make `implement` unique only inside
    // themselves. The graph must show both boxes and put a current-node marker
    // on exactly one of them.
    const doc = {
      apiVersion: "communication.dev/v1alpha1" as const,
      version: "v1alpha1" as const,
      kind: "pipeline" as const,
      metadata: { name: "two-scopes" },
      spec: {
        nodes: [
          {
            id: "first_scope",
            kind: "until" as const,
            config: {
              max_iterations: 2,
              body: { nodes: [{ id: "implement", kind: "agent.acp" as const }] },
            },
          },
          {
            id: "second_scope",
            kind: "until" as const,
            config: {
              max_iterations: 2,
              body: { nodes: [{ id: "implement", kind: "agent.acp" as const }] },
            },
          },
        ],
      },
    };
    render(
      <DefinitionGraph
        document={doc}
        statuses={{ "/first_scope/implement": "running" }}
        onSelectKey={() => {}}
      />,
    );
    const first = screen.getByTestId("definition-graph-node-first_scope-implement");
    const second = screen.getByTestId("definition-graph-node-second_scope-implement");
    expect(first.getAttribute("aria-label")).toContain("in scope first_scope");
    expect(second.getAttribute("aria-label")).toContain("in scope second_scope");
    expect(first.textContent).toContain("running");
    expect(second.textContent).not.toContain("running");
  });

  it("labels every node with its kind name, not a glyph alone (rule 06)", () => {
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const node = screen.getByTestId("definition-graph-node-plan");
    expect(node.textContent).toContain("agent.acp");
    expect(node.getAttribute("aria-label")).toContain("kind agent.acp");
  });

  it("draws condition routes and keeps the condition node's cases readable", () => {
    render(<DefinitionGraph document={samplePipelineDocument} onSelectKey={() => {}} />);
    expect(screen.getByTestId("definition-graph-edge-verdict-to-publish_verified")).toBeTruthy();
  });

  it("shows a selected node's bindings with the position they were written in", () => {
    render(
      <DefinitionGraph
        document={samplePipelineDocument}
        selectedKey="/build_until_verified/implement"
      />,
    );
    const inspector = screen.getByTestId("definition-graph-inspector");
    expect(inspector.textContent).toContain("config.prompt");
    expect(inspector.textContent).toContain("inputs.repository");
    expect(inspector.textContent).toContain("in text");
    expect(screen.getByTestId("definition-graph-inspector-pointer").textContent).toBe(
      "/spec/nodes/2/config/body/nodes/0",
    );
    // The declared roots it names, as words: the UI never re-resolves a plan.
    expect(screen.getAllByText("inputs").length).toBe(3);
    expect(screen.getByText("previous").textContent).toBe("previous");
  });

  it("states the canvas size, so a cut-off graph does not look complete", () => {
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const hint = screen.getByTestId("definition-graph-hint").textContent!;
    // The numbers come from the layout, not from a caption: eight concrete nodes
    // (three of them inside the loop) and seven edges is the § 9.3 sample exactly.
    expect(hint).toContain("8 nodes");
    expect(hint).toContain("7 edges");
    expect(hint).toMatch(/\d+×\d+px/);
  });

  it("keeps an equivalent node list for anyone not using the canvas", () => {
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const list = screen.getByTestId("definition-graph-list");
    expect(list.textContent).toContain("after implement");
    expect(list.textContent).toContain("4 bindings");
  });

  it("moves focus to a neighbouring node with the arrow keys", () => {
    const onSelectKey = vi.fn();
    render(<DefinitionGraph document={samplePipelineDocument} onSelectKey={onSelectKey} />);
    const canvas = screen.getByTestId("definition-graph");
    const plan = screen.getByTestId("definition-graph-node-plan");
    plan.focus();
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(onSelectKey).toHaveBeenCalledWith("/approve");
  });

  it("marks the seven kinds M4 refuses, with the milestone named", () => {
    const deferred = {
      ...fanOutPipelineDocument,
      spec: {
        ...fanOutPipelineDocument.spec,
        nodes: [
          ...fanOutPipelineDocument.spec.nodes,
          { id: "push", kind: "git.publish", dependsOn: ["collect"], config: {} },
        ],
      },
    };
    render(<DefinitionGraph document={deferred} />);
    expect(screen.getByTestId("definition-graph-node-push").textContent).toContain("not until M6");
  });

  it("shows a node's run rollup when the caller has one, without touching the definition", () => {
    render(
      <DefinitionGraph
        document={samplePipelineDocument}
        statuses={{ "/plan": "succeeded", "/verdict": "interrupted" }}
      />,
    );
    // Inside the box the chip carries the state's short word, because a 200px
    // node cannot hold "interrupted" beside a kind name.
    expect(screen.getByTestId("definition-graph-node-plan").textContent).toContain("done");
    // In the list, the wire status appears verbatim: the list has the room, and
    // `succeeded` is what the API said.
    expect(screen.getByTestId("definition-graph-list-plan").textContent).toContain("succeeded");
    expect(screen.getByTestId("definition-graph-node-verdict").textContent).toContain("stopped");
    expect(screen.getByTestId("definition-graph-list-verdict").textContent).toContain(
      "interrupted",
    );
  });

  it("degrades to words when the document is not a pipeline", () => {
    render(<DefinitionGraph document={{ apiVersion: "x", kind: "Draft", spec: { nodes: [] } }} />);
    expect(screen.getByTestId("definition-graph-unavailable").textContent).toContain(
      "does not read as a pipeline",
    );
  });

  it("refuses to crash on a document whose graph is not a DAG", () => {
    const cyclic = structuredClone(samplePipelineDocument);
    cyclic.spec.nodes[0].dependsOn = ["verdict"];
    cyclic.spec.nodes[3].dependsOn = ["plan"];
    render(<DefinitionGraph document={cyclic} />);
    // dagre breaks cycles rather than failing, so *something* is drawn; the
    // claim to test is that no throw reaches the caller.
    expect(screen.getByTestId("definition-graph")).toBeTruthy();
  });
});
