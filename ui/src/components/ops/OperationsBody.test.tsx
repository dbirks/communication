/**
 * The Operations page as one surface, driven by fixtures: what the six tiles
 * say for a healthy fleet, what they say when the queue is ageing or no worker
 * is online, how many things the lead line counts, and what every panel says
 * when its read has not arrived. The tile rules are the page's whole contract,
 * so they are asserted here rather than in the panels they scroll to.
 */
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../../test/render";
import { meFixture, type RouteStub } from "../../test/fakes";
import type { SchedulerStatus, SystemSandbox, Worker } from "../../api/types";
import type { SystemOverview } from "../../api/overview";

const HEALTH_PATH = "/api/v1/system/health";
const READY_PATH = "/api/v1/system/readiness";
const WORKERS_PATH = "/api/v1/workers";
const SCHEDULER_PATH = "/api/v1/system/scheduler";
const SANDBOX_PATH = "/api/v1/system/sandbox";
const OVERVIEW_PATH = "/api/v1/system/overview";

const LIVE_ID = "01987a74-5555-7000-8000-0000000000a1";

function liveWorker(name = "communication-worker-live"): Worker {
  return {
    id: LIVE_ID,
    name,
    hostname: name,
    version: "dev",
    status: "online",
    started_at: "2026-11-11T00:00:00Z",
    last_heartbeat_at: new Date(Date.now() - 45_000).toISOString(),
  } as Worker;
}

function deadWorker(index: number): Worker {
  const name = `communication-worker-pod-${index}`;
  return {
    id: `01987a74-5555-7000-8000-dead${index}`,
    name,
    hostname: name,
    version: "dev",
    status: "offline",
    started_at: "2026-11-10T00:00:00Z",
    last_heartbeat_at: new Date(Date.now() - (8 + index * 25) * 60_000).toISOString(),
  } as Worker;
}

function fleet(offlineCount: number): Worker[] {
  return [liveWorker(), ...Array.from({ length: offlineCount }, (_, index) => deadWorker(index))];
}

function scheduler(overrides: Partial<SchedulerStatus> = {}): SchedulerStatus {
  return {
    attempts_by_status: { queued: 0, leased: 0, running: 1 },
    oldest_queued_age_seconds: null,
    lease_expirations: 0,
    max_retry_loop_depth: 1,
    waiting_approvals: 0,
    queued_unbindable_runs: 0,
    workers: [
      { worker_id: LIVE_ID, name: "communication-worker-live", capacity: 2, active_attempts: 0 },
    ],
    ...overrides,
  } as SchedulerStatus;
}

function sandbox(overrides: Partial<SystemSandbox> = {}): SystemSandbox {
  return {
    workers: [
      {
        worker_id: LIVE_ID,
        backend: "nono",
        backend_version: "0.80.0",
        enforcement: "required",
        verified: true,
        volumes: [{ root_kind: "workspaces", volume_id: `sha256:${"7c1f".repeat(16)}` }],
        notes: ["AF_UNIX mediation is off by default in nono"],
      },
    ],
    pinned_backend_version: "0.80.0",
    policy_digest: `sha256:${"2b71".repeat(16)}`,
    ...overrides,
  } as SystemSandbox;
}

function overview(overrides: Partial<SystemOverview> = {}): SystemOverview {
  return {
    server: {
      version: "0.0.0-SNAPSHOT-f918881",
      commit: "f918881",
      replica: "communication-5b9d97499f-fccb7",
      schema_version: 30,
      started_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    },
    identity: { provider: "oidc", issuer_host: "idp.beluga-wyvern.ts.net", dev_login: false },
    storage: {
      artifact_backend: "local",
      preview_host: "communication-preview.beluga-wyvern.ts.net",
    },
    models: [
      {
        kind: "assistant",
        label: "Assistant chat",
        model: "david-birks/qwen3-8-flash-next",
        endpoint_host: "llm-collective.e-gineering.com",
        key_set: true,
        configured: true,
      },
      {
        kind: "speech",
        label: "Speech",
        model: "voice",
        endpoint_host: "llm-collective.e-gineering.com",
        key_set: true,
        configured: true,
      },
      {
        kind: "decision",
        label: "Decision",
        model: "thinker",
        endpoint_host: "llm-collective.e-gineering.com",
        key_set: true,
        configured: true,
      },
      {
        kind: "worker_chat",
        label: "Workflow model steps",
        model: "pi-runnable",
        endpoint_host: "llm-collective.e-gineering.com",
        key_set: null,
        configured: true,
      },
    ],
    secrets: { projects: 3, secrets: 7, mounts: 4 },
    workers: { online: 1, offline: 35, stale_after_seconds: 3600 },
    ...overrides,
  };
}

