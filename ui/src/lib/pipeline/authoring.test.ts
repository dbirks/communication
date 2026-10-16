/**
 * The role rule is one predicate, and it has to agree with the server's
 * `requireLibraryRole` (`internal/api/pipelines.go`) — the page that shows an
 * enabled control the API would refuse is the bug this guards against.
 */
import { describe, expect, it } from "vitest";
import { hasLibraryRole, LIBRARY_AUTHORING_HINT, LIBRARY_READ_ONLY_NOTE } from "./authoring";

describe("hasLibraryRole", () => {
  it("is the served `is_org_admin`, nothing else", () => {
    expect(hasLibraryRole({ is_org_admin: true })).toBe(true);
    expect(hasLibraryRole({ is_org_admin: false })).toBe(false);
  });

  it("is false while the answer is still loading — reading is not authoring", () => {
    expect(hasLibraryRole(undefined)).toBe(false);
  });
});

describe("the words the library surface uses", () => {
  it("says the same reason in the sidebar and the editor", () => {
    expect(LIBRARY_AUTHORING_HINT).toContain("library role");
    expect(LIBRARY_READ_ONLY_NOTE).toContain("library role");
    expect(LIBRARY_READ_ONLY_NOTE).toContain("read-only");
  });
});
