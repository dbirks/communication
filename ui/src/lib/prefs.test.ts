/**
 * Preferences client (contract C2): snake ⇄ camel mapping, optimistic
 * updates, the 404 degradation (`saved: false` + in-memory for the session)
 * and the exact PATCH bodies the server expects.
 *
 * Redesign finding 10 cut `projectsMode`, `askPlacement` and
 * `showWorkflowFolders`; the tests that drove them now drive the one layout
 * preference that survived (`sidebarCollapsed`) plus `expanded`, and one test
 * pins that a document SAVED before the cut — with all three removed keys in
 * it — still reads back clean.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { setCsrfToken } from "../api/client";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import {
  DEFAULT_LAYOUT_PREFS,
  DEFAULT_TRUST_LEVEL,
  parsePreferences,
  preferencesQueryKey,
  SIDEBAR_COLLAPSED_KEY,
  useAssistantPrefs,
  useLayoutPrefs,
} from "./prefs";

const PREFERENCES_PATH = "/api/v1/me/preferences";

/** A document as the server stored it BEFORE finding 10 cut three settings:
 * every read below must ignore the removed keys rather than trip on them. */
const OLD_DOCUMENT = {
  layout: {
    projects_mode: "switcher",
    ask_placement: "floating",
    show_workflow_folders: false,
    expanded: { p1: true, p2: false },
  },
  assistant: { trust_level: "ask_all" },
  updated_at: "2026-02-12T10:00:00Z",
};

const SAVED_DOCUMENT = OLD_DOCUMENT;

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

function harness(routes: RouteStub[]) {
  const { fetchMock, requests } = mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { fetchMock, requests, queryClient, wrapper };
}

