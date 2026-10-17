/**
 * deciderLabel tests: a `decided_by` can name a policy, not a person
 * (ADR-0039), and the feed must say which policy rather than a uuid.
 */
import { describe, expect, it } from "vitest";
import { deciderLabel } from "./actors";

const nameOf = (userId: string) => (userId === "u-ada" ? "Ada" : `stranger (${userId})`);

describe("deciderLabel", () => {
  it("names a profile policy in words", () => {
    expect(deciderLabel("profile_policy:deny", nameOf)).toBe("the profile's deny policy");
    expect(deciderLabel("profile_policy:preapproved_within_sandbox", nameOf)).toBe(
      "the profile's preapproved policy (sandboxed)",
    );
  });

  it("names a node policy as the step's policy", () => {
    expect(deciderLabel("node_policy:deny", nameOf)).toBe("the step's deny policy");
    expect(deciderLabel("node_policy:preapproved_within_sandbox", nameOf)).toBe(
      "the step's preapproved policy (sandboxed)",
    );
  });

  it("falls back to a bare policy mode for other prefixes", () => {
    expect(deciderLabel("workspace_policy:deny", nameOf)).toBe("policy deny");
    expect(deciderLabel("org_policy:preapproved_within_sandbox", nameOf)).toBe(
      "policy preapproved_within_sandbox",
    );
  });

  it("still names a user through nameOf", () => {
    expect(deciderLabel("u-ada", nameOf)).toBe("Ada");
    expect(deciderLabel("01987a63-3333-7000-8000-abcdef012345", nameOf)).toBe(
      "stranger (01987a63-3333-7000-8000-abcdef012345)",
    );
  });
});
