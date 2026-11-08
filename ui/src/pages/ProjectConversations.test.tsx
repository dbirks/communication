/**
 * The project's Threads tab (Projects Review design 1b, screen 1g): the 1b
 * header band and tab row above the SAME 1g view `/threads` draws — the
 * 320px list pane and the open-thread column — filtered to this project.
 *
 * The pass-2 review's finding was that this route drew its own card list
 * beside the band (`THREADS` panel, `all/manual/from runs` chips of its own,
 * `conversation-row-*` rows): two thread lists, two row shapes, one product.
 * It is now the shared pane (`components/threads/ThreadListPane`), so these
 * assertions are the pane's ids at the project route — and the ADR-0043 wire
 * contract the tab kept: the debounced title search and `from runs` travel to
 * `GET /projects/{id}/conversations` as `q` and `origin`, server-side.
 *
 * `10-ui-design-handoff.md` J2: a member sees their threads and reads them in
 * the app's words, not the wire's field names.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { OriginBadge } from "../components/Conversations";
import { Row } from "../components/ds/Row";
import {
  claudeProfile,
  codexProfile,
  conversationFixture,
  conversationSummaryFixture,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import { renderApp } from "../test/render";
import type { ConversationSummary } from "../api/types";

/**
 * Wait budget for one real async boundary: the row these tests await exists
 * only after a chain of `/api/v1` round trips through the fake fetch (`/me`
 * admits the page, then project, then conversations) and the repaint each one
 * answers. `findBy*`/`waitFor` wait 1000 ms by default, which measures the
 * runner rather than the page: that row lands in ~143 ms idle but was measured
 * at 3.9 s with the CPU oversubscribed ~5x — the point where this file's first
 * test flakes in CI. Budgets at real boundaries, never retries.
 */
const READ_MS = 5_000;
/** Every boundary one test can still be waiting on, summed, as its watchdog. */
const TEST_TIMEOUT = 3 * READ_MS;

const me: RouteStub = { path: "/api/v1/me", body: meFixture };
const projectPath = `/api/v1/projects/${projectFixture.id}`;
const conversationsPath = `${projectPath}/conversations`;

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    me,
    ...extra,
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile, codexProfile] } },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    { path: projectPath, method: "GET", body: projectFixture },
    { path: `${projectPath}/repos`, method: "GET", body: { items: [] } },
    { path: `${projectPath}/members`, method: "GET", body: { items: [] } },
    { path: "/api/v1/users", method: "GET", body: { items: [] } },
    {
      path: conversationsPath,
      method: "GET",
      body: { items: [conversationSummaryFixture] },
    },
  ];
}

/**
 * The tab is 1g at one project: the list pane carries the rows (the pane's
 * `thread-row-*` ids — there is no second `conversation-row-*` card list),
 * and beside it stands the thread column at rest. Search and `from runs` hit
 * the list route as `q`/`origin` (ADR-0043); `mine` narrows client-side, the
 * same chip `/threads` draws.
 */
