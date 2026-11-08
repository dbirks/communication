/**
 * The piece-of-work page (design 8b) over the mocked API: the header's
 * seen-by line for each reader state, the ADDED / UPDATED treatment when the
 * shared tour moved after this reader looked, moving off a stop paying that
 * stop's debt, the copy-link and play-tour actions, and the stop pick the
 * `?stop=` parameter makes.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken } from "../api/client";
import { mockFetch, type RouteStub } from "../test/fakes";
import { clockOf } from "../components/catchup/importance";
import CatchUpItem from "./CatchUpItem";

const workId = "01987a90-0000-7000-8000-aaaaaaaaaaaa";
const paymentsId = "01987a90-0000-7000-8000-111111111111";
const itemPath = `/api/v1/catch-up/items/${workId}`;
const seenPath = `/api/v1/catch-up/items/${workId}/seen`;

const project = { id: paymentsId, name: "payments", color: "#6a4bc4" };

function stop(id: string, title: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title,
    narrative: `Narrative for ${title}.`,
    kind: "BUG · FIXED",
    importance: "must_know",
    added_in_version: 1,
    seen: true,
    ...over,
  };
}

/** The 8b fixture: two beats from v1 the reader saw, one beat ADDED at 12:40. */
function itemDetail(over: Record<string, unknown> = {}) {
  return {
    id: workId,
    project,
    shape: "issue",
    title: "Refund webhook sent duplicates",
    summary: "Fixed on main, no review.",
    resolution: "merged",
    refs: { issue_numbers: [215], pr_numbers: [417], commit_shas: ["a1f9c2e0deadbeef"] },
    source_run_id: null,
    conversation_id: "c1",
    latest: {
      version: 2,
      reason: "Fix landed, stop 3 added",
      created_at: "2026-10-14T12:40:00Z",
      stops: [
        stop("s1", "Found: nightly replay failed"),
        stop("s2", "Cause: PR #417 dropped the key"),
        stop("s3", "Fix and follow-up", {
          added_in_version: 2,
          seen: false,
          importance: "worth_a_look",
          evidence: [{ type: "log", label: "NIGHTLY REPLAY TEST", text: "FAIL TestReplayRefunds" }],
        }),
      ],
    },
    history: [
      {
        version: 1,
        reason: "Issue opened",
        stop_count: 2,
        created_at: "2026-10-14T11:10:00Z",
      },
      {
        version: 2,
        reason: "Fix landed, stop 3 added",
        stop_count: 3,
        created_at: "2026-10-14T12:40:00Z",
      },
    ],
    seen_by: [
      { id: "u1", name: "Priya Nair", seen_at: "2026-10-14T12:45:00Z" },
      { id: "u2", name: "Jon Park", seen_at: "2026-10-14T12:50:00Z" },
    ],
    you_saw_version: 1,
    unseen_stops: 1,
    total_stops: 3,
    created_at: "2026-10-13T09:00:00Z",
    updated_at: "2026-10-14T12:40:00Z",
    ...over,
  };
}

const tourPage = {
  stops: [
    {
      work_item_id: workId,
      stop: stop("s3", "Fix and follow-up", { seen: false }),
      project,
      refs: { issue_numbers: [215] },
      minutes: 2,
    },
    {
      work_item_id: "01987a90-0000-7000-8000-bbbbbbbbbbbb",
      stop: stop("t1", "Something else", { seen: false, importance: "routine" }),
      project,
      refs: {},
      minutes: 1,
    },
  ],
  total_unseen_stops: 2,
  more_available: false,
  built_from: 2,
  minutes_total: 3,
};

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

