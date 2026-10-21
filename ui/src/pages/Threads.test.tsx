/**
 * Threads page (route `/threads`): the cross-project thread list (C3 /
 * ADR-0047, `GET /api/v1/conversations`). Rows carry ids only, so project
 * and profile names must come from the directories, the "one-off only" chip
 * defaults on, and a server without the endpoint gets an honest refusal.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationSummary, Project } from "../api/types";
import { renderApp } from "../test/render";
import {
  conversationId,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  type RouteStub,
} from "../test/fakes";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const users: RouteStub = { path: "/api/v1/users", method: "GET", body: { items: [] } };
const crossPath = "/api/v1/conversations";

const anotherProject: Project = {
  id: "01987a90-8888-7000-8000-abcdef888888",
  slug: "atlas",
  name: "Atlas",
  description: "Atlas services",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "contributor",
};

const runLinked: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a91-9999-7000-8000-abcdef999999",
  title: "Review loop for the release run",
  origin: "run",
  updated_at: "2026-10-14T18:20:00Z",
};

function routes(items: ConversationSummary[], extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    me,
    users,
    { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture, anotherProject] } },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: [] } },
    { path: crossPath, method: "GET", body: { items, next_cursor: null } },
  ];
}

describe("/threads (cross-project thread list)", () => {
  it("lists threads with project and profile names, controller and updated age", async () => {
    renderApp({
      path: "/threads",
      routes: routes(
        [runLinked, conversationSummaryFixture],
        [
          {
            path: "/api/v1/agent-profiles",
            method: "GET",
            body: {
              items: [{ name: "Claude Code", id: conversationSummaryFixture.agent_profile_id }],
            },
          },
        ],
      ),
    });

    const row = await screen.findByTestId("thread-row-refactor-billing");
    expect(row.getAttribute("href")).toBe(`/threads/${conversationId}`);
    expect(row.textContent).toContain(projectFixture.name);
    expect(row.textContent).toContain("Claude Code");
    expect(row.textContent).toContain("controller: Ada Lovelace");
    expect(row.textContent).toMatch(/updated \d+[smhd] ago/);
    expect(within(row).getByTestId("conversation-origin-manual")).toBeTruthy();
  });

  it("keeps the one-off filter on by default and hides run-linked rows", async () => {
    renderApp({ path: "/threads", routes: routes([runLinked, conversationSummaryFixture]) });

    const chip = await screen.findByTestId("threads-one-off-filter");
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(await screen.findByTestId("thread-row-refactor-billing")).toBeTruthy();
    expect(screen.queryByTestId("thread-row-review-loop-for-the-release-run")).toBeNull();

    fireEvent.click(chip);
    expect(await screen.findByTestId("thread-row-review-loop-for-the-release-run")).toBeTruthy();
    expect(
      within(screen.getByTestId("thread-row-review-loop-for-the-release-run")).getByTestId(
        "conversation-origin-run",
      ),
    ).toBeTruthy();
  });

  it("says honestly what a server without the endpoint can not list", async () => {
    const { requests } = renderApp({
      path: "/threads",
      routes: [me, users, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("could not be loaded");
    expect(requests.some((request) => request.url === crossPath && request.method === "GET")).toBe(
      true,
    );
  });

  it("offers the empty state when the caller has no threads at all", async () => {
    renderApp({ path: "/threads", routes: routes([]) });
    expect(await screen.findByTestId("threads-list-empty")).toBeTruthy();
    expect(screen.getByTestId("threads-list-empty").textContent).toContain("No threads yet");
  });
});
