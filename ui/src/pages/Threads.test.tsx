/**
 * Threads page (routes `/threads` + the pane at `/threads/:id`, design 1g):
 * the 320px cross-project list beside the open thread. Rows are
 * `ConversationSummary` rows from `GET /api/v1/conversations` (C3 / ADR-0047)
 * — the page names projects and profiles from the directories, groups rows
 * LIVE / EARLIER off the server's own flags, and draws the ADR-0065
 * `repository_name` / `last_agent_line` only when the wire serves them (an
 * older server, or an unbound/silent thread, falls back to `project · agent`
 * with no last line). Empty, error and populated states are each proven here;
 * `/threads/:id` selects its row in the pane.
 */
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ConversationSummary, Project } from "../api/types";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  meFixture,
  otherUserId,
  projectFixture,
  type RouteStub,
} from "../test/fakes";

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const users: RouteStub = { path: "/api/v1/users", method: "GET", body: { items: [] } };
const crossPath = "/api/v1/conversations";

const anotherProject: Project = {
  id: "01987a90-8888-7000-8000-abcdef888888",
  slug: "atlas",
  name: "Atlas",
  description: "Atlas services",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  my_role: "contributor",
};

/** A live one-off: `status: active` — the server's own "session attached". */
const liveManual = conversationSummaryFixture;

/** An EARLIER row: idle (no session, no turn), run-origin, somebody else's. */
const earlierRun: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a91-9999-7000-8000-abcdef999999",
  title: "Review loop for the release run",
  project_id: anotherProject.id,
  origin: "run",
  status: "idle",
  agent_connected: false,
  has_active_turn: false,
  created_by: otherUserId,
  created_by_display_name: "Dana Observer",
  updated_at: "2026-10-14T18:20:00Z",
};

/** A disconnected row: the state word shows next to the glyph. */
const disconnectedRow: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a92-aaaa-7000-8000-abcdefaaaaaa",
  title: "Explain the refund webhook flow",
  status: "disconnected",
  agent_connected: false,
  updated_at: "2026-10-13T18:20:00Z",
};

function routes(items: ConversationSummary[], extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    me,
    users,
    {
      path: "/api/v1/projects",
      method: "GET",
      body: { items: [projectFixture, anotherProject] },
    },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: [claudeProfile] } },
    { path: crossPath, method: "GET", body: { items, next_cursor: null } },
  ];
}

