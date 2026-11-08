/**
 * The catch-up page (design 8a) over the mocked API: the filter chips are the
 * reader's whole project list (all on by default) and drive the list query,
 * the big-backlog banner appears only past the threshold and dismisses for the
 * session, a recap-less reader gets the honest empty, the recap's ask posts the
 * page's scope, the tour cards render in order with the first one focused,
 * "See more" pages the tour, and the rest panel's writes reach the seen
 * endpoints.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../api/client";
import { meFixture, mockFetch, type RouteStub } from "../test/fakes";
import CatchUp from "./CatchUp";

const paymentsId = "01987a90-0000-7000-8000-111111111111";
const webId = "01987a90-0000-7000-8000-222222222222";
const platformId = "01987a90-0000-7000-8000-333333333333";
const itemA = "01987a90-0000-7000-8000-aaaaaaaaaaaa";
const itemB = "01987a90-0000-7000-8000-bbbbbbbbbbbb";

function chip(id: string, name: string, color: string) {
  return { id, name, color };
}

/** The reader's own project list: the filter row is drawn from THIS, not from
 * whichever projects one page of items happens to mention. */
function project(id: string, name: string, color: string) {
  return {
    id,
    slug: name,
    name,
    description: "",
    created_at: "2026-10-13T09:00:00Z",
    version: 1,
    my_role: "maintainer",
    agent_mail_enabled: false,
    color,
  };
}

const myProjects = {
  items: [
    project(paymentsId, "payments", "#6a4bc4"),
    project(webId, "web-console", "#1f8077"),
    project(platformId, "platform", "#4a5a78"),
  ],
};

function item(
  id: string,
  projectId: string,
  name: string,
  color: string,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    project: chip(projectId, name, color),
    shape: "issue",
    title: `Work ${id.slice(-4)}`,
    summary: "One line under the title",
    resolution: "merged",
    refs: { issues: [{ number: 215 }] },
    updated: false,
    unseen_stops: 2,
    total_stops: 2,
    importance: "must_know",
    updated_at: "2026-10-14T09:00:00Z",
    created_at: "2026-10-13T09:00:00Z",
    ...over,
  };
}

const twoItems = {
  items: [
    item(itemA, paymentsId, "payments", "#6a4bc4", { updated: true, resolution: "run_failed" }),
    item(itemB, webId, "web-console", "#1f8077", {
      resolution: "no_code",
      refs: { pull_requests: [{ number: 425 }] },
    }),
  ],
  total_unseen: 2,
  oldest_unseen_at: "2026-10-14T09:12:00Z",
};

function manyItems(count: number, daysAgo: number) {
  return {
    items: Array.from({ length: count }, (_, index) =>
      item(
        `01987a90-0000-7000-8000-${String(index).padStart(12, "0")}`,
        paymentsId,
        "payments",
        "#6a4bc4",
      ),
    ),
    total_unseen: count,
    oldest_unseen_at: new Date(Date.now() - daysAgo * 86_400_000 + 3_600_000).toISOString(),
  };
}

const tourPage = {
  stops: [
    {
      work_item_id: itemA,
      stop: {
        id: "s1",
        title: "Refund webhook sent duplicates",
        narrative: "From PR #417 yesterday. Fixed on main, no review.",
        kind: "BUG · FIXED",
        importance: "must_know",
        seen: false,
        added_in_version: 2,
        evidence: [
          {
            type: "diff",
            path: "webhook/sender.go · a1f9c2e",
            text: "-  return s.post(ev.URL, ev.Body)\n+  return s.post(ev.URL, ev.Body,\n+    WithIdempotencyKey(ev.ID))",
          },
        ],
      },
      project: chip(paymentsId, "payments", "#6a4bc4"),
      refs: { issues: [{ number: 215 }] },
      minutes: 2,
    },
    {
      work_item_id: itemB,
      stop: {
        id: "s2",
        title: "Checkout summary redesigned",
        narrative: "Sticky footer on mobile. Totals logic untouched.",
        kind: "UI CHANGE",
        importance: "worth_a_look",
        seen: false,
        added_in_version: 1,
        evidence: [{ type: "files", files: ["Checkout.tsx", "Totals.tsx"] }],
      },
      project: chip(webId, "web-console", "#1f8077"),
      refs: { pull_requests: [{ number: 425 }] },
      minutes: 1,
    },
  ],
  total_unseen_stops: 3,
  more_available: true,
  built_from: 4,
  minutes_total: 4,
};

const tourMorePage = {
  stops: [
    {
      work_item_id: itemB,
      stop: {
        id: "s3",
        title: "Index restore locks a table",
        narrative: "About 40s on deploy. Worth scheduling.",
        kind: "MIGRATION",
        importance: "routine",
        seen: false,
        added_in_version: 1,
        evidence: [{ type: "log", text: "lock held 40.2s" }],
      },
      project: chip(platformId, "platform", "#4a5a78"),
      refs: { issues: [{ number: 198 }] },
      minutes: 1,
    },
  ],
  total_unseen_stops: 3,
  more_available: false,
  built_from: 4,
  minutes_total: 5,
};

