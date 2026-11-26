/**
 * The ACCOUNTS strip on Manage → Agents & models: a row per harness in the
 * strip's order, the probe's own state words, the sign-in button for admins
 * only (the read never fires for a non-admin), and the dialog the button
 * opens. Hooks are mocked; nothing hits a network.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAccount } from "../../../api/agentAccounts";
import AccountsStrip from "./AccountsStrip";

const mocks = vi.hoisted(() => ({
  me: { data: { is_org_admin: true }, isPending: false } as {
    data: { is_org_admin: boolean } | undefined;
    isPending: boolean;
  },
  accounts: vi.fn(),
  startMutate: vi.fn(),
}));

vi.mock("../../../api/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/queries")>()),
  useMe: () => mocks.me,
}));
vi.mock("../../../api/agentAccounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agentAccounts")>()),
  useAgentAccounts: mocks.accounts,
  useStartAgentLogin: () => ({ mutate: mocks.startMutate }),
}));
vi.mock("../../../components/settings/AgentLoginDialog", async () => {
  const React = await import("react");
  return {
    default: ({ target }: { target: { launcher: string } }) =>
      React.createElement("div", { "data-testid": "agent-login-dialog" }, target.launcher),
  };
});

const loginFixture = {
  id: "login-1",
  launcher: "codex" as const,
  worker_id: "worker-1",
  status: "queued" as const,
  verification_url: null,
  user_code: null,
  needs_code: false,
  account_label: null,
  error: null,
  expires_at: null,
  created_at: "2026-11-18T10:00:00Z",
  updated_at: "2026-11-18T10:00:00Z",
};

function accountFixture(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return {
    worker_id: "worker-1",
    worker_name: "worker-1",
    launcher: "codex",
    state: "unknown",
    account_label: null,
    detail: null,
    checked_at: null,
    login: null,
    ...overrides,
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <AccountsStrip />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mocks.me = { data: { is_org_admin: true }, isPending: false };
  mocks.accounts.mockReturnValue({ data: { items: [] }, isPending: false, error: null });
  mocks.startMutate.mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AccountsStrip", () => {
  it("renders three rows in the order Claude, Codex, Antigravity", () => {
    mount();
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Claude");
    expect(rows[1].textContent).toContain("Codex");
    expect(rows[2].textContent).toContain("Antigravity");
  });

  it("prints the probe's own state words: signed in / needs sign-in / not checked", () => {
    mocks.accounts.mockReturnValue({
      data: {
        items: [
          accountFixture({
            launcher: "claude" as AgentAccount["launcher"],
            state: "signed_in",
            account_label: "ada@example.com",
          }),
          accountFixture({ launcher: "codex", state: "signed_out" }),
          accountFixture({ launcher: "antigravity", state: "unknown" }),
        ],
      },
      isPending: false,
      error: null,
    });
    mount();
    const states = screen.getAllByTestId("agent-account-state");
    const words = states.map((el) => el.textContent);
    expect(words.some((w) => w?.includes("✓ signed in as ada@example.com"))).toBe(true);
    expect(words.some((w) => w?.includes("! needs sign-in"))).toBe(true);
    expect(words.some((w) => w?.includes("not checked yet"))).toBe(true);
  });

  it("prints the API-key line for Claude when the read reports no claude item and no button", () => {
    mount();
    expect(screen.getByText("uses the worker's API key")).toBeTruthy();
    expect(screen.queryByTestId("agent-account-signin")).toBeNull();
  });

  it("treats a claude item like any other harness", () => {
    mocks.accounts.mockReturnValue({
      data: {
        items: [
          accountFixture({ launcher: "claude" as AgentAccount["launcher"], state: "signed_out" }),
        ],
      },
      isPending: false,
      error: null,
    });
    mount();
    expect(screen.queryByText("uses the worker's API key")).toBeNull();
    expect(screen.getByTestId("agent-account-signin").textContent).toBe("Sign in");
  });

  it("lists one line per worker with the worker name in mono for a shared harness", () => {
    mocks.accounts.mockReturnValue({
      data: {
        items: [
          accountFixture({
            launcher: "antigravity",
            worker_id: "w-1",
            worker_name: "worker-one",
            state: "signed_in",
            account_label: "ada@example.com",
          }),
          accountFixture({
            launcher: "antigravity",
            worker_id: "w-2",
            worker_name: "worker-two",
            state: "signed_out",
          }),
        ],
      },
      isPending: false,
      error: null,
    });
    mount();
    const one = screen.getByTestId("agent-account-antigravity-worker-one");
    const two = screen.getByTestId("agent-account-antigravity-worker-two");
    expect(one.textContent).toContain("worker-one");
    expect(two.textContent).toContain("worker-two");
    expect(one.textContent).toContain("✓ signed in as ada@example.com");
    expect(two.textContent).toContain("! needs sign-in");
  });

  it("lets an admin start a login and opens the dialog", () => {
    mocks.accounts.mockReturnValue({
      data: { items: [accountFixture({ launcher: "codex", state: "signed_out" })] },
      isPending: false,
      error: null,
    });
    mocks.startMutate.mockImplementation(
      (_input: unknown, opts: { onSuccess: (login: unknown) => void }) => {
        opts.onSuccess(loginFixture);
      },
    );
    mount();
    fireEvent.click(screen.getByTestId("agent-account-signin"));
    expect(mocks.startMutate).toHaveBeenCalledWith(
      { launcher: "codex", worker_id: "worker-1" },
      expect.any(Object),
    );
    expect(screen.getByTestId("agent-login-dialog").textContent).toBe("codex");
  });

  it("labels Sign in again for a signed-in row", () => {
    mocks.accounts.mockReturnValue({
      data: {
        items: [
          accountFixture({
            launcher: "codex",
            state: "signed_in",
            account_label: "ada@example.com",
          }),
        ],
      },
      isPending: false,
      error: null,
    });
    mount();
    expect(screen.getByTestId("agent-account-signin").textContent).toBe("Sign in again");
  });

  it("never fires the accounts read for a non-admin and shows the sentence", () => {
    mocks.me = { data: { is_org_admin: false }, isPending: false };
    mount();
    expect(screen.getByTestId("agent-accounts-forbidden").textContent).toBe(
      "Only organization admins can manage agent sign-ins.",
    );
    expect(mocks.accounts).toHaveBeenCalledWith(false);
    expect(screen.queryByTestId("agent-account-signin")).toBeNull();
  });
});
