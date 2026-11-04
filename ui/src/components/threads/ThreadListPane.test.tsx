/**
 * Thread list rows and the chat's SCOPE (rcn-2e works-in-moved, round 9).
 *
 * A row names a repository only from the API's own `repository_name` — a
 * row the wire answers null names no repository at all, and the list row
 * carries no workspace field for the pane to fall back through: a whole-
 * project chat is never named after a workspace's checkout. A bound chat
 * prints the name the row carries.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  claudeProfile,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  type RouteStub,
} from "../../test/fakes";
import { renderApp } from "../../test/render";
import type { ConversationSummary } from "../../api/types";

const wholeProjectRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a63-1111-7000-8000-abcdef000001",
  title: "Move the billing service",
  repository_id: null,
  repository_name: null,
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
      body: { items: [wholeProjectRow, boundRow, runRow, newlineRow], next_cursor: null },
    },
  ];
}

describe("thread list rows name the chat's scope, and only the wire's", () => {
  it(
    "a null-scoped chat never names a repository — the row is project · agent, no repo crumb",
    { timeout: 15_000 },
    async () => {
      renderApp({ path: "/threads", routes: routes() });
      const row = await screen.findByTestId(`thread-row-${wholeProjectRow.id}`);
      // The mono line is `project · agent` — no repository between them, so
      // a whole-project chat is not named after the workspace's checkout.
      expect(row.textContent).toContain(`${projectFixture.name} · ${claudeProfile.name}`);
      expect(row.textContent).not.toContain("server");
    },
  );

  it("a bound chat names its repository as `project / repo`", { timeout: 15_000 }, async () => {
    renderApp({ path: "/threads", routes: routes() });
    const row = await screen.findByTestId(`thread-row-${boundRow.id}`);
    expect(row.textContent).toContain(`${projectFixture.name} / server`);
    expect(row.textContent).toContain(claudeProfile.name);
  });
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
