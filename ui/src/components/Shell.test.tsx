/**
 * The shell's signed-in chrome (`components/Shell.tsx`) after the sidebar
 * swap: the "New" menu starts things — a conversation, a workflow, a run — so
 * it only exists for a member that is actually signed in, the identity row
 * the old app bar carried (`user-badge`) now sits in the sidebar footer as
 * the account menu trigger, and the Ask placement preference moves the Ask
 * button between the sidebar row and a fixed corner button. The API is
 * mocked at the fetch boundary; the page content under the shell is not the
 * subject here.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";

/** Wait budget for the `/me` round trip the shell waits on. */
const READ_MS = 5_000;

const signedIn: RouteStub[] = [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: [] } },
];

const notSignedIn: RouteStub[] = [
  {
    path: "/api/v1/me",
    method: "GET",
    status: 401,
    body: {
      type: "https://communication.dev/errors/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "not signed in",
    },
  },
  { path: "/api/v1/projects", body: { items: [] } },
];

describe("the shell's New menu follows the session", () => {
  it("shows the New menu when a member is signed in", async () => {
    renderApp({ path: "/inbox", routes: signedIn });
    expect(await screen.findByTestId("new-menu", undefined, { timeout: READ_MS })).toBeTruthy();
  });

  it("hides the New menu when nobody is signed in", async () => {
    renderApp({ path: "/inbox", routes: notSignedIn });
    // A signed-out visitor sees the sign-in screen only — no sidebar, no app
    // chrome, no New menu — for the deep link they opened.
    await screen.findByTestId("sign-in", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("new-menu")).toBeNull();
  });
});

describe("the sidebar replaces the app bar", () => {
  it("shows the cross-project nav with the current row marked", async () => {
    renderApp({ path: "/inbox", routes: signedIn });
    expect(await screen.findByTestId("sidebar", undefined, { timeout: READ_MS })).toBeTruthy();
    for (const testid of [
      "sidebar-link-home",
      "sidebar-link-inbox",
      "sidebar-link-board",
      "sidebar-link-threads",
    ]) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
    const inboxRow = screen.getByTestId("sidebar-link-inbox");
    expect(inboxRow.getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("sidebar-link-home").getAttribute("aria-current")).toBeNull();
  });

  it("keeps the identity row the old bar carried, in the sidebar footer", async () => {
    renderApp({ path: "/inbox", routes: signedIn });
    const user = await screen.findByTestId("user-badge", undefined, { timeout: READ_MS });
    expect(user.textContent).toContain("Ada Lovelace");
    // The footer now opens the account menu; the sign-out lives in it.
    expect(screen.getByTestId("user-menu")).toBeTruthy();
    fireEvent.click(screen.getByTestId("user-menu"));
    expect(
      await screen.findByTestId("user-menu-list", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
    expect(screen.getByTestId("sign-out")).toBeTruthy();
    // The replica name moved to Settings (the About this server line).
    expect(screen.queryByTestId("replica-badge")).toBeNull();
    // The old bar's primary nav is gone; the top strip's drawer button is not.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.getByTestId("sidebar-open")).toBeTruthy();
  });

  it("moves the Ask button to the corner when the placement is floating", async () => {
    renderApp({
      path: "/inbox",
      routes: [
        ...signedIn,
        {
          path: "/api/v1/me/preferences",
          body: {
            layout: {
              projects_mode: "tree",
              ask_placement: "floating",
              show_workflow_folders: true,
              expanded: {},
            },
            assistant: { trust_level: "ask_risky" },
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
    });
    expect(await screen.findByTestId("ask-float", undefined, { timeout: READ_MS })).toBeTruthy();
    expect(screen.queryByTestId("ask-sidebar")).toBeNull();
  });
});
