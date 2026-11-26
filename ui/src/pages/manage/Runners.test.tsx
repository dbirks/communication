/**
 * Manage → Runners (redesign R7): the status words and glyphs the brief names,
 * the scheduler's own busy pair, and the honesty of the columns no read serves.
 * Hooks are mocked; nothing here hits a network.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RunnersSection from "./Runners";
import type { SchedulerStatus, Worker } from "../../api/types";

const mocks = vi.hoisted(() => ({
  workers: {
    data: { items: [] as Worker[] },
    isPending: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  },
  scheduler: {
    data: null as SchedulerStatus | null,
    isPending: false,
    error: null,
  },
}));

vi.mock("../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/queries")>()),
  useWorkers: () => mocks.workers,
}));
vi.mock("../../api/runs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/runs")>()),
  useSystemScheduler: () => mocks.scheduler,
}));
// The rest of the old Operations surface (health, queue, sandbox, the
// capability matrix, identity, about) is mounted whole; its behaviour is
// tested where it lives (components/ops).
vi.mock("../../components/ops/OperationsBody", async () => {
  const React = await import("react");
  return {
    OperationsBody: ({ embedded }: { embedded?: boolean }) =>
      React.createElement("div", {
        "data-testid": "operations-body",
        "data-embedded": String(embedded),
      }),
  };
});

function worker(overrides: Partial<Worker> & { name: string }): Worker {
  return {
    id: `worker-${overrides.name}`,
    hostname: overrides.name,
    version: "0.9.0",
    status: "online",
    started_at: "2026-10-14T18:00:00Z",
    last_heartbeat_at: "2026-10-14T18:20:00Z",
    ...overrides,
  };
}

function scheduler(workers: SchedulerStatus["workers"]): SchedulerStatus {
  return {
    attempts_by_status: { queued: 0, leased: 0, running: 0 },
    oldest_queued_age_seconds: null,
    lease_expirations: 0,
    max_retry_loop_depth: 0,
    waiting_approvals: 0,
    queued_unbindable_runs: 0,
    workers,
  };
}

beforeEach(() => {
  mocks.workers = {
    data: { items: [] },
    isPending: false,
    error: null,
    isFetching: false,
    refetch: vi.fn(),
  };
  mocks.scheduler = { data: null, isPending: false, error: null };
});

afterEach(cleanup);

function renderSection() {
  return render(
    <MemoryRouter>
      <RunnersSection />
    </MemoryRouter>,
  );
}

describe("Runners status", () => {
  it.each([
    ["online", "✓ online"],
    ["draining", "! draining"],
    ["offline", "⊘ offline"],
  ] as const)("renders %s as %s", async (status, text) => {
    mocks.workers.data = { items: [worker({ name: "runner-a", status })] };
    renderSection();
    const cell = await screen.findByTestId("runner-status-runner-a");
    expect(cell.textContent?.replace(/\s+/g, " ").trim()).toBe(text);
  });

  it("prints the scheduler's own claim pair", async () => {
    mocks.workers.data = { items: [worker({ name: "runner-a" })] };
    mocks.scheduler.data = scheduler([
      { worker_id: "worker-runner-a", name: "runner-a", capacity: 4, active_attempts: 2 },
    ]);
    renderSection();
    const busy = await screen.findByTestId("runner-busy-runner-a");
    expect(busy.textContent).toBe("2 of 4");
  });

  it("says — for a worker the scheduler does not list, and … while it reads", async () => {
    mocks.workers.data = { items: [worker({ name: "runner-a" }), worker({ name: "runner-b" })] };
    mocks.scheduler.data = scheduler([
      { worker_id: "worker-runner-a", name: "runner-a", capacity: 1, active_attempts: 0 },
    ]);
    mocks.scheduler.isPending = false;
    renderSection();
    expect((await screen.findByTestId("runner-busy-runner-a")).textContent).toBe("0 of 1");
    expect(screen.getByTestId("runner-busy-runner-b").textContent).toBe("—");
  });

  it("names the host when the hostname is a second name, else the build", async () => {
    mocks.workers.data = {
      items: [
        worker({ name: "runner-a", hostname: "box-7" }),
        worker({ name: "runner-b", hostname: "runner-b" }),
      ],
    };
    renderSection();
    const table = await screen.findByTestId("manage-runners-table");
    expect(table.textContent).toContain("box-7");
    expect(table.textContent).toContain("0.9.0");
  });

  it("keeps Used by honest: no read joins a runner to its projects", async () => {
    mocks.workers.data = { items: [worker({ name: "runner-a" })] };
    renderSection();
    expect((await screen.findByTestId("runner-used-runner-a")).textContent).toBe("—");
  });

  it("mounts the rest of Operations below the table, without the models panel", async () => {
    renderSection();
    await waitFor(() => expect(screen.getByTestId("operations-body")).toBeTruthy());
    expect(screen.getByTestId("operations-body").getAttribute("data-embedded")).toBe("true");
    expect(screen.getByTestId("manage-runners-server-label").textContent).toBe("This server");
  });
});
