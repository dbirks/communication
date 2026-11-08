/**
 * The shell's signed-in chrome (`components/Shell.tsx`) after handoff 2c/3c
 * and finding 07: the left column is the desktop chrome and there is NO top
 * bar at 768px and above — the phone strip (hamburger, brand, Ask box) is a
 * *phone* frame that below 768px owns the drawer. Between 768 and 1023px the
 * collapsed rail is FORCED (the saved preference is not touched); from 1024px
 * up the preference decides between the 220px column and the rail. `New chat`
 * starts things, so it only exists for a member that is actually signed in;
 * the identity row the old bar carried (`user-badge`) sits in the sidebar
 * footer as the account menu trigger; and the Ask placement preference moves
 * the Ask button between the sidebar row and a fixed corner button. The API is
 * mocked at the fetch boundary; the page content under the shell is not the
 * subject here.
 *
 * Which frame mounts is a `matchMedia` question (see `useMediaQuery` /
 * `useIsNarrow`), so each test states the viewport it means; the stub answers
 * the shell's real queries from the width.
 */
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { meFixture, requestsTo, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";
import {
  PHONE_ASK_RESERVE_PX,
  phoneAskReserveCss,
  sectionOf,
  ASK_FAB_SIZE_PHONE_PX,
  ASK_FAB_OFFSET_PHONE_PX,
} from "./Shell";

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

/** Answer the shell's frame queries (phone <768, rail 768–1023) as a
 * `width` px viewport would. */
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

/** Restore jsdom's real `matchMedia` after a `stubViewport` test. Re-stubbing
 * the native function (NOT `vi.unstubAllGlobals()` — that also drops the
 * session-wide `EventSource` stub while the rendered app is still mounted,
 * and a reconnect tick without it throws through the NEXT test). */
const nativeMatchMedia = window.matchMedia;
function restoreViewport(): void {
  vi.stubGlobal("matchMedia", nativeMatchMedia);
}

describe("the shell's New thread follows the session", () => {
  it("shows New thread when a member is signed in", async () => {
    renderApp({ path: "/", routes: signedIn });
    expect(await screen.findByTestId("new-chat", undefined, { timeout: READ_MS })).toBeTruthy();
  });

  it("hides New thread when nobody is signed in", async () => {
    renderApp({ path: "/", routes: notSignedIn });
    // A signed-out visitor sees the sign-in screen only — no sidebar, no app
    // chrome, no New thread — for the deep link they opened.
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

  it("shows Today and Threads, and no Board or Inbox rows", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    const scope = within(sidebar);
    expect(scope.getByTestId("sidebar-link-home").getAttribute("aria-current")).toBe("page");
    expect(scope.getByTestId("sidebar-link-home").textContent).toContain("Today");
    expect(scope.getByTestId("sidebar-link-threads").textContent).toContain("Threads");
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

  // Finding 10 (with finding 08): Ask is ALWAYS the floating bottom-right
  // button — there is no `askPlacement` preference any more, and the sidebar
  // carries the `Search ⌘K` field instead. The button names its own chord.
  it("draws the floating Ask button on every page and no Ask row in the sidebar", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    const fab = await screen.findByTestId("ask-fab", undefined, { timeout: READ_MS });
    expect(fab.textContent).toContain("Ask");
    expect(fab.textContent).toContain("⌘J");
    expect(fab.getAttribute("aria-label")).toBe("Ask the assistant (⌘J)");
    // The primary treatment: accent fill + the 2px offset shadow (`ds-btn`).
    expect(fab.className).toContain("ds-btn--primary");
    expect(screen.queryByTestId("ask-float")).toBeNull();
    expect(screen.queryByTestId("ask-sidebar")).toBeNull();
    // The sidebar's own second entry is Search.
    expect(screen.getByTestId("sidebar-search")).toBeTruthy();
  });

  // Finding 08: ⌘J opens Ask; the old first-⌘K-opens-the-assistant toggle
  // (ADR-0050) is gone — ⌘K opens the jump palette and never the assistant.
  it("⌘J opens Ask and ⌘K opens the jump palette", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    await screen.findByTestId("ask-fab", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("assistant-popover")).toBeNull();

    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(
      await screen.findByTestId("assistant-popover", undefined, { timeout: READ_MS }),
    ).toBeTruthy();

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("assistant-popover")).toBeNull());

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    expect(
      await screen.findByTestId("palette-input", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
    expect(screen.queryByTestId("assistant-popover")).toBeNull();
  });

  // Finding 8a: the Catch up row is nav, so the section the Ask box names
  // follows it.
  it("names the catch-up section for the Ask box's context chip", () => {
    expect(sectionOf("/catch-up")).toBe("catch up");
    expect(sectionOf("/")).toBe("today");
  });
});

describe("the rail is forced between 768 and 1024px (finding 07)", () => {
  it("shows the collapsed rail even though the preference says expanded", async () => {
    stubViewport(900);
    renderApp({ path: "/", routes: signedIn });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    // The rail, not the column: the expand control is the rail's, and the
    // expanded column's collapse control and labels are not there.
    expect(within(sidebar).getByTestId("sidebar-expand")).toBeTruthy();
    expect(within(sidebar).queryByTestId("sidebar-collapse")).toBeNull();
    // The phone frame does not mount here: 768–1023 is a tablet, not a phone.
    expect(screen.queryByTestId("phone-top-strip")).toBeNull();
    // The preference itself is not touched: nothing PATCHed the rail flag.
    expect(within(sidebar).queryByText("Threads")).toBeNull();
  });
});

describe("the saved preference decides at desktop width (≥1024px)", () => {
  it("shows the rail when `sidebar:collapsed` is saved", async () => {
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
              ask_placement: "sidebar",
              show_workflow_folders: true,
              expanded: { "sidebar:collapsed": true },
            },
            assistant: { trust_level: "ask_risky" },
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      ],
    });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    expect(sidebar).toBeTruthy();
    // Query the live document: when the saved prefs land, the Rail REPLACES
    // the expanded column's node, so a captured `within(sidebar)` scope
    // would poll a detached element.
    await waitFor(() => expect(screen.getByTestId("sidebar-expand")).toBeTruthy());
    expect(screen.queryByTestId("sidebar-collapse")).toBeNull();
  });

  it("shows the expanded column when the preference is not collapsed", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    const sidebar = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
    expect(within(sidebar).getByTestId("sidebar-collapse")).toBeTruthy();
  });
});

