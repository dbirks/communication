import { describe, expect, it } from "vitest";
import { pageContextFor, pageLabelOf } from "./pageContext";

describe("pageLabelOf / pageContextFor on redesigned and legacy routes", () => {
  it("uses Home / Chats / Factory / Manage labels and never legacy names", () => {
    const cases: [string, string][] = [
      ["/", "Home"],
      ["/p/atlas", "Home"],
      ["/catch-up", "Home"],
      ["/inbox", "Home"],
      ["/board", "Home"],
      ["/chats", "Chats"],
      ["/chats/c-1", "Chats"],
      ["/p/atlas/chats/c-1", "Chats"],
      ["/threads", "Chats"],
      ["/factory", "Factory"],
      ["/factory/pl-1", "Factory"],
      ["/p/atlas/factory/pl-1", "Factory"],
      ["/workflows", "Factory"],
      ["/manage/agents", "Manage"],
      ["/manage/agents/prof-1", "Manage"],
      ["/manage/projects/proj-1", "Manage"],
      ["/manage/runners", "Manage"],
      ["/profiles", "Manage"],
      ["/settings/assistant", "Manage"],
    ];
    for (const [route, want] of cases) {
      const label = pageLabelOf(route);
      expect(label, route).toBe(want);
      expect(label).not.toMatch(/Today|Catch up|Threads|Workflows/);
    }
  });

  it("attaches draft and run entities and labels for editor query params", () => {
    expect(pageContextFor("/factory/pl-1?draft=draft-2")).toEqual({
      label: "Draft draft-2",
      route: "/factory/pl-1?draft=draft-2",
      entity: { kind: "draft", id: "draft-2" },
    });
    expect(pageContextFor("/p/atlas/factory/pl-1?draft=draft-2")).toEqual({
      label: "Draft draft-2",
      route: "/p/atlas/factory/pl-1?draft=draft-2",
      project: "atlas",
      entity: { kind: "draft", id: "draft-2" },
    });
    expect(pageContextFor("/factory/pl-1?run=run-9")).toEqual({
      label: "Run run-9",
      route: "/factory/pl-1?run=run-9",
      entity: { kind: "run", id: "run-9" },
    });
    expect(pageContextFor("/p/atlas/chats/c-1")).toEqual({
      label: "Chats",
      route: "/p/atlas/chats/c-1",
      project: "atlas",
      entity: { kind: "conversation", id: "c-1" },
    });
  });
});
