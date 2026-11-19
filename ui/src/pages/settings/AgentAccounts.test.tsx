/**
 * Settings → Agent accounts (ADR-0085), driven through the fetch boundary like
 * `Assistant.test.tsx`: the chip states are the worker's probe answers, the
 * Sign in button's POST body is the real request, and the dialog the button
 * opens is the same component the row uses in the app.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { setCsrfToken } from "../../api/client";
import type { components } from "../../api/schema";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import AgentAccountsSettings from "./AgentAccounts";

const ACCOUNTS_PATH = "/api/v1/agent-accounts";
const LOGIN_PATH = "/api/v1/agent-logins/01987b00-0000-7000-8000-000000000001";
const CSRF = meFixture.csrf_token;

type AgentLogin = components["schemas"]["AgentLogin"];
type AgentAccount = components["schemas"]["AgentAccount"];

const adminFixture = { ...meFixture, is_org_admin: true };

function loginFixture(overrides: Partial<AgentLogin> = {}): AgentLogin {
  return {
    id: "01987b00-0000-7000-8000-000000000001",
    launcher: "codex",
    worker_id: "worker-1",
    status: "queued",
    verification_url: null,
    user_code: null,
    needs_code: false,
    account_label: null,
    error: null,
    expires_at: "2026-11-18T10:15:00Z",
    created_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T10:00:00Z",
    ...overrides,
  };
}

function accountFixture(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    worker_id: "worker-1",
    worker_name: "worker-1",
    launcher: "codex",
    state: "signed_out",
    account_label: null,
    detail: null,
    checked_at: "2026-11-18T10:00:00Z",
    login: null,
    ...overrides,
  };
}

function mount(stubs: RouteStub[]) {
  // Test stubs first: `mockFetch` answers from the first route it matches.
  const { requests } = mockFetch([
    ...stubs,
    { path: "/api/v1/me", body: adminFixture },
    { path: ACCOUNTS_PATH, method: "GET", body: { items: [] } },
  ]);
  setCsrfToken(CSRF);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentAccountsSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests };
}

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

describe("Settings → Agent accounts", () => {
  it("refuses a member who typed the URL, without asking the server", async () => {
    const { requests } = mount([{ path: "/api/v1/me", body: meFixture }]);
    expect((await screen.findByTestId("settings-accounts-forbidden")).textContent).toBe(
      "Only organization admins can manage agent sign-ins.",
    );
    expect(requestsTo(requests, ACCOUNTS_PATH)).toEqual([]);
  });

  it("says so when no worker is online", async () => {
    mount([]);
    expect((await screen.findByTestId("settings-accounts-empty")).textContent).toBe(
      "No workers are online, so there is nothing to sign in yet.",
    );
  });

  it("shows the honest alert when the list can't be read", async () => {
    mount([{ path: ACCOUNTS_PATH, method: "GET", status: 500 }]);
    expect(await screen.findByTestId("settings-accounts-error")).toBeTruthy();
    expect(screen.getByText("Couldn't load agent accounts.")).toBeTruthy();
  });

  it("renders the three probe states, the worker name and the age", async () => {
    mount([
      {
        path: ACCOUNTS_PATH,
        method: "GET",
        body: {
          items: [
            accountFixture({ state: "signed_in", account_label: "ada@example.com" }),
            accountFixture({ launcher: "antigravity", state: "signed_out" }),
            accountFixture({ worker_id: "worker-2", worker_name: "worker-2", state: "unknown" }),
          ],
        },
      },
    ]);
    const chips = await screen.findAllByTestId("agent-account-state");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Signed in as ada@example.com",
      "Needs sign-in",
      "Not checked yet",
    ]);
    expect(chips[0].getAttribute("class")).toContain("text-st-done-tag-fg");
    expect(chips[1].getAttribute("class")).toContain("text-st-waiting-tag-fg");
    expect(chips[2].getAttribute("class")).toContain("text-muted");
    expect(screen.getByTestId("agent-account-codex-worker-1").textContent).toContain("Codex");
    expect(screen.getByTestId("agent-account-antigravity-worker-1").textContent).toContain(
      "Antigravity",
    );
    expect(screen.getAllByTestId("agent-account-checked")[0].textContent).toMatch(
      /^Checked .+ ago$/,
    );
    // A signed-in row offers to redo it; a signed-out one offers the sign-in.
    expect(screen.getAllByTestId("agent-account-signin").map((b) => b.textContent)).toEqual([
      "Sign in again",
      "Sign in",
      "Sign in",
    ]);
  });

  it("queues a sign-in on that row's worker and opens the dialog on it", async () => {
    const { requests } = mount([
      {
        path: ACCOUNTS_PATH,
        method: "GET",
        body: { items: [accountFixture()] },
      },
      {
        path: `${ACCOUNTS_PATH}/codex/logins`,
        method: "POST",
        status: 201,
        body: loginFixture(),
      },
      { path: LOGIN_PATH, method: "GET", body: loginFixture() },
    ]);
    await screen.findByTestId("agent-account-codex-worker-1");
    fireEvent.click(screen.getByTestId("agent-account-signin"));

    const dialog = await screen.findByTestId("agent-login-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(await screen.findByTestId("agent-login-status")).toBeTruthy();
    expect(screen.getByText("Starting the sign-in on worker-1…")).toBeTruthy();
    expect(
      requestsTo(requests, `${ACCOUNTS_PATH}/codex/logins`, "POST").map((r) => r.body),
    ).toEqual(['{"worker_id":"worker-1"}']);
  });

  it("reopens the attempt already running instead of queueing a second one", async () => {
    const { requests } = mount([
      {
        path: ACCOUNTS_PATH,
        method: "GET",
        body: {
          items: [
            accountFixture({
              state: "signed_out",
              login: loginFixture({ status: "awaiting_user", user_code: "ABCD-EFGH" }),
            }),
          ],
        },
      },
      {
        path: LOGIN_PATH,
        method: "GET",
        body: loginFixture({ status: "awaiting_user", user_code: "ABCD-EFGH" }),
      },
    ]);
    const signin = await screen.findByTestId("agent-account-signin");
    expect(signin.textContent).toBe("Continue sign-in");
    fireEvent.click(signin);
    expect(await screen.findByTestId("agent-login-dialog")).toBeTruthy();
    expect(requestsTo(requests, `${ACCOUNTS_PATH}/codex/logins`, "POST")).toEqual([]);
  });

  it("says so when a sign-in for that agent is already in progress (409)", async () => {
    mount([
      { path: ACCOUNTS_PATH, method: "GET", body: { items: [accountFixture()] } },
      {
        path: `${ACCOUNTS_PATH}/codex/logins`,
        method: "POST",
        status: 409,
        body: { type: "x", title: "Conflict", status: 409, detail: "already in progress" },
      },
    ]);
    await screen.findByTestId("agent-account-codex-worker-1");
    fireEvent.click(screen.getByTestId("agent-account-signin"));
    expect(await screen.findByTestId("agent-account-conflict")).toBeTruthy();
    expect(screen.getByText("A sign-in for this agent is already in progress.")).toBeTruthy();
    expect(screen.queryByTestId("agent-login-dialog")).toBeNull();
  });
});
