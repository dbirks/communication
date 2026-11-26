/**
 * TopBarSlot — the page's portal into the top bar's left region (CONTRACT
 * "Shell"). The rules that matter: a page that claims the region takes it over
 * completely (the scope name goes), giving it back brings the name back, and
 * on the phone the claimed content appears in the strip under the bar instead
 * of vanishing with the rail.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../api/types";
import TopBar from "./TopBar";
import { TopBarLeft } from "./TopBarSlot";

const projects = vi.hoisted(() => ({ current: [] as Project[] }));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useProjects: () => ({ data: { items: projects.current }, isPending: false }),
}));
vi.mock("../../lib/sidebarFlags", () => ({
  useSidebarFlags: () => ({
    inbox: { needsYou: 0, failed: 0 },
    board: { running: 0 },
    threads: null,
    projects: {},
  }),
}));
vi.mock("../assistant/askControl", () => ({ openAsk: vi.fn() }));

function Frame({ page, phone = false }: { page?: ReactNode; phone?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/p/p-1"]}>
        <div className="flex h-dvh overflow-hidden">
          <TopBar phone={phone} />
          <main className="min-h-0 flex-1 overflow-auto">{page}</main>
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  cleanup();
  projects.current = [];
});

describe("TopBarLeft", () => {
  it("takes the left region and retires the scope name while it holds it", async () => {
    projects.current = [
      {
        id: "p-1",
        slug: "p-1",
        name: "Project One",
        description: "",
        created_at: "2026-10-14T18:00:00Z",
        version: 1,
        my_role: "maintainer",
      },
    ];
    const { rerender } = render(<Frame page={<TopBarLeft>Workflow fix-issue</TopBarLeft>} />);
    const context = screen.getByTestId("top-bar-context");
    expect(await screen.findByText("Workflow fix-issue")).toBeTruthy();
    expect(context.textContent).toContain("Workflow fix-issue");
    expect(screen.queryByTestId("top-bar-scope-name")).toBeNull();

    // The page lets go: the name comes back.
    rerender(<Frame page={<span>nothing claimed</span>} />);
    expect((await screen.findByTestId("top-bar-scope-name")).textContent).toBe("Project One");
    expect(context.querySelector("#top-bar-left-slot")?.childElementCount).toBe(0);
  });

  it("lands in the bar even when the page rendered before the bar existed", async () => {
    // The portal target is looked up after mount, so a page mounted alone (the
    // first frame of a lazy route) is not stuck with an orphaned breadcrumb.
    const { rerender } = render(
      <MemoryRouter>
        <TopBarLeft>Run 4182</TopBarLeft>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Run 4182")).toBeNull();
    rerender(<Frame page={<TopBarLeft>Run 4182</TopBarLeft>} />);
    expect(await screen.findByText("Run 4182")).toBeTruthy();
    expect(screen.getByTestId("top-bar-context").textContent).toContain("Run 4182");
  });

  it("shows a claimed region on the phone in the strip under the bar", async () => {
    const { rerender } = render(<Frame phone page={<TopBarLeft>Draft · 2 changes</TopBarLeft>} />);
    expect(await screen.findByText("Draft · 2 changes")).toBeTruthy();
    expect(screen.getByTestId("top-bar-phone-slot").className).not.toContain("hidden");

    rerender(<Frame phone page={<span>quiet</span>} />);
    await waitFor(() => expect(screen.queryByText("Draft · 2 changes")).toBeNull());
    expect(screen.getByTestId("top-bar-phone-slot").className).toContain("hidden");
    // The phone bar never prints the scope name — the tile button is the scope.
    expect(screen.queryByTestId("top-bar-scope-name")).toBeNull();
  });
});
