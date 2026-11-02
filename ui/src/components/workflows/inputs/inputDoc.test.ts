/**
 * inputDoc — the pure document half of the Inputs tab (design 1j, ADR-0066).
 * The contracts with teeth: the derivation mirrors the server's `input_specs`
 * reading (annotation merged over JSON Schema members, un-annotated presented
 * as text, sorted by name), and every edit writes the ANNOTATION plus the
 * JSON Schema members the ADR keeps in step (`required` in the array, `default`
 * on the property, `type` matching the runtime shape) into the draft text —
 * without disturbing the rest of the document.
 */
import { describe, expect, it } from "vitest";
import {
  applyInputEdit,
  draftInputSpecs,
  draftTextParses,
  inputsYamlPreview,
  suggestInputName,
  usedByStepNames,
} from "./inputDoc";

const DOC = `apiVersion: communication.dev/v1alpha1
kind: Pipeline
metadata:
  name: issue-to-pr
spec:
  inputs:
    type: object
    required: [issue]
    properties:
      issue:
        type: object
        x-communication-input: {type: github_issue, label: Issue to work on, help: The issue becomes the goal.}
      base_branch:
        type: string
        default: main
        x-communication-input: {type: branch, label: Base branch}
      notes:
        type: string
  nodes:
    - id: plan
      kind: agent.acp
      config:
        prompt: |
          Goal: \${{ inputs.issue.body }} on \${{ inputs.base_branch }}
    - id: loop
      kind: until
      config:
        body:
          nodes:
            - id: implement
              kind: agent.acp
              config:
                prompt: Read \${{ inputs.issue.title }}
            - id: tidy
              kind: agent.acp
              config:
                prompt: nothing here
`;

describe("draftInputSpecs — the ADR-0066 derivation", () => {
  it("merges the annotation over the JSON Schema members, sorted by name", () => {
    expect(draftInputSpecs(DOC)).toEqual([
      {
        name: "base_branch",
        type: "branch",
        label: "Base branch",
        help: undefined,
        required: false,
        default: "main",
      },
      {
        name: "issue",
        type: "github_issue",
        label: "Issue to work on",
        help: "The issue becomes the goal.",
        required: true,
      },
      { name: "notes", type: "text", label: undefined, help: undefined, required: false },
    ]);
  });

  it("a document without spec.inputs has no rows, not an error", () => {
    expect(draftInputSpecs("apiVersion: v\nkind: Pipeline\nspec:\n  nodes: []\n")).toEqual([]);
    expect(draftTextParses("a: {b: 1\n c: 2")).toBe(false);
    expect(draftTextParses(DOC)).toBe(true);
  });

  it("an unknown annotation type rides through unchanged", () => {
    const specs = draftInputSpecs(
      DOC.replace("type: github_issue", "type: github_pr").replace(
        "type: object\n        x-communication-input",
        "type: object\n        x-communication-input",
      ),
    );
    expect(specs.find((s) => s.name === "issue")?.type).toBe("github_pr");
  });
});

describe("usedByStepNames", () => {
  it("names the step whose binding reads the input", () => {
    expect(usedByStepNames(DOC, "base_branch")).toEqual(["plan"]);
  });

  it("reports every step that reads it, and the innermost step inside a loop", () => {
    // `plan` and the nested `implement` both read `issue`; the loop itself
    // never does, so it is not named — only its inner step is.
    expect(usedByStepNames(DOC, "issue")).toEqual(["plan", "implement"]);
    const noPlan = DOC.replace(
      "Goal: ${{ inputs.issue.body }} on ${{ inputs.base_branch }}",
      "Goal: something else",
    );
    expect(usedByStepNames(noPlan, "issue")).toEqual(["implement"]);
  });

  it("never lets a sibling name match", () => {
    expect(usedByStepNames(DOC, "issue_title")).toEqual([]);
    expect(usedByStepNames(DOC, "notes")).toEqual([]);
  });
});

