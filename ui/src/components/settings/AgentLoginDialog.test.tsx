/**
 * The ADR-0085 sign-in dialog, mounted directly (the row that opens it is
 * covered in `pages/settings/AgentAccounts.test.tsx`). Everything here is the
 * provider-facing half of the flow: the two different shapes of `awaiting_user`,
 * the terminal states and what closing versus cancelling actually posts.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setCsrfToken } from "../../api/client";
import type { components } from "../../api/schema";
import { meFixture, mockFetch, requestsTo, type RouteStub } from "../../test/fakes";
import AgentLoginDialog, { type AgentLoginDialogTarget } from "./AgentLoginDialog";

const CSRF = meFixture.csrf_token;
const LOGIN_ID = "01987b00-0000-7000-8000-000000000001";
const LOGIN_PATH = `/api/v1/agent-logins/${LOGIN_ID}`;
const START_PATH = "/api/v1/agent-accounts/codex/logins";

const target: AgentLoginDialogTarget = {
  loginId: LOGIN_ID,
  launcher: "codex",
  workerId: "worker-1",
  workerName: "worker-1",
};

type AgentLogin = components["schemas"]["AgentLogin"];

function loginFixture(overrides: Partial<AgentLogin> = {}): AgentLogin {
  return {
    id: LOGIN_ID,
    launcher: "codex",
    worker_id: "worker-1",
    status: "awaiting_user",
    verification_url: "https://auth.openai.com/codex/device",
    user_code: "ABCD-EFGH",
    needs_code: false,
    account_label: null,
    error: null,
    expires_at: "2026-11-18T10:15:00Z",
    created_at: "2026-11-18T10:00:00Z",
    updated_at: "2026-11-18T10:00:00Z",
    ...overrides,
  };
}

function mount(login: AgentLogin, extra: RouteStub[] = []) {
  const { requests } = mockFetch([{ path: LOGIN_PATH, method: "GET", body: login }, ...extra]);
  setCsrfToken(CSRF);
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentLoginDialog target={target} onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, onClose };
}

afterEach(() => {
  cleanup();
  setCsrfToken(null);
});

describe("AgentLoginDialog · Codex device code", () => {
  it("is an accessible dialog named for the agent", async () => {
    const { onClose } = mount(loginFixture());
    const dialog = await screen.findByTestId("agent-login-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const title = screen.getByRole("heading", { name: "Sign in to Codex" });
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    void onClose;
  });

  it("shows the link without its scheme and the code big and mono", async () => {
    mount(loginFixture());
    const link = await screen.findByTestId("agent-login-link");
    expect(link.getAttribute("href")).toBe("https://auth.openai.com/codex/device");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener noreferrer");
    expect(link.textContent).toBe("auth.openai.com/codex/device");
    const code = screen.getByTestId("agent-login-code");
    expect(code.textContent).toBe("ABCD-EFGH");
    expect(code.getAttribute("class")).toContain("font-mono");
    expect(screen.getByTestId("agent-login-status").textContent).toBe(
      "Waiting for you to approve…",
    );
    expect(
      screen.getByText(
        /If OpenAI says device code sign-in is off, turn on “Enable device code sign-in for Codex” in ChatGPT → Settings → Security\./,
      ),
    ).toBeTruthy();
  });

  it("copies the code and says Copied", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    mount(loginFixture());
    const copy = await screen.findByTestId("agent-login-copy");
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-EFGH"));
    expect((await screen.findByTestId("agent-login-copy")).textContent).toBe("Copied");
  });

  it("posts a cancel when asked, and closes without one on Escape", async () => {
    const { requests, onClose } = mount(loginFixture());
    await screen.findByTestId("agent-login-status");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(requestsTo(requests, `${LOGIN_PATH}/cancel`, "POST")).toEqual([]);

    fireEvent.click(screen.getByTestId("agent-login-cancel"));
    await waitFor(() =>
      expect(requestsTo(requests, `${LOGIN_PATH}/cancel`, "POST").length).toBe(1),
    );
  });
});

describe("AgentLoginDialog · Antigravity paste-back", () => {
  const google = loginFixture({
    launcher: "antigravity",
    verification_url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
    user_code: null,
    needs_code: true,
  });

  it("hands the pasted code to the worker and empties the field", async () => {
    const { requests } = mount(google, [
      { path: `${LOGIN_PATH}/code`, method: "POST", status: 202 },
    ]);
    const input = await screen.findByTestId("agent-login-code-input");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(screen.getByTestId("agent-login-submit").hasAttribute("disabled")).toBe(true);
    fireEvent.change(input, { target: { value: "  4/0Aabc-code  " } });
    expect(screen.getByTestId("agent-login-submit").hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByTestId("agent-login-submit"));
    await waitFor(() =>
      expect(requestsTo(requests, `${LOGIN_PATH}/code`, "POST").map((r) => r.body)).toEqual([
        '{"code":"4/0Aabc-code"}',
      ]),
    );
    expect((screen.getByTestId("agent-login-code-input") as HTMLInputElement).value).toBe("");
    const link = screen.getByTestId("agent-login-link");
    expect(link.textContent).toBe("Open Google sign-in");
  });

  it("says so when the sign-in stopped waiting for a code (409)", async () => {
    mount(google, [
      {
        path: `${LOGIN_PATH}/code`,
        method: "POST",
        status: 409,
        body: { type: "x", title: "Conflict", status: 409, detail: "not awaiting a code" },
      },
    ]);
    const input = await screen.findByTestId("agent-login-code-input");
    fireEvent.change(input, { target: { value: "4/0Aabc-code" } });
    fireEvent.click(screen.getByTestId("agent-login-submit"));
    expect((await screen.findByTestId("agent-login-code-rejected")).textContent).toBe(
      "This sign-in isn't waiting for a code any more.",
    );
  });
});

describe("AgentLoginDialog · the terminal states", () => {
  it("shows the worker's sentence and retries on a new attempt", async () => {
    const { requests } = mount(
      loginFixture({ status: "failed", error: "Codex refused the device code." }),
      [{ path: START_PATH, method: "POST", status: 201, body: loginFixture({ status: "queued" }) }],
    );
    await screen.findByTestId("agent-login-retry");
    const dialog = screen.getByTestId("agent-login-dialog");
    const alert = within(dialog).getByTestId("agent-login-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain("Codex refused the device code.");
    fireEvent.click(screen.getByTestId("agent-login-retry"));
    await waitFor(() =>
      expect(requestsTo(requests, START_PATH, "POST").map((r) => r.body)).toEqual([
        '{"worker_id":"worker-1"}',
      ]),
    );
    await screen.findByText("Starting the sign-in on worker-1…");
    expect(screen.getByTestId("agent-login-status").textContent).toBe(
      "Starting the sign-in on worker-1…",
    );
  });

  it("names the timeout and offers another try", async () => {
    mount(loginFixture({ status: "expired" }));
    expect(await screen.findByText("The sign-in timed out after 15 minutes.")).toBeTruthy();
    expect(screen.getByTestId("agent-login-status").textContent).toBe(
      "The sign-in timed out after 15 minutes.",
    );
    expect(screen.getByTestId("agent-login-retry").textContent).toBe("Try again");
  });

  it("says cancelled and only closes", async () => {
    const { requests, onClose } = mount(loginFixture({ status: "cancelled" }));
    await screen.findByTestId("agent-login-close");
    expect(screen.getByTestId("agent-login-status").textContent).toBe("Sign-in cancelled.");
    fireEvent.click(screen.getByTestId("agent-login-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(requestsTo(requests, `${LOGIN_PATH}/cancel`, "POST")).toEqual([]);
  });

  it("reports who signed in and Done closes it", async () => {
    const { onClose } = mount(
      loginFixture({ status: "succeeded", account_label: "ada@example.com" }),
    );
    await screen.findByTestId("agent-login-done");
    expect(screen.getByTestId("agent-login-status").textContent).toBe(
      "Signed in as ada@example.com.",
    );
    fireEvent.click(screen.getByTestId("agent-login-done"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says checking while the worker verifies", async () => {
    mount(loginFixture({ status: "verifying" }));
    await screen.findByTestId("agent-login-status");
    expect(screen.getByTestId("agent-login-status").textContent).toBe("Checking the code…");
  });
});
