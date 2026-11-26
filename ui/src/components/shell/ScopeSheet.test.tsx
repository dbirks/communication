/**
 * ScopeSheet — the phone's rail (CONTRACT "Phone"). The rows are the rail's
 * tiles as full rows, in the rail's order, and all three ways out (Escape, the
 * backdrop, choosing a row) hand the keyboard back to the `scope-open` button
 * the sheet came from.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, Project } from "../../api/types";
import type { Flag } from "../../lib/sidebarFlags";
import { meFixture } from "../../test/fakes";
import ScopeSheet from "./ScopeSheet";

const projects = vi.hoisted(() => ({ current: [] as Project[] }));
const flags = vi.hoisted(() => ({ current: {} as Record<string, Flag> }));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useProjects: () => ({ data: { items: projects.current }, isPending: false }),
  useMe: () => ({ data: meFixture as Me }),
  useLogout: () => ({ mutate: vi.fn() }),
}));
vi.mock("../../lib/sidebarFlags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/sidebarFlags")>()),
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

/** The sheet only ever stands under the phone bar, whose scope button is the
 * focus return target; the test provides one. */
function renderSheet(onClose = vi.fn(), path = "/chats") {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <button type="button" data-testid="scope-open">
        Projects
      </button>
      <ScopeSheet onClose={onClose} />
    </MemoryRouter>,
  );
  return { ...utils, onClose };
}

afterEach(() => {
  cleanup();
  projects.current = [];
  flags.current = {};
  document.body.style.overflow = "";
});

describe("the rows", () => {
  it("is a dialog labelled Projects with All first, the projects, Add last, then Manage and the account", () => {
    projects.current = [project("p-1", "Project One"), project("p-2", "Project Two")];
    renderSheet();
    const sheet = screen.getByTestId("scope-sheet");
    expect(sheet.getAttribute("role")).toBe("dialog");
    expect(screen.getByRole("dialog", { name: "Projects" })).toBe(sheet);
    const rows = within(sheet)
      .getAllByRole("link")
      .map((row) => row.getAttribute("data-testid") ?? "");
    expect(rows).toEqual([
      "scope-row-all",
      "scope-row-p-1",
      "scope-row-p-2",
      "scope-row-add",
      "scope-row-manage",
    ]);
    expect(within(sheet).getByTestId("scope-row-p-2").textContent).toContain("Project Two");
    expect(within(sheet).getByTestId("user-badge").textContent).toContain("Ada Lovelace");
  });

  it("keeps the section on every row and carries the waiting flag", () => {
    projects.current = [project("p-1", "Project One")];
    flags.current = { "p-1": { kind: "waiting", count: 1 } };
    renderSheet(vi.fn(), "/chats");
    expect(screen.getByTestId("scope-row-all").getAttribute("href")).toBe("/chats");
    expect(screen.getByTestId("scope-row-p-1").getAttribute("href")).toBe("/p/p-1/chats");
    expect(screen.getByTestId("scope-row-add").getAttribute("href")).toBe("/manage/projects?new=1");
    expect(screen.getByTestId("scope-row-manage").getAttribute("href")).toBe("/manage/projects");
    expect(screen.getByTestId("scope-row-p-1").textContent).toContain("needs you");
  });

  it("marks the row for the scope that is showing", () => {
    projects.current = [project("p-1", "Project One")];
    renderSheet(vi.fn(), "/p/p-1/factory");
    expect(screen.getByTestId("scope-row-p-1").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("scope-row-all").getAttribute("aria-current")).toBeNull();
  });
});

describe("the ways out", () => {
  it("closes on Escape and returns the keyboard to the scope button", () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("scope-open");
  });

  it("closes on the backdrop and on a row", () => {
    projects.current = [project("p-1", "Project One")];
    const { onClose } = renderSheet();
    fireEvent.click(screen.getByTestId("scope-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("scope-row-p-1"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("scope-open");
  });

  it("locks the page behind it and gives the lock back", () => {
    const { unmount } = renderSheet();
    expect(document.body.style.overflow).toBe("hidden");
    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
