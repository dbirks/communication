/**
 * The canonical path builders (route contract C1). The redirect audit — each
 * legacy URL landing on its canonical path with query string preserved — is a
 * rendered-router table test in `App.test.tsx` (JSX needs a .tsx file).
 */
import { describe, expect, it } from "vitest";
import { routes } from "./routes";

describe("route path builders", () => {
  it("builds the canonical top-level paths", () => {
    expect(routes.home()).toBe("/");
    expect(routes.inbox()).toBe("/inbox");
    expect(routes.board()).toBe("/board");
    expect(routes.threads()).toBe("/threads");
    expect(routes.projects()).toBe("/projects");
    expect(routes.workflows()).toBe("/workflows");
    expect(routes.steps()).toBe("/steps");
    expect(routes.profiles()).toBe("/profiles");
    expect(routes.ops()).toBe("/ops");
    expect(routes.settings()).toBe("/settings/layout");
    expect(routes.settings("assistant")).toBe("/settings/assistant");
  });

  it("builds the parameterised paths and percent-encodes ids", () => {
    expect(routes.thread("c-1")).toBe("/threads/c-1");
    expect(routes.project("p 1")).toBe("/p/p%201");
    expect(routes.projectTab("p-1", "runs")).toBe("/p/p-1/runs");
    expect(routes.projectTab("p-1", "pipelines")).toBe("/p/p-1/pipelines");
    expect(routes.projectTab("p-1", "artifacts")).toBe("/p/p-1/artifacts");
    expect(routes.projectTab("p-1", "conversations")).toBe("/p/p-1/conversations");
    expect(routes.projectTab("p-1", "settings")).toBe("/p/p-1/settings");
    expect(routes.workflow("pl-1")).toBe("/workflows/pl-1");
    expect(routes.draft("pl-1", "d-1")).toBe("/workflows/pl-1/drafts/d-1");
    expect(routes.step("s-1")).toBe("/steps/s-1");
    expect(routes.profile("ap-1")).toBe("/profiles/ap-1");
  });

  it("builds run links with the ADR-0043 URL state", () => {
    expect(routes.run("r-1")).toBe("/runs/r-1");
    expect(routes.run("r-1", { view: "timeline", node: "build" })).toBe(
      "/runs/r-1?view=timeline&node=build",
    );
    // Empty values do not become `?node=` noise.
    expect(routes.run("r-1", { view: "timeline", node: "" })).toBe("/runs/r-1?view=timeline");
  });
});
