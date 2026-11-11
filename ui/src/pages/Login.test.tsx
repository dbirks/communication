/**
 * The sign-in screen (gh-3 / gh-4): a signed-out visitor sees ONLY this screen —
 * no sidebar, no app chrome — for `/` and every deep link, and the screen keeps
 * the deep link as `return_to` so a sign-in lands back on the page they asked
 * for. The screen itself carries one primary action (`sign-in`) plus a single
 * short muted line; the explanatory paragraphs are gone.
 *
 * ADR-0083 added the other shape: `GET /auth/providers` decides how many buttons
 * there are. One entry (what an env-only deployment reports) must draw exactly
 * the screen this file originally pinned — same label, same URL. Two entries
 * draw two, in configuration order, each naming its provider.
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

const oneProvider: RouteStub = {
  path: "/auth/providers",
  method: "GET",
  body: [{ id: "default", label: "OIDC" }],
};

const twoProviders: RouteStub = {
  path: "/auth/providers",
  method: "GET",
  body: [
    { id: "tailnet", label: "Tailscale" },
    { id: "work", label: "Microsoft (E-gineering)" },
  ],
};

describe("the sign-in screen", () => {
  it("renders the product name, the one primary sign-in button and one muted line", async () => {
    renderApp({ path: "/login", routes: [unauthenticated] });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
    // The brand is the Mark + plain wordmark, not boxed letters (sidebar parity).
    expect(screen.getByText("Communication")).toBeTruthy();
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

  it("draws exactly today's one button when one provider is configured", async () => {
    renderApp({ path: "/login", routes: [unauthenticated, oneProvider] });
    const signIn = await screen.findByTestId("sign-in", undefined, { timeout: 5_000 });
    // The synthesized `default` provider needs no `provider=` on the link: the
    // URL an env-only deployment has always sent is the URL it sends now.
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2F");
    expect(signIn.textContent).toContain("Sign in with OIDC");
    // One button, not a chooser.
    expect(screen.queryByTestId("sign-in-tailnet")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(
      screen.getByText("You sign in through your organization's OpenID Connect provider."),
    ).toBeTruthy();
  });

  it("draws one button per provider, in configuration order, each naming its provider", async () => {
    renderApp({ path: "/board", routes: [unauthenticated, twoProviders] });
    const tailnet = await screen.findByTestId("sign-in-tailnet", undefined, { timeout: 5_000 });
    const work = screen.getByTestId("sign-in-work");
    expect(tailnet.textContent).toContain("Sign in with Tailscale");
    expect(work.textContent).toContain("Sign in with Microsoft (E-gineering)");
    // The deep link survives into every option, and each option names the
    // provider the server must start the handshake with.
    expect(tailnet.getAttribute("href")).toBe("/auth/login?return_to=%2Fboard&provider=tailnet");
    expect(work.getAttribute("href")).toBe("/auth/login?return_to=%2Fboard&provider=work");
    // Configuration order is the order of the buttons a person reads.
    const links = screen.getAllByRole("link");
    expect(links.indexOf(tailnet)).toBeLessThan(links.indexOf(work));
    // The single-provider button is gone: there is a choice to make.
    expect(screen.queryByTestId("sign-in")).toBeNull();
    expect(screen.getByText("Choose the provider your account lives at.")).toBeTruthy();
  });

  it("keeps a usable sign-in action when the provider list cannot be read", async () => {
    renderApp({
      path: "/login",
      routes: [unauthenticated, { path: "/auth/providers", method: "GET", status: 503, body: {} }],
    });
    const signIn = await screen.findByTestId("sign-in", undefined, { timeout: 5_000 });
    expect(signIn.getAttribute("href")).toBe("/auth/login?return_to=%2F");
  });
});
