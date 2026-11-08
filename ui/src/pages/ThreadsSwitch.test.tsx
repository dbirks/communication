/**
 * gh-69 regression: switching threads keeps the layout stable.
 *
 * The reported defect: the FIRST click on a run in the threads view flashed
 * part of the page (a different part for another run) — the route answer
 * replaced the whole painted screen with a one-line `Loading conversation…`
 * spinner while its read was cold, and returning to an opened thread was
 * smooth only because the query cache made the wait invisible. These tests
 * pin the fixed contract:
 *
 * 1. a cold open keeps the two-pane frame (the list pane stays on screen with
 *    its rows, the thread column holds a same-size spinner) — the spinner may
 *    never be the only thing the column shows;
 * 2. switching from an already-loaded thread keeps THAT thread painted while
 *    the next one loads (`placeholderData: keepPreviousData`): no fallback
 *    text appears between the two threads at all;
 * 3. a pointer entering a row prefetches that thread's detail read, so the
 *    click usually does not wait on the network in the first place.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useRun } from "../api/runs";
import { RouteErrorBoundary } from "../components/RouteErrorBoundary";
import type { Conversation, ConversationSummary } from "../api/types";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type FetchMock,
  type RouteStub,
} from "../test/fakes";

/** A second thread, so a click can move from one open thread to another. */
const secondId = "01987a99-9999-7000-8000-abcdef999999";
const second: Conversation = { ...conversationFixture, id: secondId, title: "Second thread" };
const secondRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: secondId,
  title: "Second thread",
};

