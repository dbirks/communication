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
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Conversation, ConversationSummary, Project } from "../api/types";
import { renderApp } from "../test/render";
import {
  claudeProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  conversationSummaryFixture,
  FakeEventSource,
  meFixture,
  otherUserId,
  projectFixture,
  turnFixture,
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
    // …but that empty column is DESKTOP-only: below `lg` the phone shows the
    // list alone (the thread is one tap away, not a pane that draws empty under
    // the list — pass-2 review, 390). jsdom runs no media query, so the contract
    // is asserted on the classes that express it.
    const detail = screen.getByTestId("threads-detail-column");
    const cls = detail.className.split(/\s+/);
    expect(cls).toContain("hidden");
    expect(cls).toContain("lg:flex");
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

  it("says honestly what a server without the endpoint can not list — ONCE", async () => {
    const { requests } = renderApp({
      path: "/threads",
      routes: [me, users, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    // One loud banner, in the list column that failed — the pass-2 review found
    // the same refusal said twice (a quiet line in the pane and a loud banner in
    // the thread column), and the second one reflowed to the foot of the phone
    // page where nobody was looking. The failure is reachable at every width now
    // because it lives where the reader already is.
    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("Couldn't load the thread list");
    // The pass-3 review asked for a plain sentence: what the reader sees, and
    // where else to go — not the old `no rows are invented to fill the gap`.
    expect(alerts[0].textContent).toContain("none could be read");
    expect(alerts[0].textContent).not.toContain("invented");
    expect(await screen.findByTestId("threads-list-error")).toBeTruthy();
    // Independent review (1g server-error at 1280): the thread column no
    // longer invites a pick while there is nothing to pick — "No thread
    // selected / Pick a thread on the left" contradicted the banner beside it.
    // The column still stands as empty paper (pass review 1g defect 5: a dead
    // layout read as a broken app) and the refusal is still said exactly ONCE.
    expect(screen.queryByTestId("threads-no-selection")).toBeNull();
    expect(screen.queryByText("No thread selected")).toBeNull();
    expect(screen.queryByText(/Pick a thread on the left/)).toBeNull();
    const detail = screen.getByTestId("threads-detail-column");
    expect(detail.textContent).toBe("");
    const cls = detail.className.split(/\s+/);
    expect(cls).toContain("bg-paper");
    expect(cls).toContain("lg:flex");
    expect(await screen.findAllByRole("alert")).toHaveLength(1);
    expect(requests.some((request) => request.url === crossPath && request.method === "GET")).toBe(
      true,
    );
  });

  it("keeps the at-rest prompt while the list loads and when it answers empty", async () => {
    // Brief: loading and empty states keep their behaviour — only the error
    // state goes quiet, because that is the state with nothing to pick.
    renderApp({ path: "/threads", routes: routes([]) });
    // Once the shell is up (and the list read still in flight) the column
    // already holds the prompt.
    expect(await screen.findByTestId("threads-detail-column")).toBeTruthy();
    expect(screen.getByTestId("threads-no-selection").textContent).toContain("No thread selected");

    await screen.findByTestId("threads-list-empty");
    expect(screen.getByTestId("threads-list-empty").textContent).toContain("No threads yet");
    expect(screen.getByTestId("threads-no-selection").textContent).toContain("No thread selected");
  });

  it("drops 'No thread selected' from the right pane when the list read errors", async () => {
    renderApp({
      path: "/threads",
      routes: [me, users, { path: "/api/v1/projects", method: "GET", body: { items: [] } }],
    });
    await screen.findByTestId("threads-list-error");
    expect(screen.queryByTestId("threads-no-selection")).toBeNull();
    expect(screen.queryByText("No thread selected")).toBeNull();
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
    // Pass review 1g defect 6: the transcript column holds the transcript
    // ALONE (design 1g draws no WORKSPACE / ARTIFACTS / NEXT inline) — the
    // thread context is a collapsed disclosure at its end, every rail testid
    // still inside it and one click from the reader at every width.
    expect(context.tagName).toBe("DETAILS");
    expect((context as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByTestId("thread-context-disclosure").closest("details")).toBe(context);
    expect(within(context).getByTestId("workspace-widget")).toBeTruthy();
    // The context (workspace, artifacts, next) stays reachable in the pane —
    // it just no longer sits under the composer.
    expect(within(context).getByTestId("artifacts-rail")).toBeTruthy();
    expect(within(context).getByTestId("hand-to-workflow")).toBeTruthy();
  });

  it("wears design 1g's transcript column: the 720px cap and the plain tint bubble", async () => {
    // Pass review 1g defect 3: the user prompt is a plain tint bubble — the
    // shared Transcript row (used by the run-attempt pane too, outside this
    // brief) is restyled from the column that owns the 1g design: no border,
    // and the inline "alice:" prefix is screen-reader text again, not the
    // design's visible copy. The column is capped at 720px as drawn.
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    const main = await screen.findByTestId("conversation-main");
    const tokens = main.className.split(/\s+/);
    expect(tokens).toContain("max-w-[720px]");
    expect(tokens).toContain("[&_li.ml-auto]:border-0");
    expect(tokens).toContain("[&_li.ml-auto>span.font-semibold]:sr-only");
  });

  it("keeps the header one compact stack: no clipped meta words, no stray separator dots", async () => {
    // rcn-2e review defect 1 REPLACED pass review 1g's `lg:truncate`: with the
    // Threads list column and the 280px rail, the meta line at 1280 was cut to
    // “C…”, hiding the agent and the age. The contract now holds at every
    // width — the line WRAPS onto a second row (`lg:basis-full`) and names no
    // `truncate` anywhere, because two full lines of facts beat one clipped
    // row. repo-chain-r4 review item 3's 390 rule is unchanged and now covers
    // the desktop too. The status readout keeps its own row with no leading,
    // trailing or empty dot-segments: at rest it read "· idle — no turn yet · •"
    // — a queued `·` glyph, a separator over a wordless live-stream segment.
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    const meta = await screen.findByTestId("conversation-meta");
    const metaTokens = meta.className.split(/\s+/);
    expect(metaTokens).not.toContain("lg:truncate");
    expect(metaTokens).not.toContain("truncate");
    expect(metaTokens).toContain("lg:flex-1");
    expect(metaTokens).toContain("min-w-0");

    act(() => {
      FakeEventSource.last().open();
    });
    const turnWord = await screen.findByTestId("turn-status");
    expect(turnWord.textContent).toBe("idle — no turn yet");
    const readout = turnWord.parentElement as HTMLElement;
    expect(readout.textContent).not.toContain("·");
    expect(readout.textContent).not.toContain("●");
    // The stream state keeps its announced element even when nothing prints.
    expect(screen.getByTestId("stream-status").textContent).toBe("live");
  });

  it("shows the turn's glyph without a separator while a live turn runs", async () => {
    // "starting — a worker has the turn · •" was the second half of review
    // defect 2: a separator dot into a live stream with no word. The turn's
    // own glyph rides its word; the live stream adds no ink.
    renderApp({
      path: `/threads/${conversationId}`,
      routes: paneRoutes([
        {
          path: `/api/v1/conversations/${conversationId}`,
          method: "GET",
          body: { ...conversationFixture, active_turn: turnFixture() },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");
    act(() => {
      FakeEventSource.last().open();
    });
    const turnWord = await screen.findByTestId("turn-status");
    expect(turnWord.textContent).toBe("running");
    const readout = turnWord.parentElement as HTMLElement;
    expect(readout.textContent).not.toContain("·");
    expect(readout.textContent).toContain("●");
  });

  it("re-shelves the open thread under LIVE when its turn opens on this page", async () => {
    // Pass review 1g defect 1: the pane beside the open thread groups rows
    // off the cross-project summary read — the one conversation list the
    // per-frame SSE invalidation does not reach, so the open thread's row
    // kept its page-load shape and sat under EARLIER while its turn ran.
    // The session recomputes that shelf when the open turn flips; the pane
    // re-reads and re-shelves the row. The first page answer is the load-
    // time truth (no turn yet); the second is the wire after the send.
    const idleRow: ConversationSummary = {
      ...conversationSummaryFixture,
      status: "idle",
      has_active_turn: false,
    };
    const openTurnRow: ConversationSummary = {
      ...conversationSummaryFixture,
      status: "idle",
      has_active_turn: true,
    };
    const conversationWithTurn: Conversation = {
      ...conversationFixture,
      active_turn: turnFixture(),
    };
    renderApp({
      path: `/threads/${conversationId}`,
      routes: paneRoutes([
        {
          path: `/api/v1/conversations/${conversationId}`,
          method: "GET",
          body: (call: number) => (call === 1 ? conversationFixture : conversationWithTurn),
        },
        {
          path: crossPath,
          method: "GET",
          body: (call: number) => ({
            items: call === 1 ? [idleRow] : [openTurnRow],
            next_cursor: null,
          }),
        },
      ]),
    });

    // At load the wire said "no turn": the row sits under EARLIER.
    const row = await screen.findByTestId(`thread-row-${conversationId}`);
    expect(row.getAttribute("aria-current")).toBe("page");

    // The prompt goes in and the turn opens: the stream says so, and the
    // detail refetch brings `active_turn` — the pane's shelf is recomputed
    // and the row lands under LIVE without a remount.
    act(() => {
      FakeEventSource.last().open();
    });
    act(() => {
      FakeEventSource.last().emit(
        conversationEvent("conversation.message.user", {
          submitted_by: meFixture.id,
          text: "Hello from the pane",
        }),
      );
      FakeEventSource.last().emit(conversationEvent("conversation.turn.started", {}));
    });

    const liveGroup = await waitFor(() => screen.getByTestId("threads-group-live"), {
      timeout: 5000,
    });
    expect(liveGroup.contains(screen.getByTestId(`thread-row-${conversationId}`))).toBe(true);
    expect(screen.queryByTestId("threads-group-earlier")).toBeNull();
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
      "you're in control",
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
    // instead of truncating to a word under the pill; the meta line runs the
    // full width with the quiet readout in its flow, and only `lg+` pulls the
    // pill back onto the title row and the readout to the line's right.
    // rcn-2e review defect 1 took the two-line clamp out at `lg+` as well —
    // the thread's own name is never the thing that gives way (the same rule
    // a68240c set for run titles), so the H1 WRAPS at every width and names no
    // truncate or clamp anywhere.
    renderApp({ path: `/threads/${conversationId}`, routes: paneRoutes() });
    const title = await screen.findByTestId("conversation-title");
    const titleRow = (title.parentElement as HTMLElement).className.split(/\s+/);
    expect(titleRow).toContain("flex-col");
    expect(titleRow).toContain("lg:flex-row");

    const titleTokens = title.className.split(/\s+/);
    expect(titleTokens).toContain("wrap-anywhere"); // a long slug breaks inside
    expect(titleTokens).not.toContain("truncate");
    expect(titleTokens).not.toContain("lg:truncate");
    expect(titleTokens).not.toContain("line-clamp-2");
    // The title keeps a MEASURE (`basis-[16rem] grow`) rather than `flex-1`:
    // with `flex-1` (basis 0) a 412px pane gave the 45-character name 138px —
    // seven lines — because the control row beside it is `lg:shrink-0`. A basis
    // the row cannot shrink past makes the control row wrap onto its own line
    // instead, which is what design 1g's narrow pane looks like.
    expect(titleTokens).toContain("lg:basis-[16rem]");
    expect(titleTokens).toContain("lg:grow");
    expect(titleTokens).not.toContain("lg:flex-1");
    expect((title.parentElement as HTMLElement).className.split(/\s+/)).toContain("lg:flex-wrap");

    // The pill and the acts share their own row below `lg` (a sibling of the
    // title in the stacked row container).
    const controls = screen.getByTestId("controller-badge").parentElement?.parentElement;
    expect(controls?.parentElement).toBe(title.parentElement);
    expect(controls).not.toBe(title);

    // Pass-3 review defect 5: below `lg` that row is the 1280 row turned
    // sideways — a full-width, LEFT-aligned line under the title — not a
    // shrink-to-fit block right-aligned against the pane's edge, which is what
    // made "No controller — take control to drive" and its button look like
    // they were floating over the thread. `lg:` puts the design's right-hand
    // placement back. Pass-1 review (threads-1g-not-controller-390) changed
    // the lone act's shape: at 390 `Take control` is a COMPACT button (auto
    // width, 44px touch height) on the same line as its `○` glyph, not the
    // full-width primary bar it used to stretch into; the controller's two
    // acts (Return control + Stop) still share one inline line.
    const rowTokens = controls?.className.split(/\s+/) ?? [];
    expect(rowTokens).toContain("justify-start");
    expect(rowTokens).toContain("lg:justify-end");
    expect(rowTokens).toContain("[&>div:first-child]:w-full");
    expect(rowTokens).toContain("lg:[&>div:first-child]:w-auto");
    expect(rowTokens).not.toContain("[&>div:first-child]:justify-end");
    expect(rowTokens).toContain("lg:[&>div:first-child]:justify-end");
    expect(rowTokens).not.toContain("[&>div:first-child>span:last-child>button:only-child]:w-full");
    expect(rowTokens).toContain("max-lg:[&>div:first-child>span:last-child>button]:h-[44px]");

    // The meta line never ellipsises (review 1g defects 2 and 4; repo-chain-r4
    // item 3; rcn-2e defect 1 took the `lg` ellipsis out too) — plain block
    // flow that wraps at every width, no floated narrow column; `lg:` gives
    // the design's shape back.
    const meta = screen.getByTestId("conversation-meta");
    const metaRow = (meta.parentElement as HTMLElement).className.split(/\s+/);
    expect(metaRow).not.toContain("flex");
    expect(metaRow).toContain("lg:flex");
    expect(metaRow).not.toContain("justify-between");
    expect(metaRow).toContain("lg:justify-between");
    expect(meta.className.split(/\s+/)).not.toContain("flex-1");
    expect(meta.className.split(/\s+/)).not.toContain("truncate");
    // The readout flows after the meta line as one inline group, carrying
    // the turn word and (only when it is not live) the stream state.
    const readout = screen.getByTestId("turn-status").parentElement as HTMLElement;
    expect(readout.tagName).toBe("SPAN");
    expect(readout.parentElement).toBe(meta.parentElement);
    expect(readout.contains(screen.getByTestId("stream-status"))).toBe(true);
  });
});
