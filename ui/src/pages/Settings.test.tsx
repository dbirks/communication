/**
 * The Settings page (`/settings/:tab`) rendered on its real route: the two
 * tabs, the three layout radio groups with the documented defaults, the
 * trust-level group, and the honest "not saved" state when the server does
 * not store preferences yet (the 404 degradation of contract C2).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../api/client";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../test/fakes";
import Settings from "./Settings";

const PREFERENCES_PATH = "/api/v1/me/preferences";
const CSRF = meFixture.csrf_token;

const SAVED_DOCUMENT = {
  layout: {
    projects_mode: "switcher",
    ask_placement: "floating",
    show_workflow_folders: false,
    expanded: {},
  },
  assistant: { trust_level: "ask_all" },
  updated_at: "2026-02-12T10:00:00Z",
};

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

function mount(path: string, extra: RouteStub[] = []) {
  const { fetchMock, requests } = mockFetch([...extra, { path: "/api/v1/me", body: meFixture }]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/settings/:tab", element: <Settings /> }),
      ),
    ),
  );
  render(tree);
  return { fetchMock, requests };
}

function checked(name: RegExp): boolean {
  return (screen.getByRole("radio", { name }) as HTMLInputElement).checked;
}

describe("Settings page", () => {
  it("shows the H1, both tab links and the Layout tab by default", () => {
    mount("/settings/layout");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
    const layoutTab = screen.getByTestId("settings-tab-layout");
    const assistantTab = screen.getByTestId("settings-tab-assistant");
    expect(layoutTab.getAttribute("href")).toBe("/settings/layout");
    expect(layoutTab.getAttribute("aria-current")).toBe("page");
    expect(assistantTab.getAttribute("href")).toBe("/settings/assistant");
    expect(assistantTab.getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("settings-layout")).toBeTruthy();
  });

  it("renders the Assistant tab on /settings/assistant", () => {
    mount("/settings/assistant");
    expect(screen.getByTestId("settings-assistant")).toBeTruthy();
    expect(screen.queryByTestId("settings-layout")).toBeNull();
    expect(
      screen.getByText("The assistant acts as you, so it can never do more than your role allows."),
    ).toBeTruthy();
  });

  it("treats an unknown tab as the Layout tab", () => {
    mount("/settings/nope");
    expect(screen.getByTestId("settings-layout")).toBeTruthy();
  });
});

describe("Settings → Layout", () => {
  it("checks the documented defaults when nothing is saved (404) and shows the honest note", async () => {
    mount("/settings/layout"); // no stub for the endpoint → 404
    await waitFor(() => expect(screen.queryByTestId("settings-layout-not-saved")).toBeTruthy());
    expect(checked(/All projects as a tree/)).toBe(true);
    expect(checked(/Top of the sidebar/)).toBe(true);
    expect(checked(/Show folders/)).toBe(true);
    expect(screen.getByTestId("settings-layout-chord-k").textContent).toContain(
      "⌘K always opens the assistant",
    );
  });

  it("applies a radio change immediately, PATCHes snake_case with the CSRF header, and clears the note", async () => {
    const { requests } = mount("/settings/layout", [
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: { ...SAVED_DOCUMENT, layout: { ...SAVED_DOCUMENT.layout, projects_mode: "tree" } },
      },
    ]);
    setCsrfToken(CSRF);
    await waitFor(() => expect(checked(/Project switcher/)).toBe(true));
    // A stored document: no honest-not-saved note.
    expect(screen.queryByTestId("settings-layout-not-saved")).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: /All projects as a tree/ }));
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const [patch] = requestsTo(requests, PREFERENCES_PATH, "PATCH");
    expect(JSON.parse(patch.body ?? "{}")).toEqual({
      layout: {
        projects_mode: "tree",
        ask_placement: "floating",
        show_workflow_folders: false,
        expanded: {},
      },
    });
    expect(patch.headers.get("x-csrf-token")).toBe(CSRF);
  });

  it("keeps the change in memory for the session when the endpoint is a 404", async () => {
    mount("/settings/layout"); // no stub → 404
    await waitFor(() => expect(screen.queryByTestId("settings-layout-not-saved")).toBeTruthy());

    fireEvent.click(screen.getByRole("radio", { name: /Project switcher/ }));
    await waitFor(() => expect(checked(/Project switcher/)).toBe(true));
    // The change sticks and the honest note stays.
    const treeOption = screen.getByTestId("settings-layout-projects-mode-option-tree");
    expect(treeOption.className).toContain("border-transparent");
    expect(screen.queryByTestId("settings-layout-not-saved")).toBeTruthy();
  });
});

describe("Settings → Assistant", () => {
  it("defaults to 'Ask for risky actions' with the one-line explanations", async () => {
    mount("/settings/assistant"); // no stub → 404
    await waitFor(() => expect(screen.queryByTestId("settings-assistant-not-saved")).toBeTruthy());
    expect(checked(/Ask for risky actions/)).toBe(true);
    expect(
      screen.getByText(
        "Every tool call that changes state, including navigation, shows a confirm card.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "It can do everything, with each action logged and undo offered where possible.",
      ),
    ).toBeTruthy();
  });

  it("applies a trust-level change immediately and PATCHes only the assistant section", async () => {
    const { requests } = mount("/settings/assistant", [
      { path: PREFERENCES_PATH, method: "GET", body: SAVED_DOCUMENT },
      {
        path: PREFERENCES_PATH,
        method: "PATCH",
        body: { ...SAVED_DOCUMENT, assistant: { trust_level: "no_ask" } },
      },
    ]);
    setCsrfToken(CSRF);
    await waitFor(() => expect(checked(/Ask before everything/)).toBe(true));

    fireEvent.click(screen.getByRole("radio", { name: /Don't ask/ }));
    await waitFor(() => expect(requestsTo(requests, PREFERENCES_PATH, "PATCH")).toHaveLength(1));
    const [patch] = requestsTo(requests, PREFERENCES_PATH, "PATCH");
    expect(JSON.parse(patch.body ?? "{}")).toEqual({ assistant: { trust_level: "no_ask" } });
    expect(patch.headers.get("x-csrf-token")).toBe(CSRF);
  });
});
