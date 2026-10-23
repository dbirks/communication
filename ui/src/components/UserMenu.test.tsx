/**
 * The sidebar footer's user menu (`components/UserMenu.tsx`): the signed-in
 * user's avatar + name is the menu trigger, and the menu carries Settings,
 * Operations and Sign out. The menu semantics are asserted with the keyboard
 * (open, arrows, Escape → focus returns to the trigger, click-outside closes)
 * and the sign-out writes the real `POST /auth/logout` mutation.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture, projectFixture, requestsTo, type RouteStub } from "../test/fakes";

/** Wait budget for the first round trips the menu's reads wait on. */
const READ_MS = 5_000;

const PREFS_PATH = "/api/v1/me/preferences";

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/pipelines", body: { pipelines: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [] } },
    {
      path: PREFS_PATH,
      method: "GET",
      body: {
        layout: {
          projects_mode: "tree",
          ask_placement: "sidebar",
          show_workflow_folders: true,
          expanded: {},
        },
        assistant: { trust_level: "ask_risky" },
        updated_at: null,
      },
    },
    ...extra,
  ];
}

describe("the sidebar user menu", () => {
  it("opens from the user trigger with Settings, Operations and Sign out, focused on the first item", async () => {
    renderApp({ path: "/", routes: routes() });
    const trigger = await screen.findByTestId("user-menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The always-visible user element keeps the name the e2e signIn waits for.
    expect(screen.getByTestId("user-badge").textContent).toContain("Ada Lovelace");

    fireEvent.click(trigger);
    const menu = await screen.findByTestId("user-menu-list", undefined, { timeout: READ_MS });
    expect(menu.getAttribute("role")).toBe("menu");
    expect(screen.getByTestId("user-menu-settings").textContent).toBe("Settings");
    expect(screen.getByTestId("user-menu-ops").textContent).toBe("Operations");
    expect(screen.getByTestId("sign-out").textContent).toBe("Sign out");
    expect(document.activeElement).toBe(screen.getByTestId("user-menu-settings"));
  });

  it("opens with ArrowDown, moves with the arrows and closes on Escape returning focus to the trigger", async () => {
    renderApp({ path: "/", routes: routes() });
    const trigger = await screen.findByTestId("user-menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const settings = await screen.findByTestId("user-menu-settings", undefined, {
      timeout: READ_MS,
    });
    expect(document.activeElement).toBe(settings);

    // Arrows move between items, with wrap-around.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("user-menu-ops"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("sign-out"));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByTestId("user-menu-settings"));

    // Escape closes and returns focus to the trigger.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("user-menu-list")).toBeNull(), {
      timeout: READ_MS,
    });
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on click outside the menu", async () => {
    renderApp({ path: "/", routes: routes() });
    const trigger = await screen.findByTestId("user-menu");
    fireEvent.click(trigger);
    await screen.findByTestId("user-menu-list", undefined, { timeout: READ_MS });
    expect(screen.getByTestId("user-menu-list")).toBeTruthy();

    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("user-menu-list")).toBeNull(), {
      timeout: READ_MS,
    });
  });

  it("sign out closes the menu, POSTs /auth/logout and leaves for the login page", async () => {
    const { requests } = renderApp({
      path: "/",
      routes: [...routes(), { path: "/auth/logout", method: "POST", status: 204 }],
    });
    const trigger = await screen.findByTestId("user-menu");
    fireEvent.click(trigger);
    const signOut = await screen.findByTestId("sign-out", undefined, { timeout: READ_MS });
    fireEvent.click(signOut);

    await waitFor(() => expect(screen.queryByTestId("user-menu-list")).toBeNull(), {
      timeout: READ_MS,
    });
    const [request] = requestsTo(requests, "/auth/logout", "POST");
    expect(request.method).toBe("POST");
  });
});