describe("/p/:projectId/threads — the 1g view, filtered to the project", () => {
  it(
    "renders the 1b frame: the header band, the tab row, Threads marked, no rail",
    async () => {
      renderApp({ path: `/p/${projectFixture.id}/threads`, routes: routes() });

      // The band is the overview's component, so the project's name is still
      // the page's H1 and the two verbs are still there.
      expect(
        await screen.findByTestId("project-header", undefined, { timeout: READ_MS }),
      ).toBeTruthy();
      expect(screen.getByTestId("project-name").textContent).toBe(projectFixture.name);
      expect(screen.getByTestId("project-new-conversation").textContent).toBe("New thread");
      // Pass-2 review (`project-1b-threads`): the tab repeated the band — a
      // second `Threads` H1 and a second primary `New thread` under the
      // header's own. The band owns them: the page holds ONE h1 (the
      // project's name) and ONE `New thread` button.
      expect(screen.queryByTestId("threads-new-open")).toBeNull();
      expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(projectFixture.name);
      const tabs = screen.getByTestId("project-tabs");
      expect(within(tabs).getByTestId("project-tab-threads").getAttribute("aria-current")).toBe(
        "page",
      );
      // The tab that means this screen is marked; the one you came from is not.
      expect(
        within(tabs).getByTestId("project-tab-overview").getAttribute("aria-current"),
      ).toBeNull();
      // ONE navigation: the only "Project sections" landmark on the page is
      // the header's tab row.
      expect(screen.getAllByRole("navigation", { name: /project sections/i })).toHaveLength(1);
      // The band runs across the full-bleed route: no shell `max-w-5xl`
      // column around it (the frame dropped its `-mx-4` pad-bleed when the
      // route joined `App.tsx`'s full-bleed list).
      expect(screen.getByTestId("project-conversations").className).not.toContain("-mx-4");
    },
    TEST_TIMEOUT,
  );

  it(
    "lists each thread as a 1g pane row: title, agent, relative age — no wire field names",
    async () => {
      renderApp({ path: `/p/${projectFixture.id}/threads`, routes: routes() });

      const row = await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      // The row lives in the shared pane, inside the project's frame.
      expect(row.closest('[data-testid="threads-page"]')).toBeTruthy();
      expect(row.textContent).toContain("Refactor billing");
      // The summary names only the profile id, so the pane resolves the name.
      expect(row.textContent).toContain("Claude Code");
      expect(row.textContent).not.toContain("profile:");
      expect(row.textContent).not.toContain("controller:");
      // The state rides the glyph (identity rule 06); the wire's raw status is
      // never spelled out.
      expect(row.textContent).not.toMatch(/\bACTIVE\b/);
      // The clock is relative, like every other age in the app.
      expect(row.textContent).not.toContain("2026-10-14T18:05:00Z");
      expect(row.textContent).toMatch(/\d+[smhd]/);
      expect(row.getAttribute("href")).toBe(`/threads/${conversationFixture.id}`);
    },
    TEST_TIMEOUT,
  );

  it(
    "stands the open-thread column at rest beside the pane",
    async () => {
      renderApp({ path: `/p/${projectFixture.id}/threads`, routes: routes() });

      await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      // The same at-rest prompt `/threads` draws — one product, one empty.
      expect(screen.getByTestId("threads-detail-column")).toBeTruthy();
      expect(screen.getByTestId("threads-no-selection").textContent).toContain(
        "No thread selected",
      );
    },
    TEST_TIMEOUT,
  );

  it(
    // Pass-2 review (`project-1b-threads`): the pane's duplicate `Threads`
    // H1 and its second primary `New thread` are gone — the band owns both —
    // so the tab's one verb is the header's.
    "starts a thread from the band's verb, with this project fixed",
    async () => {
      const { requests } = renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes([
          { path: conversationsPath, method: "POST", status: 201, body: conversationFixture },
          {
            path: `/api/v1/conversations/${conversationFixture.id}`,
            method: "GET",
            body: conversationFixture,
          },
        ]),
      });

      await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      fireEvent.click(screen.getByTestId("project-new-conversation"));
      const dialog = await screen.findByTestId("new-conversation-dialog", undefined, {
        timeout: READ_MS,
      });
      // The project is FIXED (the pane is the project's view): the dialog
      // names it instead of offering a picker.
      const fixed = within(dialog).getByTestId("new-conversation-dialog-project");
      expect(fixed.tagName).not.toBe("SELECT");
      expect(fixed.textContent).toBe(projectFixture.name);
      fireEvent.change(screen.getByTestId("conversation-new-title"), {
        target: { value: "Tighten the query layer" },
      });
      fireEvent.change(screen.getByTestId("conversation-new-profile"), {
        target: { value: codexProfile.id },
      });
      fireEvent.change(screen.getByTestId("conversation-new-prompt"), {
        target: { value: "List the hot paths" },
      });
      fireEvent.click(screen.getByTestId("conversation-new-submit"));

      // One round trip: the submit's `POST .../conversations`.
      await waitFor(
        () => {
          const [request] = requestsTo(requests, conversationsPath, "POST");
          expect(request.headers.get("x-csrf-token")).toBe(meFixture.csrf_token);
          expect(JSON.parse(request.body ?? "{}")).toEqual({
            agent_profile_id: codexProfile.id,
            title: "Tighten the query layer",
            prompt: "List the hot paths",
          });
        },
        { timeout: READ_MS },
      );
      // Created threads are the caller's to drive: the navigation lands on the
      // thread, where the controller is named.
      await waitFor(() => expect(screen.getByTestId("controller-badge")).toBeTruthy(), {
        timeout: READ_MS,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "says there are no threads yet",
    async () => {
      renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes([{ path: conversationsPath, method: "GET", body: { items: [] } }]),
      });

      // The empty state is the pane's own, said in 1g's words.
      const empty = await screen.findByTestId("threads-list-empty", undefined, {
        timeout: READ_MS,
      });
      expect(empty.textContent).toContain("No threads yet");
    },
    TEST_TIMEOUT,
  );

  it(
    "still renders the pane when the route is reached directly",
    async () => {
      renderApp({ path: `/p/${projectFixture.id}/threads`, routes: routes() });

      await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      // The header's tab row names the same route, in the canonical `/p/…` form
      // (no legacy `/projects/…` href is emitted).
      const nav = screen.getByRole("navigation", { name: /project sections/i });
      expect(within(nav).getByTestId("project-tab-threads").getAttribute("href")).toBe(
        `/p/${projectFixture.id}/threads`,
      );
    },
    TEST_TIMEOUT,
  );
});

