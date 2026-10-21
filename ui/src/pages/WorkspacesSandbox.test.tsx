/**
 * M3 workspace + sandbox surfaces: the project panel, the conversation widget,
 * and `/ops` fleet health. What is pinned here is honesty: an unverified worker
 * never reads as healthy, a lost workspace never reads as resumed, and no
 * screen offers a git action this API does not have.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { testidOf } from "../lib/format";
import {
  artifactFixture,
  claudeProfile,
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  systemSandboxFixture,
  turnId,
  turnSandboxFixture,
  workerId,
  workspaceFixture,
  type RouteStub,
} from "../test/fakes";
import type { Conversation, TurnSandbox, Workspace } from "../api/types";

const projectId = projectFixture.id;
const apiProject = `/api/v1/projects/${projectId}`;
const workspacesPath = `${apiProject}/workspaces`;
const statusPath = `/api/v1/workspaces/${workspaceFixture.id}/repos/${workspaceFixture.repos[0]?.repository_id}/status`;
const sandboxPath = "/api/v1/system/sandbox";
const turnSandboxPath = `/api/v1/turns/${turnId}/sandbox`;

const quarantined: Workspace = {
  ...workspaceFixture,
  id: "01987a75-7000-7000-8000-abcdef012345",
  state: "quarantined",
};
const lost: Workspace = {
  ...workspaceFixture,
  id: "01987a75-7100-7000-8000-abcdef012345",
  state: "lost",
  lost_reason: "volume_changed",
  lost_at: "2026-10-14T19:00:00Z",
};

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    ...extra,
    { path: apiProject, method: "GET", body: projectFixture },
    { path: `${apiProject}/repos`, method: "GET", body: { items: [] } },
    { path: `${apiProject}/members`, method: "GET", body: { items: [] } },
    { path: `${apiProject}/conversations`, method: "GET", body: { items: [] } },
    { path: `${apiProject}/artifacts`, method: "GET", body: { artifacts: [artifactFixture] } },
    { path: workspacesPath, method: "GET", body: { workspaces: [workspaceFixture] } },
  ];
}

describe("project workspaces", () => {
  it("shows refs, volume identity and dirt — and no git action at all", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: routes() });

    const row = await screen.findByTestId(`workspace-row-${workspaceFixture.id}`);
    expect(row.textContent).toContain("conversation · worktree");
    expect(row.textContent).toContain("vol-7c1f7c");
    // A machine-produced ref is shown, and it is not a button.
    expect(row.textContent).toContain(workspaceFixture.repos[0]?.run_ref ?? "");
    expect(row.textContent).toContain("dirty: 2 paths");
    expect(row.textContent).toContain("1 excluded (materialized/APM paths, never staged)");
    // ADR-0017: the checkout is on one worker's volume, so nothing is offered.
    expect(row.querySelector("button:not([data-testid^='workspace-inspect'])")).toBeNull();
  });

  it("reads the worker's recorded status for one repository on demand", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: routes([
        {
          path: statusPath,
          method: "GET",
          body: {
            workspace_id: workspaceFixture.id,
            repository_id: workspaceFixture.repos[0]?.repository_id,
            run_ref: workspaceFixture.repos[0]?.run_ref,
            base_commit: workspaceFixture.repos[0]?.base_commit,
            head_commit: null,
            dirty: true,
            modified_paths: ["internal/api/secrets.go"],
            excluded_paths: ["backend/.env.test.local"],
            recorded_at: "2026-10-14T18:30:00Z",
          },
        },
      ]),
    });
    const repo = workspaceFixture.repos[0];
    fireEvent.click(
      await screen.findByTestId(`workspace-inspect-${workspaceFixture.id}-${repo?.name}`),
    );
    const status = await screen.findByTestId(
      `workspace-status-${workspaceFixture.id}-${repo?.name}`,
    );
    // It says so when the number is a stale record rather than a live git call.
    expect(status.textContent).toContain("not a live git status");
    expect(status.textContent).toContain("internal/api/secrets.go");
  });

  it("treats a quarantine as a finding and refuses to imply auto-cleanup", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: routes([
        { path: workspacesPath, method: "GET", body: { workspaces: [quarantined] } },
      ]),
    });
    const alert = await screen.findByTestId(`workspace-quarantined-${quarantined.id}`);
    expect(alert.textContent).toContain("reuse is blocked");
    expect(alert.textContent).toContain("nothing here is auto-cleaned");
    expect(screen.getByTestId(`workspace-state-${quarantined.id}`).textContent).toContain(
      "quarantined",
    );
  });

  it("says a lost workspace lost its edits, never that it resumed", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: routes([{ path: workspacesPath, method: "GET", body: { workspaces: [lost] } }]),
    });
    const alert = await screen.findByTestId(`workspace-lost-${lost.id}`);
    expect(alert.textContent).toContain("lost");
    expect(alert.textContent.toLowerCase()).not.toContain("resumed");
  });

  it("reads an unreadable workspace list as unknown state, not as an empty list", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: routes([
        {
          path: workspacesPath,
          method: "GET",
          status: 503,
          body: {
            type: "about:blank",
            title: "Unavailable",
            status: 503,
            detail: "worker offline",
          },
        },
      ]),
    });
    expect((await screen.findByTestId("workspace-list-error")).textContent).toContain(
      "state of any in-progress edit is unknown",
    );
  });

  it("shows an empty workspace list as a checkout that has not been prepared", async () => {
    renderApp({
      path: `/projects/${projectId}`,
      routes: routes([{ path: workspacesPath, method: "GET", body: { workspaces: [] } }]),
    });
    expect((await screen.findByTestId("workspace-list-empty")).textContent).toContain(
      "prepared the first time",
    );
  });

  it("lists the recent artifacts of the project on the same screen", async () => {
    renderApp({ path: `/projects/${projectId}`, routes: routes() });
    const row = await screen.findByTestId(`artifact-row-${artifactFixture.name}`);
    expect(row.textContent).toContain(artifactFixture.name);
  });
});

describe("/ops sandbox health", () => {
  it("labels each worker by mode and verdict together", async () => {
    renderApp({
      path: "/ops",
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/health", body: { status: "ok", replica: "r", version: "v" } },
        {
          path: "/api/v1/readiness",
          body: { status: "ready", schema_version: 3, expected_schema_version: 3 },
        },
        {
          path: "/api/v1/workers",
          body: {
            items: [
              {
                id: workerId,
                name: "worker-1",
                hostname: "h",
                version: "v",
                status: "online",
                started_at: "2026-10-14T18:00:00Z",
                last_heartbeat_at: "2026-10-14T18:30:00Z",
              },
            ],
          },
        },
        { path: sandboxPath, body: systemSandboxFixture },
      ],
    });

    const verifiedRow = await screen.findByTestId(`sandbox-worker-row-${testidOf(workerId)}`);
    expect(verifiedRow.textContent).toContain("required");
    expect(verifiedRow.textContent).toContain("verified");

    const permissive = screen.getByTestId(
      `sandbox-worker-row-${testidOf("01987a74-5556-7000-8000-abcdef012345")}`,
    );
    expect(permissive.textContent).toContain("permissive-dev");
    // The honest label, not a green check next to a mode that is not a boundary.
    expect(permissive.textContent).toContain("NOT a security boundary");
    expect(screen.getByTestId("sandbox-pinned-version").textContent).toBe("0.80.0");
    expect(screen.getByTestId("sandbox-policy-digest").textContent).toBe(
      systemSandboxFixture.policy_digest,
    );
  });

  it("calls an unverified `required` worker a failure rather than a pass", async () => {
    renderApp({
      path: "/ops",
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/health", body: { status: "ok", replica: "r", version: "v" } },
        {
          path: "/api/v1/readiness",
          body: { status: "ready", schema_version: 3, expected_schema_version: 3 },
        },
        { path: "/api/v1/workers", body: { items: [] } },
        {
          path: sandboxPath,
          body: {
            ...systemSandboxFixture,
            workers: [{ ...systemSandboxFixture.workers[0]!, verified: false }],
          },
        },
      ],
    });
    const row = await screen.findByTestId(`sandbox-worker-row-${testidOf(workerId)}`);
    expect(row.textContent).toContain("no verified launch yet");
    expect(row.textContent).toContain("not a capability");
  });

  it("names the storage-root identity per root, and refuses to invent one", async () => {
    renderApp({
      path: "/ops",
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/health", body: { status: "ok", replica: "r", version: "v" } },
        {
          path: "/api/v1/readiness",
          body: { status: "ready", schema_version: 3, expected_schema_version: 3 },
        },
        { path: "/api/v1/workers", body: { items: [] } },
        {
          path: sandboxPath,
          body: {
            ...systemSandboxFixture,
            workers: [
              {
                ...systemSandboxFixture.workers[0]!,
                volumes: [{ root_kind: "repos", volume_id: "" }],
              },
            ],
          },
        },
      ],
    });
    await screen.findByTestId("sandbox-worker-list");
    // An empty identity is ADR-0017's `unknown volume`, quoted per root.
    expect((await screen.findByTestId("volume-unknown-repos")).textContent).toContain(
      "no M3 workspace may bind here",
    );
  });

  it("says so when no worker has registered at all", async () => {
    renderApp({
      path: "/ops",
      routes: [
        { path: "/api/v1/me", body: meFixture },
        { path: "/api/v1/health", body: { status: "ok", replica: "r", version: "v" } },
        {
          path: "/api/v1/readiness",
          body: { status: "ready", schema_version: 3, expected_schema_version: 3 },
        },
        { path: "/api/v1/workers", body: { items: [] } },
        {
          path: sandboxPath,
          body: { ...systemSandboxFixture, workers: [] },
        },
      ],
    });
    // The heading renders while the read is in flight, so assert on the finding
    // itself rather than on the panel existing.
    expect(
      (
        await screen.findByText(
          "No worker has registered, so no agent here runs under any sandbox at all.",
        )
      ).textContent,
    ).toContain("No worker has registered");
  });
});

const conversationPath = `/api/v1/conversations/${conversationId}`;
const conversationPage = `/projects/${projectId}/conversations/${conversationId}`;

/** A conversation with a live turn, which is when a verdict is worth showing. */
const withTurn: Conversation = {
  ...conversationFixture,
  active_turn: {
    id: turnId,
    conversation_id: conversationId,
    status: "running",
    submitted_by: meFixture.id,
    created_at: "2026-10-14T18:10:00Z",
  },
};

