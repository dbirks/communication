/**
 * Thread list rows and the chat's SCOPE (rcn-2e works-in-moved, round 9;
 * rcn-review12).
 *
 * A row names a repository only from the API's own `repository_name` — a
 * row the wire answers null names no repository at all, and the list row
 * carries no workspace field for the pane to fall back through: a whole-
 * project chat is never named after a workspace's checkout. When the server
 * answers `repository_id: null` (a moved or born-unbound chat, ADR-0067
 * amendment) the row says `project / Whole project` — the scope is a fact the
 * wire states, not an absence. A bound chat prints the name the row carries.
 */
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import { renderApp } from "../../test/render";
import type { Conversation, ConversationSummary } from "../../api/types";

const wholeProjectRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-1111-7000-8000-abcdef000001",
  title: "Move the billing service",
  repository_id: null,
  repository_name: null,
};

// rcn-review13 item 1: the row the wire can still answer after a move —
// `repository_id` null by the row's own contract while the other
// repository member carries the workspace's checkout name. The id is the
// scope fact; the name beside it is not a scope.
const movedRowWithStaleName: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-9999-7000-8000-abcdef000009",
  title: "Emu rcn pass-2 — 2026-11-03",
  repository_id: null,
  repository_name: "server",
};

const boundRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-2222-7000-8000-abcdef000002",
  title: "Fix the flaky checkout",
  repository_id: "01987a79-aaaa-7000-8000-abcdef033333",
  repository_name: "server",
};

// A run-origin thread whose agent ended on structured output: the server's
// preview rule (internal/store/postgres/conversations.go) reads the blob's own
// `summary`/`title` when one is there and otherwise answers the plain word —
// a chunk the worker's cap split mid-blob never reaches the row as `"]}}`.
const runRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-3333-7000-8000-abcdef000003",
  title: "run 01a1a4f5 /plan attempt 1",
  status: "idle",
  origin: "run",
  last_agent_line: "structured output",
};

// A run row whose served preview still carries a real newline (the server
// collapses its previews, but the wire contract is one line — the row must
// render it as such, never wrap, never add escaping of its own).
const newlineRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-4444-7000-8000-abcdef000004",
  title: "run 01a1a58e /plan attempt 1",
  status: "idle",
  origin: "run",
  last_agent_line: "Fix hello.py so it is documented.\n- Keep the API stable",
};

function routes(): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    {
      path: "/api/v1/conversations",
      body: {
        items: [wholeProjectRow, movedRowWithStaleName, boundRow, runRow, newlineRow],
        next_cursor: null,
      },
    },
  ];
}

describe("thread list rows name the chat's scope, and only the wire's", () => {
  it(
    "a null-scoped chat says `project / Whole project` — never a repository",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${wholeProjectRow.id}`);
      // The mono line is `project / Whole project · agent` — the server's
      // `repository_id: null` says the whole project, and a whole-project
      // chat is not named after the workspace's checkout.
      expect(row.textContent).toContain(
        `${projectFixture.name} / Whole project · ${claudeProfile.name}`,
      );
      expect(row.textContent).not.toContain("server");
    },
  );

  it("a bound chat names its repository as `project / repo`", { timeout: 15_000 }, async () => {
    renderApp({ path: "/threads", routes: routes() });
    const row = await screen.findByTestId(`thread-row-${boundRow.id}`);
    expect(row.textContent).toContain(`${projectFixture.name} / server`);
    expect(row.textContent).toContain(claudeProfile.name);
  });

  it(
    "a row whose own id says null never prints a repository, even with the name member set (rcn-review13)",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${movedRowWithStaleName.id}`);
      // The row's `repository_id: null` is the wire's "works in the whole
      // project" — the `repository_name` beside it is the derivation's
      // workspace checkout, not the chat's scope. Never a repository.
      expect(row.textContent).toContain(
        `${projectFixture.name} / Whole project · ${claudeProfile.name}`,
      );
      expect(row.textContent).not.toContain("server");
    },
  );
});

