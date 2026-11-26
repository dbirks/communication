/**
 * ProjectRail (redesign R1): the tile list the rail is — All, one tile per
 * project in the API's order, "+", and the pinned Manage + account group. The
 * rules under test are the ones the brief fixes: the two-letter initials, the
 * ink-selected tile, the amber "!" for the waiting flag only, and the tile's
 * target (the SAME section in the new scope).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me, Project } from "../../api/types";
import type { Flag } from "../../lib/sidebarFlags";
import { meFixture } from "../../test/fakes";
import ProjectRail from "./ProjectRail";

const projects = vi.hoisted(() => ({ current: [] as Project[] }));
const flags = vi.hoisted(() => ({ current: {} as Record<string, Flag> }));
const me = vi.hoisted(() => ({ current: undefined as Me | undefined }));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useProjects: () => ({ data: { items: projects.current }, isPending: false }),
  useMe: () => ({ data: me.current }),
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

/** One signed-in person, so the account row renders its menu. */
function signedIn(): void {
  me.current = meFixture satisfies Me;
}

function renderRail(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectRail />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  projects.current = [];
  flags.current = {};
  me.current = undefined;
  window.sessionStorage.removeItem("communication.scope");
});

describe("the rail's tiles", () => {
  it("draws All, one tile per project, the add tile and Manage", () => {
    projects.current = [project("p-1", "Project One"), project("p-2", "Project Two")];
    renderRail("/");
    const rail = screen.getByTestId("project-rail");
    expect(screen.getByRole("navigation", { name: "Projects" })).toBe(rail);
    expect(screen.getByTestId("rail-tile-all").textContent).toContain("All");
    expect(screen.getByTestId("rail-tile-p-1").textContent).toBe("PO");
    expect(screen.getByTestId("rail-tile-p-2").textContent).toBe("PT");
    expect(screen.getByTestId("rail-add-project")).toBeTruthy();
    expect(screen.getByTestId("rail-manage")).toBeTruthy();
    expect(screen.getByTestId("brand-home")).toBeTruthy();
  });

  it("takes its project order from the API, not from the name", () => {
    projects.current = [project("p-2", "Project Two"), project("p-1", "Project One")];
    renderRail("/");
    const ids = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("rail-tile-"));
    expect(ids).toEqual(["rail-tile-all", "rail-tile-p-2", "rail-tile-p-1"]);
  });

  it("spells initials by the tile rule: two words → PO, one word → its first two letters", () => {
    projects.current = [
      project("p-1", "Project One"),
      project("p-2", "atlasweb"),
      project("p-3", "  spaced   name  here"),
    ];
    renderRail("/");
    expect(screen.getByTestId("rail-tile-p-1").textContent).toBe("PO");
    expect(screen.getByTestId("rail-tile-p-2").textContent).toBe("AT");
    expect(screen.getByTestId("rail-tile-p-3").textContent).toBe("SN");
  });

  it("titles a project tile with its name and the add tile with its job", () => {
    projects.current = [project("p-1", "Project One")];
    renderRail("/");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("title")).toBe("Project One");
    expect(screen.getByTestId("rail-tile-all").getAttribute("title")).toBe("All projects");
    expect(screen.getByTestId("rail-add-project").getAttribute("title")).toBe("Add project");
  });

  it("links the add tile to Manage → Projects with the new-project flag", () => {
    renderRail("/");
    expect(screen.getByTestId("rail-add-project").getAttribute("href")).toBe(
      "/manage/projects?new=1",
    );
    expect(screen.getByTestId("rail-manage").getAttribute("href")).toBe("/manage/projects");
  });
});

