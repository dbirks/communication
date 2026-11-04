/**
 * The repo feed's chat rows and the chat's SCOPE (rcn-2e works-in-moved,
 * round 9): a feed row names the chat by its title, state and AGENT
 * profile — never by a repository. A whole-project chat carried into the
 * feed by the server's own `?repository=` filter is not renamed after the
 * page's repository, and no workspace fallback exists in this component
 * for a repo crumb to name.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { buildActivityRows, RepoActivity } from "./RepoActivity";
import { projectFixture } from "../../test/fakes";
import { testidOf } from "../../lib/format";
import type { ConversationSummary } from "../../api/types";
import { conversationFixture } from "../../test/fakes";

afterEach(cleanup);

function renderFeed(rows: ReturnType<typeof buildActivityRows>) {
  render(
    <MemoryRouter>
      <RepoActivity
        rows={rows}
        nameFor={() => null}
        profileNameFor={() => "Claude Code"}
        meId={null}
        repositoryName="web"
        projectId={projectFixture.id}
        runsPending={false}
        runsError={null}
        onRetryRuns={() => {}}
        retryingRuns={false}
        chatsPending={false}
        chatsError={null}
        onRetryChats={() => {}}
        retryingChats={false}
      />
    </MemoryRouter>,
  );
}

describe("the repo feed's chat rows never name the chat's repository", () => {
  it("a chat with no repository answers as title · state · agent — no repo crumb anywhere on the row", () => {
    const chat: ConversationSummary = {
      ...conversationFixture,
      title: "Move the billing service",
      repository_id: null,
      repository_name: null,
    };
    renderFeed(buildActivityRows([], [chat]));
    const row = screen.getByTestId(`repo-chat-row-${testidOf(chat.id)}`);
    expect(row.textContent).toContain("Move the billing service");
    expect(row.textContent).toContain("Claude Code");
    // No repository crumb: the page's own repository and any workspace
    // checkout are not the chat's scope, and the row prints neither.
    expect(row.textContent).not.toContain("web");
    expect(row.textContent).not.toContain("server");
  });

  it("a chat the wire answers with a repository still rows as title · state · agent", () => {
    const chat: ConversationSummary = {
      ...conversationFixture,
      title: "Fix the flaky checkout",
      repository_id: "01987a79-aaaa-7000-8000-abcdef033333",
      repository_name: "server",
    };
    renderFeed(buildActivityRows([], [chat]));
    const row = screen.getByTestId(`repo-chat-row-${testidOf(chat.id)}`);
    expect(row.textContent).toContain("Fix the flaky checkout");
    // The row's fourth cell is the agent, and the wire's repository name
    // never rides a feed row — the repository it answers is the PAGE's,
    // printed once in the page header, not on every chat.
    expect(row.textContent).toContain("Claude Code");
    expect(row.textContent).not.toContain("server");
    expect(row.textContent).not.toContain("web");
  });
});
