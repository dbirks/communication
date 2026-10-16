/**
 * The form's contract with the text: a field write lands on its own key's line
 * and nothing else moves. "Untouched lines are byte-identical" is the whole
 * point — the textarea is what Save PUTs, so a form that reflows the document
 * would be silently rewriting the parts the user never looked at.
 */
import { describe, expect, it } from "vitest";
import { editableFields, listNodes, readScalar, writeScalar, yamlOnlyKeys } from "./nodeFields";
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
      "/spec/nodes/3/config/sessionMode",
      "/spec/nodes/3/config/fallback",
      "/spec/nodes/3/config/secretRefs",
      "/spec/nodes/3/timeoutSeconds",
    ]);
    expect(editableFields("process.exec").map((f) => f.key)).toEqual([
      "executable",
      "args",
      "cwd",
      "secretRefs",
      "timeoutSeconds",
    ]);
    expect(editableFields("model.chat").map((f) => f.key)).toEqual(["model", "prompt"]);
  });

  it("covers the scalar and flat-array keys of the six kinds that had none", () => {
    // The keys are the canonical schema's, one per `config*` definition — the
    // form that used to say "no editable fields" over a node full of them.
    expect(editableFields("human.approval").map((f) => f.key)).toEqual([
      "summary",
      "approverRoles",
      "approverUserIds",
      "artifactRefs",
      "deadlineSeconds",
      "onTimeout",
    ]);
    expect(editableFields("until").map((f) => f.key)).toEqual([
      "maxIterations",
      "maxDurationSeconds",
      "passWhen",
      "failWhen",
      "carryForward",
    ]);
    expect(editableFields("for_each").map((f) => f.key)).toEqual([
      "items",
      "maxConcurrency",
      "onChildFailure",
    ]);
    expect(editableFields("condition").map((f) => f.key)).toEqual(["default"]);
    expect(editableFields("artifact.publish").map((f) => f.key)).toEqual([
      "name",
      "kind",
      "mediaType",
      "sensitivity",
      "retentionSeconds",
    ]);
  });

  it("offers the schema's enum values for the keys that have them", () => {
    const approver = editableFields("human.approval").find((f) => f.key === "approverRoles");
    expect(approver?.options).toEqual(["maintainer", "contributor"]);
    expect(
      editableFields("artifact.publish")
        .find((f) => f.key === "kind")
        ?.options?.slice(0, 2),
    ).toEqual(["markdown", "image"]);
    expect(editableFields("until").find((f) => f.key === "carryForward")?.options).toEqual([
      "true",
      "false",
    ]);
  });

  it("names the keys of a covered kind that stay in the YAML", () => {
    // `additionalProperties: false` means the form cannot add them, and an
    // editor that hid this would look like it covered the node when it does not.
    expect(yamlOnlyKeys("until")).toEqual([
      "config.body (the nested node graph)",
      "config.resultBindings",
    ]);
    expect(yamlOnlyKeys("condition")).toEqual(["config.cases (when/route pairs)"]);
    expect(yamlOnlyKeys("artifact.publish")).toEqual(["config.from (mode/path/value object)"]);
    expect(yamlOnlyKeys("human.approval")).toEqual([]);
  });

  it("has nothing to offer any other kind", () => {
    // The kinds whose whole config is nested structure.
    expect(editableFields("parallel")).toEqual([]);
    expect(editableFields("pipeline.invoke")).toEqual([]);
    expect(editableFields("gate")).toEqual([]);
    expect(yamlOnlyKeys("gate")).toEqual([]);
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

/**
 * Flat arrays, bare booleans and the six kinds that used to render "no editable
 * fields" over a node whose config was full of exactly these.
 */
const rich = [
  "spec:",
  "  nodes:",
  "  - id: gate",
  "    kind: human.approval",
  "    config:",
  "      summary: Ship it",
  "      approverRoles: [maintainer]",
  "      deadlineSeconds: 86400",
  "      onTimeout: fail",
  "  - id: loop",
  "    kind: until",
  "    config:",
  "      maxIterations: 4",
  "      carryForward: true",
  "      passWhen: nodes.loop_inner.outputs.ok == true",
  "      body:",
  "        nodes: []",
  "  - id: fan",
  "    kind: for_each",
  "    config:",
  "      items: ${{ nodes.inventory.outputs.rows }}",
  "      secretRefs:",
  "      - project/gh_token",
  "      - project/npm_token",
  "      body:",
  "        nodes: []",
  "  - id: verdict",
  "    kind: condition",
  "    config:",
  "      cases:",
  "      - when: nodes.loop.outputs.approved == true",
  "        route: verified",
  "      default: needs_attention",
].join("\n");

describe("flat arrays", () => {
  it("reads a flow array as one comma-separated field", () => {
    expect(readScalar(rich, "/spec/nodes/0/config/approverRoles", "list")).toBe("maintainer");
  });

  it("reads a block sequence as the same field", () => {
    expect(readScalar(rich, "/spec/nodes/2/config/secretRefs", "list")).toBe(
      "project/gh_token, project/npm_token",
    );
  });

  it("writes a flow array back as a flow array, quoting items", () => {
    const out = writeScalar(
      rich,
      "/spec/nodes/0/config/approverRoles",
      "maintainer, contributor",
      "list",
    );
    expect(out.missing).toBe(false);
    expect(out.text.split("\n")[6]).toBe("      approverRoles: ['maintainer', 'contributor']");
    // Round-trips, and touches nothing else.
    expect(readScalar(out.text, "/spec/nodes/0/config/approverRoles", "list")).toBe(
      "maintainer, contributor",
    );
    expect(
      out.text
        .split("\n")
        .filter((_, i) => i !== 6)
        .join("\n"),
    ).toBe(
      rich
        .split("\n")
        .filter((_, i) => i !== 6)
        .join("\n"),
    );
  });

  it("keeps a block sequence in block style, one item per line", () => {
    const out = writeScalar(rich, "/spec/nodes/2/config/secretRefs", "project/gh_token", "list");
    expect(out.text.split("\n").slice(21, 24)).toEqual([
      "      secretRefs:",
      "        - 'project/gh_token'",
      "      body:",
    ]);
    expect(readScalar(out.text, "/spec/nodes/2/config/secretRefs", "list")).toBe(
      "project/gh_token",
    );
  });

  it("writes an emptied field as [] rather than a key with nothing under it", () => {
    // A block key with no items reads back as absent, which would strand the
    // form on its own edit; `[]` is the same value and keeps reading.
    const out = writeScalar(rich, "/spec/nodes/2/config/secretRefs", "", "list");
    expect(out.text.split("\n")[21]).toBe("      secretRefs: []");
    expect(readScalar(out.text, "/spec/nodes/2/config/secretRefs", "list")).toBe("");
  });

  it("refuses an array whose items are objects — that stays in the YAML", () => {
    expect(readScalar(rich, "/spec/nodes/3/config/cases", "list")).toBeNull();
    expect(writeScalar(rich, "/spec/nodes/3/config/cases", "a, b", "list").missing).toBe(true);
  });

  it("refuses a key the document does not carry", () => {
    expect(writeScalar(rich, "/spec/nodes/0/config/approverUserIds", "u", "list").missing).toBe(
      true,
    );
  });
});

describe("bare scalars the schema does not want quoted", () => {
  it("writes a boolean bare, because 'true' is a string to the schema", () => {
    const out = writeScalar(rich, "/spec/nodes/1/config/carryForward", "false", "bool");
    expect(out.text.split("\n")[13]).toBe("      carryForward: false");
    expect(readScalar(rich, "/spec/nodes/1/config/carryForward", "bool")).toBe("true");
  });

  it("writes an integer bare and keeps the surrounding document intact", () => {
    const out = writeScalar(rich, "/spec/nodes/0/config/deadlineSeconds", "3600", "number");
    expect(out.text.split("\n")[7]).toBe("      deadlineSeconds: 3600");
    expect(readScalar(out.text, "/spec/nodes/0/config/deadlineSeconds", "number")).toBe("3600");
  });

  it("reads the CEL and binding scalars the six kinds are built from", () => {
    expect(readScalar(rich, "/spec/nodes/1/config/passWhen", "text")).toBe(
      "nodes.loop_inner.outputs.ok == true",
    );
    expect(readScalar(rich, "/spec/nodes/2/config/items", "text")).toBe(
      "${{ nodes.inventory.outputs.rows }}",
    );
    expect(readScalar(rich, "/spec/nodes/3/config/default", "text")).toBe("needs_attention");
    expect(readScalar(rich, "/spec/nodes/0/config/onTimeout", "text")).toBe("fail");
  });

  it("leaves a nested mapping alone", () => {
    expect(readScalar(rich, "/spec/nodes/1/config/body", "text")).toBeNull();
    expect(writeScalar(rich, "/spec/nodes/1/config/body", "x", "text").missing).toBe(true);
  });
});
