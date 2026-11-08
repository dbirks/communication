/**
 * The tour player (design 7b) over the mocked API: progress-segment states,
 * the keyboard (←/→ move, S seen now, Esc closes, ⌘J asks), "See more"
 * appending four stops, per-stop seen (moving on posts EXACTLY one stop id),
 * the `?item=` single-piece mode, the end-of-tour panel, and the bug-story
 * FOUND/CAUSE/FIXED/FOLLOW-UP steps rendering only when sibling stops back
 * them.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../api/client";
import { mockFetch, type RouteStub } from "../test/fakes";
import TourPlayer from "./TourPlayer";

const w1 = "01987a90-0000-7000-8000-111111111111";
const w2 = "01987a90-0000-7000-8000-222222222222";

const payments = { id: "p1", name: "payments", color: "#6a4bc4" };
const webConsole = { id: "p2", name: "web-console", color: "#1f8077" };

function stop(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title,
    narrative: `Narrative for ${title}. Second paragraph.`,
    kind: "BUG · FIXED",
    importance: "must_know",
    added_in_version: 1,
    seen: false,
    ...over,
  };
}

function tourEntry(workId: string, s: ReturnType<typeof stop>, project = payments, minutes = 2) {
  return { work_item_id: workId, stop: s, project, refs: { issues: [{ number: 215 }] }, minutes };
}

const page0 = {
  stops: [
    tourEntry(w1, stop("s1", "Refund duplicates: found, cause, fix")),
    tourEntry(w2, stop("t1", "Checkout summary redesign", { kind: "UI CHANGE" }), webConsole),
    tourEntry(
      w2,
      stop("t2", "Session key grace: your call", { kind: "YOUR CALL", importance: "worth_a_look" }),
      webConsole,
      1,
    ),
    tourEntry(
      w1,
      stop("s9", "Index restore lock time", { importance: "worth_a_look" }),
      payments,
      2,
    ),
  ],
  total_unseen_stops: 9,
  more_available: true,
  built_from: 2,
  minutes_total: 7,
};

const page4 = {
  stops: Array.from({ length: 4 }, (_, i) =>
    tourEntry(w2, stop(`m${i}`, `Later piece ${i + 1}`, { importance: "routine" }), webConsole, 1),
  ),
  total_unseen_stops: 9,
  more_available: false,
  built_from: 2,
  minutes_total: 4,
};

const seenPath = (workId: string) => `/api/v1/catch-up/items/${workId}/seen`;
const itemPath = (workId: string) => `/api/v1/catch-up/items/${workId}`;
/** The same open event AssistantPopover listens for (mirrored as a literal so
 * this suite does not import the Shell module graph). */
const ASSISTANT_OPEN_EVENT = "communication:assistant-open";

function itemDetail(workId: string, stops: ReturnType<typeof stop>[], over = {}) {
  return {
    id: workId,
    project: payments,
    shape: "issue",
    title: "Refund webhook sent duplicates",
    summary: "Fixed on main, no review.",
    resolution: "merged",
    refs: {
      issues: [{ number: 215 }],
      pull_requests: [{ number: 417, url: "https://github.com/octo/widgets/pull/417" }],
      commits: [
        {
          sha: "a1f9c2e0deadbeef",
          url: "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef",
        },
      ],
    },
    source_run_id: "run-1",
    conversation_id: "c1",
    latest: { version: 2, reason: "Fix landed", created_at: "2026-10-14T12:40:00Z", stops },
    history: [],
    seen_by: [],
    you_saw_version: null,
    unseen_stops: stops.length,
    total_stops: stops.length,
    created_at: "2026-10-13T09:00:00Z",
    updated_at: "2026-10-14T12:40:00Z",
    ...over,
  };
}

/** The four beats of the mock's bug story, as one item's shared tour. */
function bugStops() {
  return [
    stop("b1", "The nightly replay test failed", { kind: "BUG · FOUND" }),
    stop("b2", "PR #417 dropped the idempotency key", { kind: "CAUSE" }),
    stop("b3", "Key added back on every retry", { kind: "BUG · FIXED" }),
    stop("b4", "The agent opened a review-policy issue", { kind: "FOLLOW-UP" }),
  ];
}

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

