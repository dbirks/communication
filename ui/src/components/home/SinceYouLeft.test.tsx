/**
 * SinceYouLeft: the rows the catch-up list read serves (important items
 * first, routine ones behind the "+ N routine updates" line that expands in
 * place), the brief headline above them, the one empty sentence per scope,
 * and the visit stamp CatchUp recorded on open.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { SinceYouLeft } from "./SinceYouLeft";
import { mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";
import type { CatchUpBrief, CatchUpListItem } from "../../api/catchup";

function catchUpItemFixture(
  overrides: Partial<CatchUpListItem> & Pick<CatchUpListItem, "id" | "importance">,
): CatchUpListItem {
  return {
    project: { id: projectFixture.id, name: "Project One", color: "#6a4bc4" },
    shape: "pr",
    title: `Story ${overrides.id}`,
    summary: "One line about the work.",
    resolution: "merged",
    refs: {},
    updated: false,
    unseen_stops: 2,
    total_stops: 2,
    updated_at: "2026-10-14T16:00:00Z",
    created_at: "2026-10-14T15:00:00Z",
    ...overrides,
  };
}

function briefFixture(overrides: Partial<CatchUpBrief> = {}): CatchUpBrief {
  return {
    window: { key: "unseen", since: "2026-10-13T18:00:00Z", until: "2026-10-14T18:00:00Z" },
    headline: { state: "ready", text: "" },
    needs_you: [],
    running_now: [],
    shipped: [],
    broke: [],
    heads_up: [],
    changes: [],
    numbers: {
      runs: { succeeded: 0, failed: 0, cancelled: 0, running: 0 },
      approvals: { decided: 0, pending: 0 },
      threads_active: 0,
      prs: 0,
      commits: 0,
    },
    by_project: [],
    omitted: {},
    ...overrides,
  };
}

function renderSince(routes: RouteStub[], props: Parameters<typeof SinceYouLeft>[0] = {}) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<SinceYouLeft {...props} />, { wrapper });
  return { requests };
}

afterEach(cleanup);

describe("SinceYouLeft", () => {
  it("heads the section with a sentence-case column heading, even when empty", async () => {
    renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: { items: [], total_unseen: 0, oldest_unseen_at: null },
      },
      { path: "/api/v1/catch-up/brief", body: briefFixture() },
    ]);
    const head = await screen.findByTestId("since-you-left-label");
    expect(head.tagName).toBe("H3");
    expect(head.textContent).toBe("Since you left");
    expect(head.className).toContain("text-[15px]");
    expect(head.className).toContain("font-bold");
    expect(head.className).toContain("border-line");
    expect(head.className).not.toContain("font-mono");
    expect(head.className).not.toContain("uppercase");
    expect(screen.getByRole("heading", { name: "Since you left" })).toBe(head);
  });

  it("says the empty sentence when the window holds nothing", async () => {
    renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: { items: [], total_unseen: 0, oldest_unseen_at: null },
      },
      { path: "/api/v1/catch-up/brief", body: briefFixture() },
    ]);
    expect(await screen.findByTestId("since-you-left-empty")).toBeTruthy();
    expect(screen.getByTestId("since-you-left-empty").textContent).toBe(
      "Nothing new since you left.",
    );
  });

  it("names the project in the empty sentence in project scope", async () => {
    renderSince(
      [
        {
          path: "/api/v1/catch-up/items",
          body: { items: [], total_unseen: 0, oldest_unseen_at: null },
        },
        { path: "/api/v1/catch-up/brief", body: briefFixture() },
      ],
      { projectId: projectFixture.id, projectName: projectFixture.name },
    );
    expect(await screen.findByTestId("since-you-left-empty")).toBeTruthy();
    expect(screen.getByTestId("since-you-left-empty").textContent).toBe(
      `Nothing new in ${projectFixture.name} since you left.`,
    );
  });

  it("prints one sentence, not the quiet headline, when the window holds nothing", async () => {
    renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: { items: [], total_unseen: 0, oldest_unseen_at: null },
      },
      {
        path: "/api/v1/catch-up/brief",
        body: briefFixture({ headline: { state: "ready", text: "A quiet stretch." } }),
      },
    ]);
    expect(await screen.findByTestId("since-you-left-empty")).toBeTruthy();
    expect(screen.queryByTestId("since-you-left-headline")).toBeNull();
    // One sentence in the section, no matter what the brief read said.
    const section = screen.getByTestId("since-you-left");
    expect(section.querySelectorAll("p")).toHaveLength(1);
  });

  it("shows important rows, folds routine ones behind '+ N routine updates' and expands in place", async () => {
    const items = [
      catchUpItemFixture({ id: "w-1", importance: "must_know" }),
      catchUpItemFixture({ id: "w-2", importance: "worth_a_look" }),
      catchUpItemFixture({ id: "w-3", importance: "routine" }),
      catchUpItemFixture({ id: "w-4", importance: "routine" }),
    ];
    renderSince([
      { path: "/api/v1/catch-up/items", body: { items, total_unseen: 4, oldest_unseen_at: null } },
      { path: "/api/v1/catch-up/brief", body: briefFixture() },
    ]);
    await screen.findByTestId("since-row-w-1");
    expect(screen.getByTestId("since-row-w-2")).toBeTruthy();
    expect(screen.queryByTestId("since-row-w-3")).toBeNull();

    const more = screen.getByTestId("since-you-left-routine");
    expect(more.textContent).toBe("+ 2 routine updates");
    more.click();
    expect(await screen.findByTestId("since-row-w-4")).toBeTruthy();
    // The row is a link to the item's own catch-up page, the href CatchUp builds.
    expect(screen.getByTestId("since-row-w-1").getAttribute("href")).toBe("/catch-up/w-1");
  });

  it("prints no brief headline above the rows (design review 9, F3)", async () => {
    renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: {
          items: [catchUpItemFixture({ id: "w-1", importance: "must_know" })],
          total_unseen: 1,
          oldest_unseen_at: null,
        },
      },
      {
        path: "/api/v1/catch-up/brief",
        body: briefFixture({ headline: { state: "ready", text: "Two projects moved." } }),
      },
    ]);
    expect(await screen.findByTestId("since-row-w-1")).toBeTruthy();
    expect(screen.queryByTestId("since-you-left-headline")).toBeNull();
  });

  it("prints no headline when only routine updates came in", async () => {
    renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: {
          items: [catchUpItemFixture({ id: "w-1", importance: "routine" })],
          total_unseen: 1,
          oldest_unseen_at: null,
        },
      },
      {
        path: "/api/v1/catch-up/brief",
        body: briefFixture({
          headline: {
            state: "ready",
            text: "Quiet stretch: nothing changed in the projects you follow.",
          },
        }),
      },
    ]);
    expect(await screen.findByTestId("since-you-left-routine")).toBeTruthy();
    expect(screen.queryByTestId("since-you-left-headline")).toBeNull();
  });

  it("stamps the visit once, fire-and-forget, like CatchUp did", async () => {
    const { requests } = renderSince([
      {
        path: "/api/v1/catch-up/items",
        body: { items: [], total_unseen: 0, oldest_unseen_at: null },
      },
      { path: "/api/v1/catch-up/brief", body: briefFixture() },
      { path: "/api/v1/catch-up/visits", method: "POST", status: 204 },
    ]);
    await waitFor(() =>
      expect(requestsTo(requests, "/api/v1/catch-up/visits", "POST").length).toBe(1),
    );
  });
});