const recap = {
  text: "Start with the refund bug: it was fixed straight on main.",
  written_at: "2026-10-14T14:00:00Z",
  window: "unseen",
  project_ids: [],
};

const notFound = { type: "about:blank", title: "Not found", status: 404, detail: "" };

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: myProjects },
    {
      path: "/api/v1/approvals",
      body: { approvals: [{ id: "a1" }, { id: "a2" }] },
    },
    { path: "/api/v1/catch-up/items", body: twoItems },
    { path: "/api/v1/catch-up/tour", body: (n: number) => (n === 1 ? tourPage : tourMorePage) },
    { path: "/api/v1/catch-up/recap", body: recap },
    { path: "/api/v1/catch-up/visits/suggestion", body: { window: "24h", visits_per_week: 5 } },
    { path: "/api/v1/catch-up/visits", method: "POST", status: 204 },
    { path: "/api/v1/catch-up/seen-all", method: "POST", status: 204 },
    ...extra,
  ];
}

afterEach(cleanup);

function mount(extra: RouteStub[] = []) {
  setCsrfToken("test-csrf");
  const { fetchMock, requests } = mockFetch(routes(extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/catch-up"]}>
        <Routes>
          <Route path="/catch-up" element={<CatchUp />} />
          <Route path="*" element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, fetchMock };
}

function urlsFor(fetchMock: ReturnType<typeof mockFetch>["fetchMock"], prefix: string): string[] {
  return fetchMock.mock.calls
    .map((args) => String(args[0]))
    .filter((url) => url.startsWith(prefix));
}

/** The `projects` a recorded items read carried, as the page wrote them. */
function projectsParam(url: string): string[] {
  const raw = new URL(url.replace(/^\//, "http://x/")).searchParams.get("projects");
  return raw === null ? [] : raw.split(",");
}

describe("/catch-up", () => {
  it("opens on the unseen window with no since, and the window chips refetch", async () => {
    const { fetchMock } = mount();
    await screen.findByTestId("catchup-row-" + itemA);
    const first = urlsFor(fetchMock, "/api/v1/catch-up/items")[0]!;
    expect(first).not.toContain("since=");
    expect(screen.getByTestId("catchup-window-unseen").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("catchup-window-24h"));
    await waitFor(() => {
      expect(
        urlsFor(fetchMock, "/api/v1/catch-up/items").some((url) => url.includes("since=")),
      ).toBe(true);
    });
  });

  it("draws every one of the reader's projects, all on by default, and a click narrows the read", async () => {
    const { fetchMock } = mount();
    await screen.findByTestId("catchup-row-" + itemA);
    // The projects on screen: the two the items name AND platform, which has
    // nothing unseen and is still a project the reader can filter to.
    for (const id of [paymentsId, webId, platformId]) {
      const chipButton = await screen.findByTestId(`catchup-project-chip-${id}`);
      expect(chipButton.getAttribute("aria-pressed")).toBe("true");
    }
    // "Everything" is the API's empty scope, so the first read names nothing.
    expect(projectsParam(urlsFor(fetchMock, "/api/v1/catch-up/items")[0]!)).toEqual([]);

    fireEvent.click(screen.getByTestId(`catchup-project-chip-${paymentsId}`));
    await waitFor(() => {
      expect(projectsParam(urlsFor(fetchMock, "/api/v1/catch-up/items").at(-1)!)).toEqual([
        webId,
        platformId,
      ]);
    });
    expect(
      screen.getByTestId(`catchup-project-chip-${paymentsId}`).getAttribute("aria-pressed"),
    ).toBe("false");

    // Choosing it back is the same answer as choosing nothing: no scope at all.
    fireEvent.click(screen.getByTestId(`catchup-project-chip-${paymentsId}`));
    await waitFor(() => {
      expect(projectsParam(urlsFor(fetchMock, "/api/v1/catch-up/items").at(-1)!)).toEqual([]);
    });
  });

  it("the recap ask posts the page's scope and the refusal line is the reader's, not the status", async () => {
    const { requests } = mount([
      {
        path: "/api/v1/catch-up/recap",
        method: "POST",
        status: 503,
        body: {
          type: "about:blank",
          title: "Service Unavailable",
          status: 503,
          detail: "assistant_not_configured",
          degraded: "assistant_not_configured",
        },
      },
    ]);
    const block = await screen.findByTestId("catchup-recap");
    expect(block.textContent).toContain("ASSISTANT RECAP · WRITTEN");
    fireEvent.click(screen.getByTestId("catchup-recap-regenerate"));
    await waitFor(() => {
      const post = requests.find(
        (request) => request.url === "/api/v1/catch-up/recap" && request.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post!.body!)).toEqual({ projects: [], window: "unseen" });
    });
    const error = await screen.findByTestId("catchup-recap-error");
    expect(error.textContent).toBe(
      "The assistant isn't set up on this server. Ask an admin to configure it.",
    );
    // The recap that was there is still shown: a refusal stored nothing.
    expect(block.textContent).toContain("Start with the refund bug");
  });

  it("states the unseen tally and the waiting-on-you count in the subline", async () => {
    mount();
    const page = await screen.findByTestId("catchup-page");
    expect(page.textContent).toContain("2 unseen");
    expect(page.textContent).toContain("2 waiting on you on Today");
  });

  it("shows the big-backlog banner past 12 unseen, not at 12, and Keep all dismisses it", async () => {
    mount([{ path: "/api/v1/catch-up/items", body: manyItems(12, 1) }]);
    await screen.findByTestId("catchup-rest");
    expect(screen.queryByTestId("catchup-banner")).toBeNull();
    cleanup();

    mount([{ path: "/api/v1/catch-up/items", body: manyItems(13, 4) }]);
    const banner = await screen.findByTestId("catchup-banner");
    expect(banner.textContent).toContain("13 unseen over 4 days.");
    expect(banner.textContent).toContain("Narrow to the last 24h?");
    fireEvent.click(screen.getByTestId("catchup-banner-keep-all"));
    await waitFor(() => expect(screen.queryByTestId("catchup-banner")).toBeNull());
  });

  it("answers a missing recap with the honest line, and offers to write one", async () => {
    mount([{ path: "/api/v1/catch-up/recap", status: 404, body: notFound }]);
    const block = await screen.findByTestId("catchup-recap");
    await waitFor(() => expect(block.textContent).toContain("No recap yet."));
    expect(block.textContent).not.toContain("Not found");
    expect(screen.getByTestId("catchup-recap-regenerate").textContent).toBe("Write one");
  });

  it("renders the tour cards in order, the first one focused, and starts the tour", async () => {
    mount();
    const first = await screen.findByTestId("catchup-card-1");
    await screen.findByTestId("catchup-card-2");
    expect(first.textContent).toContain("Refund webhook sent duplicates");
    expect(first.textContent).toContain("From PR #417 yesterday.");
    expect(first.className).toContain("shadow-[2px_2px_0_var(--color-ink)]");
    const second = screen.getByTestId("catchup-card-2");
    expect(second.className).not.toContain("shadow-[2px_2px_0");
    const start = screen.getByTestId("catchup-start-tour");
    expect(start.getAttribute("href")).toBe("/catch-up/tour");
    expect(start.textContent).toContain("2 stops");
  });

  it("See more asks the tour for the next four stops", async () => {
    const { fetchMock } = mount();
    await screen.findByTestId("catchup-see-more");
    fireEvent.click(screen.getByTestId("catchup-see-more"));
    await waitFor(() => {
      expect(
        urlsFor(fetchMock, "/api/v1/catch-up/tour").some((url) => url.includes("offset=4")),
      ).toBe(true);
    });
    const third = await screen.findByTestId("catchup-card-3");
    expect(third.textContent).toContain("Index restore locks a table");
    // The earlier cards stay.
    expect(screen.getByTestId("catchup-card-1")).toBeTruthy();
  });

  it("the rest rows carry the UPDATED tag, mark all seen writes, show seen refetches", async () => {
    const { requests, fetchMock } = mount();
    const row = await screen.findByTestId(`catchup-row-${itemA}`);
    expect(row.textContent).toContain("UPDATED");
    expect(row.textContent).toContain("run failed");

    fireEvent.click(screen.getByTestId("catchup-mark-all-seen"));
    await waitFor(() =>
      expect(
        requests.filter(
          (request) => request.url === "/api/v1/catch-up/seen-all" && request.method === "POST",
        ),
      ).toHaveLength(1),
    );

    fireEvent.click(screen.getByTestId("catchup-show-seen"));
    await waitFor(() => {
      expect(
        urlsFor(fetchMock, "/api/v1/catch-up/items").some((url) =>
          url.includes("include_seen=true"),
        ),
      ).toBe(true);
    });
  });

  it("records one visit on mount", async () => {
    const { requests } = mount();
    await screen.findByTestId("catchup-page");
    await waitFor(() =>
      expect(
        requests.filter(
          (request) => request.url === "/api/v1/catch-up/visits" && request.method === "POST",
        ),
      ).toHaveLength(1),
    );
  });

  it("says so when there is nothing to catch up on", async () => {
    mount([
      {
        path: "/api/v1/catch-up/items",
        body: { items: [], total_unseen: 0, oldest_unseen_at: null },
      },
    ]);
    const empty = await screen.findByTestId("catchup-caught-up");
    expect(empty.textContent).toContain("You're caught up");
    expect(screen.queryByTestId("catchup-recap")).toBeNull();
  });

  it("a failed list read ends in an action", async () => {
    mount([
      {
        path: "/api/v1/catch-up/items",
        status: 500,
        body: { type: "about:blank", title: "Boom", status: 500, detail: "items broke" },
      },
    ]);
    const banner = await screen.findByTestId("catchup-error");
    expect(banner.textContent).toContain("Retry");
  });
});
