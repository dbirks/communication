/**
 * `viewValidate` is called with whatever a draft row carries in `validation`,
 * straight off the wire — a brand-new draft crashed the whole pipeline page
 * (blank screen) because its validation block had no `errors` array to map.
 * The rule under test: the function is *total* over the shapes the schema
 * allows (the last validate body verbatim, or nothing at all when the draft
 * has never been validated), and a real body still maps field for field.
 */
import { describe, expect, it } from "vitest";
import { viewRunTree, viewValidate } from "./m4view";
import type { RunSummary, RunTree, ValidateResponse } from "./types";

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

/**
 * `GET /runs/{runId}/tree`, mapped exactly as the route answers (the lab's
 * `01a144f6…` fan-out, C8's 25 children): the child run's identity, status and
 * timestamps live *inside* `run`, and the invocation facts — which node
 * execution invoked it, with which wait policy, at what depth — ride beside it.
 * There is no `child_run_id`, no child-level `status` and no `pipeline_slug` on
 * the wire, so reading any of those would silently drop every child (W11: 6
 * children on the route, none of them named by the page).
 */
const D = (n: number) => `sha256:${String(n).padStart(2, "0")}${"f".repeat(62)}`;

function wireChild(id: string, key: string, status: RunSummary["status"], depth = 1): RunTree {
  return {
    run: {
      id,
      project_id: "01a144e9-afee-7488-8e25-a72c6bb88cec",
      pipeline_id: "01a144e9-b43c-7e2d-a04b-ab984ec76ff7",
      pipeline_revision_id: "01a144e9-b549-74cc-bf6e-85e65cd87fac",
      assignment_id: "01a144e9-b5cd-7cc2-9020-90b27439f527",
      revision_digest: D(1),
      plan_digest: D(2),
      status,
      depth,
      priority: 0,
      created_at: "2026-10-16T13:46:00Z",
    },
    node_instance_key: key,
    wait_policy: "completion",
    depth,
    children: [],
  };
}

const fanOutTree: RunTree = {
  run: { ...wireChild("01a144f6-e85f-7c84-bd80-1d5ea77ff33e", "/", "running", 0).run },
  node_instance_key: null,
  wait_policy: null,
  // The route answers `"depth": null` on the root — `RunTreeView.Depth` is a
  // pointer in Go and the schema calls it an integer. `viewRunTree`'s `?? 0` is
  // what turns that null into the root the tree draws, so the fixture keeps the
  // wire's own shape rather than the schema's promise.
  depth: null as unknown as number,
  children: [
    wireChild("01a144f7-01c0-7655-a54d-7b8efae8ab5e", "/fan_out[0]/invoke", "completed"),
    wireChild("01a144f7-29e7-7c01-809b-d81e0b6c7437", "/fan_out[1]/invoke", "running"),
    {
      ...wireChild("01a144f7-29ea-73a0-9675-a7ecf0fa2a01", "/fan_out[2]/invoke", "failed"),
      // A grandchild: the invocation key below is in the CHILD's keyspace.
      children: [wireChild("01a144f8-0000-7000-8000-000000000001", "/plan", "running", 2)],
    },
  ],
};

describe("viewRunTree: the /tree route's real spelling", () => {
  it("keeps every child the route reports, with the route's own facts", () => {
    const view = viewRunTree(fanOutTree, (id) => (id === "x" ? "never" : "feature-development"));
    expect(view.run_id).toBe("01a144f6-e85f-7c84-bd80-1d5ea77ff33e");
    expect(view.depth).toBe(0);
    expect(view.children.map((child) => child.child_run_id)).toEqual([
      "01a144f7-01c0-7655-a54d-7b8efae8ab5e",
      "01a144f7-29e7-7c01-809b-d81e0b6c7437",
      "01a144f7-29ea-73a0-9675-a7ecf0fa2a01",
    ]);
    expect(view.children.map((child) => child.status)).toEqual(["completed", "running", "failed"]);
    expect(view.children.map((child) => child.depth)).toEqual([1, 1, 1]);
    expect(view.children.map((child) => child.node_instance_key)).toEqual([
      "/fan_out[0]/invoke",
      "/fan_out[1]/invoke",
      "/fan_out[2]/invoke",
    ]);
    // The route spells the wait policy; a null one means the compiled default.
    expect(view.children.every((child) => child.wait_policy === "completion")).toBe(true);
    // `pipeline_slug` is not on the wire: the caller's slug map names it, and
    // the honest fallback is the id it was read from.
    expect(view.children[0].pipeline_slug).toBe("feature-development");
    expect(viewRunTree(fanOutTree).children[0].pipeline_slug).toBe(
      "01a144e9-b43c-7e2d-a04b-ab984ec76ff7",
    );
  });

  it("nests a grandchild under its own parent, at the depth the route gave it", () => {
    const view = viewRunTree(fanOutTree);
    const nested = view.children[2].children ?? [];
    expect(nested).toHaveLength(1);
    expect(nested[0].child_run_id).toBe("01a144f8-0000-7000-8000-000000000001");
    expect(nested[0].depth).toBe(2);
    // The grandchild's key is in the child's keyspace — it is NOT a place in the
    // parent's fan-out, and the tree must not attach it to a coincidental key.
    expect(nested[0].node_instance_key).toBe("/plan");
  });
});
