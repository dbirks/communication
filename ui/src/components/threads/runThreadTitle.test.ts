/**
 * The worded form of a run-origin row the server still named in raw ids
 * (round-16 DEFECT: `run 01a1a992 /plan attempt 1` — a run-id prefix plus
 * the node instance key, built by the legacy
 * `attemptConversationTitle` in internal/store/postgres/agentturn_seams.go).
 * The design names things in words (screens 1g/2a), with the short run
 * reference as secondary metadata at most.
 */
import { describe, expect, it } from "vitest";
import { humanizeNodeLabel, legacyRunThreadTitle } from "./runThreadTitle";

const RUN_LINK = {
  run_id: "01a1a992-8822-7000-8000-abcdef000000",
  node_execution_id: "01987a80-aaaa-7000-8000-abcdef000001",
  node_instance_key: "/plan",
  node_id: "plan",
  attempt_id: "01987a80-bbbb-7000-8000-abcdef000002",
  attempt_number: 1,
};

describe("humanizeNodeLabel says the node's words", () => {
  it("capitalises a plain node id", () => {
    expect(humanizeNodeLabel("plan")).toBe("Plan");
    expect(humanizeNodeLabel("/plan")).toBe("Plan");
  });

  it("keeps only the last path segment of a nested instance key", () => {
    expect(humanizeNodeLabel("/build_until_verified[1]/code_review")).toBe("Code review");
    expect(humanizeNodeLabel("build_until_verified[2]/review")).toBe("Review");
    expect(humanizeNodeLabel("/fan_out[3]/invoke")).toBe("Invoke");
  });

  it("is honest when the key carries no node id", () => {
    expect(humanizeNodeLabel("")).toBe("");
    expect(humanizeNodeLabel(null)).toBe("");
    expect(humanizeNodeLabel("[1]")).toBe("");
  });
});

describe("legacyRunThreadTitle renders the stored id title in words", () => {
  it("word-forms the legacy pattern from the row's own run link", () => {
    const got = legacyRunThreadTitle("run 01a1a992 /plan attempt 1", RUN_LINK);
    expect(got?.title).toBe("Plan · run #01a1");
    expect(got?.secondary).toBe("run #01a1 · attempt 1");
  });

  it("word-forms a nested instance key the same way", () => {
    const got = legacyRunThreadTitle(
      "run 01a1a992 /build_until_verified[1]/code_review attempt 1",
      { ...RUN_LINK, node_instance_key: "/build_until_verified[1]/code_review" },
    );
    expect(got?.title).toBe("Code review · run #01a1");
  });

  it("reads the attempt from the link, and from the title when the link omits it", () => {
    const got = legacyRunThreadTitle("run 01a1a992 /plan attempt 2", {
      ...RUN_LINK,
      attempt_number: 2,
    });
    expect(got?.secondary).toBe("run #01a1 · attempt 2");
    const parsed = legacyRunThreadTitle("run 01a1a992 /plan attempt 3", {
      ...RUN_LINK,
      attempt_number: undefined as unknown as number,
    });
    expect(parsed?.secondary).toBe("run #01a1 · attempt 3");
  });

  it("falls back to the node id when the instance key is empty", () => {
    const got = legacyRunThreadTitle("run 01a1a992 /plan attempt 1", {
      ...RUN_LINK,
      node_instance_key: "",
    });
    expect(got?.title).toBe("Plan · run #01a1");
  });

  it("keeps a title a person wrote verbatim — even one starting with `run`", () => {
    expect(legacyRunThreadTitle("run the backup now", RUN_LINK)).toBeNull();
    expect(legacyRunThreadTitle("run 01a1a992 /plan", RUN_LINK)).toBeNull();
    expect(legacyRunThreadTitle("Refactor billing", null)).toBeNull();
  });

  it("is honest when the row carries no run link to name from", () => {
    expect(legacyRunThreadTitle("run 01a1a992 /plan attempt 1", null)).toBeNull();
    expect(
      legacyRunThreadTitle("run 01a1a992 /plan attempt 1", {
        ...RUN_LINK,
        run_id: "ab",
      }),
    ).toBeNull();
  });
});
