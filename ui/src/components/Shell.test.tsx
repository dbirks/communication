/**
 * The app shell after redesign R1: the 64px project rail and the 60px top bar
 * are the frame, and the content region scrolls itself (`h-dvh overflow-hidden`
 * on the root, `min-h-0 flex-1 overflow-auto` on `<main>`).
 *
 * What the rewrite took away is part of the contract, so it is asserted: the
 * 220px `Sidebar` column, the phone drawer and its hamburger, the forced-rail
 * overlay, the ⌘\ chord and the floating `ask-fab` are gone; what it must keep
 * is mounted — the ⌘K palette engine (invisible, the bar's field is its
 * trigger) and the ⌘J Quick chat panel — plus every name other modules import from
 * this file.
 *
 * Which frame mounts is a `matchMedia` question (see `useMediaQuery`), so each
 * test states the viewport it means; the stub answers the shell's real queries
 * from the width.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api/types";
import type { Flag } from "../lib/sidebarFlags";
import { mockFetch, type RouteStub } from "../test/fakes";
import Shell, {
  ASSISTANT_PAGE_PATH,
  PHONE_MAX_WIDTH_PX,
  RAIL_MAX_WIDTH_PX,
  isAssistantPagePath,
  sectionOf,
  useIsNarrow,
  useIsRailWidth,
  useMediaQuery,
} from "./Shell";

/** Wait budget for a stubbed read's round trip. */
const READ_MS = 5_000;

const projects = vi.hoisted(() => ({ current: [] as Project[] }));
const flags = vi.hoisted(() => ({ current: {} as Record<string, Flag> }));

vi.mock("../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/queries")>()),
  useProjects: () => ({ data: { items: projects.current }, isPending: false }),
}));
vi.mock("../lib/sidebarFlags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sidebarFlags")>()),
  useSidebarFlags: () => ({
    inbox: { needsYou: 0, failed: 0 },
    board: { running: 0 },
    threads: null,
    projects: flags.current,
  }),
}));

function project(id: string, name: string): Project {
  return {
    id,
    slug: id,
    name,
    description: "",
    created_at: "2026-10-14T18:00:00Z",
    version: 1,
    my_role: "maintainer",
  };
}

/** Answer the shell's frame queries (phone <768, rail band 768–1023) as a
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

/** Restore jsdom's real `matchMedia` (NOT `vi.unstubAllGlobals()` — that also
 * drops the session-wide `EventSource` stub while the app is still mounted). */
const nativeMatchMedia = window.matchMedia;
function restoreViewport(): void {
  vi.stubGlobal("matchMedia", nativeMatchMedia);
}

const signedIn: RouteStub[] = [{ path: "/api/v1/me", body: meStub() }];

function meStub(): unknown {
  // `useMe` is real here (the account row and the assistant engine read it).
  return {
    id: "01987a61-2345-7000-8000-abcdef012345",
    display_name: "Ada Lovelace",
    email: "ada@example.com",
    is_org_admin: false,
    organization: {
      id: "01987a6b-9c1d-7e5f-8a0b-1c2d3e4f5a60",
      slug: "default",
      name: "Default organization",
    },
    csrf_token: "csrf-token-value",
  };
}

function renderShell(path = "/", children = <span>the page</span>) {
  stubViewport(1280);
  mockFetch(signedIn);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Shell>{children}</Shell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPhone(path = "/") {
  stubViewport(390);
  mockFetch(signedIn);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Shell>{<span>the page</span>}</Shell>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  restoreViewport();
  projects.current = [];
  flags.current = {};
  document.body.style.overflow = "";
});

describe("the names other modules import from Shell", () => {
  it("still names the sections the assistant's chip reads", () => {
    expect(sectionOf("/p/a/chats")).toBe("chats");
    expect(sectionOf("/")).toBe("home");
    expect(sectionOf("/factory/wf-1")).toBe("factory");
    expect(sectionOf("/manage/people")).toBe("manage");
    // Outside the pill's three, the path names itself by its own first segment.
    expect(sectionOf("/runs/run-9")).toBe("factory");
    expect(sectionOf("/profile")).toBe("profile");
    expect(sectionOf("/login")).toBe("login");
  });

  it("still owns the assistant page's path rule and the frame constants", () => {
    expect(ASSISTANT_PAGE_PATH).toBe("/assistant");
    expect(isAssistantPagePath("/assistant/thread-1")).toBe(true);
    expect(isAssistantPagePath("/assistantx")).toBe(false);
    expect(PHONE_MAX_WIDTH_PX).toBe(767.98);
    expect(RAIL_MAX_WIDTH_PX).toBe(1023.98);
    for (const fn of [useMediaQuery, useIsNarrow, useIsRailWidth]) {
      expect(typeof fn).toBe("function");
    }
  });
});

