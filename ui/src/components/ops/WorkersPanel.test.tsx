/**
 * The workers list against a fleet that behaves like the lab: one live worker
 * and 35 pod names whose leases died hours ago. The page's job is to make the
 * live one obvious and the dead ones counted, not listed; the collapse is a
 * `Show` button with `aria-expanded`, never a hidden fact.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SchedulerStatus, Worker, WorkerSandboxStatus } from "../../api/types";
import { WorkersPanel } from "./WorkersPanel";

afterEach(cleanup);

type Load = SchedulerStatus["workers"][number];

function worker(overrides: Partial<Worker> & { name: string }): Worker {
  const { name, ...rest } = overrides;
  return {
    id: `01987a74-5555-7000-8000-${name}`,
    name,
    hostname: overrides.hostname ?? name,
    version: "dev",
    status: "online",
    started_at: "2026-11-11T00:00:00Z",
    last_heartbeat_at: new Date(Date.now() - 30_000).toISOString(),
    ...rest,
  } as Worker;
}

/** One live worker + N dead ones whose last heartbeat spans minutes to hours. */
function fleet(offlineCount: number): Worker[] {
  const dead = Array.from({ length: offlineCount }, (_, index) =>
    worker({
      name: `communication-worker-dead-${index}`,
      status: "offline",
      last_heartbeat_at: new Date(Date.now() - (8 + index * 30) * 60_000).toISOString(),
    }),
  );
  return [worker({ name: "communication-worker-live" }), ...dead];
}

function panel(fleetWorkers: Worker[], extra: Partial<Parameters<typeof WorkersPanel>[0]> = {}) {
  // The scheduler and the sandbox report one worker each — the first in the
  // list — because that is the shape the lab has: one live box, both side reads
  // naming it. Everything else in the fleet answers `—`.
  const first = fleetWorkers[0];
  const loads: Record<string, Load> = first
    ? {
        [first.name]: {
          worker_id: first.id,
          name: first.name,
          capacity: 2,
          active_attempts: 0,
        },
      }
    : {};
  const verdicts: Record<string, WorkerSandboxStatus> = first
    ? {
        [first.id]: {
          worker_id: first.id,
          backend: "nono",
          backend_version: "0.80.0",
          enforcement: "required",
          verified: true,
          notes: [],
        },
      }
    : {};
  return render(
    <WorkersPanel
      workers={fleetWorkers}
      pending={false}
      error={null}
      loadOf={(name) => loads[name] ?? null}
      sandboxOf={(id) => verdicts[id] ?? null}
      {...extra}
    />,
  );
}

describe("WorkersPanel", () => {
  it("lists the one online worker and collapses the 35 offline ones", () => {
    panel(fleet(35));

    expect(screen.getAllByTestId(/^worker-row-/)).toHaveLength(1);
    const line = screen.getByTestId("workers-offline-line");
    expect(line.textContent).toContain("35 offline workers, last seen");
    expect(screen.getByTestId("workers-offline-toggle").textContent).toBe("Show");
    expect(screen.getByTestId("workers-offline-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("reveals the 35 offline rows on Show and hides them again on Hide", () => {
    panel(fleet(35));
    const toggle = screen.getByTestId("workers-offline-toggle");

    fireEvent.click(toggle);
    expect(screen.getAllByTestId(/^worker-row-/)).toHaveLength(36);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.textContent).toBe("Hide");

    fireEvent.click(toggle);
    expect(screen.getAllByTestId(/^worker-row-/)).toHaveLength(1);
  });

  it("says the head count in the meta, online and offline", () => {
    panel(fleet(35));
    expect(screen.getByTestId("ops-workers").textContent).toContain("1 online · 35 offline");
  });

  it("does not print the hostname when it repeats the name", () => {
    panel([worker({ name: "worker-a", hostname: "worker-a" })]);
    const row = screen.getByTestId("worker-row-worker-a");
    // One copy of the string, not two: the duplicate line is what the old page did.
    expect(row.textContent).toContain("status: online");
    expect(row.textContent?.match(/worker-a/g)).toHaveLength(1);
    expect(screen.getByTestId("worker-leases-worker-a").textContent).toBe("0 / 2 active");
    expect(screen.getByTestId("worker-heartbeat-worker-a").textContent).toMatch(/^\d+s ago$/);
  });

  it("prints the hostname as a second line only when it differs", () => {
    panel([worker({ name: "worker-a", hostname: "lab-1" })]);
    const row = screen.getByTestId("worker-row-worker-a");
    expect(row.textContent).toContain("worker-a");
    expect(row.textContent).toContain("lab-1");
  });

  it("writes the status as a word next to the dot, never a chip", () => {
    panel([
      worker({ name: "worker-a" }),
      worker({ name: "worker-b", status: "draining" }),
      worker({ name: "worker-c", status: "offline" }),
    ]);
    expect(screen.getByTestId("worker-row-worker-a").textContent).toContain("status: online");
    fireEvent.click(screen.getByTestId("workers-offline-toggle"));
    expect(screen.getByTestId("worker-row-worker-b").textContent).toContain("status: draining");
    expect(screen.getByTestId("worker-row-worker-c").textContent).toContain("status: offline");
    // The offline row is muted, so it reads as a fact and not a finding.
    expect(screen.getByTestId("worker-row-worker-c").getAttribute("class")).toContain("text-muted");
  });

  it("draws the sandbox cell as backend + mode + verdict with its own dot", () => {
    panel([worker({ name: "worker-a" })]);
    const cell = screen.getByTestId("worker-sandbox-worker-a");
    expect(cell.textContent).toContain("nono required · verified");
    expect(cell.querySelector("[data-status]")?.getAttribute("data-status")).toBe("ok");
  });

  it("says so when no worker has ever registered, with the command to start one", () => {
    panel([]);
    const empty = screen.getByTestId("workers-empty");
    expect(empty.textContent).toBe(
      "No workers have registered. Start one with communication worker.",
    );
    expect(empty.textContent).toContain("communication worker");
  });

  it("says the lease cell is not reported rather than showing zero", () => {
    panel([worker({ name: "worker-a" }), worker({ name: "worker-b" })], { sidePending: false });
    // Only `worker-a` is in the scheduler's load report; the other worker's
    // capacity is unknown, which is not the same answer as `0 / 0`.
    expect(screen.getByTestId("worker-leases-worker-b").textContent).toBe("— not reported");
  });

  it("shows the loading skeleton and never a stale row", () => {
    panel(fleet(1), { pending: true });
    expect(screen.getAllByTestId("workers-skeleton")[0]).toBeTruthy();
    expect(screen.queryByTestId(/^worker-row-/)).toBeNull();
  });

  it("offers a retry when the list could not be read", () => {
    let retried = 0;
    panel([], { error: new Error("boom"), onRetry: () => (retried += 1) });
    expect(screen.getByTestId("workers-error").textContent).toContain(
      "Couldn't load the worker list.",
    );
    fireEvent.click(screen.getByTestId("workers-error-retry"));
    expect(retried).toBe(1);
  });
});