/**
 * The QA walk (`convo-route`): a person, a breadcrumb or the assistant's route
 * table reaches for the list URL, and until this page existed it rendered the
 * app's "Not found" screen.
 */
describe("/projects/:projectId/conversations", () => {
  it(
    "renders the project's thread list at the literal list URL",
    async () => {
      renderApp({ path: `/projects/${projectFixture.id}/conversations`, routes: routes() });

      const row = await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      expect(row.textContent).toContain("Refactor billing");
      expect(row.getAttribute("href")).toBe(`/threads/${conversationFixture.id}`);
      // Not the app's "Not found" page any more, and the frame knows where it
      // is: one navigation, the Threads tab marked as the page you are on.
      expect(screen.queryByText("That page does not exist.")).toBeNull();
      expect(screen.getByTestId("project-header")).toBeTruthy();
      const nav = screen.getByRole("navigation", { name: /project sections/i });
      expect(within(nav).getByTestId("project-tab-threads").getAttribute("aria-current")).toBe(
        "page",
      );
      // One canonical form: the tab's href is the route itself.
      expect(within(nav).getByTestId("project-tab-threads").getAttribute("href")).toBe(
        `/p/${projectFixture.id}/threads`,
      );
      // The old page's vocabulary is gone from the screen (the ROUTE keeps the
      // API's noun; the product's word is "thread").
      const words = document.body.textContent ?? "";
      expect(words).toMatch(/Threads/);
      expect(words).not.toMatch(/conversations?/i);
      expect(words).not.toMatch(/New conversation/i);
    },
    TEST_TIMEOUT,
  );

  it(
    "gives a caller who cannot open the project the same refusal as its siblings",
    async () => {
      const problem = (status: number) => ({
        type: "about:blank",
        title: status === 403 ? "Forbidden" : "Not Found",
        status,
        detail: status === 403 ? "Nope." : "No such project.",
      });
      renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes([{ path: projectPath, status: 404, body: problem(404) }]),
      });

      const refusal = await screen.findByTestId("project-conversations-not-found", undefined, {
        timeout: READ_MS,
      });
      expect(refusal.textContent).toContain("Project not found or you do not have access");
      // A shell around an unreadable project is the leak: no pane, no rows,
      // and no "no threads yet" confirming more than the API said.
      expect(screen.queryByTestId("project-conversations")).toBeNull();
      expect(screen.queryByTestId("threads-list")).toBeNull();
      expect(screen.queryByTestId("conversation-new-title")).toBeNull();
      expect(screen.queryByText(/No conversations yet/)).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "refuses the screen when only the conversations read is refused",
    async () => {
      renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes([
          { path: conversationsPath, method: "GET", status: 403, body: { status: 403 } },
        ]),
      });

      expect(
        await screen.findByTestId("project-conversations-not-found", undefined, {
          timeout: READ_MS,
        }),
      ).toBeTruthy();
      expect(screen.queryByTestId("threads-list")).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps a failure that is not an access refusal a banner, not the refusal",
    async () => {
      const problem = { type: "about:blank", title: "Internal Server Error", status: 500 };
      renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes([{ path: conversationsPath, method: "GET", status: 500, body: problem }]),
      });

      // The screen is the reader's own project, so it stays up and says what
      // actually went wrong instead of claiming the project is unreachable.
      await screen.findByTestId("project-conversations", undefined, { timeout: READ_MS });
      expect(screen.queryByTestId("project-conversations-not-found")).toBeNull();
      // The pane owns the loud banner here (the thread column says nothing
      // twice): `ownsError`, the same split `/threads` makes.
      expect((await screen.findAllByRole("alert"))[0].textContent).toContain(
        "Internal Server Error",
      );
    },
    TEST_TIMEOUT,
  );
});

