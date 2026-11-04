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

function routes(): RouteStub[] {
  return [
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    {
      path: "/api/v1/conversations",
      body: { items: [wholeProjectRow, boundRow], next_cursor: null },
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
