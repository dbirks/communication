/**
 * SectionPill — the three places in the middle of the top bar (redesign R1).
 * Its links carry the current scope (a project's Chats, not the global list)
 * and its active item is the section the URL is in, including a detail URL
 * (`/p/x/chats/abc` is still Chats).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import SectionPill from "./SectionPill";

const scope = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("../../lib/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/scope")>()),
  useScope: () => scope.current,
}));

function renderPill(path = "/", compact = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SectionPill compact={compact} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  scope.current = null;
});

describe("the pill's links", () => {
  it("points at All projects when the scope is null", () => {
    renderPill("/");
    expect(screen.getByTestId("pill-home").getAttribute("href")).toBe("/");
    expect(screen.getByTestId("pill-chats").getAttribute("href")).toBe("/chats");
    expect(screen.getByTestId("pill-factory").getAttribute("href")).toBe("/factory");
  });

  it("points inside the project when a project is in scope", () => {
    scope.current = "p-9";
    renderPill("/p/p-9");
    expect(screen.getByTestId("pill-home").getAttribute("href")).toBe("/p/p-9");
    expect(screen.getByTestId("pill-chats").getAttribute("href")).toBe("/p/p-9/chats");
    expect(screen.getByTestId("pill-factory").getAttribute("href")).toBe("/p/p-9/factory");
  });
});

describe("the active item", () => {
  it("is Home on /", () => {
    renderPill("/");
    expect(screen.getByTestId("pill-home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("pill-chats").getAttribute("aria-current")).toBeNull();
  });

  it("is Chats on a thread URL inside a project", () => {
    scope.current = "p-x";
    renderPill("/p/p-x/chats/abc");
    expect(screen.getByTestId("pill-chats").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("pill-home").getAttribute("aria-current")).toBeNull();
  });

  it("is Factory on a workflow editor URL", () => {
    renderPill("/factory/wf");
    expect(screen.getByTestId("pill-factory").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("pill-chats").getAttribute("aria-current")).toBeNull();
  });

  it("is nothing at all on a page outside the three (Manage)", () => {
    renderPill("/manage/runners");
    for (const testid of ["pill-home", "pill-chats", "pill-factory"]) {
      expect(screen.getByTestId(testid).getAttribute("aria-current")).toBeNull();
    }
  });
});

describe("the pill's shape", () => {
  it("is a labelled nav with three worded items", () => {
    renderPill("/");
    const nav = screen.getByRole("navigation", { name: "Sections" });
    expect(nav.textContent).toContain("Home");
    expect(nav.textContent).toContain("Chats");
    expect(nav.textContent).toContain("Factory");
  });

  it("drops the words but keeps the names when compact (phone)", () => {
    renderPill("/chats", true);
    const chats = screen.getByTestId("pill-chats");
    expect(chats.className).toContain("h-10");
    expect(chats.className).toContain("w-10");
    expect(chats.querySelector("span")?.className).toContain("sr-only");
    // The accessible name survives the label going visual-only.
    expect(chats.getAttribute("aria-label") ?? chats.textContent).toContain("Chats");
  });
});