// Redesign 4a: three ways between the rail and the column — the expand
// button (covered in `Sidebar.test.tsx`), ⌘\\ from anywhere, and the edge
// drag (`Sidebar.test.tsx`). At ≥1024px ⌘\\ writes the stored preference; in
// the forced-rail zone (768–1023px) it opens the full column as an OVERLAY
// and the preference is never touched.
describe("⌘\\ toggles the sidebar (4a)", () => {
  const PREFS_PATH = "/api/v1/me/preferences";
  const COLLAPSED = "sidebar:collapsed";

  function prefsDoc(expanded: Record<string, boolean>): unknown {
    return {
      layout: {
        projects_mode: "tree",
        ask_placement: "sidebar",
        show_workflow_folders: true,
        expanded,
      },
      assistant: { trust_level: "ask_risky" },
      updated_at: "2026-01-01T00:00:00Z",
    };
  }

  it("flips the stored preference at desktop width, both directions", async () => {
    stubViewport(1280);
    try {
      const { requests } = renderApp({
        path: "/",
        routes: [
          ...signedIn,
          { path: PREFS_PATH, method: "GET", body: prefsDoc({}) },
          {
            path: PREFS_PATH,
            method: "PATCH",
            // The server echoes the write it was given: collapse on the
            // first ⌘\, expand on the second (a constant `true` answer
            // would snap the rail back over the expanded column).
            body: (n: number) => prefsDoc({ [COLLAPSED]: n === 1 }),
          },
        ],
      });
      const column = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
      expect(within(column).getByTestId("sidebar-collapse")).toBeTruthy();

      // The chord does nothing while the saved document is still in flight
      // (a toggle must not stamp over a read), so the press waits for the
      // GET to settle — then fires exactly once.
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "GET")).toHaveLength(1), {
        timeout: READ_MS,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      fireEvent.keyDown(window, { key: "\\", metaKey: true });
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1), {
        timeout: READ_MS,
      });
      expect(
        JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[0].body ?? "{}").layout.expanded[
          COLLAPSED
        ],
      ).toBe(true);
      // The rail replaced the column: expand is back, collapse is gone.
      await waitFor(() => expect(screen.queryByTestId("sidebar-collapse")).toBeNull(), {
        timeout: READ_MS,
      });
      expect(screen.getByTestId("sidebar-expand")).toBeTruthy();

      // Ctrl+backslash works the same on non-mac platforms.
      fireEvent.keyDown(window, { key: "\\", ctrlKey: true });
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(2), {
        timeout: READ_MS,
      });
      expect(
        JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[1].body ?? "{}").layout.expanded[
          COLLAPSED
        ],
      ).toBe(false);
      await waitFor(() => expect(screen.getByTestId("sidebar-collapse")).toBeTruthy(), {
        timeout: READ_MS,
      });
    } finally {
      restoreViewport();
    }
  });

  // lab-e2e acceptance 42456100374: the rail the ⌘\ collapses to at a desktop
  // width has to be a rail someone can leave. The hung run was the e2e clicking
  // the FORCED rail's expand mid-resize, but the contract it aims at — after ⌘\
  // at 1500px the `sidebar-expand` tile is mounted, enabled, unobstructed (no
  // rail-zone overlay, no drawer backdrop) and expands by the preference — lives
  // here, where nothing can race it.
  it("collapses to a clickable rail at 1500px, and the rail's expand brings the column back", async () => {
    stubViewport(1500);
    try {
      const { requests } = renderApp({
        path: "/",
        routes: [
          ...signedIn,
          { path: PREFS_PATH, method: "GET", body: prefsDoc({}) },
          {
            path: PREFS_PATH,
            method: "PATCH",
            // The server echoes the write it was given, so the second toggle
            // (the rail's expand) genuinely returns the expanded column.
            body: (n: number) => prefsDoc({ [COLLAPSED]: n === 1 }),
          },
        ],
      });
      const column = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
      expect(within(column).getByTestId("sidebar-collapse")).toBeTruthy();
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "GET")).toHaveLength(1), {
        timeout: READ_MS,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 1500px is outside the forced-rail zone: the chord writes the
      // preference, and the rail that replaces the column is the CHOSEN one.
      fireEvent.keyDown(window, { key: "\\", metaKey: true });
      await waitFor(() => expect(screen.queryByTestId("sidebar-collapse")).toBeNull(), {
        timeout: READ_MS,
      });

      // The expand tile is there, in the rail, enabled, and nothing stands
      // over it: at this width the overlay (768–1023px) and the phone drawer
      // never mount, so neither backdrop can swallow the click.
      const rail = screen.getByTestId("sidebar-rail");
      const expand = within(rail).getByTestId("sidebar-expand");
      expect(expand.getAttribute("aria-hidden")).not.toBe("true");
      expect(expand.hasAttribute("disabled")).toBe(false);
      expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull();
      expect(screen.queryByTestId("sidebar-backdrop")).toBeNull();
      expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(1);

      // Way one (the tile) still owns the preference at this width — no
      // overlay opens, the write says `false`, the labelled column returns.
      fireEvent.click(expand);
      await waitFor(() => expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(2), {
        timeout: READ_MS,
      });
      expect(
        JSON.parse(requestsTo(requests, PREFS_PATH, "PATCH")[1].body ?? "{}").layout.expanded[
          COLLAPSED
        ],
      ).toBe(false);
      const wide = await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
      expect(within(wide).getByTestId("sidebar-collapse")).toBeTruthy();
      expect(within(wide).getByText("Threads")).toBeTruthy();
      expect(screen.queryByTestId("sidebar-rail")).toBeNull();
      expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull();
    } finally {
      restoreViewport();
    }
  });

  it("stays out of the way while someone is typing in a text field", async () => {
    stubViewport(1280);
    try {
      const { requests } = renderApp({
        path: "/",
        routes: [
          ...signedIn,
          { path: PREFS_PATH, method: "GET", body: prefsDoc({}) },
          { path: PREFS_PATH, method: "PATCH", body: prefsDoc({ [COLLAPSED]: true }) },
        ],
      });
      await screen.findByTestId("sidebar", undefined, { timeout: READ_MS });
      // The palette's own input is the app's nearest real text field: the
      // chord fired inside it must NOT toggle the column.
      fireEvent.keyDown(document.body, { key: "k", metaKey: true });
      const input = await screen.findByTestId("palette-input", undefined, { timeout: READ_MS });
      fireEvent.keyDown(input, { key: "\\", metaKey: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(0);
    } finally {
      restoreViewport();
    }
  });

  it("opens the column as an overlay in the rail zone without touching the preference", async () => {
    stubViewport(900);
    try {
      const { requests } = renderApp({
        path: "/",
        routes: [
          ...signedIn,
          { path: PREFS_PATH, method: "GET", body: prefsDoc({}) },
          { path: PREFS_PATH, method: "PATCH", body: prefsDoc({ [COLLAPSED]: true }) },
        ],
      });
      const rail = await screen.findByTestId("sidebar-rail", undefined, { timeout: READ_MS });
      expect(within(rail).getByTestId("sidebar-expand")).toBeTruthy();

      // The rail's expand button opens the overlay — not a preference write.
      fireEvent.click(within(rail).getByTestId("sidebar-expand"));
      const overlay = await screen.findByTestId("rail-overlay-backdrop", undefined, {
        timeout: READ_MS,
      });
      const column = overlay.parentElement?.querySelector('[data-testid="sidebar"]');
      expect(column).toBeTruthy();
      // The overlay column is the real one: labels and the ‹‹ collapse button.
      expect(within(column as HTMLElement).getByTestId("sidebar-collapse")).toBeTruthy();
      expect(within(column as HTMLElement).queryByText("Threads")).toBeTruthy();
      expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(0);

      // Its ‹‹ button closes it, and the keyboard returns to the expand tile.
      const expandTile = within(rail).getByTestId("sidebar-expand");
      fireEvent.click(within(column as HTMLElement).getByTestId("sidebar-collapse"));
      await waitFor(() => expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull(), {
        timeout: READ_MS,
      });
      expect(document.activeElement).toBe(expandTile);

      // ⌘\\ opens it again; Esc closes it.
      fireEvent.keyDown(window, { key: "\\", metaKey: true });
      await screen.findByTestId("rail-overlay-backdrop", undefined, { timeout: READ_MS });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull(), {
        timeout: READ_MS,
      });

      // A click on the backdrop closes it too.
      fireEvent.click(expandTile);
      const backdrop = await screen.findByTestId("rail-overlay-backdrop", undefined, {
        timeout: READ_MS,
      });
      fireEvent.click(backdrop);
      await waitFor(() => expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull(), {
        timeout: READ_MS,
      });
      // None of it ever touched the stored preference.
      expect(requestsTo(requests, PREFS_PATH, "PATCH")).toHaveLength(0);
    } finally {
      restoreViewport();
    }
  });
});

