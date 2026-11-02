// Unit test for the emulator fixture's api-collector filter (fixtures.ts
// `isBenignStreamAbort`). The contract the acceptance loop needs:
//
//   • `net::ERR_ABORTED` on a JOURNAL FEED is always the client closing an
//     open subscription — the page navigating/unloading, or the app replacing
//     a socket (route unmounts, the reconnect ladder). It is never an API
//     failure, so it must not file (20+ issues, #103–#128, were this one
//     fact repeated across every screen).
//   • `net::ERR_ABORTED` on any OTHER endpoint is a cancelled real request
//     and still files.
//   • A journal feed that dies for a SERVER-side or network reason fails
//     with its own error text (`ERR_CONNECTION_RESET`, `ERR_EMPTY_RESPONSE`,
//     …), never `ERR_ABORTED` — those still file.
//   • Real error STATUSES on `/api/v1/events` (4xx/5xx) never reach this
//     filter at all: they arrive as RESPONSES and the fixture's `response`
//     handler records them regardless of content type.
//
// Runs in the no-lab `reflow` project (see emulator/playwright.config.ts) —
// a pure function, no page, no server.
//
//   pnpm --dir e2e exec playwright test -c emulator/playwright.config.ts emulator/fixtures-abort.spec.ts
import { test } from "@playwright/test";
import { isBenignStreamAbort } from "./fixtures.js";

const input = (over: Partial<Parameters<typeof isBenignStreamAbort>[0]>) => ({
  errorText: "net::ERR_ABORTED",
  resourceType: "eventsource",
  accept: "text/event-stream",
  url: "http://localhost:18091/api/v1/events",
  ...over,
});

const assert = (cond: boolean, why: string): void => {
  if (!cond) throw new Error(why);
};

test.describe("isBenignStreamAbort", () => {
  test("an aborted EventSource on every journal-feed path is benign", () => {
    for (const url of [
      "http://localhost:18091/api/v1/events",
      "http://localhost:18091/api/v1/events?after=41",
      "http://localhost:18091/api/v1/projects/01a1/events",
      "http://localhost:18091/api/v1/conversations/01a1/events",
      "http://localhost:18091/api/v1/runs/01a1/events",
      "http://localhost:18091/api/v1/runs/01a1/nodes/x/stream",
    ]) {
      assert(
        isBenignStreamAbort(input({ url })),
        `the abort of a journal feed must not file: ${url}`,
      );
    }
  });

  test("a fetch reading a text/event-stream body is a journal feed too", () => {
    assert(
      isBenignStreamAbort(
        input({
          resourceType: "fetch",
          accept: "text/event-stream",
          url: "http://localhost:18091/api/v1/conversations/01a1/messages/stream",
        }),
      ),
      "the accept header alone proves the subscription",
    );
    // Even without a readable accept header, the /events path is the app's
    // own journal route — a client-cancelled read of it says nothing about
    // the API.
    assert(
      isBenignStreamAbort(
        input({ resourceType: "fetch", accept: "", url: "http://localhost:18091/api/v1/events" }),
      ),
      "the path suffix carries it",
    );
  });

  test("an aborted NON-stream request still files", () => {
    for (const url of [
      "http://localhost:18091/api/v1/runs",
      "http://localhost:18091/api/v1/events-x",
      "http://localhost:18091/api/v1/projects/01a1",
      "http://localhost:18091/healthz",
    ]) {
      assert(
        !isBenignStreamAbort(input({ url, resourceType: "fetch", accept: "application/json" })),
        `an abort of a real request is a defect and must file: ${url}`,
      );
    }
    // Even the events URL under a NON-eventsource type with no event-stream
    // accept is only caught by the path rule — which the app's fetch-based
    // journal reads rely on. A stray `fetch` abort whose accept names a
    // different payload is still path-matched, the one deliberate widening
    // of the filter (an `/events` route is a journal feed in this app, full
    // stop); an abort on any other path still files.
  });

  test("a journal feed that died for a non-abort reason still files", () => {
    for (const errorText of ["net::ERR_CONNECTION_RESET", "net::ERR_EMPTY_RESPONSE", "ns_error::60"]) {
      assert(
        !isBenignStreamAbort(input({ errorText })),
        `a dead stream with its own net error is not a client teardown: ${errorText}`,
      );
    }
    // Only the exact code counts as a client cancel (whitespace tolerated,
    // as Playwright's own errorText sometimes carries one).
    assert(isBenignStreamAbort(input({ errorText: " net::ERR_ABORTED " })), "trim is tolerated");
    assert(
      !isBenignStreamAbort(input({ errorText: "net::ERR_ABORTED-ish" })),
      "a lookalike code is not the cancel",
    );
  });

  test("an unparsable url is never swallowed", () => {
    assert(
      !isBenignStreamAbort(input({ resourceType: "fetch", accept: "", url: "not a url" })),
      "no crash, no silent drop",
    );
    // An EventSource whose url cannot be parsed still has a resource type —
    // the type carries it, and the path check must not throw.
    assert(
      isBenignStreamAbort(input({ url: "not a url" })),
      "an eventsource is a journal feed whatever the url reads as",
    );
  });
});
