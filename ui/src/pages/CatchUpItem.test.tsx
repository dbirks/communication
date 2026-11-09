/**
 * The piece-of-work page (design 8b) over the mocked API: the header's
 * seen-by line for each reader state, the ADDED / UPDATED treatment when the
 * shared tour moved after this reader looked, moving off a stop paying that
 * stop's debt, the copy-link and play-tour actions, the stop pick the
 * `?stop=` parameter makes, and the tour column's words at both frames — the
 * phone's select replaces the stop list but stays inside the column, so 390
 * still prints the heading, the note and the explainer the width sweep reads
 * at 1280.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken } from "../api/client";
import { mockFetch, type RouteStub } from "../test/fakes";
import { PHONE_MAX_WIDTH_PX } from "../components/Shell";
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
    refs: {
      issues: [{ number: 215 }],
      pull_requests: [{ number: 417 }],
      commits: [{ sha: "a1f9c2e0deadbeef" }],
    },
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
      refs: { issues: [{ number: 215 }] },
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

/** Answer the page's frame query (the phone cut is `PHONE_MAX_WIDTH_PX`, the
 * shell's rule) as a `width` px viewport would. The stop list and the select
 * are a `matchMedia` question, not a stylesheet one, so this is what decides
 * which of them mounts. */
function stubViewport(width: number): void {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /\(max-width: ([\d.]+)px\)/.exec(query);
    const min = /\(min-width: ([\d.]+)px\)/.exec(query);
    let matches = true;
    if (min) matches = matches && width >= Number(min[1]);
    if (max) matches = matches && width <= Number(max[1]);
    return {
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    };
  });
}

/** Restore jsdom's real `matchMedia` after a `stubViewport` test — NOT
 * `vi.unstubAllGlobals()`, which would also drop the session-wide stubs while
 * a rendered app is still mounted. */