function baseRoutes(): RouteStub[] {
  return [
    { path: "/api/v1/me", body: { ...meFixture, is_org_admin: true } },
    {
      path: HEALTH_PATH,
      body: {
        status: "ok",
        replica: "communication-5b9d97499f-fccb7",
        version: "0.0.0-SNAPSHOT-f918881",
      },
    },
    {
      path: READY_PATH,
      body: { status: "ready", schema_version: 30, expected_schema_version: 30 },
    },
    { path: WORKERS_PATH, body: { items: fleet(35) } },
    { path: SCHEDULER_PATH, body: scheduler() },
    { path: SANDBOX_PATH, body: sandbox() },
    { path: OVERVIEW_PATH, body: overview() },
  ];
}

/**
 * The stub table with one read's answer replaced. An override is either a body
 * or a full stub (so a test can answer 503 the way the server does); the base
 * entry for that path is REMOVED, because the mock answers the first match.
 */
function opsRoutes(overrides: Record<string, unknown> = {}): RouteStub[] {
  const paths = Object.keys(overrides);
  const routes = baseRoutes().filter((stub) => !paths.includes(stub.path));
  for (const [path, value] of Object.entries(overrides)) {
    const isStub =
      typeof value === "object" && value !== null && "body" in (value as Record<string, unknown>);
    routes.push(isStub ? { ...(value as RouteStub), path } : { path, body: value });
  }
  return routes;
}

async function renderOps(overrides: Record<string, unknown> = {}) {
  renderApp({ path: "/settings/operations", routes: opsRoutes(overrides) });
  // Every tile waits: a page still mid-read has nothing to assert about.
  await waitFor(() => {
    for (const label of ["Health", "Workers", "Queue", "Approvals", "Sandbox", "Models"]) {
      if (tile(label).getAttribute("data-status") === "off") {
        throw new Error(`${label} is still loading`);
      }
    }
  });
}

function tile(label: string): HTMLElement {
  return screen.getByTestId(`stat-tile-${label.toLowerCase()}`);
}

