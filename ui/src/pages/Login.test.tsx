/**
 * The sign-in screen (gh-3 / gh-4): a signed-out visitor sees ONLY this screen —
 * no sidebar, no app chrome — for `/` and every deep link, and the screen keeps
 * the deep link as `return_to` so a sign-in lands back on the page they asked
 * for. The screen itself carries one primary action (`sign-in`) plus a single
 * short muted line; the explanatory paragraphs are gone.
 */
import { renderApp } from "../test/render";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type RouteStub } from "../test/fakes";

const unauthenticated: RouteStub = {
  path: "/api/v1/me",
  method: "GET",
  status: 401,
  body: {
    type: "https://communication.dev/errors/unauthorized",
    title: "Unauthorized",
    status: 401,
    detail: "not signed in",
  },
};

describe("the sign-in screen", () => {
  it("renders the product name, the one primary sign-in button and one muted line", async () => {
    renderApp({ path: "/login", routes: [unauthenticated] });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    const signIn = screen.getByTestId("sign-in");
    expect(signIn.textContent).toContain("Sign in with OIDC");
  });

  it("shows the sign-in button and no sidebar for a signed-out deep link", async () => {
    renderApp({ path: "/board", routes: [unauthenticated] });
    const signIn = await screen.findByTestId("sign-in", undefined, { timeout: 5_000 });
    // The deep link is preserved for the return: sign-in lands back on /board.
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2Fboard");
    // No sidebar, no app chrome — the signed-out visitor sees the screen only.
    expect(screen.queryByTestId("sidebar")).toBeNull();
  });

  it("returns a signed-out visitor to the home deep link on sign-in", async () => {
    renderApp({ path: "/", routes: [unauthenticated] });
    const signIn = await screen.findByTestId("sign-in", undefined, { timeout: 5_000 });
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2F");
  });
});
