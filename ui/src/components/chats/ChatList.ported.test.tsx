/**
 * Behaviours ported off the `/threads` list page (`pages/Threads.test.tsx`,
 * `pages/ProjectConversations.test.tsx`, `pages/ThreadsSwitch.test.tsx`,
 * `components/threads/ThreadListPane.test.tsx`) onto its replacement,
 * `components/chats/ChatList.tsx`.
 *
 * The old page's own chrome (its page band, the LIVE / EARLIER shelves, the
 * filter chips, the 320px pane geometry, the at-rest "No thread selected"
 * column) is retired in the redesign; what a person still does here — search,
 * read the served preview line, walk the keyset page, retry a failed read,
 * warm a row by hovering it — is asserted against the ids the NEW component
 * defines (`chat-row-*`, `chat-search`, `chat-list-error`, `chat-load-more`).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatList } from "./ChatList";
import type { ConversationSummary } from "../../api/types";
import {
  claudeProfile,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChatList(routes: RouteStub[], scope: string | null = null) {
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ChatList scope={scope} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

function crossRoutes(items: ConversationSummary[]): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: "/api/v1/conversations", body: { items, next_cursor: null } },
  ];
}

const manualRow = conversationSummaryFixture;

/** The row's preview line — the second block the row draws, under its title. */
function rowPreview(row: HTMLElement): HTMLElement {
  return row.lastElementChild as HTMLElement;
}

/** An EARLIER-ish row from a run, owned by somebody else. */
const runRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a91-9999-7000-8000-abcdef999999",
  title: "Review loop for the release run",
  origin: "run",
  status: "idle",
  has_active_turn: false,
  agent_connected: false,
  created_by: "01987a62-2345-7000-8000-abcdef012345",
  created_by_display_name: "Dana Observer",
  updated_at: "2026-10-14T18:20:00Z",
};

