/**
 * The profiles page against the fake fetch: 2e list + 3e detail on
 * `GET /api/v1/agent-profiles`, the C5 launcher registry, `GET
 * /api/v1/system/sandbox` and per-project secret metadata. The sandbox chip
 * is green only when both halves have evidence; the APM triple moves as one
 * unit; `Duplicate…` is POST + the source's pin.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import AgentsPage from "./Agents";
import type { AgentProfile, Me, SystemSandbox } from "../api/types";
import type { Launcher } from "../lib/profiles";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
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

const cap = (
  name: "acp_session" | "resume" | "permission_prompts" | "nono_required",
  result: "observed" | "not_supported" | "not_tested" = "not_tested",
) => ({
  capability: name,
  result,
  observed_at: result === "observed" ? "2026-10-14T18:00:00Z" : null,
  evidence: result === "observed" ? "docs/compatibility/SANDBOX.md" : null,
});

/** C5 fixture: claude is fully evidenced; codex lacks the nono probe; the rest are unregistered. */
const launcherFixture: { launchers: Launcher[] } = {
  launchers: [
    {
      id: "claude",
      display_name: "Claude Code",
      registered: true,
      workers_online: 1,
      capabilities: [
        cap("acp_session", "observed"),
        cap("resume", "observed"),
        cap("permission_prompts", "observed"),
        cap("nono_required", "observed"),
      ],
    },
    {
      id: "codex",
      display_name: "Codex",
      registered: true,
      workers_online: 1,
      capabilities: [
        cap("acp_session", "observed"),
        cap("resume", "not_supported"),
        cap("permission_prompts", "observed"),
        cap("nono_required"),
      ],
    },
    {
      id: "pi",
      display_name: "Pi",
      registered: false,
      workers_online: 0,
      capabilities: [
        cap("acp_session"),
        cap("resume"),
        cap("permission_prompts"),
        cap("nono_required"),
      ],
    },
    {
      id: "antigravity",
      display_name: "Antigravity",
      registered: false,
      workers_online: 0,
      capabilities: [
        cap("acp_session"),
        cap("resume"),
        cap("permission_prompts"),
        cap("nono_required"),
      ],
    },
  ],
};

const sandboxFixture: SystemSandbox = {
  workers: [
    {
      worker_id: "01987a74-5555-7000-8000-abcdef012345",
      backend: "nono",
      backend_version: "0.80.0",
      enforcement: "required",
      verified: true,
    },
  ],
  pinned_backend_version: "0.80.0",
  policy_digest: `sha256:${"cd".repeat(32)}`,
};

function routes(overrides: RouteStub[] = []): RouteStub[] {
  return [
    ...overrides,
    { path: "/api/v1/launchers", body: launcherFixture },
    { path: "/api/v1/system/sandbox", body: sandboxFixture },
    { path: "/api/v1/projects", body: { items: [] } },
    { path: "/api/v1/me", body: admin },
    { path: listPath, method: "GET", body: { items: [pinned, codexProfile] } },
  ];
}

