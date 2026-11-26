/**
 * A chat's workspace and enforcement record, ported from the old conversation
 * page (`pages/Conversation.tsx`, `/p/:p/threads/:id`, no longer routed) onto
 * its replacement: `components/chats/ChatThread.tsx`, the right column of
 * `pages/Chats.tsx` (`/p/:projectId/chats/:conversationId`).
 *
 * What moved is the shelf, not the facts. The old page kept a visible rail;
 * design 3 puts the same `WorkspaceWidget` and `TurnSandboxPanel` behind the
 * header's "…" menu → Details (`ChatDetailsSheet`), so every test opens that
 * sheet first and then asserts exactly what it asserted before: a workspace is
 * named by its `run_ref` and never by a host path, another thread's workspace
 * is not this thread's, a `permissive-dev` launch says isolation=none, a turn
 * with no record invents no verdict, and a failed read says which read failed.
 *
 * (The project-level workspace panel and the `/ops` fleet sandbox rows are the
 * same components under the redesign's Manage pages — they stay in
 * `pages/WorkspacesSandbox.test.tsx`.)
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import Chats from "../../pages/Chats";
import type { Conversation, TurnSandbox, Workspace } from "../../api/types";
import {
  FakeEventSource,
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  turnId,
  turnSandboxFixture,
  workspaceFixture,
  type RouteStub,
} from "../../test/fakes";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.reset();
});

const projectId = projectFixture.id;
const workspacesPath = `/api/v1/projects/${projectId}/workspaces`;
const turnSandboxPath = `/api/v1/turns/${turnId}/sandbox`;

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

function chatRoutes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/users", body: { items: [] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: `/api/v1/projects/${projectId}`, body: projectFixture },
    { path: `/api/v1/projects/${projectId}/repos`, body: { items: [] } },
    { path: `/api/v1/projects/${projectId}/assignments`, body: { assignments: [] } },
    {
      path: `/api/v1/projects/${projectId}/issue-triggers`,
      body: { issue_triggers: [] },
    },
    { path: `/api/v1/projects/${projectId}/runs`, body: { runs: [] } },
    { path: `/api/v1/projects/${projectId}/artifacts`, body: { artifacts: [] } },
    { path: "/api/v1/pipelines", body: { pipelines: [] } },
    {
      path: "/api/v1/conversations",
      body: { items: [conversationSummaryFixture], next_cursor: null },
    },
    {
      path: `/api/v1/projects/${projectId}/conversations`,
      body: { items: [conversationSummaryFixture] },
    },
    { path: `/api/v1/conversations/${conversationId}`, method: "GET", body: withTurn },
    { path: `/api/v1/conversations/${conversationId}/assistant-notes`, body: { notes: [] } },
    { path: workspacesPath, method: "GET", body: { workspaces: [workspaceFixture] } },
  ];
}

/** Open the chat, then open the "…" menu's Details sheet the way a person does. */
async function openDetails(extra: RouteStub[] = []) {
  const { requests } = mockFetch(chatRoutes(extra));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${projectId}/chats/${conversationId}`]}>
        <Routes>
          <Route path="/p/:projectId/chats/:conversationId?" element={<Chats />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByTestId("chat-header");
  fireEvent.click(screen.getByTestId("chat-menu"));
  fireEvent.click(await screen.findByTestId("chat-menu-details"));
  return { requests };
}

describe("a chat's workspace and enforcement record", () => {
  it("shows this chat's workspace, by ref not by host path", async () => {
    await openDetails();
    const row = await screen.findByTestId(`workspace-row-${workspaceFixture.id}`);
    expect(row.textContent).toContain(workspaceFixture.repos[0]?.run_ref ?? "");
    expect(row.textContent).not.toContain("/home/");
    expect(row.textContent).not.toContain("/workspaces/");
  });

  it("does not show another conversation's workspace", async () => {
    const other: Workspace = {
      ...workspaceFixture,
      id: "01987a75-8000-7000-8000-abcdef012345",
      conversation_id: null,
    };
    await openDetails([{ path: workspacesPath, method: "GET", body: { workspaces: [other] } }]);
    expect((await screen.findByTestId("workspace-widget-empty")).textContent).toContain(
      "No workspace for this thread yet",
    );
  });

  it("shows the enforcement record for the running turn, including egress honesty", async () => {
    await openDetails([{ path: turnSandboxPath, body: turnSandboxFixture }]);

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
    await openDetails([{ path: turnSandboxPath, body: stopped }]);
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
    await openDetails([{ path: turnSandboxPath, body: permissive }]);
    await screen.findByTestId("sandbox-verdict-panel");
    expect(document.body.textContent).toContain("isolation=none");
  });

  it("does not invent a verdict for a turn with no record", async () => {
    await openDetails([
      {
        path: turnSandboxPath,
        status: 404,
        body: { type: "about:blank", title: "Not Found", status: 404, detail: "no record" },
      },
    ]);
    // The pending line carries the same testid, so wait for the verdict copy.
    expect((await screen.findByText(/no sandbox record for this turn/)).textContent).toContain(
      "never launched",
    );
  });

  it("says when the workspace read itself fails", async () => {
    await openDetails([
      {
        path: workspacesPath,
        status: 503,
        body: { type: "about:blank", title: "Unavailable", status: 503, detail: "worker down" },
      },
    ]);
    const error = await screen.findByTestId("workspace-widget-error");
    expect(within(error).getByText(/worker down/)).toBeTruthy();
  });
});
