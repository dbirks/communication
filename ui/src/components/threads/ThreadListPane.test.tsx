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
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import {
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  mockFetch,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import { renderApp } from "../../test/render";
import { ThreadListPane } from "./ThreadListPane";
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
// The title is the LEGACY server naming (run-id prefix + node instance key)
// with the row's own run_link (ADR-0043) beside it: the pane renders that
// row in words from the link, never the raw ids (round-16 DEFECT).
const runRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-3333-7000-8000-abcdef000003",
  title: "run 01a1a4f5 /plan attempt 1",
  status: "idle",
  origin: "run",
  last_agent_line: "structured output",
  run_link: {
    run_id: "01a1a4f5-bbbb-7000-8000-abcdef000003",
    node_execution_id: "01987a80-cccc-7000-8000-abcdef000003",
    node_instance_key: "/plan",
    node_id: "plan",
    attempt_id: "01987a80-dddd-7000-8000-abcdef000003",
    attempt_number: 1,
  },
};

// A run row whose served preview still carries a real newline (the server
// collapses its previews, but the wire contract is one line — the row must
// render it as such, never wrap, never add escaping of its own). Its node is
// nested in an until body: the worded title keeps only the last segment.
const newlineRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-4444-7000-8000-abcdef000004",
  title: "run 01a1a58e /build_until_verified[1]/code_review attempt 1",
  status: "idle",
  origin: "run",
  last_agent_line: "Fix hello.py so it is documented.\n- Keep the API stable",
  run_link: {
    run_id: "01a1a58e-eeee-7000-8000-abcdef000004",
    node_execution_id: "01987a80-ffff-7000-8000-abcdef000004",
    node_instance_key: "/build_until_verified[1]/code_review",
    node_id: "code_review",
    attempt_id: "01987a80-1111-7000-8000-abcdef000004",
    attempt_number: 1,
  },
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
      // The group shows the worded title, not the stored id title.
      const worded = "Plan · run #01a1";
      const earlier = screen.getByTestId("threads-group-earlier");
      expect(earlier.textContent).toContain(worded);
      expect(earlier.textContent).not.toContain(runRow.title);
      expect(screen.getByTestId("threads-group-live").textContent).not.toContain(worded);
    },
  );

  it(
    "a run-origin row still named in raw ids renders in words, the run reference demoted to muted text (round-16)",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${runRow.id}`);
      // The worded title: the node's human label and the short run reference —
      // the raw run-id prefix and the bare node key never reach the screen.
      expect(row.textContent).toContain("Plan · run #01a1");
      expect(row.textContent).not.toContain(runRow.title);
      // The run reference demotes to its own muted secondary line.
      const ref = screen.getByTestId(`thread-run-ref-${runRow.id}`);
      expect(ref.textContent).toBe("run #01a1 · attempt 1");
      expect(ref.className).toContain("text-muted");
      // A nested node keeps only its last segment — the same words the server
      // now titles with.
      const nested = await screen.findByTestId(`thread-row-${newlineRow.id}`);
      expect(nested.textContent).toContain("Code review · run #01a1");
      expect(nested.textContent).not.toContain(newlineRow.title);
      expect(screen.getByTestId(`thread-run-ref-${newlineRow.id}`).textContent).toBe(
        "run #01a1 · attempt 1",
      );
      // A manual row keeps its own title verbatim and carries no run line.
      const manual = screen.getByTestId(`thread-row-${wholeProjectRow.id}`);
      expect(manual.textContent).toContain(wholeProjectRow.title);
      expect(
        manual.querySelector(`[data-testid="thread-run-ref-${wholeProjectRow.id}"]`),
      ).toBeNull();
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
      // whose `truncate` keeps it a single (clipped) line, not a wrap. The
      // row's own title is the worded form — the stored raw-id title is
      // gone from the screen (round-16).
      expect(lastLine.className).toContain("truncate");
      expect(lastLine.className).toContain("block");
      expect(row.textContent).toContain("Code review · run #01a1");
      expect(row.textContent).not.toContain(newlineRow.title);
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

// m5-inbox (lab-e2e): the row wears the conversation's OWN state word — the
// `ds/states` rule that a state carries its glyph AND its word, never the
// glyph (colour/shape) alone. An active chat reads `● … · active`, an idle
// one `· … · idle`, on the mono meta line where `disconnected` and `archived`
// have always printed their word.
describe("thread rows carry the state WORD, not only the glyph", () => {
  const activeRow: ConversationSummary = {
    ...conversationSummaryFixture,
    id: "01987a63-5555-7000-8000-abcdef000005",
    title: "m5 two-context",
    status: "active",
    has_active_turn: false,
  };
  const idleRow: ConversationSummary = {
    ...conversationSummaryFixture,
    id: "01987a63-6666-7000-8000-abcdef000006",
    title: "quiet thread",
    status: "idle",
    has_active_turn: false,
  };

  it(
    "an active row prints `active`, an idle row prints `idle` (glyph + word)",
    { timeout: 15_000 },
    async () => {
      renderApp({
        path: "/threads",
        routes: [
          { path: "/api/v1/me", body: meFixture },
          { path: "/api/v1/projects", body: { items: [projectFixture] } },
          { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
          {
            path: "/api/v1/conversations",
            body: { items: [activeRow, idleRow], next_cursor: null },
          },
        ],
      });
      const row = await screen.findByTestId(`thread-row-${activeRow.id}`);
      expect(row.textContent).toMatch(/active/);
      // The word rides the mono meta line with the other facts, and the
      // glyph stays decorative (`aria-hidden`) — the word is the cue.
      expect(row.querySelector('[aria-hidden="true"]')?.textContent).toBe("●");
      const idle = await screen.findByTestId(`thread-row-${idleRow.id}`);
      expect(idle.textContent).toMatch(/idle/);
    },
  );
});

/**
 * Finding 07, review pass on the 907a578 captures (DEFECT at 1280 and 390):
 * `/threads` draws the shared `PageBand` ("Threads"), and the pane printed a
 * SECOND `Threads` H1 with the `New thread` button under it. Whoever draws the
 * band owns the title and the one verb; the pane keeps its search, chips and
 * rows. Where NO band stands above the column — the open thread at
 * `/threads/:id`, which mounts this pane beside the transcript, and the
 * loading frame — the pane is the column's only title, so it keeps both.
 */
describe("the pane's title belongs to whoever draws the band (finding 07)", () => {
  /** The pane on its own, the way a host with no band mounts it. */
  function mountPane(props: Parameters<typeof ThreadListPane>[0] = {}) {
    mockFetch(routes());
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ThreadListPane {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it(
    "under the page band: the pane draws no heading, and the verb rides the band",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const pane = await screen.findByTestId("threads-page");
      const band = screen.getByTestId("page-band");

      // ONE `Threads` H1 on the screen, and it is the band's.
      expect(screen.getAllByRole("heading", { level: 1, name: "Threads" })).toHaveLength(1);
      expect(band.querySelector("h1")?.textContent).toBe("Threads");
      expect(pane.querySelector("h1")).toBeNull();

      // The button that used to ride the pane's heading moved with it, test id
      // and all — the emulator still presses `threads-new-open` on `/threads`.
      const verb = screen.getByTestId("threads-new-open");
      expect(band.contains(verb)).toBe(true);
      expect(pane.contains(verb)).toBe(false);
      // …and it is still the verb that opens the shared dialog.
      fireEvent.click(verb);
      expect(await screen.findByTestId("new-conversation-dialog")).toBeTruthy();

      // What the pane keeps: its search, its chips, its rows.
      expect(screen.getByTestId("threads-search")).toBeTruthy();
      expect(screen.getByTestId("threads-filters")).toBeTruthy();
      expect(await screen.findByTestId(`thread-row-${boundRow.id}`)).toBeTruthy();
    },
  );

  it(
    "with no band above the column, the pane still names itself and offers the verb",
    { timeout: 15_000 },
    async () => {
      mountPane();
      const pane = await screen.findByTestId("threads-page");
      expect(pane.querySelector("h1")?.textContent).toBe("Threads");
      expect(pane.contains(screen.getByTestId("threads-new-open"))).toBe(true);
    },
  );
});
