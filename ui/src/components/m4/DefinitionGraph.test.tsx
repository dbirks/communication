/**
 * The definition graph is a projection of a pinned revision, so its tests are
 * about fidelity and access: the nodes and scopes the document actually has,
 * the bindings the document actually contains, a keyboard path that does not
 * need the canvas, and a deferred kind that says so in words.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DefinitionGraph,
  MIN_LABEL_PX,
  MIN_READABLE_SCALE,
  SMALLEST_CANVAS_FONT_PX,
} from "./DefinitionGraph";
import { NODE_MAX_WIDTH } from "../../lib/pipeline/layout";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import {
  fanOutPipelineDocument,
  samplePipelineDocument,
} from "../../test/fixtures/m4/samplePipeline";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

/** A definition whose node names are wider than the fixed box the canvas used
 * to draw, and a scope whose bar is wider than the single child it holds — the
 * two shapes the live `feature-development` revision showed clipped. */
const wideNodesDocument = {
  apiVersion: "communication.dev/v1alpha1",
  version: "v1alpha1",
  kind: "pipeline",
  metadata: { name: "wide-nodes" },
  spec: {
    nodes: [
      { id: "plan", kind: "process.exec", config: { executable: "ls" } },
      {
        id: "fan_out",
        kind: "for_each",
        dependsOn: ["plan"],
        config: {
          maxConcurrency: 3,
          items: "inputs.things",
          body: {
            nodes: [
              {
                id: "invoke_reviewer",
                kind: "pipeline.invoke",
                config: { pipeline: "reviewer" },
              },
            ],
          },
        },
      },
      {
        id: "review_and_record_the_decision",
        kind: "artifact.publish",
        dependsOn: ["fan_out"],
        config: { path: "out/review.md" },
      },
    ],
  },
} as unknown as DefinitionDocument;

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

  it("labels every node with its kind in words, and keeps the name readable", () => {
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const node = screen.getByTestId("definition-graph-node-plan");
    // A box sized to its content carries the few words the design uses (`agent`);
    // the catalogue name — what the API and an expression say — is in the
    // aria-label, the title and the list below the canvas.
    expect(node.textContent).toContain("agent");
    expect(node.getAttribute("aria-label")).toContain("kind agent.acp");
    expect(screen.getByTestId("definition-graph-node-kind-plan").getAttribute("title")).toBe(
      "agent.acp",
    );
    expect(screen.getByTestId("definition-graph-list-plan").textContent).toContain("agent.acp");
  });

  it("names only the kind in a definition-only graph, never a run state", () => {
    const { container } = render(
      <DefinitionGraph
        document={samplePipelineDocument}
        label={"r1 \u00b7 definition only, no run states"}
      />,
    );
    // The bug this pins: a box reading `command pendi` on a screen whose own
    // header says "definition only, no run states". With no `statuses` from the
    // caller there is no run to be pending in, so the kind word stands alone —
    // on the canvas and in the list, which is the same graph in words.
    expect(container.textContent).not.toContain("pending");
    const plan = screen.getByTestId("definition-graph-node-plan");
    expect(plan.textContent).toContain("agent");
    expect(screen.queryByTestId("definition-graph-node-state-plan")).toBeNull();
    expect(screen.queryByTestId("definition-graph-list-unscheduled-plan")).toBeNull();
    expect(screen.getByTestId("definition-graph-node-kind-plan").textContent).toBe("agent");
  });

  it("keeps kind and state together when the caller supplies run states", () => {
    // The other mode, unchanged: a caller that has a run keeps today's text, and
    // a node that run never scheduled says so rather than showing nothing.
    render(
      <DefinitionGraph document={samplePipelineDocument} statuses={{ "/plan": "succeeded" }} />,
    );
    const plan = screen.getByTestId("definition-graph-node-plan");
    expect(plan.textContent).toContain("agent");
    expect(plan.textContent).toContain("done");
    expect(screen.getByTestId("definition-graph-node-verdict").textContent).toContain("pending");
    expect(screen.getByTestId("definition-graph-list-unscheduled-verdict")).toBeTruthy();
  });

  it("sizes a node box to its id and wraps a long one rather than clipping it", () => {
    render(<DefinitionGraph document={wideNodesDocument} />);
    const slug = "review_and_record_the_decision";
    const box = screen.getByTestId(`definition-graph-node-${slug}`);
    const width = Number(box.style.width.replace("px", ""));
    const height = Number(box.style.height.replace("px", ""));
    // `review_and_record_the_decision` does not fit the old fixed 108px box, and
    // that is what produced "emit_ite…": width now follows content up to the ceiling,
    // and past the ceiling the id takes a second row.
    expect(width).toBeGreaterThan(108);
    expect(width).toBeLessThanOrEqual(NODE_MAX_WIDTH);
    expect(height).toBeGreaterThan(60);
    const id = screen.getByTestId(`definition-graph-node-id-${slug}`);
    expect(id.textContent).toBe("review_and_record_the_decision");
    expect(id.className).toContain("break-words");
    expect(id.className).not.toContain("truncate");
    // A short id is not padded to the same width, and the second line — the kind,
    // which the caller can abbreviate — is the only one that may ellipsize.
    expect(
      Number(screen.getByTestId("definition-graph-node-plan").style.width.replace("px", "")),
    ).toBe(108);
    expect(screen.getByTestId("definition-graph-node-kind-plan").className).toContain("shrink-0");
    // The edges are laid out against these same boxes, so a wider node cannot
    // leave its arrow short: the polyline starts on the box it leaves from.
    const plan = screen.getByTestId("definition-graph-node-plan");
    const edge = screen.getByTestId("definition-graph-edge-plan-to-invoke_reviewer");
    const [first] = edge.getAttribute("points")!.trim().split(/\s+/);
    const [startX] = first.split(",").map(Number);
    expect(startX).toBe(
      Number(plan.style.left.replace("px", "")) + Number(plan.style.width.replace("px", "")),
    );
    expect(box.getAttribute("data-node-key")).toBe(`/${slug}`);
  });

  it("gives a scope bar its own rows above the children it contains", () => {
    render(<DefinitionGraph document={wideNodesDocument} />);
    const group = screen.getByTestId("definition-graph-scope-fan_out");
    const label = screen.getByTestId("definition-graph-scope-label-fan_out");
    const child = screen.getByTestId("definition-graph-node-fan_out-invoke_reviewer");
    expect(label.textContent).toBe("for each \u00b7 fan_out \u00b7 \u22643 parallel");
    // The `for each · fan_out · ≤3` line is wider than the one 108px child under it,
    // so it wraps — and the box grew a row for it instead of the second row
    // landing on the child's title, as it did live.
    const reserved =
      Number(child.style.top.replace("px", "")) - Number(group.style.top.replace("px", ""));
    expect(reserved).toBeGreaterThanOrEqual(48);
    // The label wraps inside the box it belongs to, never over its edge.
    expect(Number(label.style.width.replace("px", ""))).toBeLessThan(
      Number(group.style.width.replace("px", "")),
    );
  });

  it("draws a human.approval node as a gate, and an unscheduled node dashed", () => {
    render(<DefinitionGraph document={samplePipelineDocument} statuses={{ "/plan": "pending" }} />);
    const gate = screen.getByTestId("definition-graph-node-approve");
    expect(gate.getAttribute("data-gate")).toBe("true");
    expect(gate.className).toContain("bg-st-waiting-pale-body");
    expect(gate.textContent).toContain("gate");
    // A node the run never scheduled is dashed and muted, like "Draft PR".
    const plan = screen.getByTestId("definition-graph-node-plan");
    expect(plan.className).toContain("border-dashed");
    expect(plan.getAttribute("data-state")).toBe("queued");
    expect(screen.getByTestId("definition-graph-list-approve").getAttribute("data-gate")).toBe(
      "true",
    );
  });

  it("draws each scope box around its children, with its bound and its loop line", () => {
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const group = screen.getByTestId("definition-graph-scope-build_until_verified");
    expect(group.getAttribute("data-scope-kind")).toBe("until");
    expect(group.textContent).toContain("until \u00b7 build_until_verified \u00b7 max 4");
    expect(
      screen.getByTestId("definition-graph-scope-note-build_until_verified").textContent,
    ).toContain("\u21bb");
    // The children sit inside the box in the laid-out geometry, not beside it.
    const child = screen.getByTestId("definition-graph-node-build_until_verified-implement");
    expect(Number(child.style.left.replace("px", ""))).toBeGreaterThan(
      Number(group.style.left.replace("px", "")),
    );
    expect(
      screen.getByTestId("definition-graph-list-build_until_verified-implement").textContent,
    ).toContain("in build_until_verified");
  });

  it("fits the pane but never past the readable floor: a wide graph pans, it does not shrink", () => {
    // Unmeasured (jsdom reports no layout at all), the graph keeps its natural
    // scale rather than scaling to nothing.
    render(<DefinitionGraph document={samplePipelineDocument} />);
    expect(screen.getByTestId("definition-graph-canvas").getAttribute("data-scale")).toBe("1.000");
    cleanup();
    // A pane much narrower than the graph. Scaling to fit would put a node's
    // kind line under 9px — the live view landed at 68% — so the floor holds and
    // the frame gains a horizontal scrollbar instead.
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      value: 320,
    });
    render(<DefinitionGraph document={samplePipelineDocument} />);
    const canvas = screen.getByTestId("definition-graph-canvas");
    const fitted = Number(canvas.getAttribute("data-scale"));
    expect(fitted).toBeGreaterThanOrEqual(MIN_READABLE_SCALE);
    // The invariant in the reader's units, not in scale numbers.
    expect(SMALLEST_CANVAS_FONT_PX * fitted).toBeGreaterThanOrEqual(MIN_LABEL_PX);
    // So the graph must overflow the frame, and the sized box says by how much.
    const sized = canvas.parentElement as HTMLElement;
    expect(Number(sized.style.width.replace("px", ""))).toBeGreaterThan(320);
    expect(screen.getByTestId("definition-graph").className).toContain("overflow-auto");
    expect(screen.getByTestId("definition-graph-scale").textContent).toContain("%");
    expect(screen.getByTestId("definition-graph-hint").textContent).toContain("drag to pan");
    // Zoom still belongs to the reader: `+` goes up, `−` may go below the floor
    // on an explicit click, and `fit` returns to it.
    fireEvent.click(screen.getByTestId("definition-graph-zoom-in"));
    expect(
      Number(screen.getByTestId("definition-graph-canvas").getAttribute("data-scale")),
    ).toBeGreaterThan(fitted);
    fireEvent.click(screen.getByTestId("definition-graph-zoom-fit"));
    expect(screen.getByTestId("definition-graph-canvas").getAttribute("data-scale")).toBe(
      fitted.toFixed(3),
    );
    fireEvent.click(screen.getByTestId("definition-graph-zoom-out"));
    expect(
      Number(screen.getByTestId("definition-graph-canvas").getAttribute("data-scale")),
    ).toBeLessThan(fitted);
    delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  });

  it("selects a node from the canvas and from the list with the same handle", () => {
    const onSelectKey = vi.fn();
    render(<DefinitionGraph document={samplePipelineDocument} onSelectKey={onSelectKey} />);
    fireEvent.click(screen.getByTestId("definition-graph-node-plan"));
    expect(onSelectKey).toHaveBeenLastCalledWith("/plan");
    fireEvent.click(screen.getByTestId("definition-graph-list-build_until_verified-test"));
    expect(onSelectKey).toHaveBeenLastCalledWith("/build_until_verified/test");
    fireEvent.keyDown(screen.getByTestId("definition-graph-node-approve"), { key: "Enter" });
    expect(onSelectKey).toHaveBeenLastCalledWith("/approve");
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
