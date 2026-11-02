/**
 * The shell's signed-in chrome (`components/Shell.tsx`) after handoff 2c/3c:
 * the left column is the desktop chrome and there is NO top bar at 1024px and
 * above — the phone strip (hamburger, brand, Ask box) is a *phone* frame that
 * below that width owns the drawer. `New chat` starts things, so it only exists
 * for a member that is actually signed in; the identity row the old bar carried
 * (`user-badge`) sits in the sidebar footer as the account menu trigger; and the
 * Ask placement preference moves the Ask button between the sidebar row and a
 * fixed corner button. The API is mocked at the fetch boundary; the page content
 * under the shell is not the subject here.
 *
 * Which frame mounts is a `matchMedia` question (see `useIsNarrow`), so each
 * test states the viewport it means. jsdom's own `matchMedia` never matches, so
 * the desktop tests need no stub and the phone tests stub the narrow answer.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

/** Answer the shell's narrow query as a `width` px viewport would. */
function stubViewport(width: number): void {
  const narrow = width < 1024;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  }));
}

describe("the shell's New chat follows the session", () => {
  it("shows New chat when a member is signed in", async () => {
    renderApp({ path: "/", routes: signedIn });
    expect(await screen.findByTestId("new-chat", undefined, { timeout: READ_MS })).toBeTruthy();
  });

  it("hides New chat when nobody is signed in", async () => {
    renderApp({ path: "/", routes: notSignedIn });
    // A signed-out visitor sees the sign-in screen only — no sidebar, no app
    // chrome, no New chat — for the deep link they opened.
    await screen.findByTestId("sign-in", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("new-chat")).toBeNull();
  });
});

describe("the sidebar is the whole desktop chrome (2c/3c)", () => {
  it("mounts no top bar at all at desktop width", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    expect(await screen.findByTestId("sidebar", undefined, { timeout: READ_MS })).toBeTruthy();
    // No strip, no hamburger, no header brand: the column owns the left edge.
    expect(screen.queryByTestId("phone-top-strip")).toBeNull();
    expect(screen.queryByTestId("sidebar-open")).toBeNull();
    expect(document.querySelector("header")).toBeNull();
    // The old top app bar's `aria-label="Primary"` header/nav stays gone.
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("shows Today and My chats, and no Board or Inbox rows", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    expect(scope.getByTestId("sidebar-link-home").getAttribute("aria-current")).toBe("page");
    expect(scope.getByTestId("sidebar-link-home").textContent).toContain("Today");
    expect(scope.getByTestId("sidebar-link-threads").textContent).toContain("My chats");
    expect(scope.queryByTestId("sidebar-link-inbox")).toBeNull();
    expect(scope.queryByTestId("sidebar-link-board")).toBeNull();
    // The label the row used to carry is gone from the column, too.
    expect(scope.queryByText("Home", { exact: true })).toBeNull();
  });

  it("renders a page whose route is not a nav row under the same shell", async () => {
    // /inbox is no longer a nav row (it folded into Today), but the route
    // still answers: the shell mounts around it and claims no active row.
    stubViewport(1280);
    renderApp({ path: "/inbox", routes: signedIn });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    expect(
      within(sidebar).getByTestId("sidebar-link-home").getAttribute("aria-current"),
    ).toBeNull();
    expect(screen.queryByTestId("phone-top-strip")).toBeNull();
  });

  it("keeps the identity row the old bar carried, in the sidebar footer", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
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
  });

  it("moves the Ask button to the corner when the placement is floating", async () => {
    stubViewport(1280);
    renderApp({
      path: "/",
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

describe("the phone frame (<1024px) keeps the hamburger and the drawer", () => {
  it("mounts the strip with the palette trigger, never over the page", async () => {
    stubViewport(390);
    renderApp({ path: "/", routes: signedIn });
    const box = await screen.findByTestId("ask-box", undefined, { timeout: READ_MS });
    // The box renders inside the phone strip, next to the drawer button — the
    // one header the phone frame has. At desktop widths the strip does not
    // mount at all and the sidebar's `⌘K` row is the trigger; either way the
    // box cannot cover page content, which is what the pass-2 review saw it do
    // on the run page (over the gate card's decision copy) and on Workflows
    // (over the yaml).
    const header = box.closest("header");
    expect(header).toBeTruthy();
    expect(header!.getAttribute("data-testid")).toBe("phone-top-strip");
    expect(header!.querySelector('[data-testid="sidebar-open"]')).toBeTruthy();
    expect(box.closest('[class*="fixed"]')).toBeNull();
    expect(box.closest("main")).toBeNull();
    // At phone width the desktop column does not mount at all: the only
    // sidebar the phone frame has is the drawer's, and that one arrives on
    // demand (see the drawer test below).
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("opens the drawer, and the drawer shows the EXPANDED sidebar", async () => {
    stubViewport(390);
    renderApp({ path: "/", routes: signedIn });
    const open = await screen.findByTestId("sidebar-open", undefined, { timeout: READ_MS });
    // Nothing stands over the page until the hamburger is pressed.
    expect(screen.queryByTestId("sidebar-close")).toBeNull();
    fireEvent.click(open);
    const drawer = await screen.findByTestId("sidebar-close", undefined, { timeout: READ_MS });
    // One column, not two: the phone frame owns the whole width.
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
    const column = drawer.closest('[data-testid="sidebar"]') as HTMLElement;
    // The rail is a desktop affordance: the phone drawer is the 220px column,
    // labels and all.
    expect(within(column).getByTestId("new-chat")).toBeTruthy();
    expect(within(column).getByText("My chats")).toBeTruthy();
    expect(within(column).queryByTestId("sidebar-expand")).toBeNull();
    expect(screen.getByTestId("sidebar-backdrop")).toBeTruthy();
    // Esc closes it and the keyboard goes back to the button that opened it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("sidebar-close")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });

  it("wraps the strip's brand in a non-selectable, non-draggable link (issue #61)", async () => {
    stubViewport(390);
    renderApp({ path: "/", routes: signedIn });
    const header = await screen.findByTestId("phone-top-strip", undefined, { timeout: READ_MS });
    const brand = within(header).getByTestId("brand-home");
    expect(brand.tagName).toBe("A");
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.getAttribute("draggable")).toBe("false");
    expect(brand.className).toContain("select-none");
    expect(brand.textContent).toContain("Communication");
    const mark = within(brand).getByRole("img", { name: "Communication" });
    expect(mark.className).toContain("select-none");
    expect(mark.getAttribute("draggable")).toBe("false");
  });
});