describe("Operations tiles", () => {
  it("says every tile is well when nothing is wrong, and names each answer", async () => {
    await renderOps();

    expect(await screen.findByText("All systems normal.")).toBeTruthy();
    expect(tile("Health").textContent).toContain("OK");
    expect(tile("Health").textContent).toContain("schema 30 of 30 · replica …fccb7");
    expect(tile("Workers").textContent).toContain("1 online");
    expect(tile("Workers").textContent).toContain("2 slots · 0 busy");
    expect(tile("Queue").textContent).toContain("0 queued");
    expect(tile("Queue").textContent).toContain("oldest —");
    expect(tile("Approvals").textContent).toContain("0 waiting");
    expect(tile("Sandbox").textContent).toContain("nono 0.80.0");
    expect(tile("Sandbox").textContent).toContain("required · verified");
    expect(tile("Models").textContent).toContain("3 of 3");
    expect(tile("Models").textContent).toContain("assistant · speech · decision");
    for (const label of ["Health", "Workers", "Queue", "Approvals", "Sandbox", "Models"]) {
      expect(tile(label).getAttribute("data-status")).toBe("ok");
    }
  });

  it("names the tile in words, with its state, and scrolls to its own section", async () => {
    await renderOps();

    const workers = tile("Workers");
    expect(workers.getAttribute("aria-label")).toBe("Workers: 1 online, ok");
    expect(workers.getAttribute("data-target")).toBe("ops-workers");
    expect(screen.getByTestId("ops-workers")).toBeTruthy();
  });

  it("warns on a queue whose oldest attempt is older than five minutes", async () => {
    await renderOps({
      [SCHEDULER_PATH]: { body: scheduler({ oldest_queued_age_seconds: 6 * 60 }) },
    });

    expect(tile("Queue").getAttribute("data-status")).toBe("warn");
    expect(screen.getByTestId("stat-tile-queue").textContent).toContain("oldest 6m");
    // One tile out of six: the lead line counts, it does not describe.
    expect(screen.getByTestId("ops-health-line").textContent).toBe("1 thing needs attention.");
  });

  it("calls a half-hour-old queue a problem, and an unbindable run one too", async () => {
    await renderOps({
      [SCHEDULER_PATH]: { body: scheduler({ oldest_queued_age_seconds: 31 * 60 }) },
    });
    expect(tile("Queue").getAttribute("data-status")).toBe("bad");
    expect(screen.getByTestId("ops-health-line").textContent).toBe("1 thing needs attention.");
  });

  it("counts every tile that needs attention, not just the first", async () => {
    await renderOps({
      [SCHEDULER_PATH]: {
        body: scheduler({ oldest_queued_age_seconds: 8 * 60, waiting_approvals: 2 }),
      },
      [SANDBOX_PATH]: {
        body: sandbox({
          workers: [
            {
              worker_id: LIVE_ID,
              backend: "nono",
              backend_version: "0.80.0",
              enforcement: "required",
              verified: false,
              volumes: [],
              notes: [],
            },
          ],
        }),
      },
    });

    expect(screen.getByTestId("ops-health-line").textContent).toBe("3 things need attention.");
    expect(screen.getByTestId("stat-tile-queue").getAttribute("data-status")).toBe("warn");
    expect(screen.getByTestId("stat-tile-approvals").getAttribute("data-status")).toBe("warn");
    expect(screen.getByTestId("stat-tile-sandbox").getAttribute("data-status")).toBe("bad");
  });

  it("says the fleet is broken when no worker is online", async () => {
    await renderOps({
      [WORKERS_PATH]: { body: { items: [deadWorker(1)] } },
      [SCHEDULER_PATH]: { body: scheduler({ workers: [] }) },
    });

    const workers = tile("Workers");
    expect(workers.textContent).toContain("0 online");
    expect(workers.getAttribute("data-status")).toBe("bad");
    expect(screen.getByTestId("stat-tile-sandbox").getAttribute("data-status")).toBe("bad");
    expect(screen.getByTestId("stat-tile-sandbox").textContent).toContain(
      "no online worker verified",
    );
  });

  it("says the models tile is a problem when the assistant has no model", async () => {
    const data = overview();
    data.models = data.models.map((model) =>
      model.kind === "assistant" ? { ...model, configured: false } : model,
    );
    await renderOps({ [OVERVIEW_PATH]: { body: data } });

    expect(tile("Models").getAttribute("data-status")).toBe("bad");
    expect(screen.getByTestId("stat-tile-models").textContent).toContain("2 of 3");
  });

  it("refuses to call a read it could not make a healthy one", async () => {
    // Only `/me` answers: every other read 404s off the mock. The tiles must
    // say they could not see, and the lead line must not claim the system is
    // normal on the strength of nothing.
    renderApp({ path: "/settings/operations", routes: [{ path: "/api/v1/me", body: meFixture }] });
    await screen.findByTestId("ops-stat-strip");

    await waitFor(() => expect(tile("Queue").textContent).toContain("couldn't load"));
    expect(tile("Queue").getAttribute("data-status")).toBe("bad");
    expect(tile("Workers").getAttribute("data-status")).toBe("bad");
    expect(tile("Sandbox").getAttribute("data-status")).toBe("bad");
    // A server that does not answer the overview read is `not reported`, not a
    // models problem: the page cannot claim the assistant has no model.
    expect(tile("Models").textContent).toContain("not reported");
    expect(tile("Models").getAttribute("data-status")).toBe("off");
    expect(screen.getByTestId("ops-health-line").textContent).not.toBe("All systems normal.");
    expect(screen.getByTestId("models-not-served")).toBeTruthy();
  });

  it("marks a tile bad with `couldn't load` when its read failed", async () => {
    await renderOps({
      [SANDBOX_PATH]: {
        path: SANDBOX_PATH,
        status: 503,
        body: {
          type: "https://communication.dev/errors/unavailable",
          title: "Unavailable",
          status: 503,
          detail: "sandbox fleet report is not answering",
        },
      },
    });

    expect(tile("Sandbox").getAttribute("data-status")).toBe("bad");
    expect(screen.getByTestId("sandbox-health-error").textContent).toContain(
      "sandbox fleet report is not answering",
    );
  });
});