function mount(routes: RouteStub[], entry = "/catch-up/tour") {
  setCsrfToken("test-csrf");
  const { requests } = mockFetch([
    { path: seenPath(w1), method: "POST", status: 204 },
    { path: seenPath(w2), method: "POST", status: 204 },
    ...routes,
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/catch-up/tour" element={<TourPlayer />} />
          <Route path="/catch-up" element={<div>catch-up home</div>} />
          <Route path="*" element={<div>other page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

const seenPosts = (requests: ReturnType<typeof mockFetch>["requests"], workId = w1) =>
  requests.filter((request) => request.url === seenPath(workId) && request.method === "POST");

describe("TourPlayer — the catch-up tour", () => {
  it("draws the top bar, the meta line and the progress segments in their states", async () => {
    mount([{ path: "/api/v1/catch-up/tour", body: page0 }]);
    await screen.findByTestId("tour-stop-1");
    expect(screen.getByTestId("tour-player").textContent).toContain("Catch-up tour");
    expect(screen.getByTestId("tour-player").textContent).toContain("stop 1 of 4 · about 7 min");
    // current = accent, upcoming = the quiet token, last dashed for "see more".
    expect(screen.getByTestId("tour-progress-seg-0").className).toContain("bg-imp-must-fill");
    expect(screen.getByTestId("tour-progress-seg-1").className).toContain("bg-line");
    expect(screen.getByTestId("tour-progress-seg-4").className).toContain("border-dashed");
    // Moving on turns the beat left behind to ink and lights the new one.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("tour-progress-seg-0").className).toContain("bg-ink");
    expect(screen.getByTestId("tour-progress-seg-1").className).toContain("bg-imp-must-fill");
  });

  it("→ moves and posts EXACTLY the one stop id left behind; S marks the current stop now", async () => {
    const { requests } = mount([{ path: "/api/v1/catch-up/tour", body: page0 }]);
    await screen.findByTestId("tour-stop-1");
    fireEvent.click(screen.getByTestId("tour-next"));
    await waitFor(() => expect(seenPosts(requests, w1)).toHaveLength(1));
    expect(JSON.parse(seenPosts(requests, w1)[0]!.body!)).toEqual({
      version: 1, // the beat's own tour version — only s1 is named
      stop_ids: ["s1"],
    });
    expect(screen.getByTestId("tour-current").textContent).toContain("Checkout summary redesign");
    // S marks the CURRENT stop (stop 2 belongs to w2) seen now.
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(seenPosts(requests, w2)).toHaveLength(1));
    expect(JSON.parse(seenPosts(requests, w2)[0]!.body!)).toEqual({ version: 1, stop_ids: ["t1"] });
    // ← moves back; the already-paid stop posts nothing more.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.getByTestId("tour-current").textContent).toContain("Refund duplicates"),
    );
    expect(seenPosts(requests, w1)).toHaveLength(1);
  });

  it("Esc closes back to the Catch up page", async () => {
    mount([{ path: "/api/v1/catch-up/tour", body: page0 }]);
    await screen.findByTestId("tour-stop-1");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByText("catch-up home")).toBeTruthy();
  });

  it("See more appends the next 4 stops", async () => {
    const { requests } = mount([
      {
        path: "/api/v1/catch-up/tour",
        body: (n: number) => (n === 1 ? page0 : page4),
      },
    ]);
    await screen.findByTestId("tour-stop-4");
    expect(screen.queryByTestId("tour-stop-5")).toBeNull();
    fireEvent.click(screen.getByTestId("tour-see-more"));
    await screen.findByTestId("tour-stop-8");
    expect(
      requests.filter((r) => r.url === "/api/v1/catch-up/tour" && r.method === "GET"),
    ).toHaveLength(2);
    expect(screen.getByTestId("tour-player").textContent).toContain("stop 1 of 8");
  });

  it("ends in the caught-up panel once the last stop is passed with nothing more", async () => {
    mount([
      {
        path: "/api/v1/catch-up/tour",
        body: { ...page0, stops: page0.stops.slice(0, 2), more_available: false },
      },
    ]);
    await screen.findByTestId("tour-stop-2");
    fireEvent.click(screen.getByTestId("tour-next"));
    await waitFor(() =>
      expect(screen.getByTestId("tour-current").textContent).toContain("Checkout summary redesign"),
    );
    fireEvent.click(screen.getByTestId("tour-next"));
    const end = await screen.findByTestId("tour-caught-up");
    expect(end.textContent).toContain("You're caught up");
    fireEvent.click(screen.getByText("Back to Catch up"));
    expect(await screen.findByText("catch-up home")).toBeTruthy();
  });

  it("⌘J and the footer button open Ask with this stop named, and the fix links the PR", async () => {
    const asked: unknown[] = [];
    const listener = (event: Event) => asked.push((event as CustomEvent).detail);
    window.addEventListener(ASSISTANT_OPEN_EVENT, listener);
    try {
      mount([
        { path: "/api/v1/catch-up/tour", body: page0 },
        { path: itemPath(w1), body: itemDetail(w1, bugStops()) },
      ]);
      await screen.findByTestId("tour-stop-1");
      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(asked[0]).toContain("Refund duplicates: found, cause, fix");
      asked.length = 0;
      fireEvent.click(screen.getByTestId("tour-ask"));
      expect(asked[0]).toContain("Refund duplicates");
      // The fix is the PR the SERVER could link (ADR-0078 § Decision 6): the
      // url beside the ref is computed from the repository's remote, and the
      // player prefers it over its own run page.
      const fix = await screen.findByTestId("tour-open-fix");
      expect(fix.getAttribute("href")).toBe("https://github.com/octo/widgets/pull/417");
      expect(fix.getAttribute("target")).toBe("_blank");
    } finally {
      window.removeEventListener(ASSISTANT_OPEN_EVENT, listener);
    }
  });

  it("with no server-computed ref url, the fix falls back to the run that made the work", async () => {
    mount([
      { path: "/api/v1/catch-up/tour", body: page0 },
      {
        path: itemPath(w1),
        body: itemDetail(w1, bugStops(), {
          // A repository on a host that is not GitHub answers no url at all.
          refs: { pull_requests: [{ number: 417 }] },
        }),
      },
    ]);
    const fix = await screen.findByTestId("tour-open-fix");
    expect(fix.getAttribute("href")).toBe("/runs/run-1");
  });

  it("a commit url is the fix when there is no pull request to open", async () => {
    mount([
      { path: "/api/v1/catch-up/tour", body: page0 },
      {
        path: itemPath(w1),
        body: itemDetail(w1, bugStops(), {
          refs: {
            commits: [
              {
                sha: "a1f9c2e0deadbeef",
                url: "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef",
              },
            ],
          },
        }),
      },
    ]);
    const fix = await screen.findByTestId("tour-open-fix");
    expect(fix.getAttribute("href")).toBe(
      "https://github.com/octo/widgets/commit/a1f9c2e0deadbeef",
    );
  });

  it("renders bug steps only when the item's sibling stops back them", async () => {
    mount([
      { path: "/api/v1/catch-up/tour", body: page0 },
      { path: itemPath(w1), body: itemDetail(w1, bugStops()) },
    ]);
    const current = await screen.findByTestId("tour-current");
    // Stop 1 (w1) is a bug story with found/cause/fixed/follow-up siblings —
    // they appear once the item read that carries the siblings lands.
    await waitFor(() => expect(current.textContent).toContain("FOUND"));
    expect(current.textContent).toContain("CAUSE");
    expect(current.textContent).toContain("FIXED");
    expect(current.textContent).toContain("FOLLOW-UP");
    expect(current.textContent).toContain("PR #417 dropped the idempotency key");
    // Stop 2 (w2, UI CHANGE, no backing item read) stays plain narrative.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(current.textContent).toContain("Checkout summary redesign"));
    expect(current.textContent).not.toContain("FOLLOW-UP");
  });

  it("the lead is the stop's first sentence, never a duplicate of the steps' text", async () => {
    mount([
      { path: "/api/v1/catch-up/tour", body: page0 },
      { path: itemPath(w1), body: itemDetail(w1, bugStops()) },
    ]);
    const current = await screen.findByTestId("tour-current");
    // Stop 1's beat chain is backed by the sibling stop s9: the FOUND/… rows
    // print the narrative, so the lead stands down instead of repeating it.
    await waitFor(() => expect(current.textContent).toContain("FOUND"));
    expect(screen.queryByTestId("tour-lead")).toBeNull();
    expect(current.textContent).toContain("Narrative for Refund duplicates");
    // Stop 2 is plain: lead = first sentence only, the rest follows below it.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(current.textContent).toContain("Checkout summary redesign"));
    expect(screen.getByTestId("tour-lead").textContent).toBe(
      "Narrative for Checkout summary redesign.",
    );
    expect(current.textContent).toContain("Second paragraph.");
  });
});

describe("TourPlayer — one piece (?item=)", () => {
  it("plays every beat of the item's own tour without asking for the page tour", async () => {
    const { requests } = mount(
      [{ path: itemPath(w1), body: itemDetail(w1, bugStops()) }],
      `/catch-up/tour?item=${w1}`,
    );
    await screen.findByTestId("tour-stop-4");
    expect(requests.filter((r) => r.url === "/api/v1/catch-up/tour")).toHaveLength(0);
    expect(screen.getByTestId("tour-player").textContent).toContain(
      "Refund webhook sent duplicates",
    );
    expect(screen.queryByTestId("tour-see-more")).toBeNull();
    fireEvent.click(screen.getByTestId("tour-next"));
    await waitFor(() => expect(seenPosts(requests, w1)).toHaveLength(1));
    // Item mode names the newest version — and still only the beat left behind.
    expect(JSON.parse(seenPosts(requests, w1)[0]!.body!)).toEqual({
      version: 2,
      stop_ids: ["b1"],
    });
  });

  it("a lone bug stop with no sibling support renders plainly, never as invented steps", async () => {
    mount(
      [
        {
          path: itemPath(w2),
          body: itemDetail(w2, [stop("x1", "A bug found and fixed")], { title: "Quiet fix" }),
        },
      ],
      `/catch-up/tour?item=${w2}`,
    );
    const current = await screen.findByTestId("tour-current");
    await waitFor(() => expect(current.textContent).toContain("A bug found and fixed"));
    expect(screen.getByTestId("tour-player").textContent).toContain("Quiet fix");
    expect(current.textContent).not.toContain("FOLLOW-UP");
    expect(screen.queryByTestId("tour-step-found")).toBeNull();
  });
});