describe("applyInputEdit — add", () => {
  it("creates spec.inputs when the document has none", () => {
    const out = applyInputEdit("apiVersion: v\nkind: Pipeline\nspec:\n  nodes: []\n", {
      op: "add",
      name: "goal",
    });
    expect(draftInputSpecs(out)).toEqual([
      { name: "goal", type: "text", label: undefined, help: undefined, required: false },
    ]);
    // The rest of the document survives.
    expect(out).toContain("nodes: []");
    expect(out).toContain("type: object");
  });

  it("adds a plain text property that no edit has annotated beyond the type", () => {
    const out = applyInputEdit(DOC, { op: "add", name: "reviewer" });
    expect(out).toContain("x-communication-input:");
    expect(draftInputSpecs(out).map((s) => s.name)).toEqual(
      ["base_branch", "notes", "reviewer", "issue"].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("applyInputEdit — edit", () => {
  it("writes the annotation, the required array and the schema type together", () => {
    const out = applyInputEdit(DOC, {
      op: "edit",
      name: "notes",
      patch: { type: "long_text", label: "Notes", required: true, defaultText: "hi" },
    });
    const spec = draftInputSpecs(out).find((s) => s.name === "notes");
    expect(spec).toMatchObject({
      type: "long_text",
      label: "Notes",
      required: true,
      default: "hi",
    });
    // `notes` joined the `required` array; the array keeps the old members.
    expect(out).toMatch(/required:\s*\[?\s*-?\s*issue[,\s]*-?\s*notes/);
    // …and the JSON Schema type stayed a string.
    expect(out).toMatch(/notes:\s*\n\s*type: string/);
  });

  it("keeps untouched annotation members when only the label changes", () => {
    const out = applyInputEdit(DOC, { op: "edit", name: "issue", patch: { label: "Issue" } });
    expect(draftInputSpecs(out).find((s) => s.name === "issue")).toMatchObject({
      type: "github_issue",
      label: "Issue",
      help: "The issue becomes the goal.",
      required: true,
    });
  });

  it("switching TO github_issue moves the schema type to object and drops a string default", () => {
    const out = applyInputEdit(DOC, {
      op: "edit",
      name: "base_branch",
      patch: { type: "github_issue" },
    });
    expect(out).toMatch(/base_branch:\s*\n\s*type: object/);
    expect(out).not.toMatch(/base_branch:[\s\S]{0,120}default: main/);
  });

  it("switching away from github_issue drops the object default", () => {
    const doc = DOC.replace(
      "x-communication-input: {type: github_issue, label: Issue to work on, help: The issue becomes the goal.}",
      "default: {number: 1}\n        x-communication-input: {type: github_issue}",
    );
    expect(draftInputSpecs(doc).find((s) => s.name === "issue")?.default).toEqual({ number: 1 });
    const out = applyInputEdit(doc, { op: "edit", name: "issue", patch: { type: "text" } });
    const spec = draftInputSpecs(out).find((s) => s.name === "issue");
    expect(spec).toMatchObject({ type: "text" });
    expect(spec && "default" in spec).toBe(false);
  });

  it("clears the default and leaves the required array alone on an unset", () => {
    const out = applyInputEdit(DOC, {
      op: "edit",
      name: "base_branch",
      patch: { defaultText: null },
    });
    expect(draftInputSpecs(out).find((s) => s.name === "base_branch")?.default).toBeUndefined();
    // `issue` is still required — the array is untouched.
    expect(draftInputSpecs(out).find((s) => s.name === "issue")?.required).toBe(true);
  });

  it("un-required removes the name from the array", () => {
    const out = applyInputEdit(DOC, { op: "edit", name: "issue", patch: { required: false } });
    expect(draftInputSpecs(out).find((s) => s.name === "issue")?.required).toBe(false);
    expect(draftInputSpecs(out).find((s) => s.name === "base_branch")?.required).toBe(false);
  });
});

describe("applyInputEdit — remove", () => {
  it("drops the property and its required member", () => {
    const out = applyInputEdit(DOC, { op: "remove", name: "issue" });
    expect(draftInputSpecs(out).map((s) => s.name)).toEqual(["base_branch", "notes"]);
    expect(out).not.toMatch(/issue:/);
  });

  it("refuses rather than rewriting bytes it cannot read", () => {
    expect(() => applyInputEdit("a: {b: 1\n c: 2", { op: "remove", name: "x" })).toThrow();
    expect(() => applyInputEdit(DOC, { op: "edit", name: "ghost", patch: {} })).toThrow();
  });
});

describe("names and preview", () => {
  it("suggests an unused name in the wire vocabulary", () => {
    expect(suggestInputName([])).toBe("new_input");
    expect(suggestInputName(["new_input"])).toBe("new_input2");
    expect(suggestInputName(["new_input", "new_input2"])).toBe("new_input3");
  });

  it("previews the inputs block the design shows", () => {
    expect(inputsYamlPreview(draftInputSpecs(DOC))).toBe(
      [
        "inputs:",
        "  base_branch:",
        "    type: branch",
        "    default: main",
        "  issue:",
        "    type: github_issue",
        "    required: true",
        "  notes:",
        "    type: text",
      ].join("\n"),
    );
  });

  it("an inputless workflow previews as an empty block", () => {
    expect(inputsYamlPreview([])).toBe("inputs: {}");
  });
});
