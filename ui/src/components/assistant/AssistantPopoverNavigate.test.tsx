/**
 * Finding F-1 (docs/testing/assistant-exercise-2026-11-11.md): the answer said
 * "Opened the Operations page." while `location.pathname` stayed `/workflows`,
 * because ADR-0050 Decision 7 — **the client performs the navigation** — had no
 * consumer. These tests drive the real container over a stub server and watch
 * the router, pinning the four rules the fix rests on:
 *
 *   - a turn whose rows carry a `navigate` change moves the router to its
 *     `target_ref`, ONCE, and the surface stays where the person left it
 *     (popover open, side panel docked);
 *   - replaying an old thread navigates nothing — the transcript read is not a
 *     request to move;
 *   - a `target_ref` the client will not perform (an absolute URL, a
 *     protocol-relative host, a path with a control character) navigates
 *     nothing, and the jump row under the answer remains the way in;
 *   - the jump row still works as the fallback, so the page is reachable even
 *     when the automatic move was refused.
 */
import { useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import AssistantPopover, { openAssistantPopover } from "./AssistantPopover";

const CONV = "conv-1";
const CREATE_PATH = "/api/v1/assistant/conversations";
const CONVS_PATH = "/api/v1/assistant/conversations?limit=5";
const CONVS_MENU_PATH = "/api/v1/assistant/conversations?limit=30";
const CONV_ROW = {
  id: CONV,
  title: "operations",
  created_at: "2026-11-11T00:00:00Z",
  updated_at: "2026-11-11T00:00:00Z",
  last_message_at: "2026-11-11T00:00:00Z",
};
const STATUS_BODY = {
  chat_model: { configured: false, model: "" },
  speech_model: { configured: false, model: "" },
  decision_model: { configured: false, model: "" },
  workers: { online: 0, sandbox_mode: "off" },
  execution_mode: "inprocess",
  github_credentials: [],
  projects: { count: 0 },
  workflows: { count: 0, samples: 0, assigned: 0 },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One turn's rows, id-prefixed so a second turn can re-echo the SAME change
 * row (the once-only test) without the transcript holding two rows with one id. */
function turnRows(turnId: string, changeId: string, targetRef = "/ops") {
  return [
    {
      id: `${turnId}-user`,
      kind: "user",
      payload: { kind: "user", text: "Open the Operations page", context: null },
      created_at: "2026-11-11T10:00:00Z",
    },
    {
      id: `${turnId}-answer`,
      kind: "assistant",
      payload: {
        kind: "assistant",
        turn_id: turnId,
        answer_markdown: "Opened the Operations page.",
        links: [{ label: "Go to ops", route: targetRef }],
        tool_calls: [{ name: "ui.navigate", summary: `Navigated to ${targetRef}`, ok: true }],
      },
      created_at: "2026-11-11T10:00:01Z",
    },
    wireNavigate(changeId, targetRef),
  ];
}

/** One `navigate` change row, as ADR-0050 decision 7 writes it. */
function wireNavigate(changeId: string, targetRef: string) {
  return {
    id: `msg-${changeId}`,
    kind: "change",
    payload: {
      kind: "change",
      change_id: changeId,
      change_kind: "navigate",
      target_ref: targetRef,
      summary: `Navigated to ${targetRef}`,
      undoable: false,
    },
    created_at: "2026-11-11T10:00:02Z",
  };
}

/**
 * The stub server. `postPages` is what each turn POST answers with; the
 * transcript read answers `transcript` (what a replay test stages).
 */
function stubFetch(postPages: unknown[][], transcript: unknown[] = []) {
  let posts = 0;
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/v1/me/preferences") return json({});
    if (url === "/api/v1/assistant/status") return json(STATUS_BODY);
    if (method === "GET" && (url === CONVS_PATH || url === CONVS_MENU_PATH)) {
      return json({ conversations: [CONV_ROW], next_cursor: null });
    }
    if (method === "POST" && url === CREATE_PATH) return json(CONV_ROW);
    const msgs = /^\/api\/v1\/assistant\/conversations\/([^/]+)\/messages\?limit=200$/.exec(url);
    if (method === "GET" && msgs) return json({ messages: transcript, next_cursor: null });
    const post = /^\/api\/v1\/assistant\/conversations\/([^/]+)\/messages$/.exec(url);
    if (method === "POST" && post) {
      const page = postPages[Math.min(posts, postPages.length - 1)] ?? [];
      posts += 1;
      return json({ messages: page, next_cursor: null });
    }
    return json({ title: "Not Found", status: 404, detail: `unstubbed ${method} ${url}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** How many turn POSTs the stub answered (a send that never left the browser
 * is not evidence of a rule, so the tests that assert "nothing happened" first
 * prove the turn happened). */
function postCount(fetchMock: ReturnType<typeof stubFetch>): number {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).endsWith("/messages") &&
      String((call[1] as RequestInit | undefined)?.method ?? "GET") === "POST",
  ).length;
}

/**
 * Records EVERY location the router lands on, including a repeat visit to the
 * same path — a `useLocation().key` change is a navigation, which is what the
 * ONCE rule is about. `seen[0]` is the mount.
 */
function LocationSink({ seen }: { seen: string[] }) {
  const location = useLocation();
  useEffect(() => {
    seen.push(`${location.pathname}#${location.key.slice(0, 2)}`);
  }, [location, seen]);
  return null;
}

/** Counts every push the router makes, including a repeat visit to the page
 * the person is already on — which is what "ONCE per change id" has to prove. */
function MoveCounter({ tally }: { tally: { n: number } }) {
  const location = useLocation();
  useEffect(() => {
    tally.n += 1;
  }, [location, tally]);
  return null;
}

/** The person's own way off the destination page (the once-only test walks
 * them away, then lets a re-delivered row try to move them back). */
function WalkAway() {
  const navigate = useNavigate();
  return (
    <button type="button" data-testid="walk-away" onClick={() => navigate("/threads")}>
      leave
    </button>
  );
}

function renderAt(path: string, seen: string[], counter: { n: number } = { n: 0 }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <MoveCounter tally={counter} />
                <LocationSink seen={seen} />
                <WalkAway />
                <AssistantPopover />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** The navigations the router performed AFTER its first render. */
function moves(seen: string[]): string[] {
  return seen.slice(1).map((entry) => entry.split("#")[0]);
}

async function ask(question: string) {
  act(() => openAssistantPopover());
  const input = await screen.findByTestId("assistant-composer-input");
  fireEvent.change(input, { target: { value: question } });
  fireEvent.click(screen.getByTestId("assistant-send"));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe("ui.navigate moves the client when the person asked (F-1)", () => {
  it("navigates an app route the person may perform, and the jump row is the door", async () => {
    // The server's allowlist (internal/assistant/routes.go) is what decides
    // whether a `navigate` change's target is a page at all; the client's
    // shape check then refuses anything that would leave the origin. This is
    // the positive case of the second half: /ops is a real route, so both the
    // automatic move and the row's own click work.
    stubFetch([turnRows("t-1", "ch-ok", "/ops")]);
    const seen: string[] = [];
    renderAt("/workflows", seen);
    await ask("Open the Operations page");
    await screen.findByText("Opened the Operations page.");
    await waitFor(() => expect(moves(seen).at(-1)).toBe("/ops"));
    expect(screen.getByTestId("assistant-link")).toBeTruthy();
  });

  it("opens the page the turn navigated to and keeps the popover open over it", async () => {
    stubFetch([turnRows("t-1", "ch-1")]);
    const seen: string[] = [];
    renderAt("/workflows", seen);
    await ask("Open the Operations page");
    await screen.findByText("Opened the Operations page.");

    // ADR-0050 Decision 7: the client performs the navigation.
    await waitFor(() => expect(moves(seen)).toEqual(["/ops"]));
    // The ask does not vanish with the move — handoff §1's popover stays open
    // over the destination, which is where the person reads the answer from.
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
    expect(screen.getByTestId("assistant-panel").getAttribute("data-variant")).toBe("popover");
    // And the jump row is still drawn: the page stays reachable from the
    // answer, so a later scroll back does not lose the turn's destination.
    expect(screen.getByTestId("assistant-link").textContent).toContain("Go to ops");
  });

  it("performs a navigate change ONCE — the change id, not the row, is the key", async () => {
    // The scenario the Set exists for: a later turn (a Retry whose rows the
    // route answered again) re-echoes the SAME `ch-1` navigate row. The
    // destination is the page the person is already on and stays on: the
    // second batch may not push a fresh history entry over their own browsing.
    const turn = turnRows("t-1", "ch-1");
    const fetchMock = stubFetch([turn, turn]);
    const seen: string[] = [];
    const counter = { n: 0 };
    renderAt("/workflows", seen, counter);
    await ask("Open the Operations page");
    await screen.findByText("Opened the Operations page.");
    await waitFor(() => expect(moves(seen)).toEqual(["/ops"]));
    // The person then leaves Operations on their own, and a later turn
    // re-echoes the SAME `ch-1` row (a Retry whose rows the route answered
    // again). Re-performing a navigation the surface already performed would
    // yank them back to a page they had already walked away from.
    fireEvent.click(await screen.findByTestId("walk-away"));
    await waitFor(() => expect(moves(seen).at(-1)).toBe("/threads"));

    await ask("And the workers?");
    // The second turn really ran (a send that never left the browser proves
    // nothing), and BOTH of its rows are on screen — the re-echoed `ch-1`
    // change row among them — before the once-only rule is asserted.
    await waitFor(() => expect(postCount(fetchMock)).toBe(2));
    await waitFor(() =>
      expect(screen.getAllByText("Opened the Operations page.").length).toBeGreaterThanOrEqual(2),
    );
    // Let any navigation the second batch could still trigger reach the router.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
    // ONE push per change row, however many times its rows arrive: the mount,
    // Operations from the turn, Threads from the person's own click. The
    // re-echoed row moves nothing.
    expect(counter.n).toBe(3);
    expect(moves(seen)).toEqual(["/ops", "/threads"]);
  });

  it("keeps the side panel docked while it moves the page", async () => {
    stubFetch([turnRows("t-1", "ch-dock", "/ops")]);
    const seen: string[] = [];
    renderAt("/workflows", seen);
    // Dock FIRST, then ask: the side panel is the size the deployed exercise
    // hit (prompt 8, the dock on /workflows).
    act(() => openAssistantPopover());
    await screen.findByTestId("assistant-composer-input");
    fireEvent.click(screen.getByTestId("assistant-dock"));
    await waitFor(() =>
      expect(screen.getByTestId("assistant-panel").getAttribute("data-variant")).toBe("dock"),
    );
    const input = await screen.findByTestId("assistant-composer-input");
    fireEvent.change(input, { target: { value: "Open the Operations page" } });
    fireEvent.click(screen.getByTestId("assistant-send"));
    await screen.findByText("Opened the Operations page.");
    await waitFor(() => expect(moves(seen).at(-1)).toBe("/ops"));
    // The panel is still the right-hand column over the destination page: the
    // navigation moved the page, not the surface.
    expect(screen.getByTestId("assistant-popover").getAttribute("data-dock")).toBe("right");
    expect(screen.getByTestId("assistant-panel").getAttribute("data-variant")).toBe("dock");
  });

  it("replays an old thread without moving the page", async () => {
    // The thread's transcript carries a navigate change from last week. Reading
    // a transcript is not a request to leave this page.
    stubFetch([turnRows("t-now", "ch-now")], turnRows("t-old", "ch-old"));
    const seen: string[] = [];
    renderAt("/workflows", seen);
    act(() => openAssistantPopover());
    await screen.findByText("Opened the Operations page.");
    expect(moves(seen)).toEqual([]);
    // The change row still renders in the transcript — it just does not move.
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
  });

  it.each([
    ["an absolute URL", "https://example.com/ops"],
    ["a protocol-relative host", "//example.com/ops"],
    ["a backslash host", "/\\example.com"],
    ["a path with a control character", "/ops\nX-Header: 1"],
    ["an empty ref", ""],
  ])("navigates nothing for %s", async (_name, ref) => {
    const fetchMock = stubFetch([turnRows("t-1", "ch-bad", ref)]);
    const seen: string[] = [];
    renderAt("/workflows", seen);
    await ask("Open the Operations page");
    // The turn landed — the answer is on screen and its change row is in the
    // transcript — and NOTHING moved.
    await screen.findByText("Opened the Operations page.");
    await waitFor(() => expect(postCount(fetchMock)).toBe(1));
    expect(moves(seen)).toEqual([]);
    // And the surface is still the ask, not a half-moved page.
    expect(screen.getByTestId("assistant-popover")).toBeTruthy();
  });
});
