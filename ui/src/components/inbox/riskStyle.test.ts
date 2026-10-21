/**
 * The risk → button-variant table and the intent → wire-decision table.
 * The rule is the whole ADR-0052 button contract, so it is pinned as data:
 * red only for `refuse`/`destructive`, royal for `proceed`, and no mapping
 * that would let a model-suggested action pick its own decision silently.
 */
import { describe, expect, it } from "vitest";
import { actionDecision, riskToVariant } from "./riskStyle";

describe("riskToVariant", () => {
  it("maps refuse and destructive to the danger variant", () => {
    expect(riskToVariant("refuse")).toBe("danger");
    expect(riskToVariant("destructive")).toBe("danger");
  });

  it("maps proceed to the primary variant", () => {
    expect(riskToVariant("proceed")).toBe("primary");
  });

  it("maps everything else to secondary", () => {
    expect(riskToVariant("other")).toBe("secondary");
  });
});

describe("actionDecision", () => {
  it("maps approve to the approved wire decision", () => {
    expect(actionDecision("approve")).toBe("approved");
  });

  it("maps reject and request_changes to the rejected wire decision", () => {
    expect(actionDecision("reject")).toBe("rejected");
    // A change request is a rejection carried by the note: the decide enum
    // has no third member and the model never decides.
    expect(actionDecision("request_changes")).toBe("rejected");
  });

  it("does not map other to any decision", () => {
    expect(actionDecision("other")).toBeNull();
  });
});
