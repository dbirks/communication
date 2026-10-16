/**
 * The form's contract with the text: a field write lands on its own key's line
 * and nothing else moves. "Untouched lines are byte-identical" is the whole
 * point — the textarea is what Save PUTs, so a form that reflows the document
 * would be silently rewriting the parts the user never looked at.
 */
import { describe, expect, it } from "vitest";
import { editableFields, listNodes, readScalar, writeScalar } from "./nodeFields";
import { samplePipelineYaml } from "../../test/fixtures/m4/samplePipeline";

/** A document small enough to reason about line by line. */
const doc = [
  "apiVersion: communication.dev/v1alpha1",
  "kind: Pipeline",
  "spec:",
  "  nodes:",
  "  - id: plan",
  "    kind: agent.acp",
  "    timeoutSeconds: 900",
  "    config:",
  "      profile: m4-planner",
  "      prompt: |",
  "        Goal: do the thing",
  "",
  "        Reply with JSON {plan} only.",
  "  - id: run",
  "    kind: process.exec",
  "    config:",
  "      executable: go",
  "      args: [test, ./...]",
  "  - id: gate",
  "    kind: human.approval",
  "    config:",
  "      summary: Ship it",
  "",
].join("\n");

const linesOf = (text: string) => text.split("\n");

describe("listNodes", () => {
  it("names the top-level nodes with their kind", () => {
    expect(listNodes(doc)).toEqual([
      { index: 0, id: "plan", kind: "agent.acp" },
      { index: 1, id: "run", kind: "process.exec" },
      { index: 2, id: "gate", kind: "human.approval" },
    ]);
  });

  it("does not reach into a nested until body", () => {
    // The body's nodes live under /spec/nodes/2/config/body/nodes: the picker
    // lists what the form can actually write, and it cannot write those.
    const nodes = listNodes(samplePipelineYaml);
    expect(nodes.map((node) => node.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(nodes.map((node) => node.id)).toEqual([
      "plan",
      "approve",
      "build_until_verified",
      "verdict",
      "publish_verified",
      "publish_needs_attention",
    ]);
    expect(nodes.map((node) => node.id)).not.toContain("implement");
  });

  it("carries a null id rather than inventing one", () => {
    expect(listNodes("spec:\n  nodes:\n  - kind: agent.acp\n")[0]).toEqual({
      index: 0,
      id: null,
      kind: "agent.acp",
    });
  });
});

describe("editableFields", () => {
  it("lists the fixed table per kind, with the pointer each key lives at", () => {
    expect(editableFields("agent.acp").map((f) => f.pointer(3))).toEqual([
      "/spec/nodes/3/config/profile",
      "/spec/nodes/3/config/prompt",
      "/spec/nodes/3/timeoutSeconds",
    ]);
    expect(editableFields("process.exec").map((f) => f.key)).toEqual([
      "executable",
      "timeoutSeconds",
    ]);
    expect(editableFields("model.chat").map((f) => f.key)).toEqual(["model", "prompt"]);
  });

  it("has nothing to offer any other kind", () => {
    expect(editableFields("human.approval")).toEqual([]);
    expect(editableFields("until")).toEqual([]);
    expect(editableFields(null)).toEqual([]);
    expect(editableFields("nonsense.kind")).toEqual([]);
  });
});

describe("readScalar", () => {
  it("unquotes a single-line value", () => {
    expect(readScalar(doc, "/spec/nodes/0/config/profile")).toBe("m4-planner");
    expect(readScalar("a:\n  b: 'it''s here'\n", "/a/b")).toBe("it's here");
  });

  it("reads a block scalar as its dedented body", () => {
    expect(readScalar(doc, "/spec/nodes/0/config/prompt")).toBe(
      "Goal: do the thing\n\nReply with JSON {plan} only.",
    );
  });

  it("returns null for a key the document does not carry, or does not carry as text", () => {
    expect(readScalar(doc, "/spec/nodes/0/config/pipeline")).toBeNull();
    // A nested mapping is not a scalar, and a flow value is not editable.
    expect(readScalar(doc, "/spec/nodes/0/config")).toBeNull();
    expect(readScalar(doc, "/spec/nodes/1/config/args")).toBeNull();
  });
});

describe("writeScalar", () => {
  it("replaces one single-line value and leaves every other line byte-identical", () => {
    const out = writeScalar(doc, "/spec/nodes/0/config/profile", "m4-reviewer");
    expect(out.missing).toBe(false);
    const lines = linesOf(out.text);
    expect(lines).toHaveLength(linesOf(doc).length);
    expect(lines[8]).toBe("      profile: 'm4-reviewer'");
    lines.forEach((line, index) => {
      if (index !== 8) expect(line).toBe(linesOf(doc)[index]);
    });
  });

  it("quotes a string and doubles its apostrophes, and keeps numbers bare", () => {
    expect(writeScalar(doc, "/spec/nodes/0/config/profile", "it's mine").text.split("\n")[8]).toBe(
      "      profile: 'it''s mine'",
    );
    const timeout = writeScalar(doc, "/spec/nodes/0/timeoutSeconds", "1200", "number");
    expect(timeout.text.split("\n")[6]).toBe("    timeoutSeconds: 1200");
  });

  it("writes a value containing a newline as a block two spaces deeper than the key", () => {
    const out = writeScalar(doc, "/spec/nodes/1/config/executable", "one\ntwo\nthree");
    const lines = linesOf(out.text);
    expect(lines[16]).toBe("      executable: |");
    expect(lines[17]).toBe("        one");
    expect(lines[18]).toBe("        two");
    expect(lines[19]).toBe("        three");
    expect(lines[20]).toBe("      args: [test, ./...]");
  });

  it("replaces a block scalar's body in place and round-trips what it wrote", () => {
    const first = writeScalar(doc, "/spec/nodes/0/config/prompt", "New goal");
    expect(readScalar(first.text, "/spec/nodes/0/config/prompt")).toBe("New goal");
    const lines = linesOf(first.text);
    expect(lines[9]).toBe("      prompt: |");
    expect(lines[10]).toBe("        New goal");
    expect(lines[11]).toBe("  - id: run");
    // Round-tripping the untouched block returns the document exactly.
    const same = writeScalar(
      doc,
      "/spec/nodes/0/config/prompt",
      readScalar(doc, "/spec/nodes/0/config/prompt") ?? "",
    );
    expect(same.text).toBe(doc);
  });

  it("keeps the dash of a sequence item and its comment", () => {
    const text = "spec:\n  nodes:\n  - id: plan # first\n    kind: agent.acp\n";
    const out = writeScalar(text, "/spec/nodes/0/id", "draft");
    expect(out.text.split("\n")[2]).toBe("  - id: 'draft' # first");
  });

  it("refuses to invent a key that is not there", () => {
    const out = writeScalar(doc, "/spec/nodes/0/config/systemPrompt", "nope");
    expect(out).toEqual({ text: doc, missing: true });
  });

  it("refuses a pointer whose line is not that key", () => {
    // `/spec/nodes/99` resolves no further than the `nodes:` line; the reader
    // says so with `exact: false` and the writer must not rewrite that line.
    expect(writeScalar(doc, "/spec/nodes/9/config/profile", "x")).toEqual({
      text: doc,
      missing: true,
    });
  });

  it("survives a document with CRLF endings without touching the rest", () => {
    const text = "spec:\r\n  nodes:\r\n  - id: plan\r\n    kind: agent.acp\r\n";
    const out = writeScalar(text, "/spec/nodes/0/kind", "process.exec");
    expect(out.text).toBe("spec:\r\n  nodes:\r\n  - id: plan\r\n    kind: 'process.exec'\r\n");
  });
});