describe("useLayoutPrefs", () => {
  it("maps a saved document from snake_case to camelCase", async () => {
    const { wrapper } = harness([{ path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT }]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs.expanded.p1).toBe(true));
    expect(result.current.saved).toBe(true);
    // Finding 10: the document still carries `projects_mode`, `ask_placement`
    // and `show_workflow_folders`, and the read IGNORES them — the client's
    // layout is exactly the two things the app still has a say about.
    expect(result.current.prefs).toEqual({
      sidebarCollapsed: false,
      expanded: { p1: true, p2: false },
    });
  });

  // Handoff 2c/3c: the rail's state is a layout preference. It rides the
  // `expanded` map the server already stores (a new `layout` member is a 400),
  // and callers read it as `sidebarCollapsed`.
  it("reads the collapsed rail back from the saved `sidebar:collapsed` key", async () => {
    const { wrapper } = harness([
      {
        path: PREFERENCES_PATH,
        method: "GET",
        body: {
          ...SAVED_DOCUMENT,
          layout: {
            ...SAVED_DOCUMENT.layout,
            expanded: { ...SAVED_DOCUMENT.layout.expanded, [SIDEBAR_COLLAPSED_KEY]: true },
          },
        },
      },
    ]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs.sidebarCollapsed).toBe(true));
  });

  it("persists a collapse as the `sidebar:collapsed` key of the layout PATCH", async () => {
    const { requests, wrapper } = harness([
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: {
          ...SAVED_DOCUMENT,
          layout: {
            ...SAVED_DOCUMENT.layout,
            expanded: { ...SAVED_DOCUMENT.layout.expanded, [SIDEBAR_COLLAPSED_KEY]: true },
          },
        },
      },
    ]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs.expanded.p1).toBe(true));

    act(() => {
      result.current.update({ sidebarCollapsed: true });
    });
    // Optimistic, and no `sidebar_collapsed` member invented on the wire.
    await waitFor(() => expect(result.current.prefs.sidebarCollapsed).toBe(true));
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const sent = JSON.parse(requestsTo(requests, PREFERENCES_PATH, "PATCH")[0].body ?? "{}");
    // The rail's key is what the server stores, and it carries `true` only.
    expect(sent.layout.expanded[SIDEBAR_COLLAPSED_KEY]).toBe(true);
    expect(sent.layout.sidebar_collapsed).toBeUndefined();
    // The PATCH answer carries the key: the value stays after the settle, and
    // it is not also reported inside `expanded`.
    await waitFor(() => expect(result.current.prefs.sidebarCollapsed).toBe(true));
    expect(result.current.prefs.expanded).toEqual({ p1: true, p2: false });

    // Expanding overwrites the stored key with `false` (the server merges the
    // map key by key and never deletes, so absence would leave the rail stuck).
    act(() => {
      result.current.update({ sidebarCollapsed: false });
    });
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(2));
    const back = JSON.parse(requestsTo(requests, PREFERENCES_PATH, "PATCH")[1].body ?? "{}");
    expect(back.layout.expanded[SIDEBAR_COLLAPSED_KEY]).toBe(false);
  });

  it("degrades to defaults with saved=false when the server lacks the endpoint (404)", async () => {
    const { requests, wrapper } = harness([]); // no stub → 404
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.saved).toBe(false));
    expect(result.current.prefs).toEqual({
      ...DEFAULT_LAYOUT_PREFS,
      expanded: {},
    });
    expect(requestsTo(requests, PREFERENCES_PATH, "GET")).toHaveLength(1);
  });

  it("updates optimistically and PATCHes the layout section in snake_case", async () => {
    const { requests, wrapper } = harness([
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: { ...SAVED_DOCUMENT, layout: { ...SAVED_DOCUMENT.layout, expanded: { p1: false } } },
      },
    ]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs.expanded.p1).toBe(true));
    setCsrfToken(meFixture.csrf_token);

    act(() => {
      result.current.update({ expanded: { p1: false } });
    });
    // Optimistic: the change is visible as soon as the cache lands.
    await waitFor(() => expect(result.current.prefs.expanded.p1).toBe(false));

    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const [patch] = requestsTo(requests, PREFERENCES_PATH, "PATCH");
    // Finding 10: a layout write carries `expanded` and nothing else. The
    // server deep-merges per member, so the three stored values no client
    // reads stay exactly as they were — no new wire fields, no server change.
    expect(JSON.parse(patch.body ?? "{}")).toEqual({
      layout: {
        expanded: { p1: false },
      },
    });
    expect(patch.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
  });

  it("keeps a change in memory for the session when the endpoint is a 404", async () => {
    const { requests, queryClient, wrapper } = harness([]); // no stub → 404
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.saved).toBe(false));

    act(() => {
      result.current.update({ sidebarCollapsed: true });
    });
    await waitFor(() => expect(result.current.prefs.sidebarCollapsed).toBe(true));

    // A stale re-fetch hits the same 404 and must not wipe the change.
    queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "GET")).toHaveLength(2));
    expect(result.current.saved).toBe(false);
    expect(result.current.prefs.sidebarCollapsed).toBe(true);
  });

  // The sidebar auto-expands the project the route is inside without being
  // asked. That write must not start before `loaded`: an optimistic write makes
  // the in-flight GET look stale, and the saved document would be dropped.
  it("reports loaded only once the document has been read", async () => {
    const { wrapper } = harness([{ path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT }]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    expect(result.current.loaded).toBe(false);
    await waitFor(() => expect(result.current.loaded).toBe(true));
  });

  it("reports loaded when the endpoint is a 404 (the in-memory document answered)", async () => {
    const { wrapper } = harness([]); // no stub → 404
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.saved).toBe(false);
  });

  it("does not let a slow GET clobber a change made while it was in flight", async () => {
    // The never-saved document the late GET will carry: no expansion keys.
    const STALE = {
      layout: {
        projects_mode: "tree",
        ask_placement: "sidebar",
        show_workflow_folders: true,
        expanded: {},
      },
      assistant: { trust_level: "ask_risky" },
      updated_at: null,
    };
    const getStub: RouteStub = { path: PREFERENCES_PATH, method: "GET", body: STALE };
    const SAVED = {
      ...STALE,
      layout: { ...STALE.layout, expanded: { "project:abc": true } },
      updated_at: "2026-10-21T07:00:00Z",
    };
    const { fetchMock, requests, queryClient, wrapper } = harness([
      getStub,
      { path: PREFERENCES_PATH, method: "PATCH", body: SAVED },
    ]);

    // Gate the first GET behind a promise so the local change lands while
    // it is still in flight — the e2e race it guards against.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = fetchMock.getMockImplementation() as (
      input: unknown,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementationOnce(async (input: unknown, init?: RequestInit) => {
      await gate;
      return original(input, init);
    });

    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    act(() => {
      result.current.update({ expanded: { "project:abc": true } });
    });
    await waitFor(() => expect(result.current.prefs.expanded["project:abc"]).toBe(true));

    // The slow GET now resolves with the pre-change document: the change
    // (and the PATCH's answer) must keep winning.
    release();
    await waitFor(() => expect(result.current.prefs.expanded["project:abc"]).toBe(true));

    // A fresh fetch started after the change applies the saved document.
    getStub.body = SAVED;
    queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "GET")).toHaveLength(2));
    expect(result.current.prefs.expanded["project:abc"]).toBe(true);
  });
});

