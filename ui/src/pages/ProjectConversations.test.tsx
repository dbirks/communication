/**
 * The project page's Conversations section (`10-ui-design-handoff.md` J2: a
 * member sees their conversations and who is driving each one).
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
 * at 3.9 s with the CPU oversubscribed ~5x (22 cores, 66 spinners, a second
 * full suite running alongside) — the point where this file's first test flakes
 * in CI. Budgets at real boundaries, never retries.
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

describe("/projects/:projectId conversations", () => {
  it(
    "lists conversations with title, profile, status, controller and updated",
    async () => {
      renderApp({ path: `/projects/${projectFixture.id}`, routes: routes() });

      // The row arrives when `GET .../conversations` answers — awaited inside
      // that boundary's budget, not raced against it.
      const row = await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      expect(row.textContent).toContain("Refactor billing");
      // The list row carries only the profile id, so the UI resolves the name.
      expect(row.textContent).toContain("profile: Claude Code");
      // STATUS-E: the status rides a glyph+word chip ("● active"; the word is
      // the DOM text, CSS uppercases it visually only).
      expect(row.textContent).toContain("●active");
      expect(row.textContent).toContain("controller: Ada Lovelace");
      expect(row.textContent).toContain("updated: 2026-10-14T18:05:00Z");
      expect(row.getAttribute("href")).toBe(`/threads/${conversationFixture.id}`);
    },
    TEST_TIMEOUT,
  );

  it(
    "starts a conversation with a profile from the directory and opens it",
    async () => {
      const { requests } = renderApp({
        path: `/projects/${projectFixture.id}`,
        routes: routes([
          {
            path: conversationsPath,
            method: "POST",
            status: 201,
            body: conversationFixture,
          },
          {
            path: `/api/v1/conversations/${conversationFixture.id}`,
            method: "GET",
            body: conversationFixture,
          },
        ]),
      });

      await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      // The create form is the shared dialog now: open it from the section button.
      fireEvent.click(screen.getByTestId("conversations-new-open"));
      await screen.findByTestId("new-conversation-dialog", undefined, { timeout: READ_MS });
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

      // One round trip: the submit's `POST /conversations`.
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
      // Created conversations are the caller's to drive: the page shows it once
      // the read answering the navigation lands — another round trip.
      await waitFor(() => expect(screen.getByTestId("controller-badge")).toBeTruthy(), {
        timeout: READ_MS,
      });
    },
    TEST_TIMEOUT,
  );

  it(
    "creates a conversation without a first prompt when the box is empty",
    async () => {
      const { requests } = renderApp({
        path: `/projects/${projectFixture.id}`,
        routes: routes([
          { path: conversationsPath, method: "POST", status: 201, body: conversationFixture },
        ]),
      });

      await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      // The create form is the shared dialog now: open it from the section button.
      fireEvent.click(screen.getByTestId("conversations-new-open"));
      await screen.findByTestId("new-conversation-dialog", undefined, { timeout: READ_MS });
      fireEvent.change(screen.getByTestId("conversation-new-title"), {
        target: { value: "Plan" },
      });
      fireEvent.change(screen.getByTestId("conversation-new-profile"), {
        target: { value: claudeProfile.id },
      });
      fireEvent.click(screen.getByTestId("conversation-new-submit"));

      // One round trip: the submit's `POST /conversations`.
      await waitFor(
        () => {
          const [request] = requestsTo(requests, conversationsPath, "POST");
          expect(JSON.parse(request.body ?? "{}")).toEqual({
            agent_profile_id: claudeProfile.id,
            title: "Plan",
          });
        },
        { timeout: READ_MS },
      );
    },
    TEST_TIMEOUT,
  );

  it(
    "explains why a viewer cannot start a conversation",
    async () => {
      renderApp({
        path: `/projects/${projectFixture.id}`,
        routes: routes([
          {
            path: projectPath,
            method: "GET",
            body: { ...projectFixture, my_role: "viewer" },
          },
        ]),
      });

      await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      expect(screen.queryByTestId("conversation-new-title")).toBeNull();
      expect(
        screen.getByText("Only project contributors and maintainers can start conversations."),
      ).toBeTruthy();
    },
    TEST_TIMEOUT,
  );

  it(
    "says there are no conversations yet",
    async () => {
      renderApp({
        path: `/projects/${projectFixture.id}`,
        routes: routes([{ path: conversationsPath, method: "GET", body: { items: [] } }]),
      });

      // The empty state is the same boundary as the row: one conversations read.
      await screen.findByTestId("conversation-list-empty", undefined, { timeout: READ_MS });
    },
    TEST_TIMEOUT,
  );

  it(
    "still renders the section for a bookmarked #conversations fragment",
    async () => {
      renderApp({ path: `/projects/${projectFixture.id}#conversations`, routes: routes() });

      await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      // The overview answers the fragment; its rail points at the route.
      const nav = screen.getByRole("navigation", { name: "Project sections" });
      expect(within(nav).getByText("Conversations").getAttribute("href")).toBe(
        `/projects/${projectFixture.id}/conversations`,
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
    "renders the project's conversation list at the literal list URL",
    async () => {
      renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes(),
      });

      const row = await screen.findByTestId("conversation-row-refactor-billing", undefined, {
        timeout: READ_MS,
      });
      expect(row.textContent).toContain("Refactor billing");
      expect(row.getAttribute("href")).toBe(`/threads/${conversationFixture.id}`);
      // Not the app's "Not found" page any more, and the rail knows where it is.
      expect(screen.queryByText("That page does not exist.")).toBeNull();
      const nav = screen.getByRole("navigation", { name: "Project sections" });
      expect(within(nav).getByText("Conversations").getAttribute("aria-current")).toBe("true");
      // One canonical form: the rail's Conversations item is the route itself.
      expect(within(nav).getByText("Conversations").getAttribute("href")).toBe(
        `/projects/${projectFixture.id}/conversations`,
      );
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
      // A shell around an unreadable project is the leak: no list, no form,
      // and no "no conversations yet" confirming more than the API said.
      expect(screen.queryByTestId("project-conversations")).toBeNull();
      expect(screen.queryByTestId("conversation-list")).toBeNull();
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
      expect(screen.queryByTestId("conversation-list")).toBeNull();
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
      await screen.findByTestId("project-conversations-title", undefined, { timeout: READ_MS });
      expect(screen.queryByTestId("project-conversations-not-found")).toBeNull();
      expect((await screen.findAllByRole("alert"))[0].textContent).toContain(
        "Internal Server Error",
      );
    },
    TEST_TIMEOUT,
  );
});

/* ADR-0043: where a conversation was opened — manual vs run-linked rows,
 * the All/Manual/From-runs filter and the debounced title search. */

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

