/**
 * The shell's signed-in chrome (`components/Shell.tsx`): the "New" menu
 * starts things — a conversation, a workflow, a run — so it only exists for
 * a member that is actually signed in. The API is mocked at the fetch
 * boundary; the page content under the shell is not the subject here.
 */
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { meFixture, type RouteStub } from "../test/fakes";
import { renderApp } from "../test/render";

/** Wait budget for the `/me` round trip the app bar waits on. */
const READ_MS = 5_000;

const signedIn: RouteStub[] = [
  { path: "/api/v1/me", body: meFixture },
  { path: "/api/v1/projects", body: { items: [] } },
];

describe("the shell's New menu follows the session", () => {
  it("shows the New menu when a member is signed in", async () => {
    renderApp({ path: "/inbox", routes: signedIn });
    expect(await screen.findByTestId("new-menu", undefined, { timeout: READ_MS })).toBeTruthy();
  });

  it("hides the New menu when nobody is signed in", async () => {
    renderApp({
      path: "/inbox",
      routes: [
        {
          path: "/api/v1/me",
          method: "GET",
          status: 401,
          body: {
            type: "https://communication.dev/errors/unauthorized",
            title: "Unauthorized",
            status: 401,
            detail: "not signed in",
          },
        },
        { path: "/api/v1/projects", body: { items: [] } },
      ],
    });
    await screen.findByText("not signed in", undefined, { timeout: READ_MS });
    expect(screen.queryByTestId("new-menu")).toBeNull();
  });
});
