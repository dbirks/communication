/**
 * Preferences client (contract C2): snake ⇄ camel mapping, optimistic
 * updates, the 404 degradation (`saved: false` + in-memory for the session)
 * and the exact PATCH bodies the server expects.
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
  useAssistantPrefs,
  useLayoutPrefs,
} from "./prefs";

const PREFERENCES_PATH = "/api/v1/me/preferences";

const SAVED_DOCUMENT = {
  layout: {
    projects_mode: "switcher",
    ask_placement: "floating",
    show_workflow_folders: false,
    expanded: { p1: true, p2: false },
  },
  assistant: { trust_level: "ask_all" },
  updated_at: "2026-02-12T10:00:00Z",
};

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
    await waitFor(() => expect(result.current.prefs.projectsMode).toBe("switcher"));
    expect(result.current.saved).toBe(true);
    expect(result.current.prefs).toEqual({
      projectsMode: "switcher",
      askPlacement: "floating",
      showWorkflowFolders: false,
      expanded: { p1: true, p2: false },
    });
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

  it("updates optimistically and PATCHes the full layout section in snake_case", async () => {
    const { requests, wrapper } = harness([
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: { ...SAVED_DOCUMENT, layout: { ...SAVED_DOCUMENT.layout, projects_mode: "tree" } },
      },
    ]);
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.prefs.projectsMode).toBe("switcher"));
    setCsrfToken(meFixture.csrf_token);

    act(() => {
      result.current.update({ projectsMode: "tree" });
    });
    // Optimistic: the change is visible as soon as the cache lands.
    await waitFor(() => expect(result.current.prefs.projectsMode).toBe("tree"));

    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const [patch] = requestsTo(requests, PREFERENCES_PATH, "PATCH");
    expect(JSON.parse(patch.body ?? "{}")).toEqual({
      layout: {
        projects_mode: "tree",
        ask_placement: "floating",
        show_workflow_folders: false,
        expanded: { p1: true, p2: false },
      },
    });
    expect(patch.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
  });

  it("keeps a change in memory for the session when the endpoint is a 404", async () => {
    const { requests, queryClient, wrapper } = harness([]); // no stub → 404
    const { result } = renderHook(() => useLayoutPrefs(), { wrapper });
    await waitFor(() => expect(result.current.saved).toBe(false));

    act(() => {
      result.current.update({ askPlacement: "floating" });
    });
    await waitFor(() => expect(result.current.prefs.askPlacement).toBe("floating"));

    // A stale re-fetch hits the same 404 and must not wipe the change.
    queryClient.invalidateQueries({ queryKey: preferencesQueryKey });
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "GET")).toHaveLength(2));
    expect(result.current.saved).toBe(false);
    expect(result.current.prefs.askPlacement).toBe("floating");
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
  it("falls back to the defaults for unknown enum values", () => {
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
    expect(state.layout.projectsMode).toBe(DEFAULT_LAYOUT_PREFS.projectsMode);
    expect(state.layout.askPlacement).toBe(DEFAULT_LAYOUT_PREFS.askPlacement);
    expect(state.layout.showWorkflowFolders).toBe(DEFAULT_LAYOUT_PREFS.showWorkflowFolders);
    expect(state.layout.expanded).toEqual({ a: true });
    expect(state.trustLevel).toBe(DEFAULT_TRUST_LEVEL);
    expect(state.updatedAt).toBeNull();
  });
});