function mount(routes: RouteStub[], entry = `/catch-up/${workId}`) {
  setCsrfToken("test-csrf");
  const { requests } = mockFetch([
    { path: "/api/v1/catch-up/tour", body: tourPage },
    { path: seenPath, method: "POST", status: 204 },
    ...routes,
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/catch-up/:workId" element={<CatchUpItem />} />
          <Route path="*" element={<div />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

function detail(routes: Record<string, unknown> = {}): RouteStub[] {
  return [{ path: itemPath, body: itemDetail(routes) }];
}

describe("/catch-up/:workId", () => {
  it("names the update the reader has not seen when their version is older", async () => {
    mount(detail());
    await screen.findByTestId("catchup-item-current");
    const page = screen.getByTestId("catchup-item");
    const clock = clockOf("2026-10-14T12:40:00Z")!;
    expect(page.textContent).toContain(
      `seen by Priya, Jon · you have not seen the ${clock} update`,
    );
    expect(page.textContent).toContain("MUST KNOW");
    expect(page.textContent).toContain("Refund webhook sent duplicates");
    expect(page.textContent).toContain("PR #417");
    expect(page.textContent).toContain("a1f9c2e");
  });

  it("says you're up to date for a reader on the newest version, and nobody has seen it when the roster is empty", async () => {
    mount(detail({ you_saw_version: 2 }));
    const page = await screen.findByTestId("catchup-item");
    await waitFor(() => expect(page.textContent).toContain("you're up to date"));
    cleanup();

    mount(detail({ seen_by: [], you_saw_version: null, unseen_stops: 3 }));
    const fresh = await screen.findByTestId("catchup-item");
    await waitFor(() => expect(fresh.textContent).toContain("nobody has seen this yet"));
  });

  it("leads with the beats the reader missed: UPDATED note, ADDED tag, earlier stops collapsed", async () => {
    mount(detail());
    const added = await screen.findByTestId("catchup-item-stop-s3");
    expect(added.textContent).toContain(`ADDED ${clockOf("2026-10-14T12:40:00Z")}`);
    const page = screen.getByTestId("catchup-item");
    expect(page.textContent).toContain("UPDATED");
    // The carried-over beats are collapsed until asked for.
    expect(screen.queryByTestId("catchup-item-stop-s1")).toBeNull();
    fireEvent.click(screen.getByTestId("catchup-item-earlier-toggle"));
    await screen.findByTestId("catchup-item-stop-s1");
    expect(screen.getByTestId("catchup-item-stop-s2")).toBeTruthy();
  });

  it("opens the first unseen beat, and Next pays ONLY the beat left behind", async () => {
    const { requests } = mount(detail());
    const current = await screen.findByTestId("catchup-item-current");
    expect(current.textContent).toContain("Fix and follow-up");
    expect(current.textContent).toContain("Stop 3 of 3");
    expect(current.textContent).toContain("FAIL TestReplayRefunds");
    expect(current.textContent).toContain("Marked seen when you move on");

    fireEvent.click(screen.getByTestId("catchup-item-next"));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url === seenPath && request.method === "POST").length,
      ).toBeGreaterThan(0),
    );
    const seenBody = JSON.parse(
      requests.filter((request) => request.url === seenPath && request.method === "POST").at(-1)!
        .body!,
    );
    // Per-stop seen: leaving s3 marks s3, never the whole tour.
    expect(seenBody).toEqual({ version: 2, stop_ids: ["s3"] });
    await waitFor(() =>
      expect(screen.getByTestId("catchup-item-current").textContent).toContain(
        "Found: nightly replay failed",
      ),
    );
  });

  it("?stop= selects the beat and clicking another stop marks the previous seen", async () => {
    const { requests } = mount(detail(), `/catch-up/${workId}?stop=s2`);
    const current = await screen.findByTestId("catchup-item-current");
    expect(current.textContent).toContain("Cause: PR #417 dropped the key");
    // s2 was already seen at the reader's version: moving off it posts nothing.
    fireEvent.click(screen.getByTestId("catchup-item-back"));
    await waitFor(() =>
      expect(screen.getByTestId("catchup-item-current").textContent).toContain(
        "Found: nightly replay failed",
      ),
    );
    expect(
      requests.filter((request) => request.url === seenPath && request.method === "POST"),
    ).toHaveLength(0);
    // Arriving at the unseen s3 costs nothing; moving off it pays its debt.
    fireEvent.click(screen.getByTestId("catchup-item-stop-s3"));
    await waitFor(() =>
      expect(screen.getByTestId("catchup-item-current").textContent).toContain("Fix and follow-up"),
    );
    expect(
      requests.filter((request) => request.url === seenPath && request.method === "POST"),
    ).toHaveLength(0);
    fireEvent.click(screen.getByTestId("catchup-item-next"));
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url === seenPath && request.method === "POST"),
      ).toHaveLength(1),
    );
  });

  it("copy link puts the tour url on the clipboard and says Copied", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mount(detail());
    const copy = await screen.findByTestId("catchup-item-copy");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toMatch(new RegExp(`/catch-up/${workId}$`));
    await waitFor(() =>
      expect(screen.getByTestId("catchup-item-copy").textContent).toContain("Copied"),
    );
  });

  it("plays the tour for this piece and shows the slot it holds in the reader's own tour", async () => {
    mount(detail());
    const play = await screen.findByTestId("catchup-item-play");
    expect(play.getAttribute("href")).toBe(`/catch-up/tour?item=${workId}`);
    expect(play.textContent).toContain("3 stops");
    const history = await screen.findByTestId("catchup-item-history");
    // Newest version first.
    expect(history.textContent).toContain("Fix landed, stop 3 added");
    const slot = screen.getByText(/Stop 1 of 2/);
    expect(slot.closest("section")).toBeTruthy();
  });

  it("states the honest empty for a work item whose tour was never written", async () => {
    mount(detail({ latest: null, history: [], total_stops: 0, unseen_stops: 0 }));
    const page = await screen.findByTestId("catchup-item");
    await waitFor(() => expect(page.textContent).toContain("This work has no tour yet"));
  });

  it("a failed read ends in a retry, not a blank page", async () => {
    mount([
      {
        path: itemPath,
        status: 500,
        body: { type: "about:blank", title: "Boom", status: 500, detail: "items broke" },
      },
    ]);
    const banner = await screen.findByTestId("catchup-item-error");
    expect(banner.textContent).toContain("Retry");
  });
});
