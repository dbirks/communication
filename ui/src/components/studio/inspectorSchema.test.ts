/**
 * `fieldsFor` is the contract between the canonical schema and the Studio
 * inspector: every executable kind must produce at least one section, the
 * well-known fields must carry their schema constraints, and nothing may
 * throw — a broken generator hides no field, it degrades to JSON.
 */
import { describe, expect, it } from "vitest";
import { fieldsFor, SCHEMA_KINDS, type InspectorField } from "./inspectorSchema";

function findField(
  sections: { fields: InspectorField[] }[],
  path: string[],
): InspectorField | undefined {
  for (const section of sections)
    for (const field of section.fields) if (field.path.join(".") === path.join(".")) return field;
  return undefined;
}

describe("inspectorSchema.fieldsFor", () => {
  it("derives the until config from the schema with its ranges", () => {
    const sections = fieldsFor("until");
    expect(sections.length).toBeGreaterThan(0);

    const passWhen = findField(sections, ["config", "passWhen"]);
    expect(passWhen).toBeTruthy();
    expect(passWhen?.widget).toBe("cel");

    const maxIterations = findField(sections, ["config", "maxIterations"]);
    expect(maxIterations?.min).toBe(1);
    expect(maxIterations?.max).toBe(32);
    expect(maxIterations?.widget).toBe("number");

    const maxDuration = findField(sections, ["config", "maxDurationSeconds"]);
    expect(maxDuration?.min).toBe(60);
    expect(maxDuration?.max).toBe(604800);

    // Approachable labels, not raw keys.
    expect(passWhen?.label).toBe("Pass when (CEL)");
    expect(maxIterations?.label).toBe("Max iterations (1–32)");
  });

  it("covers every kind the schema's node enum admits, without throwing", () => {
    expect(SCHEMA_KINDS.length).toBeGreaterThanOrEqual(10);
    for (const kind of SCHEMA_KINDS) {
      const sections = fieldsFor(kind);
      expect(sections.length, `kind ${kind} must yield ≥1 section`).toBeGreaterThan(0);
    }
  });

  it("includes the shared node fields for every kind", () => {
    for (const kind of SCHEMA_KINDS) {
      const sections = fieldsFor(kind);
      const when = findField(sections, ["when"]);
      const timeout = findField(sections, ["timeoutSeconds"]);
      expect(when?.widget).toBe("cel");
      expect(timeout?.min).toBe(1);
      expect(findField(sections, ["dependsOn"])?.widget).toBe("deps");
      // Retry and on-failure sub-sections resolve their schema refs.
      expect(findField(sections, ["retry", "maxAttempts"])?.max).toBe(10);
      expect(findField(sections, ["onFailure", "onExecutionError"])?.widget).toBe("select");
    }
  });

  it("routes errorRoute to the sibling-node options, not a schema enum", () => {
    const sections = fieldsFor("process.exec");
    const errorRoute = findField(sections, ["onFailure", "errorRoute"]);
    expect(errorRoute?.optionsFrom).toBe("siblings");
  });

  it("gives scopes a steps list and conditions a row editor", () => {
    const until = fieldsFor("until");
    expect(findField(until, ["config", "body"])?.widget).toBe("steps");

    const parallel = fieldsFor("parallel");
    expect(findField(parallel, ["config", "branches"])?.widget).toBe("steps");

    const condition = fieldsFor("condition");
    const cases = findField(condition, ["config", "cases"]);
    expect(cases?.widget).toBe("rows");
    expect(cases?.rowFields?.map((r) => r.key)).toEqual(["when", "route"]);

    const invoke = fieldsFor("pipeline.invoke");
    const digest = findField(invoke, ["config", "revisionDigest"]);
    expect(digest?.label).toContain("sha256");
  });
});