function mount(overrides: RouteStub[] = [], entry = "/profiles") {
  const { fetchMock, requests } = mockFetch(routes(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/profiles" element={<AgentsPage />} />
          <Route path="/profiles/:id" element={<AgentsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

afterEach(cleanup);

describe("/profiles", () => {
  it("renders the list, the chips and the detail of the first profile", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "Agent profiles" })).toBeDefined();
    const claudeRow = await screen.findByTestId(`agent-row-${pinned.id}`);
    // Both halves evidenced (verified worker + observed nono probe): green.
    expect(within(claudeRow).getByTestId(`profile-chip-${pinned.id}`).textContent).toBe(
      "✓ REQUIRED · VERIFIED",
    );
    const codexRow = await screen.findByTestId(`agent-row-${codexProfile.id}`);
    // Codex has a verified worker but no nono probe: amber, never green.
    expect(within(codexRow).getByTestId(`profile-chip-${codexProfile.id}`).textContent).toBe(
      "! NOT VERIFIED",
    );
    // The detail pane defaults to the first profile and shows its pin.
    const detail = await screen.findByTestId(`profile-detail-${pinned.id}`);
    expect(within(detail).getByTestId(`agent-apm-ref-${pinned.id}`).textContent).toBe(
      "mattpocock/skills#v1.3.1",
    );
    expect(within(detail).getByTestId(`agent-permission-${pinned.id}`).textContent).toContain(
      "ask",
    );
    expect(screen.getByTestId("agents-disclaimer").textContent).toContain(
      "APM staging is not isolation",
    );
    // Used-by claims nothing it cannot measure.
    expect(screen.getByTestId("profiles-usage-unavailable").textContent).toBe(
      "usage tracking not available yet",
    );
    // Clicking the codex row navigates to /profiles/:id and selects it.
    fireEvent.click(codexRow);
    const codexDetail = await screen.findByTestId(`profile-detail-${codexProfile.id}`);
    expect(within(codexDetail).getByTestId(`agent-apm-none-${codexProfile.id}`).textContent).toBe(
      "no skill package",
    );
  });

  it("shows an unregistered launcher as a row fact, not an error", async () => {
    const antigravity: AgentProfile = {
      ...codexProfile,
      id: "01987a71-9999-7000-8000-abcdef012345",
      name: "Antigravity · personal",
      launcher_id: "antigravity",
    };
    mount([{ path: listPath, method: "GET", body: { items: [antigravity] } }]);
    const row = await screen.findByTestId(`agent-row-${antigravity.id}`);
    expect(within(row).getByTestId(`profile-chip-${antigravity.id}`).textContent).toBe(
      "! LAUNCHER NOT REGISTERED",
    );
  });

  it("renders the honest 'not available yet' when the registry endpoint is missing", async () => {
    // No stub for /api/v1/launchers → the mock answers 404 → data null.
    const base = routes().filter((stub) => stub.path !== "/api/v1/launchers");
    mockFetch(base);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/profiles"]}>
          <Routes>
            <Route path="/profiles" element={<AgentsPage />} />
            <Route path="/profiles/:id" element={<AgentsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const row = await screen.findByTestId(`agent-row-${pinned.id}`);
    expect(within(row).getByTestId(`profile-chip-${pinned.id}`).textContent).toBe(
      "· status not available yet",
    );
    expect(screen.getByTestId("profiles-launcher-unavailable").textContent).toContain(
      "launcher status not available yet",
    );
    // No error banner for the read-only status: the page renders the rest.
    expect(screen.queryByTestId("agents-load-error")).toBeNull();
  });

  it("shows no write controls to a member without the library role", async () => {
    mount([{ path: "/api/v1/me", body: meFixture }]);
    await screen.findByTestId(`agent-row-${pinned.id}`);
    expect(screen.queryByTestId("agents-new-form")).toBeNull();
    expect(screen.queryByTestId(`agent-edit-${pinned.id}`)).toBeNull();
    expect(screen.queryByTestId(`profiles-duplicate-${pinned.id}`)).toBeNull();
  });

  it("patches all three fields as one triple from the detail's pin form", async () => {
    const { requests } = mount([{ path: pinPath, method: "PATCH", body: pinned }]);
    // The list row's Edit opens the APM form on the detail route.
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

  it("duplicates the profile and carries the APM pin across", async () => {
    const copy: AgentProfile = {
      ...pinned,
      id: "01987a71-2222-7000-8000-copy",
      name: "Claude Code (pinned skills) copy",
    };
    const { requests } = mount([
      { path: listPath, method: "POST", status: 201, body: copy },
      { path: `/api/v1/agent-profiles/${copy.id}`, method: "PATCH", body: copy },
    ]);
    fireEvent.click(await screen.findByTestId(`profiles-duplicate-${pinned.id}`));
    await waitFor(() => expect(requestsTo(requests, listPath, "POST")).toHaveLength(1));
    const created = JSON.parse(requestsTo(requests, listPath, "POST")[0].body ?? "{}");
    expect(created).toEqual({ name: "Claude Code (pinned skills) copy", launcher_id: "claude" });
    await waitFor(() =>
      expect(requestsTo(requests, `/api/v1/agent-profiles/${copy.id}`, "PATCH")).toHaveLength(1),
    );
    const patchBody = JSON.parse(
      requestsTo(requests, `/api/v1/agent-profiles/${copy.id}`, "PATCH")[0].body ?? "{}",
    );
    expect(patchBody).toEqual({
      apm_package_ref: "mattpocock/skills#v1.3.1",
      apm_target: "claude",
      apm_lock_digest: `sha256:${"1a".repeat(32)}`,
    });
  });

  it("lists only the secrets that grant the profile, by slug only", async () => {
    const secret = {
      id: "01987a76-7777-7000-8000-abcdef012345",
      slug: "claude_token_work",
      scope: "project",
      purpose: "agent account",
      delivery_mode: "env",
      current_version: 1,
      allowed_agent_profile_ids: [pinned.id],
      audit_policy: "materialization_and_access",
      created_at: "2026-10-14T18:00:00Z",
    };
    const other = {
      ...secret,
      id: "01987a76-7777-7000-8000-abcdef9999",
      slug: "db_password",
      allowed_agent_profile_ids: [codexProfile.id],
    };
    mount([
      { path: "/api/v1/projects", body: { items: [projectFixture] } },
      { path: `/api/v1/projects/${projectFixture.id}/secrets`, body: { secrets: [secret, other] } },
    ]);
    const account = await screen.findByTestId(`profiles-account-${pinned.id}`);
    expect(within(account).getByTestId(`profiles-account-row-${secret.id}`).textContent).toContain(
      "secret: claude_token_work",
    );
    expect(within(account).queryByTestId(`profiles-account-row-${other.id}`)).toBeNull();
    expect(screen.getByText("value never shown")).toBeDefined();
  });

  it("shows the how-to-get-digest disclosure under the digest field", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    const details = screen.getByTestId(`agents-digest-help-${pinned.id}`);
    expect(details.querySelector("summary")?.textContent).toContain("How do I get this?");
    expect(details.textContent).toContain("moved tag fails closed");
  });

  it("digest help commands reflect the form's current ref and target", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    fireEvent.change(screen.getByTestId(`agents-ref-input-${pinned.id}`), {
      target: { value: "acme/skills#v2.0.0" },
    });
    fireEvent.change(screen.getByTestId(`agents-target-select-${pinned.id}`), {
      target: { value: "codex" },
    });
    const block = screen.getByTestId(`agents-digest-help-block-${pinned.id}`);
    expect(block.textContent).toContain("acme/skills#v2.0.0");
    expect(block.textContent).toContain("--target codex");
    expect(block.textContent).toContain("ghcr.io/dbirks/communication-worker:main");
  });

  it("copy button is disabled when the Clipboard API is absent (jsdom default)", async () => {
    mount();
    fireEvent.click(await screen.findByTestId(`agent-edit-${pinned.id}`));
    const copyBtn = screen.getByTestId(`agents-digest-help-copy-${pinned.id}`) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
  });

  it("navigates to the named profile on /profiles/:id", async () => {
    mount([], `/profiles/${codexProfile.id}`);
    const detail = await screen.findByTestId(`profile-detail-${codexProfile.id}`);
    // Codex's capability cells carry the fixture's evidence and nothing more.
    expect(
      within(detail).getByTestId(`profile-capability-${codexProfile.id}-resume`).textContent,
    ).toContain("× not supported");
    expect(
      within(detail).getByTestId(`profile-capability-${codexProfile.id}-acp_session`).textContent,
    ).toContain("✓ observed 2026-10-14");
    // The sandbox row is backend · version · enforcement · verified, no timestamp invented.
    const worker = screen.getByTestId("profile-worker-01987a74-5555-7000-8000-abcdef012345");
    expect(worker.textContent).toContain("required");
    expect(worker.textContent).toContain("✓ verified");
  });
});
