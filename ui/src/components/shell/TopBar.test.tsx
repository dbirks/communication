/**
 * TopBar — the 60px bar (and the 52px phone bar) over the content column
 * (redesign R1). The left region reads the scope's name, the center is the
 * pill, the right is search + the mic, and on the phone the left region
 * becomes the 36px scope button that opens the sheet.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../api/types";
import TopBar from "./TopBar";

const projects = vi.hoisted(() => ({ current: undefined as { items: Project[] } | undefined }));
const scope = vi.hoisted(() => ({ current: null as string | null }));
const startVoiceAsk = vi.hoisted(() => vi.fn());

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useProjects: () => ({ data: projects.current, isPending: projects.current === undefined }),
}));
vi.mock("../../lib/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/scope")>()),
  useScope: () => scope.current,
}));
vi.mock("../../lib/sidebarFlags", () => ({
  useSidebarFlags: () => ({
    inbox: { needsYou: 0, failed: 0 },
    board: { running: 0 },
    threads: null,
    projects: {},
  }),
}));
vi.mock("../assistant/askControl", () => ({
  startVoiceAsk,
  ASSISTANT_LISTENING_EVENT: "communication:assistant-listening",
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

function renderBar(props: Parameters<typeof TopBar>[0] = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <TopBar {...props} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  projects.current = undefined;
  scope.current = null;
});

describe("the left region", () => {
  it("names All projects when nothing is scoped", () => {
    projects.current = { items: [] };
    renderBar();
    expect(screen.getByTestId("top-bar-context").textContent).toContain("All projects");
  });

  it("names the project in scope", () => {
    projects.current = { items: [project("p-1", "Project One"), project("p-2", "Project Two")] };
    scope.current = "p-2";
    renderBar();
    expect(screen.getByTestId("top-bar-context").textContent).toContain("Project Two");
  });

  it("prints no name at all while the project list is still loading", () => {
    projects.current = undefined;
    scope.current = "p-2";
    renderBar();
    expect(screen.getByTestId("top-bar-context").textContent).toBe("");
  });
});

describe("the bar", () => {
  it("is a header with the pill, the field and the mic", () => {
    projects.current = { items: [] };
    renderBar();
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByTestId("top-bar")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
    expect(screen.getByTestId("search-or-ask")).toBeTruthy();
    expect(screen.getByTestId("top-bar-mic").getAttribute("aria-label")).toBe(
      "Talk to the assistant",
    );
  });

  it("starts a voice ask from the mic and turns accent while Quick chat listens", () => {
    projects.current = { items: [] };
    renderBar();
    const mic = screen.getByTestId("top-bar-mic");
    fireEvent.click(mic);
    expect(startVoiceAsk).toHaveBeenCalledTimes(1);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      window.dispatchEvent(new CustomEvent("communication:assistant-listening", { detail: true }));
    });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(mic.className).toContain("bg-accent");
    act(() => {
      window.dispatchEvent(new CustomEvent("communication:assistant-listening", { detail: false }));
    });
    expect(mic.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("the phone bar", () => {
  it("swaps the scope name for the 36px scope button and the compact pill", () => {
    projects.current = { items: [project("p-1", "Project One")] };
    scope.current = "p-1";
    renderBar({ phone: true, scopeOpen: false, onScopeOpen: () => {} });
    const open = screen.getByTestId("scope-open");
    expect(open.getAttribute("aria-label")).toBe("Projects");
    expect(open.getAttribute("aria-expanded")).toBe("false");
    expect(open.textContent).toContain("PO");
    expect(screen.queryByTestId("top-bar-scope-name")).toBeNull();
    // Compact pill: the words are screen-reader only.
    expect(screen.getByTestId("pill-chats").querySelector("span")?.className).toContain("sr-only");
  });

  it("says All on the scope button when no project is in scope", () => {
    projects.current = { items: [] };
    renderBar({ phone: true });
    expect(screen.getByTestId("scope-open").textContent).toContain("All");
  });

  it("reports the sheet's state on the button and calls back when pressed", () => {
    projects.current = { items: [] };
    const onScopeOpen = vi.fn();
    renderBar({ phone: true, scopeOpen: true, onScopeOpen });
    const open = screen.getByTestId("scope-open");
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(open);
    expect(onScopeOpen).toHaveBeenCalledTimes(1);
  });
});