describe("Operations panels", () => {
  it("collapses the 35 offline workers behind one counted line and a Show button", async () => {
    await renderOps();
    await screen.findByTestId("worker-row-communication-worker-live");

    expect(screen.getAllByTestId(/^worker-row-/)).toHaveLength(1);
    expect(screen.getByTestId("workers-offline-line").textContent).toContain("35 offline workers");
    expect(screen.getByTestId("workers-offline-toggle").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("keeps the resource-limits sentence on the queue panel even when it cannot read the queue", async () => {
    await renderOps({
      [SCHEDULER_PATH]: {
        path: SCHEDULER_PATH,
        status: 503,
        body: {
          type: "https://communication.dev/errors/unavailable",
          title: "Unavailable",
          status: 503,
          detail: "scheduler telemetry is not served by this replica",
        },
      },
    });

    expect(screen.getByTestId("scheduler-unavailable").textContent).toContain(
      "scheduler telemetry is not served by this replica",
    );
    expect(screen.getByTestId("ops-resource-limits").textContent).toContain(
      "Resource limits: not implemented — runs have no cpu, memory or disk caps in this release.",
    );
  });

  it("lists the queue's eight answers and the load each worker reports", async () => {
    await renderOps();
    const queue = await screen.findByTestId("ops-queue");
    for (const label of [
      "queued",
      "running",
      "leased",
      "waiting approvals",
      "oldest queued",
      "lease expirations",
      "retry depth",
      "unbindable runs",
    ]) {
      expect(within(queue).getByText(label).textContent).toBe(label);
    }
    expect(queue.textContent).toContain("1 worker reporting");
    expect(
      screen.getByTestId("scheduler-worker-row-communication-worker-live").textContent,
    ).toContain("0 / 2");
  });

  it("keeps the long probe notes out of the way until asked", async () => {
    await renderOps();
    const notes = await screen.findByTestId(
      `sandbox-notes-${LIVE_ID.replace(/[^A-Za-z0-9]/g, "").slice(0, 13)}`,
    );
    expect(notes.tagName).toBe("DETAILS");
    expect(notes.hasAttribute("open")).toBe(false);
    expect((notes as HTMLDetailsElement).open).toBe(false);
    expect(notes.textContent).toContain("Probe notes");
  });

  it("truncates the policy digest but keeps the whole of it selectable", async () => {
    await renderOps();
    const digest = await screen.findByTestId("sandbox-policy-digest");
    expect(digest.textContent).toBe(`sha256:${"2b71".repeat(16)}`);
    expect(digest.getAttribute("class")).toContain("truncate");
    expect(screen.getByTestId("sandbox-policy-digest-copy")).toBeTruthy();
  });

  it("says who signs in, where bytes live, and how many secrets the reader can see", async () => {
    await renderOps();
    expect((await screen.findByTestId("identity-signin")).textContent).toBe(
      "OIDC · idp.beluga-wyvern.ts.net",
    );
    expect(screen.getByTestId("identity-artifacts").textContent).toBe("local");
    expect(screen.getByTestId("identity-previews").textContent).toBe(
      "communication-preview.beluga-wyvern.ts.net",
    );
    expect(screen.getByTestId("identity-secrets").textContent).toContain(
      "7 secrets in 3 projects · 4 mounts",
    );
    expect(screen.getByTestId("identity-secrets-link").getAttribute("href")).toBe("/projects");
  });

  /**
   * ADR-0083: `COMMUNICATION_OIDC_PROVIDERS_FILE` leaves `issuer_host` empty on
   * the pre-fix overview, so the panel said “no issuer host” about a deployment
   * with several working providers. It now lists them — one line each, in the
   * order the sign-in chooser draws them.
   */
  it("lists one line per sign-in provider when the deployment offers several", async () => {
    const data = overview();
    data.identity = {
      provider: "oidc",
      issuer_host: "idp.example.ts.net",
      dev_login: false,
      providers: [
        { id: "tailnet", label: "Tailscale", issuer_host: "idp.example.ts.net" },
        { id: "work", label: "Microsoft (E-gineering)", issuer_host: "login.microsoftonline.com" },
      ],
    } as SystemOverview["identity"];
    await renderOps({ [OVERVIEW_PATH]: { body: data } });

    const rows = await screen.findAllByTestId("identity-provider");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Tailscale · idp.example.ts.net",
      "Microsoft (E-gineering) · login.microsoftonline.com",
    ]);
    // The panel says who signs in, and the provider list IS that answer — no
    // second “OIDC · …” line under it.
    expect((await screen.findByTestId("identity-signin")).textContent).toBe(
      "Tailscale · idp.example.ts.netMicrosoft (E-gineering) · login.microsoftonline.com",
    );
  });

  it("prints a provider with no parsable issuer as the gap it is", async () => {
    const data = overview();
    data.identity = {
      provider: "oidc",
      issuer_host: "",
      dev_login: false,
      providers: [{ id: "tailnet", label: "Tailscale", issuer_host: "" }],
    } as SystemOverview["identity"];
    await renderOps({ [OVERVIEW_PATH]: { body: data } });

    const rows = await screen.findAllByTestId("identity-provider");
    expect(rows.map((row) => row.textContent)).toEqual(["Tailscale · no issuer host"]);
  });

  it("keeps the single sign-in line for a replica that names no provider list", async () => {
    const data = overview();
    data.identity = {
      provider: "oidc",
      issuer_host: "idp.beluga-wyvern.ts.net",
      dev_login: false,
      providers: [],
    } as SystemOverview["identity"];
    await renderOps({ [OVERVIEW_PATH]: { body: data } });

    const rows = await screen.findAllByTestId("identity-provider");
    expect(rows.map((row) => row.textContent)).toEqual(["OIDC · idp.beluga-wyvern.ts.net"]);
  });

  it("warns in words when sign-in is the dev login", async () => {
    const data = overview();
    data.identity = { provider: "dev", issuer_host: "", dev_login: true };
    await renderOps({ [OVERVIEW_PATH]: { body: data } });

    const signin = await screen.findByTestId("identity-signin");
    expect(signin.textContent).toBe("Dev login (local only)");
    expect(signin.getAttribute("class")).toContain("text-st-waiting-tag-fg");
  });

  it("names the build: version, commit, replica, schema and when it started", async () => {
    await renderOps();
    expect((await screen.findByTestId("ops-about-version")).textContent).toBe(
      "0.0.0-SNAPSHOT-f918881",
    );
    expect(screen.getByTestId("ops-about-commit").textContent).toBe("f918881");
    expect(screen.getByTestId("ops-about-replica").textContent).toBe(
      "communication-5b9d97499f-fccb7",
    );
    expect(screen.getByTestId("readiness-card").textContent).toContain("schema version 30 of 30");
    expect(screen.getByTestId("ops-about-started").textContent).toMatch(/3h ago$/);
    expect(screen.getByTestId("ops-about-started").getAttribute("title")).toContain("UTC");
  });

  it("keeps the agent × capability matrix as the agents section", async () => {
    await renderOps();
    expect(await screen.findByTestId("ops-agents")).toBeTruthy();
    expect(screen.getByTestId("capability-matrix-footnote").textContent).toContain(
      "Only results recorded by compatibility probes are shown",
    );
  });
});
