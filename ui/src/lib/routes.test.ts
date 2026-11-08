/**
 * The canonical path builders (route contract C1). The redirect audit — each
 * legacy URL landing on its canonical path with query string preserved — is a
 * rendered-router table test in `App.test.tsx` (JSX needs a .tsx file).
 */
import { describe, expect, it } from "vitest";
import { routes, type ProjectTab } from "./routes";

describe("route path builders", () => {
  it("builds the canonical top-level paths", () => {
    expect(routes.home()).toBe("/");
    // Finding 03: `/inbox` and `/board` are legacy addresses — the builders
    // still return them (the pages that link them are being rebuilt), and
    // `App.tsx` redirects both URLs to `/` (App.test.tsx).
    expect(routes.inbox()).toBe("/inbox");
    expect(routes.board()).toBe("/board");
    expect(routes.threads()).toBe("/threads");
    expect(routes.projects()).toBe("/projects");
    expect(routes.workflows()).toBe("/workflows");
    // Finding 02: Steps is a tab of the Workflows page.
    expect(routes.steps()).toBe("/workflows/steps");
    expect(routes.profiles()).toBe("/profiles");
    expect(routes.ops()).toBe("/settings/operations");
    expect(routes.settings()).toBe("/settings/layout");
    expect(routes.settings("assistant")).toBe("/settings/assistant");
    expect(routes.settings("operations")).toBe("/settings/operations");
  });

  it("builds the parameterised paths and percent-encodes ids", () => {
    expect(routes.thread("c-1")).toBe("/threads/c-1");
    expect(routes.project("p 1")).toBe("/p/p%201");
    expect(routes.projectTab("p-1", "runs")).toBe("/p/p-1/runs");
    expect(routes.projectTab("p-1", "workflows")).toBe("/p/p-1/workflows");
    expect(routes.projectTab("p-1", "artifacts")).toBe("/p/p-1/artifacts");
    expect(routes.projectTab("p-1", "threads")).toBe("/p/p-1/threads");
    expect(routes.projectTab("p-1", "settings")).toBe("/p/p-1/settings");
    expect(routes.projectThread("p 1", "c 1")).toBe("/p/p%201/threads/c%201");
    // Finding 01: `threads` is the project tab segment — `conversations` is the
    // API's noun and is no longer a route. The old URL redirects (App.test.tsx).
    // Finding 02: `workflows` is the project tab segment — the old
    // `pipelines` spelling redirects (App.test.tsx).
    const tabs: ProjectTab[] = ["runs", "workflows", "artifacts", "threads", "settings"];
    expect(tabs.map((tab) => routes.projectTab("p-1", tab))).toEqual([
      "/p/p-1/runs",
      "/p/p-1/workflows",
      "/p/p-1/artifacts",
      "/p/p-1/threads",
      "/p/p-1/settings",
    ]);
    expect(routes.workflow("pl-1")).toBe("/workflows/pl-1");
    expect(routes.draft("pl-1", "d-1")).toBe("/workflows/pl-1/drafts/d-1");
    expect(routes.step("s-1")).toBe("/workflows/steps/s-1");
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
