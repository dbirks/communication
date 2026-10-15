/**
 * W8's UI arm: every finding renders with its location on the document, its
 * source and its hint — and a secret-literal finding renders redacted.
 */
import { afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { YamlView } from "./YamlView";
import { samplePipelineYaml } from "../../test/fixtures/m4/samplePipeline";
import { validValidation, w8DraftYaml, w8Validation } from "../../test/fixtures/m4/w8Draft";

// Vitest globals are off, so testing-library cannot register its own cleanup.
afterEach(cleanup);

/** The 1-based line carrying a snippet of authored YAML. */
function lineOf(text: string, needle: string): number {
  const at = text.split("\n").findIndex((line) => line.includes(needle));
  if (at < 0) throw new Error(`no such line: ${needle}`);
  return at + 1;
}

describe("YamlView", () => {
  it("marks each finding on the line its pointer names", () => {
    render(<YamlView text={w8DraftYaml} validation={w8Validation} />);
    // `/spec/nodes/0` — the item itself, whose duplicate key the loader refused.
    expect(
      screen.getByTestId(`yaml-line-${lineOf(w8DraftYaml, "- id: plan")}`).textContent,
    ).toContain("duplicate_key");
    // `/spec/nodes/3/config/body/nodes/2` — the body node with the outside dependency.
    expect(
      screen.getByTestId(`yaml-line-${lineOf(w8DraftYaml, "- id: review")}`).textContent,
    ).toContain("depends_on_outside_scope");
    // `schema_shape` addresses `/spec/nodes/3/config` — the config object, three
    // lines into the `verify` item — while the message names the property.
    expect(
      screen.getByTestId(`yaml-line-${lineOf(w8DraftYaml, "- id: verify") + 3}`).textContent,
    ).toContain("schema_shape");
    expect(
      screen.getByTestId(`yaml-line-${lineOf(w8DraftYaml, "maxParallelism")}`).textContent,
    ).not.toContain("schema_shape");
    // Fourteen findings, each with a marker: one per distinct location line.
    expect(screen.getAllByTestId(/^yaml-error-marker-/)).toHaveLength(14);
  });

  it("counts the three sources separately, in the order that gated them", () => {
    render(<YamlView text={w8DraftYaml} validation={w8Validation} />);
    expect(screen.getByTestId("yaml-validation-verdict").textContent).toBe("14 findings");
    expect(screen.getByTestId("yaml-validation-tally-loader").textContent).toBe("loader 1");
    expect(screen.getByTestId("yaml-validation-tally-schema").textContent).toBe("schema 3");
    expect(screen.getByTestId("yaml-validation-tally-compiler").textContent).toBe("compiler 10");
    const sources = screen.getAllByTestId(/^yaml-finding-source-/).map((node) => node.textContent);
    expect(sources[0]).toBe("loader");
    expect(sources.filter((source) => source === "schema")).toHaveLength(3);
  });

  it("shows a finding's instance location and hint verbatim", () => {
    render(<YamlView text={w8DraftYaml} validation={w8Validation} />);
    const index = w8Validation.errors.findIndex((issue) => issue.code === "cel_compile_error");
    expect(screen.getByTestId(`yaml-finding-location-${index}`).textContent).toBe(
      "/spec/nodes/3/config/passWhen",
    );
    expect(screen.getByTestId(`yaml-finding-message-${index}`).textContent).toContain(
      "invalid expression syntax",
    );
  });

  it("names the milestone a deferred kind waits for, in the server's words", () => {
    render(<YamlView text={w8DraftYaml} validation={w8Validation} />);
    const index = w8Validation.errors.findIndex(
      (issue) => issue.code === "kind_not_implemented" && issue.message.includes("git.commit"),
    );
    expect(screen.getByTestId(`yaml-finding-message-${index}`).textContent).toContain(
      "kind git.commit is not implemented until M6",
    );
  });

  it("renders a secret-literal finding as a redaction, not a quote", () => {
    const { container } = render(<YamlView text={w8DraftYaml} validation={w8Validation} />);
    const index = w8Validation.errors.findIndex(
      (issue) => issue.code === "secret_literal_detected",
    );
    const block = screen.getByTestId("yaml-finding-redacted");
    expect(block.getAttribute("aria-label")).toBe("value never shown");
    expect(screen.getByTestId(`yaml-finding-hint-${index}`).textContent).toContain("secretRefs:");
    // Nothing in the findings panel reads like a credential.
    const findings = screen.getByTestId("yaml-validation-errors");
    expect(findings.textContent).not.toMatch(/password|@[a-z0-9.]+:[0-9]+\/|:\/\/[^ ]*:[^ ]*@/i);
    expect(container).toBeTruthy();
  });

  it("says when a pointer could only be resolved to its closest line", () => {
    const inexact = {
      ...w8Validation,
      errors: [
        {
          code: "type_mismatch",
          source: "schema" as const,
          message: "got string, want integer",
          instance_location: "/spec/inputs/properties/goal/minLength",
          schema_location: null,
          hint: null,
        },
      ],
    };
    render(<YamlView text={samplePipelineYaml} validation={inexact} />);
    // `goal: {type: string, minLength: 1}` is flow style: the marker can only
    // reach the line, and the finding has to admit it.
    expect(screen.getByTestId("yaml-finding-0").textContent).toContain(
      `line ${lineOf(samplePipelineYaml, "goal: {type: string")}`,
    );
    expect(screen.getByTestId("yaml-finding-0").textContent).toContain("closest");
  });

  it("shows nothing marked, and says why, when no validate body exists", () => {
    render(<YamlView text={samplePipelineYaml} />);
    expect(screen.getByTestId("yaml-validation-none").textContent).toContain("No validate body");
    expect(screen.queryAllByTestId(/^yaml-error-marker-/)).toHaveLength(0);
  });

  it("renders a valid document as valid", () => {
    render(<YamlView text={samplePipelineYaml} validation={validValidation} label="revision 7" />);
    expect(screen.getByTestId("yaml-validation-verdict").textContent).toBe("valid");
    expect(screen.getByTestId("yaml-view-label").textContent).toBe("revision 7");
  });

  it("is not an editor: no textbox, and the read-only reason is on the screen", () => {
    const { container } = render(<YamlView text={samplePipelineYaml} />);
    expect(container.querySelector("textarea, [contenteditable], [role='textbox']")).toBeNull();
    expect(screen.getByTestId("yaml-view-readonly-note").textContent).toContain("read-only");
  });

  it("paginates a long document instead of rendering all of it", () => {
    const text = `${samplePipelineYaml}\n${Array.from({ length: 400 }, (_, i) => `# filler ${i}`).join("\n")}`;
    render(<YamlView text={text} validation={w8Validation} />);
    expect(screen.queryByTestId("yaml-line-250")).toBeNull();
    fireEvent.click(screen.getByTestId("yaml-view-more"));
    expect(screen.getByTestId("yaml-line-250")).toBeTruthy();
  });

  it("offers the pointer of a highlighted block to the graph above it", () => {
    const onSelectPointer = vi.fn();
    render(
      <YamlView
        text={samplePipelineYaml}
        highlightPointer="/spec/nodes/2/config/body/nodes/1"
        onSelectPointer={onSelectPointer}
      />,
    );
    // The `test` body node's block is washed, and its first line offers the pointer.
    const washed = screen.getByTestId(`yaml-line-${lineOf(samplePipelineYaml, "- id: test")}`);
    expect(washed.className).toContain("bg-accent-wash");
    fireEvent.click(screen.getAllByTestId("yaml-line-pointer")[0]);
    expect(onSelectPointer).toHaveBeenCalledWith("/spec/nodes/0");
  });
});
