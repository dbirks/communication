/**
 * The 4h agent × capability matrix: every cell is what the launcher registry
 * (C5 / ADR-0051) says — evidence-backed `observed` with the evidence path in
 * the title, an observed-negative `not_supported`, and `not tested` whenever
 * no probe row exists. The matrix is never hard-coded and never prefilled.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { CapabilityMatrix } from "./CapabilityMatrix";
import { mockFetch, type RouteStub } from "../../test/fakes";
import type { LauncherList } from "../../api/launchers";

afterEach(cleanup);

function cell(
  capability: LauncherList["launchers"][number]["capabilities"][number]["capability"],
  result: "observed" | "not_supported" | "not_tested",
  observed_at: string | null = null,
  evidence: string | null = null,
) {
  return { capability, result, observed_at, evidence };
}

const registry: LauncherList = {
  launchers: [
    {
      id: "claude",
      display_name: "Claude Code",
      registered: true,
      workers_online: 1,
      capabilities: [
        cell(
          "acp_session",
          "observed",
          "2025-06-01T00:00:00Z",
          "docs/compatibility/probes/acp/claude.json",
        ),
        cell(
          "resume",
          "observed",
          "2025-06-01T00:00:00Z",
          "docs/compatibility/probes/acp/claude.json",
        ),
        cell("permission_prompts", "not_supported"),
        cell(
          "nono_required",
          "observed",
          "2025-06-02T00:00:00Z",
          "docs/compatibility/probes/acp/claude-nono.json",
        ),
      ],
    },
    {
      id: "codex",
      display_name: "Codex",
      registered: true,
      workers_online: 0,
      capabilities: [
        cell("acp_session", "not_tested"),
        cell("resume", "not_supported"),
        cell("permission_prompts", "not_tested"),
        cell("nono_required", "not_tested"),
      ],
    },
    {
      id: "antigravity",
      display_name: "Antigravity",
      registered: false,
      workers_online: 0,
      capabilities: [
        cell("acp_session", "not_tested"),
        cell("resume", "not_tested"),
        cell("permission_prompts", "not_tested"),
        cell("nono_required", "not_tested"),
      ],
    },
  ],
};

function harness(routes: RouteStub[]): (props: { children: ReactNode }) => ReactNode {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("CapabilityMatrix", () => {
  it("renders one row per launcher and one cell per capability", async () => {
    render(<CapabilityMatrix />, {
      wrapper: harness([{ path: "/api/v1/launchers", body: registry }]),
    });

    await screen.findByTestId("capability-matrix-table");
    expect(screen.getByTestId("capability-row-claude").textContent).toContain("Claude Code");
    expect(screen.getByTestId("capability-row-codex").textContent).toContain("Codex");
    expect(screen.getByTestId("capability-row-antigravity").textContent).toContain("Antigravity");
    for (const column of ["acp_session", "resume", "permission_prompts", "nono_required"]) {
      for (const launcher of ["claude", "codex", "antigravity"]) {
        expect(screen.getByTestId(`capability-cell-${launcher}-${column}`)).toBeTruthy();
      }
    }
  });

  it("shows observed cells with the probe date and the evidence path as title", async () => {
    render(<CapabilityMatrix />, {
      wrapper: harness([{ path: "/api/v1/launchers", body: registry }]),
    });

    const observed = await screen.findByTestId("capability-cell-claude-acp_session");
    expect(observed.textContent).toBe("✓ observed 2025-06-01");
    expect(observed.getAttribute("title")).toBe(
      "Evidence: docs/compatibility/probes/acp/claude.json",
    );
    expect(screen.getByTestId("capability-cell-claude-permission_prompts").textContent).toBe(
      "× not supported",
    );
    expect(screen.getByTestId("capability-cell-antigravity-resume").textContent).toBe(
      "· not tested",
    );
  });

  it("flags an unregistered launcher in the row label", async () => {
    render(<CapabilityMatrix />, {
      wrapper: harness([{ path: "/api/v1/launchers", body: registry }]),
    });

    await screen.findByTestId("capability-row-antigravity");
    expect(screen.getByTestId("capability-row-antigravity").textContent).toContain(
      "not registered",
    );
  });

  it("says the matrix is not available (not an error) when the registry 404s", async () => {
    const { container } = render(<CapabilityMatrix />, {
      wrapper: harness([]), // no launcher stub → the 404 fallback
    });
    const line = await screen.findByTestId("capability-matrix-none");
    expect(line.textContent).toContain("not served by this server yet");
    expect(container.querySelector('[data-testid="capability-matrix-table"]')).toBeNull();
    expect(screen.queryByTestId("capability-matrix-unavailable")).toBeNull();
  });

  it("carries the honesty footnote", async () => {
    render(<CapabilityMatrix />, {
      wrapper: harness([{ path: "/api/v1/launchers", body: registry }]),
    });

    const footnote = await screen.findByTestId("capability-matrix-footnote");
    expect(footnote.textContent).toContain(
      "Only results recorded by compatibility probes are shown",
    );
  });
});