describe("the list says where each conversation was opened", () => {
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

  it("badges a manual row and deep-links a run-linked row into the workbench", async () => {
    renderApp({
      path: `/projects/${projectFixture.id}/conversations`,
      routes: routes([
        {
          path: conversationsPath,
          method: "GET",
          body: { items: [conversationSummaryFixture, runLinkedSummary] },
        },
      ]),
    });

    expect(await screen.findByTestId("conversation-origin-manual")).toBeTruthy();
    expect(screen.getByTestId("conversation-origin-manual").textContent).toBe("Manual");

    const badge = await screen.findByTestId("conversation-origin-run");
    expect(badge.textContent).toContain("From run · Ship billing · review");
    // The badge itself is the workbench deep link: node, instance and
    // attempt. It carries link semantics (role + title) rather than an
    // anchor because the row is itself an anchor.
    expect(badge.getAttribute("role")).toBe("link");
    expect(badge.getAttribute("title")).toBe(
      `/runs/${RUN_ID}?node=review&instance=${NODE_EXECUTION_ID}&attempt=2`,
    );
  });

  it("a pointer click on the run badge navigates to the workbench, not the conversation", async () => {
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

  it(
    "sends the All/Manual/From-runs filter as origin",
    async () => {
      const { requests } = renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes(),
      });
      const seen = watchFetchTargets();
      await screen.findByTestId("conversation-filter-run", undefined, { timeout: READ_MS });

      fireEvent.click(screen.getByTestId("conversation-filter-run"));
      await waitFor(
        () => {
          expect(seen).toContain(`${conversationsPath}?origin=run`);
        },
        { timeout: READ_MS },
      );

      fireEvent.click(screen.getByTestId("conversation-filter-manual"));
      await waitFor(
        () => {
          expect(seen).toContain(`${conversationsPath}?origin=manual`);
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
        renderApp({
          path: `/projects/${projectFixture.id}/conversations`,
          routes: routes(),
        });
        // Let the mount's reads land while every clock is fake.
        for (let i = 0; i < 5; i += 1) {
          await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
          });
        }
        const seen = watchFetchTargets();
        const search = screen.getByTestId("conversation-search");

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
        expect(screen.getByTestId("conversation-row-refactor-billing")).toBeTruthy();
      } finally {
        vi.useRealTimers();
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "says no conversations match when the filter finds nothing",
    async () => {
      renderApp({
        path: `/projects/${projectFixture.id}/conversations`,
        routes: routes([{ path: conversationsPath, method: "GET", body: { items: [] } }]),
      });
      await screen.findByTestId("conversation-filter-run", undefined, { timeout: READ_MS });

      fireEvent.click(screen.getByTestId("conversation-filter-run"));
      const nomatch = await screen.findByTestId("conversation-list-nomatch", undefined, {
        timeout: READ_MS,
      });
      expect(nomatch.textContent).toBe("No conversations match");
      // The unfiltered "no conversations yet" is a different state.
      expect(screen.queryByTestId("conversation-list-empty")).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