describe("useAssistantPrefs", () => {
  it("PATCHes the assistant section only, and applies optimistically", async () => {
    const { requests, wrapper } = harness([
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: { ...SAVED_DOCUMENT, assistant: { trust_level: "no_ask" } },
      },
    ]);
    const { result } = renderHook(() => useAssistantPrefs(), { wrapper });
    await waitFor(() => expect(result.current.trustLevel).toBe("ask_all"));

    act(() => {
      result.current.setTrustLevel("no_ask");
    });
    await waitFor(() => expect(result.current.trustLevel).toBe("no_ask"));

    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const [patch] = requestsTo(requests, PREFERENCES_PATH, "PATCH");
    expect(JSON.parse(patch.body ?? "{}")).toEqual({
      assistant: { trust_level: "no_ask" },
    });
  });

  it("defaults to ask_risky when the endpoint is a 404", async () => {
    const { wrapper } = harness([]);
    const { result } = renderHook(() => useAssistantPrefs(), { wrapper });
    await waitFor(() => expect(result.current.saved).toBe(false));
    expect(result.current.trustLevel).toBe(DEFAULT_TRUST_LEVEL);
  });
});

describe("parsePreferences", () => {
  it("falls back to the defaults for unknown values", () => {
    const state = parsePreferences({
      layout: {
        projects_mode: "bogus",
        ask_placement: "middle",
        show_workflow_folders: "yes" as unknown as boolean,
        expanded: { a: true, b: "nope" },
      },
      assistant: { trust_level: "sometimes" },
      updated_at: 42,
    });
    expect(state.layout.sidebarCollapsed).toBe(DEFAULT_LAYOUT_PREFS.sidebarCollapsed);
    expect(state.layout.expanded).toEqual({ a: true });
    expect(state.trustLevel).toBe(DEFAULT_TRUST_LEVEL);
    expect(state.updatedAt).toBeNull();
  });

  // Finding 10: the settings were cut client-side, not on the wire — the
  // server still answers with them (they are part of its closed `layout`
  // object, and dropping them is an API change needing its own ADR). Reading
  // an old document, from the server copy or a cached blob, must not error and
  // must not put a removed key back into what callers see.
  it("reads a document saved before the three settings were cut", () => {
    const state = parsePreferences(OLD_DOCUMENT);
    expect(state.layout).toEqual({
      sidebarCollapsed: false,
      expanded: { p1: true, p2: false },
    });
    expect(state.trustLevel).toBe("ask_all");
    expect(state.updatedAt).toBe("2026-02-12T10:00:00Z");
  });
});
