/**
 * The Studio diff panel: an unpublished pipeline reads "everything is new",
 * a broken draft reads "fix the YAML", an identical draft reads "no semantic
 * changes", a layout-only draft reads "only layout moved", and a changed
 * draft lists its nodes by group with expandable before/afters — long strings
 * as `-`/`+` lines, plus the edge and pipeline-level changes.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiffPanel } from "./DiffPanel";
import { stringify } from "yaml";

afterEach(cleanup);

const BASE = {
  apiVersion: "communication.dev/v1alpha1",
  kind: "Pipeline",
  metadata: { name: "sample", description: "diff fixture" },
  spec: {
    policies: { maxConcurrentNodes: 1 },
    nodes: [
      {
        id: "plan",
        kind: "model.chat",
        config: { prompt: "Draft a plan." },
      },
      { id: "check", kind: "process.exec", dependsOn: ["plan"] },
    ],
  },
} as Record<string, any>;

const baseYaml = (): string => stringify(BASE);

describe("DiffPanel", () => {
  it("reads an unpublished pipeline as all new", () => {
    render(<DiffPanel baseDocument={null} text={baseYaml()} />);
    expect(screen.getByTestId("diff-panel")).toBeTruthy();
    expect(screen.getByTestId("diff-empty").textContent).toBe(
      "No published revision yet — everything is new",
    );
  });

  it("reads broken draft YAML as an instruction, not a diff", () => {
    render(<DiffPanel baseDocument={BASE} text="spec: [nodes: not-closed" />);
    expect(screen.getByTestId("diff-invalid").textContent).toBe(
      "Fix the YAML errors to see the diff",
    );
    expect(screen.queryByTestId("diff-empty")).toBeNull();
  });

  it("reads an identical draft as no semantic changes", () => {
    render(<DiffPanel baseDocument={BASE} text={baseYaml()} />);
    expect(screen.getByTestId("diff-empty").textContent).toBe("No semantic changes");
  });

  it("reads a metadata.ui-only difference as a layout move", () => {
    const next = structuredClone(BASE);
    next.metadata = { ...next.metadata, ui: { columns: { plan: { x: 4, y: 8 } } } };
    render(<DiffPanel baseDocument={BASE} text={stringify(next)} />);
    expect(screen.getByTestId("diff-empty").textContent).toBe("only layout moved");
  });

  it("lists added, removed and changed nodes, expandable to before/afters", () => {
    const next = structuredClone(BASE);
    const nodes = next.spec.nodes;
    // changed: the prompt
    nodes.find((node: any) => node.id === "plan")!.config.prompt = "Draft a longer plan.";
    // removed: check
    next.spec.nodes = nodes.filter((node: any) => node.id !== "check");
    // added: publish
    next.spec.nodes.push({
      id: "publish",
      kind: "artifact.publish",
      dependsOn: ["plan"],
    });
    render(<DiffPanel baseDocument={BASE} text={stringify(next)} />);

    const plan = screen.getByTestId("diff-node-plan");
    expect(plan.textContent).toContain("plan");
    expect(plan.textContent).toContain("changed");
    // collapsed at first: the old prompt text is not on screen yet
    expect(screen.queryByText("Draft a plan.")).toBeNull();
    fireEvent.click(plan);
    expect(screen.getByText("config.prompt")).toBeTruthy();
    expect(screen.getByText("Draft a plan.")).toBeTruthy();
    expect(screen.getByText("Draft a longer plan.")).toBeTruthy();

    const check = screen.getByTestId("diff-node-check");
    expect(check.textContent).toContain("removed");
    const publish = screen.getByTestId("diff-node-publish");
    expect(publish.textContent).toContain("added");
    fireEvent.click(publish);
    expect(screen.getByText("New node — nothing to compare.")).toBeTruthy();

    // the dependsOn changes show as one added edge
    const edgeText = screen.getByText("plan → publish");
    expect(edgeText.parentElement?.textContent).toContain("added");
  });

  it("shows long string changes as -/+ lines", () => {
    const long = (head: string): string =>
      [
        head,
        "second line of the prompt",
        "third line of the prompt",
        "fourth line of the prompt",
      ].join("\n");
    const next = structuredClone(BASE);
    next.spec.nodes.find((node: any) => node.id === "plan")!.config.prompt = long(
      "Draft a much longer plan.",
    );
    render(<DiffPanel baseDocument={BASE} text={stringify(next)} />);
    const plan = screen.getByTestId("diff-node-plan");
    fireEvent.click(plan);
    const lines = screen.getAllByTestId("diff-line");
    expect(lines.some((line) => line.textContent === "- Draft a plan.")).toBe(true);
    expect(lines.some((line) => line.textContent === "+ Draft a much longer plan.")).toBe(true);
    expect(lines.some((line) => line.textContent === "+ second line of the prompt")).toBe(true);
  });

  it("reports pipeline-level changes outside the node list", () => {
    const next = structuredClone(BASE);
    next.spec.policies.maxConcurrentNodes = 4;
    render(<DiffPanel baseDocument={BASE} text={stringify(next)} />);
    expect(screen.getByText("spec.policies.maxConcurrentNodes")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.queryByTestId("diff-node-plan")).toBeNull();
  });
});