describe("the desktop frame (>= 768px)", () => {
  it("is the rail, the bar and one scrolling region — and nothing else", () => {
    projects.current = [project("p-1", "Project One")];
    renderShell("/");
    expect(screen.getByTestId("project-rail")).toBeTruthy();
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.getByRole("main").className).toContain("overflow-auto");
    expect(screen.getByText("the page")).toBeTruthy();
    // Gone: the old column, its drawer button, the floating Ask button.
    expect(screen.queryByTestId("ask-fab")).toBeNull();
    expect(screen.queryByTestId("sidebar-open")).toBeNull();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.queryByTestId("phone-top-strip")).toBeNull();
    expect(screen.queryByTestId("scope-open")).toBeNull();
    expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull();
    // ⌘\ no longer toggles anything.
    fireEvent.keyDown(window, { key: "\\", metaKey: true });
    expect(screen.queryByTestId("rail-overlay-backdrop")).toBeNull();
  });

  it("keeps the scope in both chrome pieces at once", () => {
    projects.current = [project("p-1", "Project One"), project("p-2", "Project Two")];
    renderShell("/p/p-2/chats");
    expect(screen.getByTestId("rail-tile-p-2").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("top-bar-scope-name").textContent).toBe("Project Two");
    expect(screen.getByTestId("pill-chats").getAttribute("aria-current")).toBe("page");
  });

  it("leaves ⌘K to the palette and ⌘J to Ask, with no button to show for them", async () => {
    renderShell("/");
    expect(screen.queryByTestId("palette-input")).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    fireEvent.keyUp(document.body, { key: "k", metaKey: true });
    expect(
      await screen.findByTestId("palette-input", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(window, { key: "j", metaKey: true });
    expect(await screen.findByTestId("quick-chat", undefined, { timeout: READ_MS })).toBeTruthy();
  });

  it("opens the palette from the field in the bar", async () => {
    renderShell("/");
    fireEvent.click(screen.getByTestId("search-or-ask"));
    expect(
      await screen.findByTestId("palette-input", undefined, { timeout: READ_MS }),
    ).toBeTruthy();
  });
});

describe("the phone frame (< 768px)", () => {
  it("mounts no rail and puts the scope behind a button", () => {
    projects.current = [project("p-1", "Project One")];
    renderPhone("/p/p-1");
    expect(screen.queryByTestId("project-rail")).toBeNull();
    expect(screen.getByTestId("scope-open").getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("scope-open").textContent).toContain("PO");
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.queryByTestId("ask-fab")).toBeNull();
  });

  it("opens the scope sheet from the button and closes it on Escape", async () => {
    projects.current = [project("p-1", "Project One")];
    renderPhone("/");
    const open = screen.getByTestId("scope-open");
    fireEvent.click(open);
    const sheet = await screen.findByTestId("scope-sheet");
    expect(within(sheet).getByText("All projects")).toBeTruthy();
    expect(screen.getByTestId("scope-open").getAttribute("aria-expanded")).toBe("true");
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("scope-sheet")).toBeNull());
    expect(document.body.style.overflow).toBe("");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("scope-open");
  });

  it("closes the sheet when a row is chosen and on the backdrop", async () => {
    projects.current = [project("p-1", "Project One")];
    renderPhone("/chats");
    fireEvent.click(screen.getByTestId("scope-open"));
    const sheet = await screen.findByTestId("scope-sheet");
    expect(within(sheet).getByTestId("scope-row-p-1").getAttribute("href")).toBe("/p/p-1/chats");
    fireEvent.click(screen.getByTestId("scope-backdrop"));
    await waitFor(() => expect(screen.queryByTestId("scope-sheet")).toBeNull());
    expect(screen.getByTestId("scope-open").getAttribute("aria-expanded")).toBe("false");
  });
});
