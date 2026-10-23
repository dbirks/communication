/**
 * The new-profile dialog (artboard 5b, contract C6) against the fake fetch:
 * five agent cards with evidence-only readiness, the account grant as a
 * secret PUT after the POST, the APM triple as one PATCH, the suggested
 * unique name, and the honest 409 inline.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import NewProfileDialog from "./NewProfileDialog";
import type { AgentProfile, Secret, SystemSandbox } from "../../api/types";
import type { Launcher } from "../../lib/profiles";
import { meFixture, mockFetch, projectFixture, requestsTo, type RouteStub } from "../../test/fakes";

const created: AgentProfile = {
  id: "01987a71-cccc-7000-8000-abcdef012345",
  name: "Claude Code · 2",
  launcher_id: "claude",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
};

const existing: AgentProfile[] = [
  {
    id: "01987a71-2222-7000-8000-abcdef012345",
    name: "Claude Code",
    launcher_id: "claude",
    permission_mode: "ask",
    created_at: "2026-10-14T18:00:00Z",
    version: 1,
  },
  {
    id: "01987a71-2222-7000-8000-abcdef0123ff",
    name: "Codex",
    launcher_id: "codex",
    permission_mode: "ask",
    created_at: "2026-10-14T18:00:00Z",
    version: 1,
  },
];

const cap = (
  name: "acp_session" | "nono_required" | "permission_prompts" | "resume",
  result: "not_supported" | "not_tested" | "observed" = "not_tested",
) => ({
  capability: name,
  result,
  observed_at: result === "observed" ? "2026-10-14T18:00:00Z" : null,
  evidence: result === "observed" ? "docs/compatibility/SANDBOX.md" : null,
});

const launchers: { launchers: Launcher[] } = {
  launchers: [
    {
      id: "claude",
      display_name: "Claude Code",
      registered: true,
      workers_online: 1,
      capabilities: [cap("acp_session", "observed"), cap("nono_required", "observed")],
    },
    {
      id: "codex",
      display_name: "Codex",
      registered: true,
      workers_online: 1,
      capabilities: [cap("acp_session", "observed"), cap("nono_required")],
    },
    {
      id: "pi",
      display_name: "Pi",
      registered: false,
      workers_online: 0,
      capabilities: [cap("nono_required")],
    },
    {
      id: "antigravity",
      display_name: "Antigravity",
      registered: false,
      workers_online: 0,
      capabilities: [cap("nono_required")],
    },
    {
      id: "gemini",
      display_name: "Gemini CLI",
      registered: true,
      workers_online: 1,
      capabilities: [cap("acp_session")],
    },
  ],
};

const sandbox: SystemSandbox = {
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

const secret: Secret = {
  id: "01987a76-7777-7000-8000-abcdef012345",
  slug: "CLAUDE_TOKEN_WORK",
  scope: "project",
  purpose: "Claude Code sign-in",
  delivery_mode: "env",
  current_version: 1,
  allowed_agent_profile_ids: [],
  audit_policy: "materialization",
  created_at: "2026-10-14T18:00:00Z",
};

function routes(extra: RouteStub[] = []): RouteStub[] {
  return [
    ...extra,
    { path: "/api/v1/me", body: { ...meFixture, is_org_admin: true } },
    { path: "/api/v1/agent-profiles", method: "GET", body: { items: existing } },
    { path: "/api/v1/agent-profiles", method: "POST", status: 201, body: created },
    { path: "/api/v1/launchers", body: launchers },
    { path: "/api/v1/system/sandbox", body: sandbox },
    { path: "/api/v1/projects", body: { items: [projectFixture] } },
    {
      path: `/api/v1/projects/${projectFixture.id}/secrets`,
      method: "GET",
      body: { secrets: [secret] },
    },
  ];
}

function mount(props: { forStep?: string } = {}, routeExtra: RouteStub[] = []) {
  const { requests } = mockFetch(routes(routeExtra));
  const onCreated = vi.fn();
  const onClose = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <NewProfileDialog open onClose={onClose} onCreated={onCreated} forStep={props.forStep} />
    </QueryClientProvider>,
  );
  return { requests, onCreated, onClose };
}

afterEach(cleanup);

describe("NewProfileDialog (5b)", () => {
  it("shows the five cards with evidence-only readiness", async () => {
    mount();
    expect(await screen.findByRole("dialog", { name: "New agent profile" })).not.toBeNull();
    const claude = await screen.findByTestId("new-profile-card-claude");
    // The readiness line needs the launcher registry and the sandbox read to
    // settle, so wait for the settled text rather than asserting the first
    // paint.
    expect(await within(claude).findByText("✓ sandbox verified")).not.toBeNull();
    const codex = screen.getByTestId("new-profile-card-codex");
    expect(await within(codex).findByText("! not tested yet")).not.toBeNull();
    expect(
      (within(screen.getByTestId("new-profile-card-pi")).getByRole("radio") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      await within(screen.getByTestId("new-profile-card-pi")).findByText("! not registered"),
    ).not.toBeNull();
    expect(
      (
        within(screen.getByTestId("new-profile-card-antigravity")).getByRole(
          "radio",
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    // Other ACP agent: gemini is the only other registered launcher.
    const other = screen.getByTestId("new-profile-card-other");
    const otherSelect = within(other).getByTestId(
      "agents-new-launcher-select",
    ) as HTMLSelectElement;
    expect(Array.from(otherSelect.options).map((option) => option.value)).toEqual(["gemini"]);
    // Defaults bar: real claims only — no egress wording.
    await screen.findByText("permission ask · sandbox: required · verified");
    // No pin was filled: no unlocked-pin note in the dialog (the lock flow lives
    // on the profile page — ADR-0054 amendment 2).
    expect(screen.queryByTestId("new-profile-lock")).toBeNull();
  });

  it("offers the unlocked-pin Lock it note once the ref and target are filled", async () => {
    mount();
    expect(screen.queryByTestId("new-profile-lock")).toBeNull();
    fireEvent.change(screen.getByTestId("new-profile-apm-ref"), {
      target: { value: "mattpocock/skills#v1.3.1" },
    });
    fireEvent.change(screen.getByTestId("new-profile-apm-target"), { target: { value: "claude" } });
    expect(await screen.findByTestId("new-profile-lock")).not.toBeNull();
  });

  it("creates the selected profile and calls onCreated with the created row", async () => {
    const { requests, onCreated, onClose } = mount();
    // No step → the suggestion is the agent name + a unique n.
    expect((screen.getByTestId("agents-new-name-input") as HTMLInputElement).value).toBe(
      "Claude Code · 2",
    );
    const submit = screen.getByTestId("agents-new-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    // Contract C6: the POST answers, the dialog hands the created row to the
    // caller through `onCreated` — and does NOT close itself. The caller
    // closes the dialog (the Studio inspector selects the profile,
    // `/profiles` navigates to its detail).
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        id: created.id,
        name: created.name,
        launcher_id: created.launcher_id,
      }),
    );
    expect(onClose).not.toHaveBeenCalled();
    const post = requestsTo(requests, "/api/v1/agent-profiles", "POST");
    expect(JSON.parse(post[0].body ?? "")).toEqual({
      name: "Claude Code · 2",
      launcher_id: "claude",
    });
  });

  it("grants the chosen account secret to the new profile", async () => {
    const { requests, onCreated } = mount({}, [
      {
        path: `/api/v1/projects/${projectFixture.id}/secrets/${secret.id}`,
        method: "PUT",
        body: { ...secret, allowed_agent_profile_ids: [created.id] },
      },
    ]);
    const secretSelect = await screen.findByTestId("new-profile-secret-select");
    await waitFor(() =>
      expect((secretSelect as HTMLSelectElement).options.length).toBeGreaterThan(1),
    );
    fireEvent.change(secretSelect, { target: { value: secret.id } });
    fireEvent.click(screen.getByTestId("agents-new-submit"));
    // C6: success hands the row to the caller after the grant lands.
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const put = requestsTo(
      requests,
      `/api/v1/projects/${projectFixture.id}/secrets/${secret.id}`,
      "PUT",
    );
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0].body ?? "")).toEqual({
      purpose: secret.purpose,
      allowed_agent_profile_ids: [created.id],
      audit_policy: secret.audit_policy,
    });
  });

  it("sends the APM triple as one PATCH after the POST", async () => {
    const { requests, onCreated } = mount({}, [
      { path: `/api/v1/agent-profiles/${created.id}`, method: "PATCH", body: created },
    ]);
    fireEvent.change(screen.getByTestId("new-profile-apm-ref"), {
      target: { value: "mattpocock/skills#v1.3.1" },
    });
    fireEvent.change(screen.getByTestId("new-profile-apm-target"), { target: { value: "claude" } });
    fireEvent.change(screen.getByTestId("new-profile-apm-digest"), {
      target: { value: `sha256:${"1a".repeat(32)}` },
    });
    fireEvent.click(screen.getByTestId("agents-new-submit"));
    // C6: success hands the row to the caller after the APM PATCH lands.
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const patch = requestsTo(requests, `/api/v1/agent-profiles/${created.id}`, "PATCH");
    expect(JSON.parse(patch[0].body ?? "")).toEqual({
      apm_package_ref: "mattpocock/skills#v1.3.1",
      apm_target: "claude",
      apm_lock_digest: `sha256:${"1a".repeat(32)}`,
    });
  });

  it("blocks submit on a partial APM triple", async () => {
    mount();
    fireEvent.change(screen.getByTestId("new-profile-apm-ref"), {
      target: { value: "mattpocock/skills#v1.3.1" },
    });
    expect(screen.getByText(/ref and target \(the digest is optional\)/)).not.toBeNull();
    expect((screen.getByTestId("agents-new-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("suggests the step in the name and the footer, and keeps 409s inline", async () => {
    const { onCreated, onClose } = mount({ forStep: "docs_review" }, [
      {
        path: "/api/v1/agent-profiles",
        method: "POST",
        status: 409,
        body: {
          type: "https://communication.dev/errors/conflict",
          title: "Conflict",
          status: 409,
          detail: "a profile named “Claude Code · docs_review” already exists",
        },
      },
    ]);
    expect(screen.getByTestId("new-profile-step").textContent).toContain("docs_review");
    const submit = screen.getByTestId("agents-new-submit") as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    expect(submit.textContent).toBe("Create and use in docs_review");
    expect((screen.getByTestId("agents-new-name-input") as HTMLInputElement).value).toBe(
      "Claude Code · docs_review",
    );
    fireEvent.click(submit);
    await screen.findByTestId("agents-new-problem");
    expect(screen.getByTestId("new-profile-dialog")).not.toBeNull(); // stays open on 409
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
