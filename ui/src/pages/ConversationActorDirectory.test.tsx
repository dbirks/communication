/**
 * One journal, one reading of it (ADR-0016 §7) — including *who* it says did
 * what. The transcript names people out of the actor directory, so a viewer
 * whose directory read was lost must not be left reading a colleague as
 * "someone (2f12d936)" while the other viewer reads their name.
 *
 * The lab case this reproduces: both API replicas restarted, the page
 * re-navigated, `GET /api/v1/users` and `GET …/members` both died in flight
 * (`net::ERR_NETWORK_CHANGED`) while every other request on the same page
 * succeeded, and the fold had already committed "Control taken by someone
 * (2f12d936)". Nothing asked the directory again.
 */
import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderApp } from "../test/render";
import { DIRECTORY_REPAIR_ATTEMPTS } from "../api/actors";
import {
  FakeEventSource,
  claudeProfile,
  conversationEvent,
  conversationFixture,
  conversationId,
  meFixture,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../test/fakes";
import type { Member, User } from "../api/types";

const projectId = projectFixture.id;
const page = `/p/${projectId}/conversations/${conversationId}`;

/** The colleague: in the organization and in the project, like the lab's Bob. */
const bob: User = {
  id: "01a18ae0-8d98-710c-b223-f2842f12d936",
  display_name: "Bob Brennan",
  email: "bob@example.invalid",
};
const meAsUser: User = {
  id: meFixture.id,
  display_name: meFixture.display_name,
  email: meFixture.email,
};
const org: User[] = [meAsUser, bob];
const meAsMember: Member = {
  user_id: meFixture.id,
  display_name: meFixture.display_name,
  role: "maintainer",
};
const members: Member[] = [
  meAsMember,
  { user_id: bob.id, display_name: bob.display_name, role: "contributor" },
];

function routes(directory: RouteStub[]): RouteStub[] {
  return [
    ...directory,
    { path: "/api/v1/me", body: meFixture },
    { path: "/api/v1/agent-profiles", body: { items: [claudeProfile] } },
    { path: `/api/v1/projects/${projectId}`, method: "GET", body: projectFixture },
    { path: `/api/v1/conversations/${conversationId}`, method: "GET", body: conversationFixture },
    { path: `/api/v1/projects/${projectId}/workspaces`, method: "GET", body: { workspaces: [] } },
  ];
}

/** Bob taking control, as the journal records it: an id and a reason, no name. */
function actorTakesControl(userId: string): void {
  act(() => {
    FakeEventSource.last().emit(
      conversationEvent("conversation.control.transferred", {
        from_kind: "human",
        from_user_id: meFixture.id,
        to_kind: "human",
        to_user_id: userId,
        reason: "taken",
        control_version: 2,
      }),
    );
  });
}

/** Everything the transcript currently says. */
async function transcriptText(): Promise<string> {
  const root = await screen.findByTestId("transcript");
  const lines = within(root)
    .getAllByTestId("transcript-item")
    .map((item) => item.textContent ?? "");
  return lines.join("\n");
}

describe("the transcript's actor names survive a bad directory read", () => {
  it("looks the directory up again after the first answer was lost in flight", async () => {
    const { requests } = renderApp({
      path: page,
      routes: routes([
        // What a replica restart does to a request in flight: no response at all.
        { path: "/api/v1/users", method: "GET", body: { items: org }, flaky: { failures: 1 } },
        {
          path: `/api/v1/projects/${projectId}/members`,
          method: "GET",
          body: { items: members },
          flaky: { failures: 1 },
        },
      ]),
    });
    await screen.findByTestId("conversation-title");
    actorTakesControl(bob.id);

    // The page owes the reader a name, not the sentence it fell back to while
    // the directory was missing: it asks again, and the line becomes Bob's. That
    // the line is right by the time the next assertion is polled — well inside
    // DIRECTORY_REPAIR_TICK_MS — is the point: the re-read rides the failed
    // read's own settling, so a lost response is a blip, not a wrong minute.
    await waitFor(async () => {
      expect(await transcriptText()).toContain("Control taken by Bob Brennan");
    });
    expect(await transcriptText()).not.toContain("someone (");
    // The repair is a second read, not a re-render of the same empty cache.
    expect(requestsTo(requests, "/api/v1/users", "GET").length).toBeGreaterThan(1);
  });

  it("asks again for a person the directory answer predates", async () => {
    // A directory that answered BEFORE Bob joined, and answers with him after:
    // no request failed, so only a lookup that treats "I cannot name this id"
    // as a question — rather than as a stranger — can converge.
    const { requests } = renderApp({
      path: page,
      routes: routes([
        {
          path: "/api/v1/users",
          method: "GET",
          body: (attempt: number) => ({ items: attempt === 1 ? [meAsUser] : org }),
        },
        {
          path: `/api/v1/projects/${projectId}/members`,
          method: "GET",
          body: (attempt: number) => ({ items: attempt === 1 ? [meAsMember] : members }),
        },
      ]),
    });
    await screen.findByTestId("conversation-title");
    actorTakesControl(bob.id);

    await waitFor(async () => {
      expect(await transcriptText()).toContain("Control taken by Bob Brennan");
    });
    expect(requestsTo(requests, "/api/v1/users", "GET").length).toBeGreaterThan(1);
  });

  it("keeps 'someone' for a stranger and stops asking about them", async () => {
    // Somebody outside the organization (a left member, the author of an old
    // run): the honest fallback stays, and the repair is bounded rather than a
    // page that polls the directory forever.
    const stranger = "01a18ae0-9999-7000-8000-0000cafe4000";
    const { requests } = renderApp({
      path: page,
      routes: routes([
        { path: "/api/v1/users", method: "GET", body: { items: org } },
        { path: `/api/v1/projects/${projectId}/members`, method: "GET", body: { items: members } },
      ]),
    });
    await screen.findByTestId("conversation-title");
    actorTakesControl(stranger);

    await waitFor(async () => {
      expect(await transcriptText()).toContain("Control taken by someone (cafe4000)");
    });
    // It did look again — and then stopped: the budget is per unknown id, so a
    // stranger costs a handful of reads rather than turning the page into a poller.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const asked = requestsTo(requests, "/api/v1/users", "GET").length;
    expect(asked).toBeGreaterThan(1);
    expect(asked).toBeLessThanOrEqual(1 + DIRECTORY_REPAIR_ATTEMPTS);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(requestsTo(requests, "/api/v1/users", "GET").length).toBeLessThanOrEqual(
      1 + DIRECTORY_REPAIR_ATTEMPTS,
    );
  });

  it("takes a '403' for the answer it is and stops reading the directory", async () => {
    // A caller the organization will not name people for reads "someone" and
    // leaves it there: a `403` is a decision, not a hiccup, and badgering the
    // control plane over it is what turns a page into a client of its own cache.
    const forbidden = {
      type: "https://communication.dev/errors/forbidden",
      title: "Forbidden",
      status: 403,
      detail: "This caller may not read the actor directory.",
    };
    const { requests } = renderApp({
      path: page,
      routes: routes([
        { path: "/api/v1/users", method: "GET", status: 403, body: forbidden },
        {
          path: `/api/v1/projects/${projectId}/members`,
          method: "GET",
          status: 403,
          body: forbidden,
        },
      ]),
    });
    await screen.findByTestId("conversation-title");
    actorTakesControl(bob.id);

    await waitFor(async () => {
      expect(await transcriptText()).toContain("Control taken by someone (2f12d936)");
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(requestsTo(requests, "/api/v1/users", "GET")).toHaveLength(1);
    expect(requestsTo(requests, `/api/v1/projects/${projectId}/members`, "GET")).toHaveLength(1);
  });
});