function conversationRoutes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: apiProject, method: "GET", body: projectFixture },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    { path: conversationPath, method: "GET", body: withTurn },
    { path: workspacesPath, method: "GET", body: { workspaces: [workspaceFixture] } },
  ];
}

describe("a conversation's workspace and enforcement record", () => {
  it("shows this conversation's workspace in the rail, by ref not by host path", async () => {
    renderApp({ path: conversationPage, routes: conversationRoutes() });

    const row = await screen.findByTestId(`workspace-row-${workspaceFixture.id}`);
    expect(row.textContent).toContain(workspaceFixture.repos[0]?.run_ref ?? "");
    expect(row.textContent).not.toContain("/home/");
    expect(row.textContent).not.toContain("/workspaces/");
  });

  it("does not show another conversation's workspace", async () => {
    const other = {
      ...workspaceFixture,
      id: "01987a75-8000-7000-8000-abcdef012345",
      conversation_id: null,
    };
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([
        { path: workspacesPath, method: "GET", body: { workspaces: [other] } },
      ]),
    });
    expect((await screen.findByTestId("workspace-widget-empty")).textContent).toContain(
      "No workspace for this thread yet",
    );
  });

  it("shows the enforcement record for the running turn, including egress honesty", async () => {
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([{ path: turnSandboxPath, body: turnSandboxFixture }]),
    });

    await screen.findByTestId("sandbox-verdict-panel");
    const grants = screen.getByTestId("sandbox-grants");
    expect(grants.textContent).toContain("workspace_repo");
    expect(grants.textContent).toContain("rw");
    // AF_UNIX and egress are reported, not hidden, per ADR-0019 D3.
    expect(screen.getByTestId("sandbox-af-unix").textContent).toContain("pathname");
    expect(screen.getByTestId("sandbox-egress").textContent).toContain("NOT");
    expect(screen.getByTestId("sandbox-child-started").textContent).toBe("yes");
    expect(screen.getByTestId("sandbox-denied").textContent).toContain(
      "mirror_run_refs:rw denied for another scope",
    );
  });

  it("raises the failure stage as an alert, quoting the worker's own reason", async () => {
    const stopped: TurnSandbox = {
      ...turnSandboxFixture,
      stage: "grant_assert",
      reason: "temp_path_grant",
      verified: false,
      child_started: false,
    };
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([{ path: turnSandboxPath, body: stopped }]),
    });
    const alert = await screen.findByTestId("sandbox-verdict-alert");
    expect(alert.textContent).toContain("Nothing ran");
    expect(alert.textContent).toContain("grant_assert");
    expect(alert.textContent).toContain("no process was ever started");
  });

  it("labels a permissive launch as isolation=none rather than as a sandbox", async () => {
    const permissive: TurnSandbox = {
      ...turnSandboxFixture,
      backend: "none",
      enforcement: "permissive-dev",
      verified: false,
      network_enforced: false,
    };
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([{ path: turnSandboxPath, body: permissive }]),
    });
    await screen.findByTestId("sandbox-verdict-panel");
    expect(document.body.textContent).toContain("isolation=none");
  });

  it("does not invent a verdict for a turn with no record", async () => {
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([
        {
          path: turnSandboxPath,
          status: 404,
          body: { type: "about:blank", title: "Not Found", status: 404, detail: "no record" },
        },
      ]),
    });
    // The pending line carries the same testid, so wait for the verdict copy.
    expect((await screen.findByText(/no sandbox record for this turn/)).textContent).toContain(
      "never launched",
    );
  });

  it("says when the workspace read itself fails", async () => {
    renderApp({
      path: conversationPage,
      routes: conversationRoutes([
        {
          path: workspacesPath,
          status: 503,
          body: { type: "about:blank", title: "Unavailable", status: 503, detail: "worker down" },
        },
      ]),
    });
    expect((await screen.findByTestId("workspace-widget-error")).textContent).toContain(
      "worker down",
    );
  });
});
