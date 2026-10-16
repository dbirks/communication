/**
 * `/ops` scheduler section (contract § 7.2 W7 + exit gate C13f): every
 * `SchedulerStatus` counter renders under a plain label, unbindable runs are
 * called "waiting for its worker" in those words and only when there are any,
 * and the page says out loud that CPU/memory/disk limits are not implemented.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture } from "../test/fakes";
import type { SchedulerStatus } from "../api/types";
import type { RouteStub } from "../test/fakes";

const schedulerPath = "/api/v1/system/scheduler";

const loaded: SchedulerStatus = {
  attempts_by_status: { queued: 3, leased: 2, running: 5 },
  oldest_queued_age_seconds: 95,
  lease_expirations: 4,
  max_retry_loop_depth: 6,
  waiting_approvals: 1,
  queued_unbindable_runs: 0,
  workers: [
    {
      worker_id: "01987a74-5555-7000-8000-abcdef012345",
      name: "worker-a",
      capacity: 4,
      active_attempts: 2,
    },
    {
      worker_id: "01987a74-5556-7000-8000-abcdef012345",
      name: "worker-b",
      capacity: 8,
      active_attempts: 0,
    },
  ],
};

function opsRoutes(scheduler: SchedulerStatus): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/system/health", body: { status: "ok", replica: "r", version: "v" } },
    {
      path: "/api/v1/system/readiness",
      body: { status: "ready", schema_version: 5, expected_schema_version: 5 },
    },
    { path: "/api/v1/workers", body: { items: [] } },
    { path: "/api/v1/system/sandbox", body: { policy_digest: "x", workers: [] } },
    { path: schedulerPath, body: scheduler },
  ];
}

describe("/ops scheduler", () => {
  it("renders every counter and each worker's active attempts over capacity", async () => {
    renderApp({ path: "/ops", routes: opsRoutes(loaded) });

    for (const [testid, text] of [
      ["scheduler-attempts-queued", "attempts queued3"],
      ["scheduler-attempts-leased", "attempts leased2"],
      ["scheduler-attempts-running", "attempts running5"],
      ["scheduler-lease-expirations", "lease expirations4"],
      ["scheduler-max-retry-depth", "max retry loop depth6"],
      ["scheduler-oldest-queued", "oldest queued age2m"],
      ["scheduler-waiting-approvals", "waiting approvals1"],
      ["scheduler-queued-unbindable", "queued unbindable runs0"],
    ] as const) {
      expect((await screen.findByTestId(testid)).textContent).toContain(text);
    }

    const rowA = await screen.findByTestId("scheduler-worker-row-worker-a");
    expect(rowA.textContent).toContain("2 / 4");
    const rowB = screen.getByTestId("scheduler-worker-row-worker-b");
    expect(rowB.textContent).toContain("0 / 8");
  });

  it("says a run is waiting for its worker when unbindable runs are queued", async () => {
    renderApp({
      path: "/ops",
      routes: opsRoutes({ ...loaded, queued_unbindable_runs: 2 }),
    });

    const note = await screen.findByTestId("scheduler-unbindable-note");
    expect(note.textContent).toContain("2 run(s) waiting for its worker");
    expect(note.textContent).toContain(
      "the worker that holds its workspace is offline, draining or full",
    );
  });

  it("stays quiet about waiting workers when nothing is unbindable", async () => {
    renderApp({ path: "/ops", routes: opsRoutes(loaded) });

    await screen.findByTestId("scheduler-queued-unbindable");
    expect(screen.queryByTestId("scheduler-unbindable-note")).toBeNull();
  });

  it("states that resource limits are not implemented, in the contract's words", async () => {
    renderApp({ path: "/ops", routes: opsRoutes(loaded) });

    const line = await screen.findByTestId("ops-resource-limits");
    expect(line.textContent).toContain(
      "Resource limits: not implemented — runs have no cpu, memory or disk caps in this release",
    );
  });

  it("still says resource limits are not implemented when the scheduler cannot be read", async () => {
    renderApp({
      path: "/ops",
      routes: opsRoutes(loaded).filter((stub) => stub.path !== schedulerPath),
    });

    // No /system/scheduler stub at all: the honest sentence must not depend on
    // the panel having data (C13f — no one infers a limit from silence).
    await screen.findByTestId("ops-resource-limits");
  });

  it("reports a scheduler status it cannot read instead of an empty section", async () => {
    renderApp({
      path: "/ops",
      routes: [
        ...opsRoutes(loaded).filter((stub) => stub.path !== schedulerPath),
        {
          path: schedulerPath,
          status: 503,
          body: {
            type: "https://communication.dev/errors/unavailable",
            title: "Unavailable",
            status: 503,
            detail: "scheduler telemetry is not served by this replica",
          },
        },
      ],
    });

    const banner = await screen.findByTestId("scheduler-unavailable");
    expect(banner.textContent).toContain("scheduler telemetry is not served by this replica");
    expect(screen.queryByTestId("scheduler-attempts-queued")).toBeNull();
  });
});