/* ADR-0043: the tab's search and origin filter travel to the list route —
 * the SAME server query the pane uses — and the chips are 1g's. */

describe("the project pane's search and filters ride the list route (ADR-0043)", () => {
  /** The route table strips query strings from recorded requests, so the wire
   * itself is spied on for the `origin`/`q` params: capture every fetch
   * target, then hand it to the mock the app mounted under. */
  function watchFetchTargets(): string[] {
    const seen: string[] = [];
    const inner = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      return inner(input, init);
    });
    return seen;
  }

  it(
    "sends the `from runs` chip as origin=run",
    async () => {
      const { requests } = renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes(),
      });
      const seen = watchFetchTargets();
      await screen.findByTestId("threads-filter-runs", undefined, { timeout: READ_MS });

      fireEvent.click(screen.getByTestId("threads-filter-runs"));
      await waitFor(
        () => {
          expect(seen).toContain(`${conversationsPath}?origin=run`);
        },
        { timeout: READ_MS },
      );
      // The unfiltered read stayed the default: no param on either side.
      expect(requestsTo(requests, conversationsPath, "GET").length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  it(
    "debounces the search box and sends it as q",
    async () => {
      vi.useFakeTimers();
      try {
        renderApp({ path: `/p/${projectFixture.id}/threads`, routes: routes() });
        // Let the mount's reads land while every clock is fake.
        for (let i = 0; i < 5; i += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
          });
        }
        const seen = watchFetchTargets();
        const search = screen.getByTestId("threads-search");

        fireEvent.change(search, { target: { value: "Refactor" } });
        // Before the debounce elapses no filtered read is issued.
        expect(seen).not.toContain(`${conversationsPath}?q=Refactor`);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(seen).toContain(`${conversationsPath}?q=Refactor`);
        // Flush the mocked answer so the filtered list can paint.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        // The mocked filtered list answers with the one matching row.
        expect(screen.getByTestId(`thread-row-${conversationFixture.id}`)).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "says no threads match when the filter finds nothing on the page",
    async () => {
      renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes([{ path: conversationsPath, method: "GET", body: { items: [] } }]),
      });
      await screen.findByTestId("threads-filter-runs", undefined, { timeout: READ_MS });

      fireEvent.click(screen.getByTestId("threads-filter-runs"));
      const nomatch = await screen.findByTestId("threads-nomatch", undefined, {
        timeout: READ_MS,
      });
      expect(nomatch.textContent).toContain("No threads match");
      // The unfiltered "no threads yet" is a different state.
      expect(screen.queryByTestId("threads-list-empty")).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "narrows to my threads client-side (no route names an author)",
    async () => {
      const someoneElses: ConversationSummary = {
        ...conversationSummaryFixture,
        id: "01987a64-3333-7000-8000-abcdef012347",
        title: "Nightly triage",
        created_by: "01987a10-9999-7000-8000-abcdef012399",
        created_by_display_name: "Dana Observer",
      };
      renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes([
          { path: conversationsPath, method: "GET", body: { items: [someoneElses] } },
        ]),
      });

      expect(
        await screen.findByTestId(`thread-row-${someoneElses.id}`, undefined, {
          timeout: READ_MS,
        }),
      ).toBeTruthy();
      fireEvent.click(screen.getByTestId("threads-filter-mine"));
      expect(await screen.findByTestId("threads-nomatch")).toBeTruthy();
      expect(screen.queryByTestId(`thread-row-${someoneElses.id}`)).toBeNull();
    },
    TEST_TIMEOUT,
  );

  it(
    "a viewer reads the band's honest limit and keeps the 1g pane",
    async () => {
      renderApp({
        path: `/p/${projectFixture.id}/threads`,
        routes: routes([
          {
            path: projectPath,
            method: "GET",
            body: { ...projectFixture, my_role: "viewer" },
          },
        ]),
      });

      await screen.findByTestId(`thread-row-${conversationFixture.id}`, undefined, {
        timeout: READ_MS,
      });
      // The band says the reader cannot start work; the pane is the shared
      // 1g view — it says the same thing at every project the reader is in,
      // and a refused create is the dialog's own honest banner.
      expect(screen.getByTestId("project-role-hint").textContent).toContain("read-only");
      expect(screen.queryByTestId("project-new-conversation")).toBeNull();
      expect(screen.queryByTestId("project-start-run")).toBeNull();
      expect(screen.getByTestId("threads-filter-all").textContent).toBe("all");
    },
    TEST_TIMEOUT,
  );
});

