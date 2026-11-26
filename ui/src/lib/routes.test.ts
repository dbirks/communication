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
    expect(routes.threads()).toBe("/chats");
    expect(routes.projects()).toBe("/manage/projects");
    expect(routes.workflows()).toBe("/factory");
    expect(routes.steps()).toBe("/manage/agents?tab=steps");
    expect(routes.profiles()).toBe("/manage/agents");
    expect(routes.ops()).toBe("/manage/runners");
    expect(routes.settings()).toBe("/manage/agents");
    expect(routes.settings("assistant")).toBe("/manage/agents?tab=assistant");
    expect(routes.settings("operations")).toBe("/manage/runners");
  });

  it("builds the parameterised paths and percent-encodes ids", () => {
    expect(routes.thread("c-1")).toBe("/chats/c-1");
    expect(routes.project("p 1")).toBe("/p/p%201");
    expect(routes.projectTab("p-1", "runs")).toBe("/p/p-1/factory");
    expect(routes.projectTab("p-1", "workflows")).toBe("/p/p-1/factory");
    expect(routes.projectTab("p-1", "artifacts")).toBe("/p/p-1/artifacts");
    expect(routes.projectTab("p-1", "threads")).toBe("/p/p-1/chats");
    expect(routes.projectTab("p-1", "settings")).toBe("/manage/projects/p-1");
    expect(routes.projectThread("p 1", "c 1")).toBe("/p/p%201/chats/c%201");
    const tabs: ProjectTab[] = ["runs", "workflows", "artifacts", "threads", "settings"];
    expect(tabs.map((tab) => routes.projectTab("p-1", tab))).toEqual([
      "/p/p-1/factory",
      "/p/p-1/factory",
      "/p/p-1/artifacts",
      "/p/p-1/chats",
      "/manage/projects/p-1",
    ]);
    expect(routes.workflow("pl-1")).toBe("/factory/pl-1");
    expect(routes.draft("pl-1", "d-1")).toBe("/factory/pl-1?draft=d-1");
    expect(routes.step("s-1")).toBe("/manage/agents?tab=steps&item=s-1");
    expect(routes.profile("ap-1")).toBe("/manage/agents/ap-1");
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
