/**
 * `/ops` scheduler section (contract § 7.2 W7 + exit gate C13f): every
 * `SchedulerStatus` counter renders under a plain label, unbindable runs are
 * called "waiting for its worker" in those words and only when there are any,
 * and the page says out loud that CPU/memory/disk limits are not implemented.
 */
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { meFixture } from "../test/fakes";
import type { SchedulerStatus } from "../api/types";
import type { RouteStub } from "../test/fakes";
import { shortId } from "../lib/format";
import type { CrossProjectRunList } from "../api/board";
import type { LauncherList } from "../api/launchers";

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
  it("redirects the legacy /ops URL to the /settings/operations Operations tab", async () => {
    renderApp({ path: "/ops", routes: opsRoutes(loaded) });
    expect(await screen.findByTestId("ops-resource-limits")).toBeTruthy();
  });

  it("renders every counter and each worker's active attempts over capacity", async () => {
    renderApp({ path: "/settings/operations", routes: opsRoutes(loaded) });

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
      path: "/settings/operations",
      routes: opsRoutes({ ...loaded, queued_unbindable_runs: 2 }),
    });

    const note = await screen.findByTestId("scheduler-unbindable-note");
    expect(note.textContent).toContain("2 run(s) waiting for its worker");
    expect(note.textContent).toContain(
      "the worker that holds its workspace is offline, draining or full",
    );
  });

  it("stays quiet about waiting workers when nothing is unbindable", async () => {
    renderApp({ path: "/settings/operations", routes: opsRoutes(loaded) });

    await screen.findByTestId("scheduler-queued-unbindable");
    expect(screen.queryByTestId("scheduler-unbindable-note")).toBeNull();
  });

  it("states that resource limits are not implemented, in the contract's words", async () => {
    renderApp({ path: "/settings/operations", routes: opsRoutes(loaded) });

    const line = await screen.findByTestId("ops-resource-limits");
    expect(line.textContent).toContain(
      "Resource limits: not implemented — runs have no cpu, memory or disk caps in this release",
    );
  });

  it("still says resource limits are not implemented when the scheduler cannot be read", async () => {
    renderApp({
      path: "/settings/operations",
      routes: opsRoutes(loaded).filter((stub) => stub.path !== schedulerPath),
    });

    // No /system/scheduler stub at all: the honest sentence must not depend on
    // the panel having data (C13f — no one infers a limit from silence).
    await screen.findByTestId("ops-resource-limits");
  });

  it("reports a scheduler status it cannot read instead of an empty section", async () => {
    renderApp({
      path: "/settings/operations",
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

/* ---------------------------------------------------------- 4h (phase 9) */

const workerIdA = "01987a74-5555-7000-8000-0000000000a1";
const runId = "01987a74-6666-7000-8000-0000000000b2";

const schedulerLoad = {
  worker_id: workerIdA,
  name: "w-1",
  capacity: 4,
  active_attempts: 2,
};

const workerFixture = {
  id: workerIdA,
  name: "w-1",
  hostname: "host-a",
  version: "0.4.0",
  status: "online",
  started_at: "2025-06-01T00:00:00Z",
  last_heartbeat_at: new Date(Date.now() - 3000).toISOString(),
};

const interruptedRun: CrossProjectRunList["runs"][number] = {
  id: runId,
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

function ops4hRoutes(overrides: {
  scheduler?: Partial<SchedulerStatus>;
  workers?: unknown;
  sandbox?: unknown;
  runs?: unknown;
  runsStatus?: number;
  launchers?: unknown;
}) {
  const scheduler: SchedulerStatus = {
    ...loaded,
    ...overrides.scheduler,
  };
  const base: RouteStub[] = [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/system/health", body: { status: "ok", replica: "api-a", version: "v" } },
    {
      path: "/api/v1/system/readiness",
      body: { status: "ready", schema_version: 5, expected_schema_version: 5 },
    },
    { path: "/api/v1/workers", body: { items: overrides.workers ?? [workerFixture] } },
    {
      path: "/api/v1/system/sandbox",
      body: overrides.sandbox ?? {
        policy_digest: "x",
        workers: [
          {
            worker_id: workerIdA,
            backend: "nono",
            enforcement: "required",
            verified: true,
          },
        ],
      },
    },
    { path: schedulerPath, body: { ...scheduler, workers: [schedulerLoad] } },
  ];
  if (overrides.runs !== undefined) {
    base.push({
      path: "/api/v1/runs",
      status: overrides.runsStatus ?? 200,
      body: overrides.runs,
    });
  }
  if (overrides.launchers !== undefined) {
    base.push({ path: "/api/v1/launchers", body: overrides.launchers });
  }
  return base;
}

describe("/ops 4h surfaces", () => {
  it("renders the health line: replica, queue depth, oldest queue age", async () => {
    renderApp({ path: "/settings/operations", routes: ops4hRoutes({}) });

    const line = await screen.findByTestId("ops-health-line");
    expect(line.textContent).toContain("replica: api-a");
    expect(line.textContent).toContain("queue: 3 queued, 2 leased");
    expect(line.textContent).toContain("oldest queued: 2m");
  });

  it("keeps the workers table testids and adds leases, sandbox and heartbeat age", async () => {
    renderApp({ path: "/settings/operations", routes: ops4hRoutes({}) });

    const row = await screen.findByTestId("worker-row-w-1");
    expect(row.textContent).toContain("w-1");
    expect(row.textContent).toContain("status: online");
    expect(screen.getByTestId("worker-leases-w-1").textContent).toContain("2 / 4 active");
    expect(screen.getByTestId("worker-sandbox-w-1").textContent).toContain("required");
    expect(screen.getByTestId("worker-sandbox-w-1").textContent).toContain("verified");
    // the render takes a moment, so assert the shape, not the exact second
    expect(screen.getByTestId("worker-heartbeat-w-1").textContent).toMatch(/^\d+s ago$/);
  });

  it("names interrupted runs with their steps and a Reclaim and retry link", async () => {
    renderApp({
      path: "/settings/operations",
      routes: ops4hRoutes({
        scheduler: { lease_expirations: 1 },
        runs: { runs: [interruptedRun], next_cursor: null },
      }),
    });

    const run = await screen.findByTestId(`ops-interrupted-run-${shortId(runId)}`);
    expect(run.textContent).toContain("infra");
    expect(run.textContent).toContain("dependency-upgrade");
    expect(run.textContent).toContain("upgrade: running");
    expect(run.textContent).toContain("verify: pending");
    expect(screen.getByTestId(`ops-interrupted-retry-${shortId(runId)}`).getAttribute("href")).toBe(
      `/runs/${runId}`,
    );
    const lease = screen.getByTestId("ops-interrupted-leases");
    await waitFor(() =>
      expect(lease.textContent).toContain("1 lease expiration(s) since replica start"),
    );
  });

  it("falls back to the lease count when no run is named", async () => {
    renderApp({
      path: "/settings/operations",
      routes: ops4hRoutes({
        scheduler: { lease_expirations: 4 },
        runs: { runs: [], next_cursor: null },
      }),
    });

    const lease = await screen.findByTestId("ops-interrupted-leases");
    await waitFor(() =>
      expect(lease.textContent).toContain("4 lease expiration(s) since replica start"),
    );
    await waitFor(() =>
      expect(lease.textContent).toContain(
        "no run is left in the interrupted state, so no run names them",
      ),
    );
    expect(screen.queryByTestId(/ops-interrupted-run-/)).toBeNull();
  });

  it("renders no callout when nothing was interrupted", async () => {
    renderApp({
      path: "/settings/operations",
      routes: ops4hRoutes({
        scheduler: { lease_expirations: 0 },
        runs: { runs: [], next_cursor: null },
      }),
    });

    await screen.findByTestId("ops-health-line");
    expect(screen.queryByTestId("ops-interrupted")).toBeNull();
  });

  it("says the run list is not served instead of a red banner on a 404 registry gap", async () => {
    renderApp({
      path: "/settings/operations",
      routes: ops4hRoutes({
        scheduler: { lease_expirations: 2 },
        runs: { runs: [], next_cursor: null },
        runsStatus: 404,
      }),
    });

    const lease = await screen.findByTestId("ops-interrupted-leases");
    expect(lease.textContent).toContain("the cross-project run list is not served by this server");
  });

  it("renders the capability matrix straight from the launcher registry", async () => {
    const launchers: LauncherList = {
      launchers: [
        {
          id: "claude",
          display_name: "Claude Code",
          registered: true,
          workers_online: 1,
          capabilities: [
            {
              capability: "acp_session",
              result: "observed",
              observed_at: "2025-06-01T00:00:00Z",
              evidence: "docs/compatibility/probes/acp/claude.json",
            },
            {
              capability: "resume",
              result: "observed",
              observed_at: "2025-06-01T00:00:00Z",
              evidence: "docs/compatibility/probes/acp/claude.json",
            },
            {
              capability: "permission_prompts",
              result: "not_supported",
              observed_at: null,
              evidence: null,
            },
            {
              capability: "nono_required",
              result: "observed",
              observed_at: "2025-06-02T00:00:00Z",
              evidence: "docs/compatibility/probes/acp/claude-nono.json",
            },
          ],
        },
        {
          id: "antigravity",
          display_name: "Antigravity",
          registered: false,
          workers_online: 0,
          capabilities: [
            { capability: "acp_session", result: "not_tested", observed_at: null, evidence: null },
            { capability: "resume", result: "not_tested", observed_at: null, evidence: null },
            {
              capability: "permission_prompts",
              result: "not_tested",
              observed_at: null,
              evidence: null,
            },
            {
              capability: "nono_required",
              result: "not_tested",
              observed_at: null,
              evidence: null,
            },
          ],
        },
      ],
    };
    renderApp({ path: "/settings/operations", routes: ops4hRoutes({ launchers }) });

    expect((await screen.findByTestId("capability-cell-claude-acp_session")).textContent).toBe(
      "✓ observed 2025-06-01",
    );
    expect(screen.getByTestId("capability-cell-claude-permission_prompts").textContent).toBe(
      "× not supported",
    );
    expect(screen.getByTestId("capability-cell-antigravity-acp_session").textContent).toBe(
      "· not tested",
    );
    expect(screen.getByTestId("capability-cell-claude-acp_session").getAttribute("title")).toBe(
      "Evidence: docs/compatibility/probes/acp/claude.json",
    );
    expect(screen.getByTestId("capability-row-antigravity").textContent).toContain(
      "not registered",
    );
    expect(screen.getByTestId("capability-matrix-footnote").textContent).toContain(
      "Only results recorded by compatibility probes are shown",
    );
  });

  it("says the matrix is not available when the launcher registry is not served", async () => {
    renderApp({ path: "/settings/operations", routes: ops4hRoutes({}) });

    const line = await screen.findByTestId("capability-matrix-none");
    expect(line.textContent).toContain("not served by this server yet");
    expect(screen.queryByTestId("capability-matrix-table")).toBeNull();
  });
});