describe("ChatList (ported from the /threads list page)", () => {
  it("lists every chat with the agent's served last line beside its author, and none when the wire serves none", async () => {
    const withLine: ConversationSummary = {
      ...manualRow,
      id: "01987a93-bbbb-7000-8000-abcdefbbbbbb",
      title: "Explain the refund webhook",
      repository_id: "01987a93-1234-7000-8000-abcdef123456",
      repository_name: "communication",
      last_agent_line: "Pushed the fix; CI is green now.",
    };
    const silent: ConversationSummary = {
      ...manualRow,
      id: "01987a93-cccc-7000-8000-abcdefcccccc",
      title: "Quiet thread",
      repository_id: null,
      repository_name: null,
      last_agent_line: null,
    };
    renderChatList(crossRoutes([withLine, silent, manualRow]));

    const row = await screen.findByTestId(`chat-row-${withLine.id}`);
    // The served line is the agent's own text, prefixed by the profile name
    // the directory resolves — never invented.
    expect(row.textContent).toContain("Claude Code: Pushed the fix; CI is green now.");
    // The old row's `project / repo · agent` meta line is gone by design (the
    // project is the group header, the scope lives in the thread header); the
    // row itself names no repository.
    expect(row.textContent).not.toContain("communication");

    // A silent agent keeps no preview line at all.
    const silentRow = await screen.findByTestId(`chat-row-${silent.id}`);
    expect(silentRow.textContent).toBe(silent.title);
  });

  it("keeps a run-origin row's worded title and its one-line preview", async () => {
    const legacyRunRow: ConversationSummary = {
      ...conversationSummaryFixture,
      id: "01987a63-3333-7000-8000-abcdef000003",
      title: "run 01a1a4f5 /plan attempt 1",
      status: "idle",
      origin: "run",
      last_agent_line: "structured output",
      run_link: {
        run_id: "01a1a4f5-bbbb-7000-8000-abcdef000003",
        node_execution_id: "01987a80-cccc-7000-8000-abcdef000003",
        node_instance_key: "/plan",
        node_id: "plan",
        attempt_id: "01987a80-dddd-7000-8000-abcdef000003",
        attempt_number: 1,
      },
    };
    const newlineRow: ConversationSummary = {
      ...conversationSummaryFixture,
      id: "01987a63-4444-7000-8000-abcdef000004",
      title: "run 01a1a58e /build_until_verified[1]/code_review attempt 1",
      status: "idle",
      origin: "run",
      last_agent_line: "Fix hello.py so it is documented.\n- Keep the API stable",
      run_link: {
        run_id: "01a1a58e-eeee-7000-8000-abcdef000004",
        node_execution_id: "01987a80-ffff-7000-8000-abcdef000004",
        node_instance_key: "/build_until_verified[1]/code_review",
        node_id: "code_review",
        attempt_id: "01987a80-1111-7000-8000-abcdef000004",
        attempt_number: 1,
      },
    };
    renderChatList(crossRoutes([legacyRunRow, newlineRow]));

    // Round-16: a row the server still named in raw ids reads in words.
    const row = await screen.findByTestId(`chat-row-${legacyRunRow.id}`);
    expect(row.textContent).toContain("Plan · run #01a1");
    expect(row.textContent).not.toContain(legacyRunRow.title);
    // The structured-output preview prints the served word, never JSON
    // punctuation.
    expect(row.textContent).toContain("structured output");
    expect(row.textContent).not.toContain("]}}");

    // A preview the wire serves with a newline still stands as ONE line: the
    // preview block truncates, it never wraps or re-escapes.
    const nested = await screen.findByTestId(`chat-row-${newlineRow.id}`);
    expect(nested.textContent).toContain("Code review · run #01a1");
    const preview = rowPreview(nested);
    expect(preview.className.split(/\s+/)).toContain("truncate");
    expect(preview.textContent).toContain("\n");
    expect(preview.textContent).not.toContain("\\n");
  });

  it("searches titles and says when the loaded page matches nothing", async () => {
    renderChatList(crossRoutes([manualRow, runRow]));

    const search = await screen.findByTestId("chat-search");
    fireEvent.change(search, { target: { value: "refund" } });
    // The client-side narrowing answers per keystroke; nothing here matches.
    expect(await screen.findByTestId("chat-list-empty")).toBeTruthy();
    expect(screen.getByTestId("chat-list-empty").textContent).toBe("No chats match your search.");
    expect(screen.queryByTestId(`chat-row-${manualRow.id}`)).toBeNull();

    fireEvent.change(search, { target: { value: "review loop" } });
    expect(await screen.findByTestId(`chat-row-${runRow.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`chat-row-${manualRow.id}`)).toBeNull();
    expect(screen.queryByTestId("chat-list-empty")).toBeNull();
  });

  it("sends the project-scoped search to the list route as q (ADR-0043)", async () => {
    const scoped: RouteStub[] = [
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
      {
        path: `/api/v1/projects/${projectFixture.id}/conversations`,
        body: { items: [manualRow] },
      },
    ];
    const seen: string[] = [];
    const { fetchMock } = renderChatList(scoped, projectFixture.id);
    const inner = fetchMock.getMockImplementation() as (...args: unknown[]) => Promise<Response>;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input, init);
    });

    const search = await screen.findByTestId("chat-search");
    const row = await screen.findByTestId(`chat-row-${conversationId}`);
    fireEvent.change(search, { target: { value: "Refactor" } });
    // The debounced read is what carries `q`; the row stays while it is typed.
    expect(row).toBeTruthy();
    await waitFor(
      () => {
        expect(seen).toContain(`/api/v1/projects/${projectFixture.id}/conversations?q=Refactor`);
      },
      { timeout: 5_000 },
    );
  });

  it("offers the empty state when the caller has no chats at all", async () => {
    renderChatList(crossRoutes([]));
    const empty = await screen.findByTestId("chat-list-empty");
    expect(empty.textContent).toBe("No chats yet.");
  });

  it("says honestly what a server without the endpoint can not list — ONCE — and retries", async () => {
    const { requests } = renderChatList([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [] } },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    ]);

    // One loud refusal, in the column that failed: the old page's second,
    // contradicting "No thread selected" pane is gone with the pane.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("The chat list could not be loaded.");
    expect(screen.getByTestId("chat-list-error").getAttribute("role")).toBe("alert");
    expect(screen.queryByTestId("chat-list-empty")).toBeNull();
    expect(requests.some((request) => request.url === "/api/v1/conversations")).toBe(true);

    fireEvent.click(screen.getByTestId("chat-list-retry"));
    await waitFor(() =>
      expect(requestsTo(requests, "/api/v1/conversations", "GET").length).toBeGreaterThan(1),
    );
  });

  it("walks the keyset page when the list carries a cursor", async () => {
    const { fetchMock } = renderChatList([
      { path: "/api/v1/me", body: meFixture },
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
      {
        path: "/api/v1/conversations",
        // First page carries the cursor; the walked page carries none.
        body: (call: number) => ({
          items: [manualRow],
          next_cursor: call === 1 ? "cursor-2" : null,
        }),
      },
    ]);

    fireEvent.click(await screen.findByTestId("chat-load-more"));
    await screen.findByTestId("chat-first-page");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=cursor-2"))).toBe(
      true,
    );

    fireEvent.click(screen.getByTestId("chat-first-page"));
    expect(await screen.findByTestId(`chat-row-${manualRow.id}`)).toBeTruthy();
  });

  it("prefetches a row's thread when the pointer enters it (gh-69)", async () => {
    const { requests } = renderChatList(
      crossRoutes([manualRow]).concat({
        path: `/api/v1/conversations/${conversationId}`,
        body: conversationSummaryFixture,
      }),
    );
    const row = await screen.findByTestId(`chat-row-${conversationId}`);
    expect(requestsTo(requests, `/api/v1/conversations/${conversationId}`).length).toBe(0);

    fireEvent.pointerEnter(row);
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/conversations/${conversationId}`).length).toBe(1),
    );
  });
});