const nativeMatchMedia = window.matchMedia;
function restoreViewport(): void {
  vi.stubGlobal("matchMedia", nativeMatchMedia);
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

  it("the last stop's Next is Done ›: it pays that beat and links back to Catch up", async () => {
    // A reader on the newest version: no UPDATED split, so the tour is walked
    // in its own order and the unseen s3 is the LAST stop of it.
    const { requests } = mount(detail({ you_saw_version: null, unseen_stops: 3 }));
    const current = await screen.findByTestId("catchup-item-current");
    expect(current.textContent).toContain("Fix and follow-up");
    const next = screen.getByTestId("catchup-item-next");
    expect(next.textContent).toContain("Done ›");
    expect(next.getAttribute("href")).toBe("/catch-up");
    expect(next.getAttribute("disabled")).toBeNull();
    fireEvent.click(next);
    // It marks the beat seen exactly the way moving on does…
    await waitFor(() =>
      expect(
        requests.filter((request) => request.url === seenPath && request.method === "POST"),
      ).toHaveLength(1),
    );
    expect(JSON.parse(requests.filter((r) => r.url === seenPath).at(-1)!.body!)).toEqual({
      version: 2,
      stop_ids: ["s3"],
    });
    // …and leaves the piece: the page behind it is the Catch up list.
    await waitFor(() => expect(screen.queryByTestId("catchup-item")).toBeNull());
  });

  it("?stop= selects the beat and clicking another stop marks the previous seen", async () => {
    const { requests } = mount(detail(), `/catch-up/${workId}?stop=s2`);
    await screen.findByTestId("catchup-item-current");
    // The `?stop=` pick lands with the read's own paint; wait for the beat the
    // parameter names rather than trusting the first frame after the mount.
    await waitFor(() =>
      expect(screen.getByTestId("catchup-item-current").textContent).toContain(
        "Cause: PR #417 dropped the key",
      ),
    );
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

  it("puts Copy link and Play tour on the header ROW, and keeps the stop-list header whole with its explainer under the list", async () => {
    mount(detail());
    const title = await screen.findByTestId("catchup-item-title");
    const copy = screen.getByTestId("catchup-item-copy");
    const play = screen.getByTestId("catchup-item-play");
    // Mock 8b: title left, the two actions top-RIGHT of the same band — they
    // are not a third line under the title, and not inside the story column.
    expect(copy.closest("header")).toBe(title.closest("header"));
    expect(play.closest("header")).toBe(title.closest("header"));
    expect(screen.getByTestId("catchup-item-current").contains(play)).toBe(false);
    // The column header carries the mock's full text (nothing truncated) and
    // the explainer line sits under the list, inside the same column.
    const column = screen.getByTestId("catchup-item-tour-column");
    expect(screen.getByTestId("catchup-item-tour-heading").textContent).toBe("This work's tour");
    expect(column.textContent).toContain("shared with the project");
    expect(column.textContent).toContain(
      "One tour per piece of work. It is rewritten as the work moves, and everyone on the project sees the same one.",
    );
    expect(column.contains(screen.getByTestId("catchup-item-stop-s3"))).toBe(true);
  });

  it.each([390, 1280])(
    "keeps the tour column's words and the pick in one container at %i",
    async (width) => {
      stubViewport(width);
      try {
        mount(detail());
        const column = await screen.findByTestId("catchup-item-tour-column");
        // The acceptance sweep (42487889463) reads these three ids per width:
        // the phone's select replaced the list AND took the column's heading,
        // note and explainer with it, so 390 lost words 1280 has.
        expect(screen.getByTestId("catchup-item-tour-heading").textContent).toBe(
          "This work's tour",
        );
        expect(column.contains(screen.getByTestId("catchup-item-tour-heading"))).toBe(true);
        expect(column.textContent).toContain("shared with the project");
        expect(screen.getByTestId("catchup-item-tour-explainer").textContent).toBe(
          "One tour per piece of work. It is rewritten as the work moves, and everyone on the " +
            "project sees the same one.",
        );
        expect(column.contains(screen.getByTestId("catchup-item-tour-explainer"))).toBe(true);
        // Only the PICK follows the frame: the rows wide, the select on the
        // phone — and it always lives inside that same column.
        const select = screen.queryByTestId("catchup-item-stop-select");
        const rows = screen.queryAllByTestId(/^catchup-item-stop-s\d$/);
        if (width <= PHONE_MAX_WIDTH_PX) {
          expect(select).toBeTruthy();
          expect(column.contains(select)).toBe(true);
          expect(rows).toHaveLength(0);
        } else {
          expect(select).toBeNull();
          expect(rows.length).toBeGreaterThan(0);
          expect(column.contains(screen.getByTestId("catchup-item-stop-s3"))).toBe(true);
        }
        cleanup();
      } finally {
        restoreViewport();
      }
    },
  );

  it("stacks the phone header so the title keeps its width and the tags never clip", async () => {
    stubViewport(390);
    try {
      mount(detail());
      const title = await screen.findByTestId("catchup-item-title");
      const copy = screen.getByTestId("catchup-item-copy");
      const play = screen.getByTestId("catchup-item-play");
      const head = screen.getByTestId("catchup-item-head");
      const headline = screen.getByTestId("catchup-item-headline");
      const actions = screen.getByTestId("catchup-item-actions");
      // Below the phone cut the header is a COLUMN: tags, title, seen-by, then
      // the actions on their own row — the two buttons beside the title squeezed
      // it to one word per line and clipped the importance/kind tags.
      expect(head.className).toContain("flex-col");
      expect(head.className).toContain("md:flex-row");
      // The title's own block stretches (nothing shrinks it to fit the buttons),
      // and the flex-shrink that keeps the buttons whole is a `md` rule only.
      expect(headline.className).toContain("min-w-0");
      expect(headline.className).toContain("md:flex-1");
      expect(actions.className).toContain("md:shrink-0");
      expect(actions.className).not.toMatch(/(^|\s)shrink-0(\s|$)/);
      // Order: the tags row and the seen-by line live inside the title block,
      // the actions after it.
      const tags = screen.getByTestId("catchup-item-tags");
      expect(headline.contains(tags)).toBe(true);
      expect(headline.contains(title)).toBe(true);
      expect(Boolean(tags.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
        true,
      );
      expect(headline.compareDocumentPosition(actions)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      // The tags wrap rather than clip.
      expect(tags.className).toContain("flex-wrap");
      // Still one header, and still not inside the story column (desktop rule).
      expect(copy.closest("header")).toBe(title.closest("header"));
      expect(play.closest("header")).toBe(title.closest("header"));
      // The three columns own what the header does not use, at every frame.
      const columns = screen.getByTestId("catchup-item-tour-column").parentElement;
      expect(columns?.className).toContain("flex-1");
      expect(head.closest("header")?.parentElement?.className).toContain("md:min-h-dvh");
      cleanup();
    } finally {
      restoreViewport();
    }
  });

  it("says nobody has seen this with no stray space in front of it", async () => {
    mount(detail({ seen_by: [], you_saw_version: null, unseen_stops: 3 }));
    const line = await screen.findByTestId("catchup-item-seen-line");
    expect(line.textContent).toBe("nobody has seen this yet");
    // No empty avatar strip to read as a leading space.
    expect(screen.queryByTestId("catchup-item-seen-by")).toBeNull();
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
    // The slot line is the OTHER read (the reader's own page tour): it arrives
    // in its own commit, so it is found, not read inline off the item page.
    const slot = await screen.findByText(/Stop 1 of 2/);
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