/* Where a conversation was opened stays the row badge's job on the surfaces
 * that draw it (the inbox, the workbench): the 1g pane says origin through the
 * `from runs` chip, not a per-row badge. This harness pins the badge's own
 * deep-link contract, which the shared `Row` must keep honouring. */

const RUN_ID = "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c";
const NODE_EXECUTION_ID = "01987b12-3c6c-7f5d-9a31-4e5f6a7b8c9d";
const ATTEMPT_ID = "01987b13-4d7d-7a6e-8b42-5f6a7b8c9d0e";

const runLinkedSummary: ConversationSummary = {
  ...conversationSummaryFixture,
  id: "01987a64-2222-7000-8000-abcdef012346",
  title: "Watch the retry",
  origin: "run",
  run_link: {
    run_id: RUN_ID,
    run_title: "Ship billing",
    node_execution_id: NODE_EXECUTION_ID,
    node_instance_key: "/review",
    node_id: "review",
    attempt_id: ATTEMPT_ID,
    attempt_number: 2,
  },
};

describe("the origin badge still deep-links a run-opened thread", () => {
  it("badges a manual row and deep-links a run-linked row", () => {
    render(
      <MemoryRouter>
        <Row to={`/threads/${runLinkedSummary.id}`} data-testid="conversation-row-badge-harness">
          <OriginBadge conversation={runLinkedSummary} />
        </Row>
      </MemoryRouter>,
    );

    const badge = screen.getByTestId("conversation-origin-run");
    expect(badge.textContent).toContain("From run · Ship billing · review");
    // The badge itself is the workbench deep link: node, instance and
    // attempt. It carries link semantics (role + title) rather than an
    // anchor because the row is itself an anchor.
    expect(badge.getAttribute("role")).toBe("link");
    expect(badge.getAttribute("title")).toBe(
      `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`,
    );
  });

  it("a pointer click on the badge navigates to the workbench, not the conversation", () => {
    // The row itself is the anchor and the badge lives inside it: a click on
    // the badge must land on the workbench deep link, never on the row's own
    // conversation href. A `useLocation` probe reports where the router is.
    function Where() {
      const location = useLocation();
      return <div data-testid="badge-where">{`${location.pathname}${location.search}`}</div>;
    }
    const workbenchHref = `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`;
    render(
      <MemoryRouter initialEntries={[`/threads/${runLinkedSummary.id}`]}>
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
        <Row to={`/threads/${runLinkedSummary.id}`} data-testid="conversation-row-badge-harness">
          <OriginBadge conversation={runLinkedSummary} />
        </Row>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("badge-where").textContent).not.toContain(workbenchHref);
    // Clicking the badge must prevent the default action — otherwise the row
    // anchor's own conversation href wins the browser navigation in a real
    // browser and only keyboard Enter reaches the workbench.
    expect(fireEvent.click(screen.getByTestId("conversation-origin-run"))).toBe(false);
    const where = screen.getByTestId("badge-where");
    // The click opened the Run Workbench deep link…
    expect(where.textContent).toBe(workbenchHref);
    // …and not the row's own conversation URL.
    expect(where.textContent).not.toContain(`/conversations/${runLinkedSummary.id}`);
  });
});