describe("the phone frame (<768px) keeps the hamburger and the drawer", () => {
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
    expect(within(column).getByText("Threads")).toBeTruthy();
    expect(within(column).queryByTestId("sidebar-expand")).toBeNull();
    expect(screen.getByTestId("sidebar-backdrop")).toBeTruthy();
    // Esc closes it and the keyboard goes back to the button that opened it.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("sidebar-close")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
  });

  // Lab-e2e (acceptance 42452527578, shell-p1): the sign-in helper leaves the
  // drawer open WITH the footer's account menu open, and one Escape must take
  // the whole frame away. The menu consumes its own Escape (`preventDefault`),
  // so the drawer answers the key regardless — and the rail, a desktop
  // affordance, never renders at 390px (its root carries the same `sidebar`
  // test id the drawer's column does).
  it("one Escape closes the drawer even with the account menu open, at 390px", async () => {
    stubViewport(390);
    renderApp({ path: "/", routes: signedIn });
    const open = await screen.findByTestId("sidebar-open", undefined, { timeout: READ_MS });
    fireEvent.click(open);
    await screen.findByTestId("sidebar-close", undefined, { timeout: READ_MS });
    // No rail under the drawer: the phone frame's only column is the drawer's.
    expect(screen.queryByTestId("sidebar-rail")).toBeNull();
    expect(screen.getAllByTestId("sidebar")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("user-menu"));
    expect(
      await screen.findByTestId("user-menu-list", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
    // The key travels the browser's path: body → document (the menu's own
    // handler, which consumes it) → window (the drawer's).
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("user-menu-list")).toBeNull());
    expect(screen.queryByTestId("sidebar-close")).toBeNull();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(open);
  });

  // Review finding (phone, round 2): the wide `Ask ⌘J` pill sat on top of
  // whatever was mid-page — a card's "Start here" link, a narrative line, the
  // Running-now corner — and no bottom padding rescues content that scrolls
  // UNDER a fixed overlay. Below 768px the button is now a 44×44 ROUND icon
  // button (the word and the chord live in `title`/`aria-label`); the shell
  // still reserves the button's band so the LAST row stays reachable.
  it("shrinks the Ask button to a 44px round icon at 390px and reserves its band", async () => {
    stubViewport(390);
    renderApp({ path: "/", routes: signedIn });
    const fab = await screen.findByTestId("ask-fab", undefined, { timeout: READ_MS });
    // The reserve is the round button's own box plus its 12px offset, and the
    // safe area rides on top of it.
    expect(PHONE_ASK_RESERVE_PX).toBe(ASK_FAB_SIZE_PHONE_PX + ASK_FAB_OFFSET_PHONE_PX);
    const main = screen.getByRole("main");
    expect(main.getAttribute("style")).toContain(`padding-bottom: ${phoneAskReserveCss()}`);
    // A 44×44 circle, not a pill: the size and the radius are its own.
    expect(fab.className).toContain("h-[44px]");
    expect(fab.className).toContain("w-[44px]");
    expect(fab.className).toContain("rounded-full");
    // 12px off both edges, safe-area included.
    const fabStyle = fab.getAttribute("style") ?? "";
    expect(fabStyle).toContain(`right: calc(${ASK_FAB_OFFSET_PHONE_PX}px`);
    expect(fabStyle).toContain(`bottom: calc(${ASK_FAB_OFFSET_PHONE_PX}px`);
    // Icon only: no visible word, no chord — both move to the names.
    expect(fab.textContent).toBe("");
    expect(fab.querySelector("svg")).toBeTruthy();
    expect(fab.getAttribute("title")).toBe("Ask");
    expect(fab.getAttribute("aria-label")).toBe("Ask the assistant (⌘J)");
    restoreViewport();
  });

  it("leaves the desktop content column unpadded and the Ask button full", async () => {
    stubViewport(1280);
    renderApp({ path: "/", routes: signedIn });
    const fab = await screen.findByTestId("ask-fab", undefined, { timeout: READ_MS });
    const main = screen.getByRole("main");
    expect(main.getAttribute("style")).toBe(null);
    expect(fab.className).not.toContain("rounded-full");
    expect(fab.getAttribute("title")).toBe(null);
    expect(fab.textContent).toContain("Ask");
    expect(fab.textContent).toContain("⌘J");
    restoreViewport();
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
