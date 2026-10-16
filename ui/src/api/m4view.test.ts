/**
 * `viewValidate` is called with whatever a draft row carries in `validation`,
 * straight off the wire — a brand-new draft crashed the whole pipeline page
 * (blank screen) because its validation block had no `errors` array to map.
 * The rule under test: the function is *total* over the shapes the schema
 * allows (the last validate body verbatim, or nothing at all when the draft
 * has never been validated), and a real body still maps field for field.
 */
import { describe, expect, it } from "vitest";
import { viewValidate } from "./m4view";
import type { ValidateResponse } from "./types";

const realBody: ValidateResponse = {
  valid: false,
  revision_digest: null,
  plan_digest: null,
  digest_scope: "v1alpha1-canonical-1",
  errors: [
    {
      code: "unknown_dependency",
      source: "compiler",
      message: "node `ship` depends on `plan`, which is not in scope",
      instance_location: "/spec/nodes/1/dependsOn/0",
      schema_location: null,
      hint: "did you mean `planning`?",
    },
    {
      code: "unquoted_date",
      source: "loader",
      message: "value was parsed as a date",
    },
  ],
  notes: ["errors_truncated"],
};

describe("viewValidate: shapes with no verdict in them", () => {
  it("treats a missing body as not validated", () => {
    expect(viewValidate(undefined)).toBeNull();
    expect(viewValidate(null)).toBeNull();
  });

  it("treats an empty validation block as not validated, not as a clean pass", () => {
    expect(viewValidate({})).toBeNull();
  });

  it("does not crash on the shape a brand-new draft really served: no arrays", () => {
    // The live failure was `TypeError: Cannot read properties of undefined
    // (reading 'map')` on exactly this body.
    expect(() => viewValidate({ valid: false })).not.toThrow();
    expect(viewValidate({ valid: false })).toEqual({
      valid: false,
      revision_digest: null,
      plan_digest: null,
      digest_scope: "",
      errors: [],
      notes: [],
    });
  });

  it("says nothing about a body that is not an object", () => {
    expect(viewValidate("nope" as unknown as ValidateResponse)).toBeNull();
  });
});

describe("viewValidate: a real validate body", () => {
  it("maps every finding, in the server's own order, with its hint only when served", () => {
    expect(viewValidate(realBody)).toEqual({
      valid: false,
      revision_digest: null,
      plan_digest: null,
      digest_scope: "v1alpha1-canonical-1",
      errors: [
        {
          code: "unknown_dependency",
          source: "compiler",
          message: "node `ship` depends on `plan`, which is not in scope",
          instance_location: "/spec/nodes/1/dependsOn/0",
          schema_location: null,
          hint: "did you mean `planning`?",
        },
        {
          code: "unquoted_date",
          source: "loader",
          message: "value was parsed as a date",
          instance_location: null,
          schema_location: null,
        },
      ],
      notes: ["errors_truncated"],
    });
  });

  it("keeps a valid body's digests", () => {
    const body = {
      ...realBody,
      valid: true,
      errors: [],
      revision_digest: `sha256:${"a".repeat(64)}`,
      plan_digest: `sha256:${"b".repeat(64)}`,
    };
    const view = viewValidate(body);
    expect(view?.valid).toBe(true);
    expect(view?.revision_digest).toBe(`sha256:${"a".repeat(64)}`);
    expect(view?.plan_digest).toBe(`sha256:${"b".repeat(64)}`);
    expect(view?.errors).toEqual([]);
  });

  it("drops findings it cannot name a stage for rather than inventing one", () => {
    // `VALIDATION_SOURCE_STATE` has no fourth stage; a future source must not
    // take the page down with it.
    const body = {
      ...realBody,
      errors: [{ code: "brand_new", source: "registry", message: "from a later server" }],
    };
    const view = viewValidate(body);
    expect(view?.valid).toBe(false);
    expect(view?.errors).toEqual([]);
  });
});
