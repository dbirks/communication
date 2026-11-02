/**
 * The dialog chrome's title row at narrow widths (390px acceptance capture):
 * a long unbroken workflow name ("Emu lc pass-2-20261102042825") ran into the
 * `esc` close affordance and got cut off. The title must wrap at any width —
 * `min-w-0` + `[overflow-wrap:anywhere]`, the same approach the run title and
 * Studio header use (a68240c) — and `esc` must never shrink or wrap.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UseInRepoDialog } from "./UseInRepoDialog";
import { mockFetch } from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  mockFetch([{ path: "/api/v1/projects", method: "GET", body: { items: [] } }]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UseInRepoDialog
          open
          onClose={vi.fn()}
          pipelineId="01987b22-0000-7000-8000-abcdef012345"
          workflowName="Emu lc pass-2-20261102042825"
          newestPublished={null}
          revisions={[]}
          onAssigned={vi.fn()}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("the Use-in-repo dialog title row wraps instead of crowding out esc", () => {
  it("the title element carries the wrap classes and esc carries shrink-0", async () => {
    mount();
    // Let the projects read arrive so the settled chrome (no-maintainer
    // branch) is on screen, then inspect the title row's classes.
    await waitFor(() => expect(screen.getByTestId("assign-no-maintainer")).toBeTruthy());

    const title = screen.getByTestId("use-in-repo-title");
    expect(title.textContent).toBe("Use Emu lc pass-2-20261102042825 in a repo…");
    expect(title.className).toContain("min-w-0");
    expect(title.className).toContain("[overflow-wrap:anywhere]");

    const esc = screen.getByRole("button", { name: "Close" });
    expect(esc.textContent).toBe("esc");
    expect(esc.className).toContain("shrink-0");

    // The row keeps a small gap so a wrapping title never touches `esc`.
    expect(title.parentElement?.className).toContain("gap-");
  });
});
