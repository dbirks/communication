import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { renameNode, updateConfig, type OpResult } from "../../lib/pipeline/graphDoc";
import { StepBesideCard, type StepBesideKind } from "./StepBesideCard";

afterEach(cleanup);

const YAML = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: test
spec:
  nodes:
    - id: build
      kind: process.exec
      config:
        executable: make
        args:
          - all
          - verbose
    - id: approve_release
      kind: human.approval
      config:
        summary: Ship the release
        approverRoles:
          - lead
    - id: triage
      kind: model.chat
      config:
        model: gpt-5
        messages:
          - role: user
            content: Classify this failure
          - role: system
            content: You triage build failures.
    - id: bare_judge
      kind: model.chat
      config:
        model: gpt-5
`;

interface Doc {
  spec: { nodes: { id: string; config: Record<string, unknown> }[] };
}

function configOf(text: string, id: string): Record<string, unknown> {
  const doc = parse(text) as Doc;
  return doc.spec.nodes.find((n) => n.id === id)!.config;
}

function renderCard(
  kind: StepBesideKind,
  nodeId: string,
  overrides: Partial<React.ComponentProps<typeof StepBesideCard>> = {},
) {
  let text = YAML;
  const apply = vi.fn((op: (t: string) => OpResult) => {
    const r = op(text);
    if (r.ok) text = r.text;
    return r;
  });
  const onMoreSettings = vi.fn();
  const onWrap = vi.fn();
  const onClose = vi.fn();
  const onRenamed = vi.fn();
  render(
    <StepBesideCard
      nodeId={nodeId}
      kind={kind}
      config={configOf(YAML, nodeId)}
      text={text}
      readOnly={false}
      apply={apply}
      onRenamed={onRenamed}
      onMoreSettings={onMoreSettings}
      onWrap={onWrap}
      onClose={onClose}
      {...overrides}
    />,
  );
  return {
    apply,
    onMoreSettings,
    onWrap,
    onClose,
    onRenamed,
    committedText: () => apply.mock.results[apply.mock.results.length - 1]?.value as OpResult,
  };
}

describe("StepBesideCard", () => {
  it("shows a per-kind title", () => {
    const exec = renderCard("process.exec", "build");
    expect(screen.getByText("COMMAND STEP")).toBeTruthy();
    exec.onClose();
    cleanup();
    const approval = renderCard("human.approval", "approve_release");
    expect(screen.getByText("APPROVAL")).toBeTruthy();
    approval.onClose();
    cleanup();
    const judge = renderCard("model.chat", "triage");
    expect(screen.getByText("JUDGE")).toBeTruthy();
    judge.onClose();
  });

  it("commits the command input split into executable and args", () => {
    const { apply } = renderCard("process.exec", "build");
    const input = screen.getByTestId("step-card-command") as HTMLInputElement;
    expect(input.value).toBe("make all verbose");
    fireEvent.change(input, { target: { value: "pnpm test --run" } });
    fireEvent.blur(input);
    expect(apply).toHaveBeenCalledTimes(1);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = configOf(result.text, "build");
    expect(config.executable).toBe("pnpm");
    expect(config.args).toEqual(["test", "--run"]);
  });

  it("omits args when the command has no arguments", () => {
    const { apply } = renderCard("process.exec", "build");
    const input = screen.getByTestId("step-card-command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "ls" } });
    fireEvent.blur(input);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const config = configOf(result.text, "build");
    expect(config.executable).toBe("ls");
    expect("args" in config).toBe(false);
  });

  it("commits approvers as a string array", () => {
    const { apply } = renderCard("human.approval", "approve_release");
    const input = screen.getByTestId("step-card-approvers") as HTMLInputElement;
    expect(input.value).toBe("lead");
    fireEvent.change(input, { target: { value: "lead, oncall ,sre" } });
    fireEvent.blur(input);
    expect(apply).toHaveBeenCalledTimes(1);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(configOf(result.text, "approve_release").approverRoles).toEqual([
      "lead",
      "oncall",
      "sre",
    ]);
  });

  it("commits the approval summary textarea", () => {
    const { apply } = renderCard("human.approval", "approve_release");
    const input = screen.getByTestId("step-card-summary") as HTMLTextAreaElement;
    expect(input.value).toBe("Ship the release");
    expect(input.rows).toBe(4);
    fireEvent.change(input, { target: { value: "Ship v2 to production" } });
    fireEvent.blur(input);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(configOf(result.text, "approve_release").summary).toBe("Ship v2 to production");
  });

  it("edits only the system message content when rewriting the judge task", () => {
    const { apply } = renderCard("model.chat", "triage");
    const input = screen.getByTestId("step-card-task") as HTMLTextAreaElement;
    expect(input.value).toBe("You triage build failures.");
    fireEvent.change(input, { target: { value: "Triage by severity." } });
    fireEvent.blur(input);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(configOf(result.text, "triage").messages).toEqual([
      { role: "user", content: "Classify this failure" },
      { role: "system", content: "Triage by severity." },
    ]);
  });

  it("creates a system message when the judge has none", () => {
    const { apply } = renderCard("model.chat", "bare_judge");
    const input = screen.getByTestId("step-card-task") as HTMLTextAreaElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "Decide if flaky" } });
    fireEvent.blur(input);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(configOf(result.text, "bare_judge").messages).toEqual([
      { role: "system", content: "Decide if flaky" },
    ]);
  });

  it("commits the model input", () => {
    const { apply } = renderCard("model.chat", "triage");
    const input = screen.getByTestId("step-card-model") as HTMLInputElement;
    expect(input.value).toBe("gpt-5");
    fireEvent.change(input, { target: { value: "gpt-5-mini" } });
    fireEvent.blur(input);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(configOf(result.text, "triage").model).toBe("gpt-5-mini");
  });

  it("renames the step through renameNode and reports the new id", () => {
    const { apply, onRenamed } = renderCard("process.exec", "build");
    const name = screen.getByTestId("step-card-name") as HTMLInputElement;
    expect(name.value).toBe("build");
    fireEvent.change(name, { target: { value: "Bad Name!" } });
    fireEvent.blur(name);
    expect(screen.getByTestId("step-card-rename-error")).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();

    fireEvent.change(name, { target: { value: "compile" } });
    fireEvent.blur(name);
    expect(screen.queryByTestId("step-card-rename-error")).toBeNull();
    expect(apply).toHaveBeenCalledTimes(1);
    const result = apply.mock.results[0].value as OpResult;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("id: compile");
    expect(onRenamed).toHaveBeenCalledWith("compile");
  });

  it("disables every input in readOnly mode", () => {
    renderCard("human.approval", "approve_release", { readOnly: true });
    for (const testid of ["step-card-name", "step-card-summary", "step-card-approvers"]) {
      const el = screen.getByTestId(testid) as HTMLInputElement | HTMLTextAreaElement;
      expect(el.disabled).toBe(true);
    }
  });

  it("calls More settings, Wrap and close handlers; hides Wrap when unset", () => {
    const { onMoreSettings, onWrap, onClose } = renderCard("process.exec", "build");
    fireEvent.click(screen.getByTestId("step-card-more"));
    expect(onMoreSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("step-card-wrap"));
    expect(onWrap).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("step-card-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    cleanup();
    renderCard("process.exec", "build", { onWrap: undefined });
    expect(screen.queryByTestId("step-card-wrap")).toBeNull();
  });

  it("does not commit when the value is unchanged", () => {
    const { apply } = renderCard("human.approval", "approve_release");
    fireEvent.blur(screen.getByTestId("step-card-name"));
    fireEvent.blur(screen.getByTestId("step-card-summary"));
    fireEvent.blur(screen.getByTestId("step-card-approvers"));
    expect(apply).not.toHaveBeenCalled();
  });

  it("uses real graphDoc ops without touching other nodes", () => {
    // Sanity: the ops themselves behave as the card assumes.
    const renamed = renameNode(YAML, "build", "compile");
    expect(renamed.ok).toBe(true);
    const patched = updateConfig(YAML, "build", { executable: "make" });
    expect(patched.ok).toBe(true);
    if (!renamed.ok || !patched.ok) return;
    expect(renamed.text).toContain("id: compile");
    expect(patched.text).toContain("Ship the release");
  });
});
