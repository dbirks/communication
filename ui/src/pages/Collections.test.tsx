/**
 * The Collections tab (`/workflows/collections`) and the editor route
 * (`/workflows/collections/:id`) — ADR-0084. The list renders cards from the
 * library read joined (client-side) with the profile read for `used by N
 * profiles`; the editor carries the ordered entries, the add-row's pin
 * refusal, the reorder → `Save draft` body order, and the publish confirm's
 * exact words. Fixtures only — no live server.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Collections from "./Collections";
import { mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import { meFixture } from "../test/fakes";

const admin = { ...meFixture, is_org_admin: true };

const matt = {
  id: "c-matt",
  slug: "matt-pocock-skills",
  name: "Matt Pocock skills",
  description: "The whole plugin set — twenty-seven skills for spec, tickets and review.",
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 1,
  latest_revision: {
    revision_id: "r-matt-1",
    revision: 1,
    status: "published",
    entries: [{ ref: "mattpocock/skills#v1.3.2" }],
    created_at: "2026-11-11T10:00:00Z",
  },
};

const pstack = {
  id: "c-pstack",
  slug: "pstack-claude-code",
  name: "pstack (Claude Code)",
  description: "Lauren Tan's pstack harness, per skill, from the Cursor Claude tree.",
  created_by: "u-1",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 3,
  latest_revision: {
    revision_id: "r-pstack-3",
    revision: 3,
    status: "published",
    entries: [
      {
        ref: "cursor/plugins/harness/pstack/claude-code/skills/how#63912a91d52c43946f974f2aaf661334a6116a82",
      },
      {
        ref: "cursor/plugins/harness/pstack/claude-code/skills/why#63912a91d52c43946f974f2aaf661334a6116a82",
      },
    ],
    created_at: "2026-11-11T10:00:00Z",
  },
};

function mount(stubs: RouteStub[], path = "/workflows/collections") {
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/workflows/collections" element={<Collections />} />
          <Route path="/workflows/collections/:id" element={<Collections />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
}

function baseStubs(collections: unknown): RouteStub[] {
  return [
    { path: "/api/v1/me", body: admin },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    { path: "/api/v1/apm-collections", body: collections },
  ];
}

afterEach(cleanup);

describe("Collections list", () => {
  it("renders a card per collection with the mono kicker and the joined used-by count", async () => {
    mount([
      { path: "/api/v1/me", body: admin },
      {
        path: "/api/v1/agent-profiles",
        method: "GET",
        body: {
          items: [
            {
              id: "p-1",
              name: "Claude Code",
              launcher_id: "claude",
              permission_mode: "ask",
              created_at: "2026-11-11T10:00:00Z",
              version: 1,
              apm_collections: [{ collection_id: "c-matt", revision: 1 }],
            },
            {
              id: "p-2",
              name: "Pi",
              launcher_id: "pi",
              permission_mode: "ask",
              created_at: "2026-11-11T10:00:00Z",
              version: 1,
              apm_collections: [
                { collection_id: "c-matt", revision: 1 },
                { collection_id: "c-pstack", revision: 3 },
              ],
            },
          ],
        },
      },
      { path: "/api/v1/apm-collections", body: { collections: [matt, pstack], next_cursor: null } },
    ]);

    const card = await screen.findByTestId("collection-card-c-matt");
    expect(within(card).getByText("COLLECTION · r1 · 1 PACKAGE")).toBeDefined();
    expect(card.textContent).toContain("Matt Pocock skills");
    expect(within(card).getByTestId("collection-card-usage-c-matt").textContent).toBe(
      "used by 2 profiles",
    );
    const pstackCard = screen.getByTestId("collection-card-c-pstack");
    expect(within(pstackCard).getByTestId("collection-card-usage-c-pstack").textContent).toBe(
      "used by 1 profile",
    );
    // The third tab is present on the strip.
    expect(screen.getByTestId("workflows-tab-collections").textContent).toBe("Collections");
  });

  it("shows the empty state, not a fake row", async () => {
    mount(baseStubs({ collections: [], next_cursor: null }));
    const empty = await screen.findByTestId("collections-empty");
    expect(empty.textContent).toBe(
      "No collections yet. Bundle skill packages once, attach them to any agent.",
    );
    expect(screen.queryByTestId("collections-grid")).toBeNull();
  });

  it("a server without the endpoint reads as NOT AVAILABLE YET, not an error", async () => {
    mount([
      { path: "/api/v1/me", body: admin },
      { path: "/api/v1/agent-profiles", body: { items: [] } },
    ]);
    const alert = await screen.findByTestId("collections-registry-unavailable");
    expect(alert.textContent).toContain("does not expose the collection library yet");
  });

  it("New collection creates a draft and lands on its editor", async () => {
    const requests = mount([
      ...baseStubs({ collections: [], next_cursor: null }),
      {
        path: "/api/v1/apm-collections",
        method: "POST",
        status: 201,
        body: { ...matt, id: "c-new" },
      },
    ]);
    fireEvent.click(await screen.findByTestId("collections-new"));
    const dialog = await screen.findByTestId("collections-new-dialog");
    fireEvent.change(within(dialog).getByTestId("collections-new-name"), {
      target: { value: "Review conventions" },
    });
    expect(within(dialog).getByTestId<HTMLInputElement>("collections-new-slug").value).toBe(
      "review-conventions",
    );
    fireEvent.click(within(dialog).getByTestId("collections-new-submit"));
    await waitFor(() => {
      const [request] = requestsTo(requests, "/api/v1/apm-collections", "POST");
      expect(request).toBeDefined();
      expect(JSON.parse(request.body ?? "{}")).toEqual({
        slug: "review-conventions",
        name: "Review conventions",
        description: "",
        entries: [],
      });
    });
  });
});