function baseRoutes(): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: [claudeProfile] } },
    {
      path: "/api/v1/conversations",
      method: "GET",
      body: { items: [conversationSummaryFixture, secondRow], next_cursor: null },
    },
    {
      path: `/api/v1/conversations/${conversationId}`,
      method: "GET",
      body: conversationFixture,
    },
    { path: `/api/v1/conversations/${secondId}`, method: "GET", body: second },
    {
      path: `/api/v1/projects/${projectFixture.id}`,
      method: "GET",
      body: projectFixture,
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/workspaces`,
      method: "GET",
      body: { workspaces: [] },
    },
    {
      path: `/api/v1/projects/${projectFixture.id}/artifacts`,
      method: "GET",
      body: { artifacts: [] },
    },
  ];
}

/**
 * Hold every request to `urlPart` until `release()` is called — the pending
 * read the defect used to flash through. Returns the release for one held
 * call at a time.
 */
function gateRequests(fetchMock: FetchMock, urlPart: string): () => void {
  const original = fetchMock.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
  const waiting: Array<() => void> = [];
  fetchMock.mockImplementation((...args: unknown[]) => {
    const url = typeof args[0] === "string" ? args[0] : String(args[0]);
    // Call the original first: it records the request synchronously, so a
    // gated request is visible to `requestsTo` while its response is held.
    const response = original(...args);
    if (url.includes(urlPart)) {
      return new Promise<Response>((release) => waiting.push(() => release(response)));
    }
    return response;
  });
  return () => waiting.shift()?.();
}

describe("gh-69: switching threads never replaces the painted screen", () => {
  it("keeps the two-pane frame (list pane + rows) up while a cold thread loads", async () => {
    const { fetchMock } = renderApp({ path: "/threads", routes: baseRoutes() });
    await screen.findByTestId(`thread-row-${conversationId}`);
    const release = gateRequests(fetchMock, `/api/v1/conversations/${secondId}`);
    fireEvent.click(screen.getByTestId(`thread-row-${secondId}`));

    // The old answer: main collapsed to one `Loading conversation…` line and
    // the list pane unmounted. The fixed answer: the same screen silhouette —
    // the pane is still the pane, its rows still listed, and the pending line
    // sits INSIDE the full-size thread column.
    // The spinner sits INSIDE the full-size column (`· Loading thread…`
    // is the announced Spinner's whole line, dots included).
    expect(screen.getByTestId("threads-view")).toBeTruthy();
    expect(screen.getByTestId("threads-detail-column").textContent).toContain("Loading thread");
    expect(screen.getByTestId("threads-page")).toBeTruthy();
    expect(screen.getByTestId(`thread-row-${conversationId}`)).toBeTruthy();

    release();
    await waitFor(() =>
      expect(screen.getByTestId("conversation-title").textContent).toBe(second.title),
    );
    // The list never left, and it now marks the row that opened.
    expect(screen.getByTestId("threads-page")).toBeTruthy();
    expect(screen.getByTestId(`thread-row-${secondId}`).getAttribute("aria-current")).toBe("page");
  });

  it("keeps the previously opened thread painted while the next one loads", async () => {
    const { fetchMock, requests } = renderApp({
      path: `/threads/${conversationId}`,
      routes: baseRoutes(),
    });
    await waitFor(() =>
      expect(screen.getByTestId("conversation-title").textContent).toBe(conversationFixture.title),
    );

    const release = gateRequests(fetchMock, `/api/v1/conversations/${secondId}`);
    // Click without hovering: the row's prefetch is not what answers here, the
    // previous read's placeholderData is.
    fireEvent.click(screen.getByTestId(`thread-row-${secondId}`));

    // The request is in flight (the gate holds it; the row was clicked without
    // hovering, so no prefetch answers here — placeholderData does) yet the
    // screen does not change: the previous thread is still painted and no
    // fallback text — the flash — ever appears in the column.
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/conversations/${secondId}`).length).toBe(1),
    );
    expect(screen.getByTestId("conversation-title").textContent).toBe(conversationFixture.title);
    expect(screen.getByTestId("threads-page")).toBeTruthy();
    expect(screen.queryByText("Loading thread")).toBeNull();

    release();
    await waitFor(() =>
      expect(screen.getByTestId("conversation-title").textContent).toBe(second.title),
    );
  });

  it("prefetches a row's thread when the pointer enters it", async () => {
    const { requests } = renderApp({ path: "/threads", routes: baseRoutes() });
    const row = await screen.findByTestId(`thread-row-${secondId}`);
    expect(requestsTo(requests, `/api/v1/conversations/${secondId}`).length).toBe(0);

    fireEvent.pointerEnter(row);

    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/conversations/${secondId}`).length).toBe(1),
    );
  });
});

/**
 * The workbench half of gh-69: the run page moved to another run collapsed to
 * the header's loading line because `useRun` went pending on the key switch.
 * `placeholderData: keepPreviousData` must answer with the previous run while
 * the next one is in flight.
 */
describe("gh-69: useRun keeps the previous run while the next one loads", () => {
  it("answers with the previous run id while the new run's read is pending", async () => {
    const held: { release?: () => void } = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/v1/runs/r-A")) return Response.json({ id: "r-A" });
        if (url.includes("/api/v1/runs/r-B")) {
          await new Promise<void>((release) => {
            held.release = () => release();
          });
          return Response.json({ id: "r-B" });
        }
        return new Response(null, { status: 404 });
      }),
    );
    function Probe() {
      const [id, setId] = useState("r-A");
      const run = useRun(id);
      return (
        <div>
          <button onClick={() => setId("r-B")}>switch</button>
          <span data-testid="state">{run.isPending ? "PENDING" : (run.data?.id ?? "none")}</span>
        </div>
      );
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("r-A"));
    fireEvent.click(screen.getByText("switch"));
    // B is held in flight by the stub; the read still answers with A, so the
    // already-painted workbench stays on screen instead of the loading line.
    expect(screen.getByTestId("state").textContent).toBe("r-A");
    held.release?.();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("r-B"));
  });
});

/**
 * The other half of the gh-69 remount: `Shell` used to key the content
 * subtree by pathname, so EVERY path change — even `/threads/a` to
 * `/threads/b` — threw away the mounted page. The boundary now clears a
 * caught crash through `resetKey` and must never remount a healthy route.
 */
describe("gh-69: the route error boundary resets without remounting", () => {
  it("keeps the mounted page across a resetKey change and clears a crash on the next one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const mounts: string[] = [];
    function Page({ tag, fail }: { tag: string; fail?: boolean }) {
      useEffect(() => {
        mounts.push(tag);
      }, [tag]);
      if (fail) throw new Error("boom on purpose");
      return <span data-testid="page">{tag}</span>;
    }
    const view = (
      <RouteErrorBoundary resetKey="/x/1">
        <Page tag="one" />
      </RouteErrorBoundary>
    );
    const { rerender } = render(view);
    expect(screen.getByTestId("page").textContent).toBe("one");

    // Navigation (the boundary's resetKey changes; children stay identical):
    // the page component instance must survive — no remount flash.
    rerender(
      <RouteErrorBoundary resetKey="/x/2">
        <Page tag="one" />
      </RouteErrorBoundary>,
    );
    expect(mounts).toEqual(["one"]);
    expect(screen.queryByTestId("route-error-boundary")).toBeNull();

    // A crash still surfaces as the banner…
    rerender(
      <RouteErrorBoundary resetKey="/x/3">
        <Page tag="one" fail />
      </RouteErrorBoundary>,
    );
    expect(screen.getByTestId("route-error-boundary").textContent).toContain("boom");

    // …and the NEXT navigation clears it (the property the pathname `key`
    // used to buy by remounting everything).
    rerender(
      <RouteErrorBoundary resetKey="/x/4">
        <Page tag="two" />
      </RouteErrorBoundary>,
    );
    expect(screen.queryByTestId("route-error-boundary")).toBeNull();
    expect(screen.getByTestId("page").textContent).toBe("two");
    expect(mounts).toEqual(["one", "two"]);
    spy.mockRestore();
  });
});
