/**
 * The Agents page against the fake fetch: rows show the APM triple the server
 * recorded (never a client-side guess), writes are org-admin only, the triple is
 * sent whole — and a `422` renders its stable `code`, because the prose is not
 * the contract (ADR-0030 §4).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import AgentsPage from "./Agents";
import type { AgentProfile, Me } from "../api/types";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  requestsTo,
  type RouteStub,
} from "../test/fakes";

const admin: Me = { ...meFixture, is_org_admin: true };

const pinned: AgentProfile = {
  ...claudeProfile,
  name: "Claude Code (pinned skills)",
  apm_package_ref: "mattpocock/skills#v1.3.1",
  apm_target: "claude",
  apm_lock_digest: `sha256:${"1a".repeat(32)}`,
};

const listPath = "/api/v1/agent-profiles";
const pinPath = `/api/v1/agent-profiles/${pinned.id}`;

function routes(overrides: RouteStub[] = []): RouteStub[] {
  return [
    ...overrides,
    { path: "/api/v1/me", body: admin },
    { path: listPath, method: "GET", body: { items: [pinned, codexProfile] } },
  ];
}

function mount(overrides: RouteStub[] = []) {
  // `routes` puts overrides first and `mockFetch` takes the first match, so an
  // override of `/api/v1/me` is how a test changes the caller's role.
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentsPage />
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

afterEach(cleanup);

describe("/agents", () => {
  it("renders each profile with its APM triple, or the honest absence", async () => {
    mount();
    const row = await screen.findByTestId(`agent-row-${pinned.id}`);
    expect(within(row).getByTestId(`agent-apm-ref-${pinned.id}`).textContent).toBe(
      "mattpocock/skills#v1.3.1",
    );
    expect(within(row).getByTestId(`agent-apm-target-${pinned.id}`).textContent).toContain(
      "claude",
    );
    // shortDigest: the digest's first 12 hex characters, not the whole blob.
    expect(within(row).getByTestId(`agent-apm-digest-${pinned.id}`).textContent).toBe(
      `${"1a".repeat(6)}`,
    );
    expect(within(row).getByTestId(`agent-permission-${pinned.id}`).textContent).toContain("ask");
    const bare = await screen.findByTestId(`agent-row-${codexProfile.id}`);
    expect(within(bare).getByTestId(`agent-apm-none-${codexProfile.id}`).textContent).toBe(
      "no skill package",
    );
    expect(screen.getByTestId("agents-disclaimer").textContent).toContain(
      "APM staging is not isolation",
    );
  });

  it("shows no write form to a member without the library role", async () => {
    mount([{ path: "/api/v1/me", body: meFixture }]);
    await screen.findByTestId(`agent-row-${pinned.id}`);
    expect(screen.queryByTestId("agents-new-form")).toBeNull();
    expect(screen.queryByTestId(`agent-edit-${pinned.id}`)).toBeNull();
  });

  it("patches all three fields as one triple", async () => {
    const { requests } = mount([{ path: pinPath, method: "PATCH", body: pinned }]);
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    fireEvent.change(screen.getByTestId(`agents-ref-input-${pinned.id}`), {
      target: { value: "mattpocock/skills/skills/engineering/ask-matt#v1.3.1" },
    });
    fireEvent.change(screen.getByTestId(`agents-digest-input-${pinned.id}`), {
      target: { value: `sha256:${"2b".repeat(32)}` },
    });
    fireEvent.click(screen.getByTestId(`agents-apm-save-${pinned.id}`));
    await waitFor(() => expect(requestsTo(requests, pinPath, "PATCH")).toHaveLength(1));
    const body = JSON.parse(requestsTo(requests, pinPath, "PATCH")[0].body ?? "{}");
    expect(body).toEqual({
      apm_package_ref: "mattpocock/skills/skills/engineering/ask-matt#v1.3.1",
      apm_target: "claude",
      apm_lock_digest: `sha256:${"2b".repeat(32)}`,
    });
  });

  it("clears the whole triple on Remove package", async () => {
    const cleared: AgentProfile = {
      ...pinned,
      apm_package_ref: null,
      apm_target: null,
      apm_lock_digest: null,
    };
    const { requests } = mount([{ path: pinPath, method: "PATCH", body: cleared }]);
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    fireEvent.click(screen.getByTestId(`agents-apm-remove-${pinned.id}`));
    await waitFor(() => expect(requestsTo(requests, pinPath, "PATCH")).toHaveLength(1));
    expect(JSON.parse(requestsTo(requests, pinPath, "PATCH")[0].body ?? "{}")).toEqual({
      apm_package_ref: null,
      apm_target: null,
      apm_lock_digest: null,
    });
  });

  it("shows the 422's code beside its prose", async () => {
    const { requests } = mount([
      {
        path: pinPath,
        method: "PATCH",
        status: 422,
        body: {
          type: "https://communication.dev/errors/apm_pin_incomplete",
          title: "Incomplete APM Pin",
          status: 422,
          detail: "apm_package_ref, apm_target and apm_lock_digest move together.",
          code: "apm_pin_incomplete",
        },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    fireEvent.change(screen.getByTestId(`agents-digest-input-${pinned.id}`), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(`agents-apm-save-${pinned.id}`));
    await waitFor(() => expect(requestsTo(requests, pinPath, "PATCH")).toHaveLength(1));
    const problem = await screen.findByTestId(`agents-apm-problem-${pinned.id}`);
    expect(problem.textContent).toContain("apm_pin_incomplete");
    expect(within(problem).getByTestId(`agents-apm-problem-${pinned.id}-code`).textContent).toBe(
      "[apm_pin_incomplete]",
    );
  });

  it("shows the how-to-get-digest disclosure under the digest field", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    // The disclosure is visible (details/summary).
    const details = screen.getByTestId(`agents-digest-help-${pinned.id}`);
    expect(details.querySelector("summary")?.textContent).toContain("How do I get this?");
    // It explains the fail-closed semantic in plain words.
    expect(details.textContent).toContain("moved tag fails closed");
  });

  it("digest help commands reflect the form's current ref and target", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    // Change the ref and target to values different from the pin.
    fireEvent.change(screen.getByTestId(`agents-ref-input-${pinned.id}`), {
      target: { value: "acme/skills#v2.0.0" },
    });
    fireEvent.change(screen.getByTestId(`agents-target-select-${pinned.id}`), {
      target: { value: "codex" },
    });
    const block = screen.getByTestId(`agents-digest-help-block-${pinned.id}`);
    // The current ref appears in the printf command.
    expect(block.textContent).toContain("acme/skills#v2.0.0");
    // The current target appears in the docker-run command.
    expect(block.textContent).toContain("--target codex");
    // The worker image is named so the block is self-contained.
    expect(block.textContent).toContain("ghcr.io/dbirks/communication-worker:main");
  });

  it("copy button is disabled when the Clipboard API is absent (jsdom default)", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    const copyBtn = screen.getByTestId(`agents-digest-help-copy-${pinned.id}`) as HTMLButtonElement;
    // jsdom has no navigator.clipboard, so the button must render disabled.
    expect(copyBtn.disabled).toBe(true);
  });
});