describe("thread list previews stay readable for structured output", () => {
  it(
    "a run row ending on structured output shows the served plain word, muted — never JSON punctuation",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${runRow.id}`);
      const lastLine = screen.getByTestId(`thread-last-line-${runRow.id}`);
      // The server answers `structured output` for a blob it cannot read as a
      // headline (or a chunk the cap split mid-blob); the row prints it verbatim,
      // in the muted preview line — round-11 saw `"]}}` under the run's title.
      expect(lastLine.textContent).toBe("structured output");
      expect(lastLine.className).toContain("text-muted");
      expect(row.textContent).not.toContain("]}}");
      expect(row.textContent).not.toContain('{"plan');
      // The thread sits in the EARLIER group: an idle run thread is not live.
      const earlier = screen.getByTestId("threads-group-earlier");
      expect(earlier.textContent).toContain(runRow.title);
      expect(screen.getByTestId("threads-group-live").textContent).not.toContain(runRow.title);
    },
  );

  it(
    "a preview the wire serves with a newline renders as ONE line, verbatim — no added escaping",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${newlineRow.id}`);
      const lastLine = screen.getByTestId(`thread-last-line-${newlineRow.id}`);
      // The served line prints verbatim — the row adds no escaping of its
      // own (the literal `\\n` the round-12 review saw was the server's
      // bug; the UI never re-escapes either way).
      expect(lastLine.textContent).toBe("Fix hello.py so it is documented.\n- Keep the API stable");
      expect(lastLine.textContent).not.toContain("\\n");
      expect(lastLine.textContent).not.toContain("\\\\n");
      // One line no matter what the wire carries: the preview is a block
      // whose `truncate` keeps it a single (clipped) line, not a wrap.
      expect(lastLine.className).toContain("truncate");
      expect(lastLine.className).toContain("block");
      expect(row.textContent).toContain(newlineRow.title);
    },
  );
});

describe("the thread list follows a WORKS-IN move (rcn-review12)", () => {
  // The chat is bound to `web` until the switcher moves it to the whole
  // project. The list row the pane reads answers the three-arm derivation:
  // the declared binding while it is set — and AFTER the move, the workspace
  // arm keeps naming the project's other repository (rcn-review13 item 1:
  // the selected row printed `Emu / server` while the header said Whole
  // project). The pane's `declaredScope` (the detail read's own
  // `repository_id`) is what must outrank that derivation for this row.
  const webRepoId = "01987a79-aaaa-7000-8000-abcdef044444";
  const serverRepoId = "01987a79-bbbb-7000-8000-abcdef044444";
  const webRepo = {
    id: webRepoId,
    project_id: projectFixture.id,
    name: "web",
    git_url: "https://git.example/web.git",
    default_branch: "main",
    created_at: "2026-10-14T18:00:00Z",
    credential: "none",
  };
  const serverRepo = {
    ...webRepo,
    id: serverRepoId,
    name: "server",
    git_url: "https://git.example/server.git",
  };
  const boundConversationDetail: Conversation = {
    ...conversationFixture,
    repository_id: webRepoId,
    repository_name: "web",
  };
  const movedConversationDetail: Conversation = {
    ...conversationFixture,
    repository_id: null,
    // the detail's three-arm name keeps answering the workspace's checkout
    repository_name: "server",
  };
  const boundListRow: ConversationSummary = {
    ...conversationSummaryFixture,
    repository_id: webRepoId,
    repository_name: "web",
  };
  const movedListRow: ConversationSummary = {
    ...conversationSummaryFixture,
    // the workspace arm answers for both members after the move
    repository_id: serverRepoId,
    repository_name: "server",
  };

  it(
    "after the scope change succeeds, the selected live row reads `project / Whole project` — no manual refresh",
    { timeout: 15_000 },
    async () => {
      const { requests } = renderApp({
        path: `/threads/${conversationId}`,
        routes: [
          { path: "/api/v1/me", body: meFixture },
          { path: "/api/v1/users", body: { items: [] } },
          { path: "/api/v1/projects", body: { items: [projectFixture] } },
          { path: `/api/v1/projects/${projectFixture.id}`, body: projectFixture },
          { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
          {
            path: `/api/v1/projects/${projectFixture.id}/repos`,
            body: { items: [webRepo, serverRepo] },
          },
          {
            // The cross-project thread list the pane reads: the first answer
            // (before the move) still names the old binding, the refetch the
            // mutation triggers answers the moved row.
            path: "/api/v1/conversations",
            body: (n: number) => ({
              items: n === 1 ? [boundListRow] : [movedListRow],
              next_cursor: null,
            }),
          },
          {
            path: `/api/v1/projects/${projectFixture.id}/conversations`,
            body: { items: [movedListRow] },
          },
          {
            path: `/api/v1/conversations/${conversationId}`,
            method: "GET",
            body: (n: number) => (n === 1 ? boundConversationDetail : movedConversationDetail),
          },
          {
            path: `/api/v1/conversations/${conversationId}`,
            method: "PATCH",
            body: movedConversationDetail,
          },
          { path: `/api/v1/projects/${projectFixture.id}/workspaces`, body: { workspaces: [] } },
          { path: `/api/v1/projects/${projectFixture.id}/artifacts`, body: { items: [] } },
          { path: `/api/v1/conversations/${conversationId}/notes`, body: { notes: [] } },
        ],
      });

      // The selected row still names the binding the wire last answered.
      const row = await screen.findByTestId(`thread-row-${conversationId}`);
      expect(row.textContent).toContain(`${projectFixture.name} / web`);
      // And the header's meta line names it too.
      expect((await screen.findByTestId("conversation-meta")).textContent).toContain("web");

      // The WORKS-IN switcher in the rail moves the thread to the whole
      // project.
      await screen.findByTestId("side-panel-works-in-switch");
      fireEvent.click(screen.getByTestId("side-panel-works-in-switch"));
      fireEvent.click(await screen.findByTestId("side-panel-scope-item-whole"));

      // One PATCH, the null binding.
      const patch = await vi
        .waitFor(() => {
          const found = requests.find(
            (request) =>
              request.method === "PATCH" &&
              request.url === `/api/v1/conversations/${conversationId}`,
          );
          expect(found?.body).toBe(JSON.stringify({ repository_id: null }));
          return found;
        })
        .catch(() => null);
      expect(patch).toBeTruthy();

      // The fresh conversation lands in the shared cache …
      // … and every list the pane reads follows it: even though the refetched
      // row still answers the workspace arm (`server`), the selected row says
      // the whole project — the detail's declared scope outranks the
      // derivation (rcn-review13 item 1) — with the header and switcher
      // agreeing.
      await vi.waitFor(() =>
        expect(screen.getByTestId(`thread-row-${conversationId}`).textContent).toContain(
          `${projectFixture.name} / Whole project`,
        ),
      );
      expect(screen.getByTestId(`thread-row-${conversationId}`).textContent).not.toContain(
        "server",
      );
      expect(screen.getByTestId("conversation-meta").textContent).toContain("Whole project");
      expect(screen.getByTestId("side-panel-works-in-switch").textContent).toContain(
        "Whole project",
      );
    },
  );
});
