/**
 * The 4h interrupted callout, driven against the fake fetch: it speaks only
 * from data the API serves — named interrupted runs with a Reclaim and retry
 * link to the run's own page, otherwise the lease-expiration count — and
 * renders nothing when nothing was interrupted (empty is healthy).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import { InterruptedCallout } from "./InterruptedCallout";
import { mockFetch, type RouteStub } from "../../test/fakes";
import type { CrossProjectRunList } from "../../api/board";
import { shortId } from "../../lib/format";

afterEach(cleanup);

const RUN_ID = "01987a74-6666-7000-8000-0000000000b2";

function interruptedRun(): CrossProjectRunList["runs"][number] {
  return {
    id: RUN_ID,
    project_id: "01987a74-5555-7000-8000-0000000000c3",
    pipeline_id: "01987a74-5555-7000-8000-0000000000c4",
    pipeline_revision_id: "01987a74-5555-7000-8000-0000000000c5",
    revision_digest: "abc",
    plan_digest: "def",
    status: "interrupted",
    depth: 0,
    priority: 0,
    created_at: "2025-06-01T00:00:00Z",
    finished_at: new Date(Date.now() - 9 * 60_000).toISOString(),
    project_name: "infra",
    pipeline_slug: "dependency-upgrade",
    pipeline_display_name: "dependency-upgrade",
    steps: [
      { node_id: "upgrade", kind: "agent.acp", state: "running" },
      { node_id: "verify", kind: "process.exec", state: "pending" },
    ],
  };
}

function harness(
  _leaseExpirations: number | null,
  routes: RouteStub[] = [],
): { wrapper: (props: { children: ReactNode }) => ReactNode } {
  mockFetch(routes);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  };
}

describe("InterruptedCallout", () => {
  it("renders nothing when nothing was interrupted", async () => {
    const { wrapper } = harness(null, [
      { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
    ]);
    const { container } = render(<InterruptedCallout leaseExpirations={0} />, { wrapper });
    expect(container.querySelector('[data-testid="ops-interrupted"]')).toBeNull();
  });

  it("renders nothing while the lease count is unknown and no runs are named", () => {
    const { wrapper } = harness(null, [
      { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
    ]);
    const { container } = render(<InterruptedCallout leaseExpirations={null} />, { wrapper });
    // the query is still pending and there is no lease count: nothing renders
    expect(container.querySelector('[data-testid="ops-interrupted"]')).toBeNull();
  });

  it("names an interrupted run with its steps and a Reclaim and retry link", async () => {
    const { wrapper } = harness(1, [
      { path: "/api/v1/runs", body: { runs: [interruptedRun()], next_cursor: null } },
    ]);
    render(<InterruptedCallout leaseExpirations={1} />, { wrapper });

    const run = await screen.findByTestId(`ops-interrupted-run-${shortId(RUN_ID)}`);
    expect(run.textContent).toContain("infra");
    expect(run.textContent).toContain("dependency-upgrade");
    expect(run.textContent).toContain("upgrade: running");
    expect(run.textContent).toContain("verify: pending");
    expect(
      screen.getByTestId(`ops-interrupted-retry-${shortId(RUN_ID)}`).getAttribute("href"),
    ).toBe(`/runs/${RUN_ID}`);
    expect(screen.getByText("Reclaim and retry")).toBeTruthy();
  });

  it("shows only the lease count when the run list is empty", async () => {
    const { wrapper } = harness(4, [
      { path: "/api/v1/runs", body: { runs: [], next_cursor: null } },
    ]);
    render(<InterruptedCallout leaseExpirations={4} />, { wrapper });

    const lease = await screen.findByTestId("ops-interrupted-leases");
    await waitFor(() =>
      expect(lease.textContent).toContain(
        "no run is left in the interrupted state, so no run names them",
      ),
    );
    expect(lease.textContent).toContain("4 lease expiration(s) since replica start");
  });

  it("says the run list is not served (not an error) when the endpoint 404s", async () => {
    const { wrapper } = harness(2); // no /api/v1/runs stub → the 404 fallback
    render(<InterruptedCallout leaseExpirations={2} />, { wrapper });

    const lease = await screen.findByTestId("ops-interrupted-leases");
    await waitFor(() =>
      expect(lease.textContent).toContain(
        "the cross-project run list is not served by this server",
      ),
    );
    expect(screen.queryByTestId("ops-interrupted-error")).toBeNull();
  });
});
