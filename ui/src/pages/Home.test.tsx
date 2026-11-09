/**
 * `/` — Today's own copy, exact (finding 12).
 *
 * The two strings the reviewer asked to see rewritten are pinned character for
 * character here: the "this server cannot answer that read" note, and the
 * absence of any link to a retired page (finding 03 — Today sends people to
 * Today, never to Inbox or Board). The run-not-found answer is pinned in
 * `components/workbench/RunNotFound.test.tsx`.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import Home from "./Home";
import { mockFetch, meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";

/** Collapse the JSX's line-wrapping to the one-line sentence a reader sees. */
function oneLine(node: Element): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function renderHome(routes: RouteStub[]) {
  const { requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<Home />, { wrapper });
  return { requests };
}

const NOT_FOUND = {
  type: "https://communication.dev/errors/not-found",
  title: "Not found",
  status: 404,
  detail: "no such route on this build",
};

afterEach(cleanup);

describe("Today's server-version note (finding 12)", () => {
  it("says what broke, what is still fine and who to ask — in that order", async () => {
    renderHome([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
      { path: "/api/v1/runs", body: { runs: [] } },
      // The serving image predates the cross-project approvals read.
      { path: "/api/v1/approvals", status: 404, body: NOT_FOUND },
      { path: "/api/v1/conversations", body: { items: [] } },
    ]);

    const note = await screen.findByTestId("home-not-available");
    expect(oneLine(note)).toBe(
      "Approvals from other projects can't load on this server version. The rest of Today is up to date. Ask an admin to update",
    );
    // No API name, no build word: the sentence names the reader's problem.
    expect(oneLine(note)).not.toMatch(/cross-project|scaffold|404|endpoint|build/i);
  });

  it("stays silent when the server answers every read", async () => {
    renderHome([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
      { path: "/api/v1/runs", body: { runs: [] } },
      { path: "/api/v1/approvals", body: { approvals: [] } },
      { path: "/api/v1/conversations", body: { items: [] } },
    ]);

    // The briefing settles on its own data (the empty state proves the reads
    // landed) and no note appears.
    await screen.findByTestId("home-empty");
    expect(screen.queryByTestId("home-not-available")).toBeNull();
  });

  it("never links to a retired page (finding 03)", async () => {
    const { requests } = renderHome([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
      { path: "/api/v1/runs", body: { runs: [] } },
      { path: "/api/v1/approvals", status: 404, body: NOT_FOUND },
      { path: "/api/v1/conversations", body: { items: [] } },
    ]);

    await screen.findByTestId("home-not-available");
    // The retired addresses are never asked for and never rendered as links.
    for (const retired of ["/inbox", "/board"]) {
      expect(document.body.textContent).not.toContain(retired);
      expect(
        Array.from(document.querySelectorAll("a")).some(
          (link) => link.getAttribute("href") === retired,
        ),
      ).toBe(false);
      expect(requestsTo(requests, retired)).toHaveLength(0);
    }
  });
});