describe("the selected tile", () => {
  it("marks All when the URL has no scope", () => {
    projects.current = [project("p-1", "Project One")];
    renderRail("/chats");
    expect(screen.getByTestId("rail-tile-all").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("aria-current")).toBeNull();
  });

  it("marks the project's tile for /p/<id>/chats", () => {
    projects.current = [project("p-1", "Project One"), project("p-2", "Project Two")];
    renderRail(`/p/${"p-2"}/chats`);
    expect(screen.getByTestId("rail-tile-p-2").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("rail-tile-all").getAttribute("aria-current")).toBeNull();
  });

  it("marks Manage while the path is under /manage", () => {
    renderRail("/manage/runners");
    expect(screen.getByTestId("rail-manage").getAttribute("aria-current")).toBe("page");
  });

  it("selects only the gear on Manage — no project tile, not even All (review 15-1280-1)", () => {
    projects.current = [project("p-1", "Project One")];
    // Manage's URL carries no scope; useScope falls back to the remembered
    // one, and that must NOT print a selected tile beside the ink gear.
    window.sessionStorage.setItem("communication.scope", "p-1");
    renderRail("/manage/runners");
    for (const tile of ["rail-tile-all", "rail-tile-p-1"]) {
      const el = screen.getByTestId(tile);
      expect(el.getAttribute("aria-current")).toBeNull();
      expect(el.className).not.toContain("bg-ink");
    }
    expect(screen.getByTestId("rail-manage").getAttribute("aria-current")).toBe("page");
  });

  it("draws the Manage gear bare at rest — no border, no fill (review SH-2)", () => {
    renderRail("/");
    const gear = screen.getByTestId("rail-manage");
    expect(gear.className).not.toContain("border");
    expect(gear.className).not.toContain("bg-");
    // …and filled ink once selected.
    cleanup();
    renderRail("/manage/runners");
    expect(screen.getByTestId("rail-manage").className).toContain("bg-ink");
  });
});

describe("the needs-you badge", () => {
  it("draws the amber ! and its words for a waiting project only", () => {
    projects.current = [project("p-1", "Project One"), project("p-2", "Project Two")];
    flags.current = { "p-1": { kind: "waiting", count: 2 }, "p-2": { kind: "running", count: 1 } };
    renderRail("/");
    const waiting = within(screen.getByTestId("rail-tile-p-1"));
    expect(waiting.getByText("needs you")).toBeTruthy();
    expect(waiting.getByText("!")).toBeTruthy();
    expect(screen.getByTestId("rail-tile-p-2").textContent).not.toContain("needs you");
  });

  it("says nothing when no flag is waiting", () => {
    projects.current = [project("p-1", "Project One")];
    flags.current = { "p-1": { kind: "none", count: 0 } };
    renderRail("/");
    expect(screen.queryByText("needs you")).toBeNull();
  });
});

describe("a tile keeps the section you are in", () => {
  it("goes to that project's chats from /chats", () => {
    projects.current = [project("p-1", "Project One")];
    renderRail("/chats");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("href")).toBe("/p/p-1/chats");
    expect(screen.getByTestId("rail-tile-all").getAttribute("href")).toBe("/chats");
  });

  it("goes to that project's factory from the factory index", () => {
    projects.current = [project("p-1", "Project One")];
    renderRail("/factory");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("href")).toBe("/p/p-1/factory");
    expect(screen.getByTestId("rail-tile-all").getAttribute("href")).toBe("/factory");
  });

  it("goes to that project's home from Manage, and keeps the section a run page is in", () => {
    projects.current = [project("p-1", "Project One")];
    renderRail("/manage/runners");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("href")).toBe("/p/p-1");
    cleanup();
    // `/runs/:id` belongs to the Factory section (lib/scope.ts), so a tile
    // there takes the person to that project's factory index.
    renderRail("/runs/run-9");
    expect(screen.getByTestId("rail-tile-p-1").getAttribute("href")).toBe("/p/p-1/factory");
  });
});

describe("the account row", () => {
  it("keeps the identity testid the lab e2e reads inside rail-account", () => {
    signedIn();
    renderRail("/");
    const account = screen.getByTestId("rail-account");
    expect(within(account).getByTestId("user-badge").textContent).toContain("Ada Lovelace");
    expect(within(account).getByTestId("user-menu")).toBeTruthy();
  });

  it("draws the account avatar as a 30px circle with a 1px ink border (review SH-1)", () => {
    signedIn();
    renderRail("/");
    const avatar = within(screen.getByTestId("rail-account")).getByTestId("user-avatar");
    expect(avatar.className).toContain("rounded-full");
    expect(avatar.className).toContain("border-ink");
    expect(avatar.style.width).toBe("30px");
    expect(avatar.style.fontSize).toBe("10.5px");
  });
});