describe("/threads (design 1g: list pane beside the thread)", () => {
  it("lists every thread grouped LIVE / EARLIER with project and profile names", async () => {
    renderApp({ path: "/threads", routes: routes([liveManual, earlierRun, disconnectedRow]) });

    const page = await screen.findByTestId("threads-page");
    expect(page).toBeTruthy();

    // By default nothing is filtered: run-origin rows are listed too (the old
    // "one-off only" default is gone with design 1g).
    const liveRow = await screen.findByTestId(`thread-row-${liveManual.id}`);
    const earlierRow = await screen.findByTestId(`thread-row-${earlierRun.id}`);
    expect(liveRow.getAttribute("href")).toBe(`/threads/${liveManual.id}`);
    expect(liveRow.textContent).toContain(projectFixture.name);
    expect(liveRow.textContent).toContain("Claude Code");
    expect(liveRow.textContent).toMatch(/\d+[smhd]/);
    // The status is a glyph; the word appears only for disconnected.
    expect(within(earlierRow).queryByText("idle", { exact: false })).toBeNull();
    const disconnected = await screen.findByTestId(`thread-row-${disconnectedRow.id}`);
    expect(disconnected.textContent).toContain("disconnected");

    // Grouping follows the server's flags: `active` sits under LIVE, idle and
    // disconnected rows under EARLIER.
    const liveGroup = screen.getByTestId("threads-group-live");
    expect(liveGroup.textContent).toContain("LIVE");
    expect(liveGroup.contains(liveRow)).toBe(true);
    const earlierGroup = screen.getByTestId("threads-group-earlier");
    expect(earlierGroup.textContent).toContain("EARLIER");
    expect(earlierGroup.contains(earlierRow)).toBe(true);
    expect(earlierGroup.contains(disconnected)).toBe(true);

    // At `/threads` no thread is open: the right column says so honestly.
    expect(await screen.findByTestId("threads-no-selection")).toBeTruthy();
  });

  it("draws ADR-0065's repository and last agent line when the wire serves them", async () => {
    // A repo-bound row with an agent that has spoken: the design's
    // `project / repo · agent` and the last line, both served fields.
    const repoBound: ConversationSummary = {
      ...liveManual,
      id: "01987a93-bbbb-7000-8000-abcdefbbbbbb",
      repository_id: "01987a93-1234-7000-8000-abcdef123456",
      repository_name: "communication",
      last_agent_line: "Pushed the fix; CI is green now.",
    };
    // A row whose fields are explicitly null: no binding, silent agent.
    const unbound: ConversationSummary = {
      ...liveManual,
      id: "01987a93-cccc-7000-8000-abcdefcccccc",
      repository_id: null,
      repository_name: null,
      last_agent_line: null,
    };
    renderApp({ path: "/threads", routes: routes([repoBound, unbound, liveManual]) });

    const row = await screen.findByTestId(`thread-row-${repoBound.id}`);
    expect(row.textContent).toContain(`${projectFixture.name} / communication`);
    expect(row.textContent).toContain("Claude Code");
    expect(screen.getByTestId(`thread-last-line-${repoBound.id}`).textContent).toContain(
      "Pushed the fix; CI is green now.",
    );

    // Nulls and a missing field (an older server's row, `liveManual`) both
    // fall back honestly: the project alone, and no last line.
    const unboundRow = await screen.findByTestId(`thread-row-${unbound.id}`);
    expect(unboundRow.textContent).toContain(`${projectFixture.name} · Claude Code`);
    expect(unboundRow.textContent).not.toContain("communication");
    expect(screen.queryByTestId(`thread-last-line-${unbound.id}`)).toBeNull();
    expect(screen.queryByTestId(`thread-last-line-${liveManual.id}`)).toBeNull();
  });

  it("filters with the chips: mine by author, from runs by origin", async () => {
    renderApp({ path: "/threads", routes: routes([liveManual, earlierRun]) });

    await screen.findByTestId(`thread-row-${liveManual.id}`);
    expect(screen.getByTestId(`thread-row-${earlierRun.id}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId("threads-filter-mine"));
    expect(await screen.findByTestId(`thread-row-${liveManual.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`thread-row-${earlierRun.id}`)).toBeNull();

    fireEvent.click(screen.getByTestId("threads-filter-runs"));
    expect(await screen.findByTestId(`thread-row-${earlierRun.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`thread-row-${liveManual.id}`)).toBeNull();

    fireEvent.click(screen.getByTestId("threads-filter-all"));
    expect(await screen.findByTestId(`thread-row-${liveManual.id}`)).toBeTruthy();
    expect(screen.getByTestId(`thread-row-${earlierRun.id}`)).toBeTruthy();
  });

  it("searches titles client-side and says when the page matches nothing", async () => {
    renderApp({ path: "/threads", routes: routes([liveManual, earlierRun]) });

    const search = await screen.findByTestId("threads-search");
    fireEvent.change(search, { target: { value: "billing" } });
    expect(await screen.findByTestId(`thread-row-${liveManual.id}`)).toBeTruthy();
    expect(screen.queryByTestId(`thread-row-${earlierRun.id}`)).toBeNull();

    fireEvent.change(search, { target: { value: "nothing like this" } });
    expect(await screen.findByTestId("threads-nomatch")).toBeTruthy();
    expect(screen.queryByTestId("threads-list")).toBeNull();
  });

  it("offers the empty state when the caller has no threads at all", async () => {
    renderApp({ path: "/threads", routes: routes([]) });
    expect(await screen.findByTestId("threads-list-empty")).toBeTruthy();
    expect(screen.getByTestId("threads-list-empty").textContent).toContain("No threads yet");
  });

  it("runs the threads routes full-bleed: no max-w-5xl column around the panes", async () => {
    // Design 1g: the list pane is 320px and the thread fills the rest of the
    // content column at full height — the shell's centred 64rem column would
    // squeeze the header and unpin the composer (App.tsx's bleed predicate).
    renderApp({ path: "/threads", routes: routes([liveManual]) });
    await screen.findByTestId("threads-page");
    expect(document.querySelector("main")?.className).not.toContain("max-w-5xl");
    expect(document.querySelector("main")?.className).toContain("w-full");
  });

  it("says honestly what a server without the endpoint can not list", async () => {
    const { requests } = renderApp({
      path: "/threads",
      routes: [me, users, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("could not be loaded");
    expect(await screen.findByTestId("threads-list-error")).toBeTruthy();
    expect(requests.some((request) => request.url === crossPath && request.method === "GET")).toBe(
      true,
    );
  });

  it("walks the keyset page when the list carries a cursor", async () => {
    const firstPage: RouteStub = {
      path: crossPath,
      method: "GET",
      body: { items: [liveManual], next_cursor: "cursor-2" },
    };
    const { fetchMock } = renderApp({
      path: "/threads",
      routes: routes([liveManual], [firstPage]),
    });

    const next = await screen.findByTestId("threads-next-page");
    fireEvent.click(next);
    await screen.findByTestId("threads-first-page");
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("cursor=cursor-2"))).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("threads-first-page"));
    expect(screen.getByTestId(`thread-row-${liveManual.id}`)).toBeTruthy();
  });
});

describe("/threads/:id (the thread renders inside the pane)", () => {
  function paneRoutes(extra: RouteStub[] = []): RouteStub[] {
    return [
      ...extra,
      me,
      users,
      { path: "/api/v1/projects", method: "GET", body: { items: [projectFixture] } },
      { path: "/api/v1/agent-profiles", method: "GET", body: { items: [claudeProfile] } },
      {
        path: `/api/v1/projects/${projectFixture.id}`,
        method: "GET",
        body: projectFixture,
      },
      {
        path: `/api/v1/projects/${projectFixture.id}/workspaces`,
        method: "GET",
        body: { workspaces: [] },
      },
      {
        path: `/api/v1/projects/${projectFixture.id}/artifacts`,
        method: "GET",
        body: { artifacts: [] },
      },
      {
        path: `/api/v1/conversations/${conversationId}`,
        method: "GET",
        body: conversationFixture,
      },
      {
        path: crossPath,
        method: "GET",
        body: { items: [conversationSummaryFixture], next_cursor: null },
      },
    ];
  }

  it("selects the row and renders the thread in the right column", async () => {
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });

    // The thread renders on the right, the list stays on the left with the
    // open thread raised (the selected row) — design 1g's one screen.
    expect((await screen.findByTestId("conversation-title")).textContent).toBe(
      conversationFixture.title,
    );
    expect(screen.getByTestId("thread-list-pane")).toBeTruthy();
    const row = await screen.findByTestId(`thread-row-${conversationId}`);
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.textContent).toContain(conversationFixture.title);
    // The pane's composer and transcript are the shared surface, so the
    // thread-control journey keeps working here.
    expect(await screen.findByTestId("composer-input")).toBeTruthy();
    expect(screen.getByTestId("conversation-meta").textContent).toContain("Claude Code");
    expect(screen.getByTestId("thread-branch").textContent).toContain("no branch recorded");
  });

  it("pins the composer as the last thing on the pane, below the transcript and its context", async () => {
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    await screen.findByTestId("conversation-title");

    // The composer rides its own pin at the column's end: the transcript
    // column and the thread context both precede it in the pane.
    const pin = screen.getByTestId("thread-composer-pin");
    expect(within(pin).getByTestId("composer-input")).toBeTruthy();
    const main = screen.getByTestId("conversation-main");
    const context = screen.getByTestId("thread-context-block");
    expect(main.contains(screen.getByTestId("transcript-empty"))).toBe(true);
    expect(main.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(context.compareDocumentPosition(pin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The context (workspace, artifacts, next) stays reachable in the pane —
    // it just no longer sits under the composer.
    expect(within(context).getByTestId("artifacts-rail")).toBeTruthy();
    expect(within(context).getByTestId("hand-to-workflow")).toBeTruthy();
  });

  it("wears the 1g header: title, mono meta, and only the pill and the acts on the right", async () => {
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    const title = await screen.findByTestId("conversation-title");
    const header = title.closest("header");
    expect(header).toBeTruthy();
    // Full-bleed like the list route (App.tsx's bleed predicate covers both).
    expect(document.querySelector("main")?.className).not.toContain("max-w-5xl");

    // The control pill and the acts belong to the header; the manual chip is
    // gone with design 1g (the "one-off only" default is dropped), and the
    // stream/turn state is the quiet readout, not a pile of chips.
    expect(within(header as HTMLElement).getByTestId("controller-badge").textContent).toBe(
      "You are in control",
    );
    expect(within(header as HTMLElement).getByTestId("return-control")).toBeTruthy();
    expect(within(header as HTMLElement).getByTestId("turn-status").textContent).toContain("idle");
    expect(within(header as HTMLElement).getByTestId("stream-status")).toBeTruthy();
    expect(within(header as HTMLElement).queryByTestId("conversation-manual-label")).toBeNull();
    // The old inline chip labels are gone (the readout carries no "stream:" /
    // "turn:" prefixes any more).
    expect(header?.textContent).not.toContain("stream:");
    expect(header?.textContent).not.toContain("turn:");
    // The meta line is the design's `repo · branch · agent` — the repo half
    // lands with the workspace read (the stub serves none: the honest label).
    await screen.findByText("no workspace yet");
    expect(within(header as HTMLElement).getByTestId("conversation-meta").textContent).toContain(
      "no workspace yet",
    );
  });

  it("stacks the header below the pane breakpoint: full-width title and meta, the acts on their own row", async () => {
    // The phone shape (390x844): the title owns a full-width row and wraps
    // (two lines at most) instead of truncating to a word under the pill;
    // the meta line runs the full width with the quiet readout in its flow,
    // and only `lg+` pulls the pill back onto the title row and the readout
    // to the line's right (the 1280 design shape must not change).
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    const title = await screen.findByTestId("conversation-title");
    const titleRow = (title.parentElement as HTMLElement).className.split(/\s+/);
    expect(titleRow).toContain("flex-col");
    expect(titleRow).toContain("lg:flex-row");

    const titleTokens = title.className.split(/\s+/);
    expect(titleTokens).toContain("line-clamp-2");
    expect(titleTokens).not.toContain("truncate"); // clamps only from lg up
    expect(titleTokens).toContain("lg:truncate");

    // The pill and the acts share their own row below `lg` (a sibling of the
    // title in the stacked row container).
    const controls = screen.getByTestId("controller-badge").parentElement?.parentElement;
    expect(controls?.parentElement).toBe(title.parentElement);
    expect(controls).not.toBe(title);

    // The meta line is plain block flow below `lg` — no floated flex row
    // squeezing the text into a narrow column; `lg:` restores the design.
    const meta = screen.getByTestId("conversation-meta");
    const metaRow = (meta.parentElement as HTMLElement).className.split(/\s+/);
    expect(metaRow).not.toContain("flex");
    expect(metaRow).toContain("lg:flex");
    expect(metaRow).not.toContain("justify-between");
    expect(metaRow).toContain("lg:justify-between");
    expect(meta.className.split(/\s+/)).not.toContain("flex-1");
    // The readout flows after the meta line as one inline group, carrying
    // the turn word and the stream glyph.
    const readout = screen.getByTestId("turn-status").parentElement as HTMLElement;
    expect(readout.tagName).toBe("SPAN");
    expect(readout.parentElement).toBe(meta.parentElement);
    expect(readout.contains(screen.getByTestId("stream-status"))).toBe(true);
  });
});
