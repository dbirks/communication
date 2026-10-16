/**
 * The project page's Conversations section (`10-ui-design-handoff.md` J2: a
 * member sees their conversations and who is driving each one).
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
      expect(row.getAttribute("href")).toBe(
        `/projects/${projectFixture.id}/conversations/${conversationFixture.id}`,
      );
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
});
