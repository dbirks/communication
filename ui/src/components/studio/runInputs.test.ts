/**
 * The `spec.inputs` reader/writer behind the workflow inspector's Run-inputs
 * rows. The contract is a round trip: a schema the rows can read must write
 * back with every keyword the rows do not show (`type`, `minLength`, `format`,
 * a root `additionalProperties`) still in place, and a schema they cannot
 * represent honestly must be refused rather than quietly simplified.
 */
import { describe, expect, it } from "vitest";
import { readRunInputs, runInputNameProblem, writeRunInputs } from "./runInputs";

describe("readRunInputs / writeRunInputs", () => {
  it("round-trips a declared schema untouched", () => {
    const inputs = {
      type: "object",
      required: ["goal", "repository"],
      properties: {
        goal: { type: "string", minLength: 1, description: "What the plan should accomplish." },
        repository: { type: "string", format: "repository" },
      },
    };
    const model = readRunInputs(inputs);
    expect(model).not.toBeNull();
    if (!model) return;
    expect(model.rows.map((row) => [row.name, row.required])).toEqual([
      ["goal", true],
      ["repository", true],
    ]);
    expect(model.rows[0]?.description).toBe("What the plan should accomplish.");
    expect(writeRunInputs(model)).toEqual(inputs);
  });

  it("treats a workflow that declares nothing as an empty list", () => {
    expect(readRunInputs(undefined)).toEqual({ rows: [], root: {} });
    expect(writeRunInputs({ rows: [], root: {} })).toEqual({ type: "object", properties: {} });
  });

  it("keeps the root keywords the rows do not edit", () => {
    const inputs = {
      type: "object",
      additionalProperties: false,
      title: "Run inputs",
      properties: { goal: { type: "string" } },
    };
    const model = readRunInputs(inputs);
    if (!model) throw new Error("a plain input list must read as rows");
    expect(writeRunInputs(model)).toEqual(inputs);
  });

  it("refuses a shape the rows would have to lie about", () => {
    for (const inputs of [
      { type: "object", properties: { goal: { oneOf: [{ type: "string" }] } } },
      { type: "object", properties: { goal: { $ref: "#/$defs/identifier" } } },
      { type: "object", properties: { goal: true } },
      { type: "object", patternProperties: { "^g": { type: "string" } } },
      { type: "array" },
      { type: "object", required: ["ghost"], properties: { goal: { type: "string" } } },
    ])
      expect(readRunInputs(inputs)).toBeNull();
  });

  it("gives a new input a type and never invents one for a sparse row", () => {
    const written = writeRunInputs({
      rows: [
        { name: "ticket", description: "", required: false, schema: {} },
        { name: "goal", description: "", required: true, schema: { minLength: 1 } },
      ],
      root: {},
    });
    expect(written).toEqual({
      type: "object",
      required: ["goal"],
      properties: { ticket: { type: "string" }, goal: { minLength: 1 } },
    });
  });

  it("drops a row that has no name yet, and the required list with it", () => {
    expect(
      writeRunInputs({
        rows: [{ name: "   ", description: "half-typed", required: true, schema: {} }],
        root: {},
      }),
    ).toEqual({ type: "object", properties: {} });
  });
});

describe("runInputNameProblem", () => {
  const rows = [
    { name: "goal", description: "", required: false, schema: {} },
    { name: "repo", description: "", required: false, schema: {} },
  ];

  it("accepts the canonical identifier and a blank new row", () => {
    expect(runInputNameProblem("goal", rows, 0)).toBeNull();
    expect(runInputNameProblem("ticket_id2", rows, 1)).toBeNull();
    expect(runInputNameProblem("", rows, 1)).toBeNull();
  });

  it("refuses a name a step could not select, and a name already taken", () => {
    expect(runInputNameProblem("Bad Name", rows, 1)).toContain("lower-case letter");
    expect(runInputNameProblem("bad-name", rows, 1)).toContain("lower-case letter");
    expect(runInputNameProblem("goal", rows, 1)).toContain("cannot share a name");
  });
});
