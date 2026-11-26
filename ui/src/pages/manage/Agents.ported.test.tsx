/**
 * The profiles surface ported from the old `/profiles` page
 * (`pages/Agents.tsx`, no longer routed) onto its replacement: Manage →
 * Agents & models (`pages/manage/Agents.tsx`), whose table is
 * `agents/ProfilesTable.tsx` and whose 560px sheet (`agents/ProfileSheet.tsx`)
 * hosts the unchanged `components/profiles/ProfileDetail.tsx`.
 *
 * What a person does here is the same: read the sandbox chip (green only when
 * a verified worker AND an observed `nono_required` probe agree), pin/unpin an
 * APM triple as ONE unit, lock an unlocked pin, read what uses the profile,
 * and see the secrets that grant it by slug only. The chip, the pin form, the
 * lock chip, the usage rows and the secret list are the old components', so
 * the assertions are the old page's — with the two links a profile now lives
 * behind: `routes.profile(id)` is `/manage/agents/<id>`, and the workflows in
 * the usage list are `/factory/<id>` (with `?draft=` for a draft use), per
 * `docs/design/redesign/CONTRACT.md`.
 *
 * Retired with the old page: its `Page` band and subtitle, the 260px list
 * column beside an always-pinned detail pane, and the list row's own `Edit`
 * button — the redesign opens the same pin form from the sheet's SKILLS panel
 * (`agent-apm-edit-*`), so that is what the tests click.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import Agents from "./Agents";
import type { AgentProfile, Me, SystemSandbox } from "../../api/types";
import type { Launcher } from "../../lib/profiles";
import {
  claudeProfile,
  codexProfile,
  meFixture,
  mockFetch,
  projectFixture,
  requestsTo,
  type RouteStub,
} from "../../test/fakes";

const admin: Me = { ...meFixture, is_org_admin: true };

const pinned: AgentProfile = {
  ...claudeProfile,
  name: "Claude Code (pinned skills)",
  apm_package_ref: "mattpocock/skills#v1.3.1",
  apm_target: "claude",
  apm_lock_digest: `sha256:${"1a".repeat(32)}`,
};

const unlockedProfile: AgentProfile = {
  ...claudeProfile,
  name: "Claude Code (unlocked skills)",
  apm_package_ref: "mattpocock/skills#v1.3.1",
  apm_target: "claude",
  apm_lock_digest: null,
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

function routeStubs(overrides: RouteStub[] = []): RouteStub[] {
  return [
    ...overrides,
    // The accounts strip's own read: empty items, so it is not this file's
    // subject (it is `agents/AccountsStrip.test.tsx`'s).
    { path: "/api/v1/agent-accounts", body: { items: [] } },
    { path: "/api/v1/launchers", body: launcherFixture },
    { path: "/api/v1/system/sandbox", body: sandboxFixture },
    { path: "/api/v1/projects", body: { items: [] } },
    { path: "/api/v1/me", body: admin },
    { path: listPath, method: "GET", body: { items: [pinned, codexProfile] } },
  ];
}

/** The section, as `Manage.tsx` mounts it: the table at the section root, the
 * profile's sheet at `/manage/agents/:itemId`. */
function mount(overrides: RouteStub[] = [], entry = "/manage/agents") {
  const { fetchMock, requests } = mockFetch(routeStubs(overrides));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/manage/agents" element={<Agents />} />
          <Route path="/manage/agents/:itemId" element={<Agents />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { fetchMock, requests };
}

/** The sheet for one profile, opened the way the section opens it: by address. */
function mountSheet(profileId: string, overrides: RouteStub[] = []) {
  return mount(overrides, `/manage/agents/${profileId}`);
}

/** Open the pin form the sheet's SKILLS panel offers. */
async function openPinForm(profileId: string) {
  fireEvent.click(await screen.findByTestId(`agent-apm-edit-${profileId}`));
}

afterEach(cleanup);

describe("/manage/agents — the profiles table", () => {
  it("renders the list and its chips, and the detail behind a row's link", async () => {
    mount();
    expect(screen.getByRole("heading", { name: /Agents & models/ })).toBeDefined();
    const claudeRow = await screen.findByTestId(`agent-row-${pinned.id}`);
    // Both halves evidenced (verified worker + observed nono probe): green.
    expect(within(claudeRow).getByTestId(`profile-chip-${pinned.id}`).textContent).toBe(
      "✓ sandbox required · verified",
    );
    const codexRow = await screen.findByTestId(`agent-row-${codexProfile.id}`);
    // Codex has a verified worker but no nono probe: amber, never green.
    expect(within(codexRow).getByTestId(`profile-chip-${codexProfile.id}`).textContent).toBe(
      "! not verified",
    );

    // The sheet is the redesign's detail: the row's name opens it, and the
    // profile's pin and permission mode answer from there.
    fireEvent.click(screen.getByTestId(`agent-name-${pinned.id}`));
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
    // Used-by: no usage report was mounted for this profile, so the read
    // errored — never a "0", never a claim the backend cannot support.
    expect((await screen.findByTestId("profiles-usage-unavailable")).textContent).toBe(
      "usage unavailable — the workflows that use this profile could not be read",
    );

    // The other row's link opens its own sheet.
    fireEvent.click(screen.getByTestId(`agent-name-${codexProfile.id}`));
    const codexDetail = await screen.findByTestId(`profile-detail-${codexProfile.id}`);
    expect(within(codexDetail).getByTestId(`agent-apm-none-${codexProfile.id}`).textContent).toBe(
      "no skill package",
    );
  });

  it("lists the workflows that use a profile, with their revision facts", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${claudeProfile.id}/usage`,
        method: "GET",
        body: {
          workflow_count: 1,
          step_count: 1,
          uses: [
            {
              pipeline_id: "01987b20-0000-7000-8000-abcdef012345",
              pipeline_name: "Widget review",
              source: "revision",
              revision_number: 3,
              draft_id: null,
              node_id: "implement",
              node_label: "Claude Code",
            },
          ],
          truncated: false,
        },
      },
    ]);
    const usage = await screen.findByTestId("profile-usage");
    expect(usage.textContent).toContain("Used by 1 workflows · 1 steps");
    const row = await screen.findByTestId("profile-usage-row");
    expect(row.textContent).toContain("Widget review");
    expect(row.textContent).toContain("v3");
    const workflowLink = screen.getByTestId(
      "profile-usage-workflow-01987b20-0000-7000-8000-abcdef012345",
    );
    // The workflow's address is the editor now (`routes.workflow`).
    expect(workflowLink.getAttribute("href")).toBe("/factory/01987b20-0000-7000-8000-abcdef012345");
  });

  it("links a draft use to the draft route and marks the row draft", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${claudeProfile.id}/usage`,
        method: "GET",
        body: {
          workflow_count: 1,
          step_count: 1,
          uses: [
            {
              pipeline_id: "01987b20-0000-7000-8000-abcdef012345",
              pipeline_name: "Widget review",
              source: "draft",
              revision_number: null,
              draft_id: "01987b30-0000-7000-8000-abcdef012345",
              node_id: "implement",
              node_label: "Claude Code",
            },
          ],
          truncated: false,
        },
      },
    ]);
    const row = await screen.findByTestId("profile-usage-row");
    expect(row.textContent).toContain("draft");
    expect(row.textContent).not.toContain("v3");
    const workflowLink = screen.getByTestId(
      "profile-usage-workflow-01987b20-0000-7000-8000-abcdef012345",
    ) as HTMLAnchorElement;
    // A draft is a query on the editor, not a nested path.
    expect(workflowLink.getAttribute("href")).toBe(
      "/factory/01987b20-0000-7000-8000-abcdef012345?draft=01987b30-0000-7000-8000-abcdef012345",
    );
  });

  it("says not used by any workflow yet when the report has no uses", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${claudeProfile.id}/usage`,
        method: "GET",
        body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
      },
    ]);
    const usage = await screen.findByTestId("profile-usage");
    expect(usage.textContent).toContain("Not used by any workflow yet");
  });

  it("renders the muted usage-unavailable copy when the report cannot be read", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${claudeProfile.id}/usage`,
        method: "GET",
        status: 500,
        body: { title: "Internal Server Error", status: 500, detail: "usage store down" },
      },
    ]);
    expect(await screen.findByTestId("profiles-usage-unavailable")).toBeTruthy();
    expect(screen.getByTestId("profiles-usage-unavailable").textContent).toContain(
      "usage unavailable",
    );
  });

  it("says showing first 200 when the report is truncated", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${claudeProfile.id}/usage`,
        method: "GET",
        body: {
          workflow_count: 201,
          step_count: 201,
          uses: [
            {
              pipeline_id: "01987b20-0000-7000-8000-abcdef012345",
              pipeline_name: "Widget review",
              source: "revision",
              revision_number: 3,
              draft_id: null,
              node_id: "implement",
              node_label: "Claude Code",
            },
          ],
          truncated: true,
        },
      },
    ]);
    expect(await screen.findByTestId("profile-usage-truncated")).toBeTruthy();
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
    const base = routeStubs().filter((stub) => stub.path !== "/api/v1/launchers");
    mockFetch(base);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/manage/agents/${pinned.id}`]}>
          <Routes>
            <Route path="/manage/agents" element={<Agents />} />
            <Route path="/manage/agents/:itemId" element={<Agents />} />
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
    const row = await screen.findByTestId(`agent-row-${pinned.id}`);
    expect(within(row).queryByTestId(`agent-edit-${pinned.id}`)).toBeNull();
    expect(screen.queryByTestId("agents-new-open")).toBeNull();
    // And the sheet it links to carries no write affordance either.
    fireEvent.click(screen.getByTestId(`agent-name-${pinned.id}`));
    await screen.findByTestId(`profile-detail-${pinned.id}`);
    expect(screen.queryByTestId(`profiles-duplicate-${pinned.id}`)).toBeNull();
    expect(screen.queryByTestId(`agent-apm-edit-${pinned.id}`)).toBeNull();
  });

  it("duplicates the profile and carries the APM pin across", async () => {
    const copy: AgentProfile = {
      ...pinned,
      id: "01987a71-2222-7000-8000-copy",
      name: "Claude Code (pinned skills) copy",
    };
    const { requests } = mountSheet(pinned.id, [
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
      version: copy.version,
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
    mountSheet(pinned.id, [
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

  it("opens the named profile's sheet from its address", async () => {
    mount([], `/manage/agents/${codexProfile.id}`);
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

  it("renders the lock contents lists when a resolve reported them", async () => {
    const withContents: AgentProfile = {
      ...pinned,
      apm_contents: {
        skills: ["ask-matt"],
        instructions: ["README.md"],
        mcp_servers: ["github"],
        truncated: false,
      },
    };
    mountSheet(withContents.id, [
      { path: listPath, method: "GET", body: { items: [withContents, codexProfile] } },
      {
        path: `/api/v1/agent-profiles/${withContents.id}/apm/lock`,
        method: "GET",
        body: { request_id: "", status: "none" },
      },
    ]);
    const detail = await screen.findByTestId(`profile-detail-${withContents.id}`);
    const contents = within(detail).getByTestId(`agent-apm-contents-${withContents.id}`);
    expect(contents.textContent).toContain("ask-matt");
    expect(contents.textContent).toContain("README.md");
    expect(contents.textContent).toContain("github");
    expect(contents.textContent).toContain("MCP SERVERS");
    expect(contents.textContent).not.toContain("truncated");
  });
});

describe("/manage/agents — the APM pin form in the sheet", () => {
  it("patches all three fields as one triple", async () => {
    const { requests } = mountSheet(pinned.id, [{ path: pinPath, method: "PATCH", body: pinned }]);
    await openPinForm(pinned.id);
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
      version: pinned.version,
    });
  });

  it("saves the unlocked pin as ref plus target with no digest", async () => {
    const { requests } = mountSheet(unlockedProfile.id, [
      { path: listPath, method: "GET", body: { items: [unlockedProfile, codexProfile] } },
      {
        path: `/api/v1/agent-profiles/${unlockedProfile.id}/apm/lock`,
        method: "GET",
        body: { request_id: "", status: "none" },
      },
    ]);
    await openPinForm(unlockedProfile.id);
    const save = screen.getByTestId(`agents-apm-save-${unlockedProfile.id}`) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/agent-profiles/${unlockedProfile.id}`, "PATCH"),
      ).toHaveLength(1),
    );
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/agent-profiles/${unlockedProfile.id}`, "PATCH")[0].body ?? "{}",
    );
    // An unlocked pin travels without a digest; the digest field is optional.
    expect(body).toEqual({
      apm_package_ref: "mattpocock/skills#v1.3.1",
      apm_target: "claude",
      apm_lock_digest: null,
      version: unlockedProfile.version,
    });
  });

  it("clears the whole triple on Remove package", async () => {
    const cleared: AgentProfile = {
      ...pinned,
      apm_package_ref: null,
      apm_target: null,
      apm_lock_digest: null,
    };
    const { requests } = mountSheet(pinned.id, [{ path: pinPath, method: "PATCH", body: cleared }]);
    await openPinForm(pinned.id);
    fireEvent.click(screen.getByTestId(`agents-apm-remove-${pinned.id}`));
    await waitFor(() => expect(requestsTo(requests, pinPath, "PATCH")).toHaveLength(1));
    expect(JSON.parse(requestsTo(requests, pinPath, "PATCH")[0].body ?? "{}")).toEqual({
      apm_package_ref: null,
      apm_target: null,
      apm_lock_digest: null,
      version: pinned.version,
    });
  });

  it("shows the 422's code beside its prose", async () => {
    const { requests } = mountSheet(pinned.id, [
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
    await openPinForm(pinned.id);
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
    mountSheet(pinned.id);
    await openPinForm(pinned.id);
    const details = screen.getByTestId(`agents-digest-help-${pinned.id}`);
    expect(details.querySelector("summary")?.textContent).toContain("How do I get this?");
    expect(details.textContent).toContain("moved tag fails closed");
  });

  it("digest help commands reflect the form's current ref and target", async () => {
    mountSheet(pinned.id);
    await openPinForm(pinned.id);
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
    mountSheet(pinned.id);
    await openPinForm(pinned.id);
    const copyBtn = screen.getByTestId(`agents-digest-help-copy-${pinned.id}`) as HTMLButtonElement;
    expect(copyBtn.disabled).toBe(true);
  });

  it("offers Lock it for an unlocked pin and shows the queued lock chip", async () => {
    const unlocked: AgentProfile = {
      ...claudeProfile,
      name: "Claude Code (unlocked skills)",
      apm_package_ref: "mattpocock/skills#v1.3.1",
      apm_target: "claude",
      apm_lock_digest: null,
    };
    const { requests } = mountSheet(unlocked.id, [
      { path: listPath, method: "GET", body: { items: [unlocked, codexProfile] } },
      {
        path: `/api/v1/agent-profiles/${unlocked.id}/apm/lock`,
        method: "GET",
        body: { request_id: "req-unlocked-1", status: "queued" },
      },
    ]);
    const detail = await screen.findByTestId(`profile-detail-${unlocked.id}`);
    // Unlocked pin: the contents are the honest "lock it" prompt, not a
    // fabricated list.
    expect(within(detail).getByTestId(`agent-apm-unlocked-${unlocked.id}`).textContent).toContain(
      "Lock the pin to see its contents",
    );
    // The pin form is closed until the operator opens it; with ref + target
    // saved the Lock it button is enabled.
    await openPinForm(unlocked.id);
    const lockButton = screen.getByTestId("profile-apm-lock") as HTMLButtonElement;
    expect(lockButton.disabled).toBe(false);
    fireEvent.click(lockButton);
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/agent-profiles/${unlocked.id}/apm/lock`, "POST"),
      ).toHaveLength(1),
    );
    const chip = await screen.findByTestId(`profile-apm-lock-status-${unlocked.id}`);
    expect(chip.textContent).toContain("queued");
  });

  it("shows the done lock chip with the recorded digest after a resolve", async () => {
    mountSheet(pinned.id, [
      {
        path: `/api/v1/agent-profiles/${pinned.id}/apm/lock`,
        method: "GET",
        body: { request_id: "req-pinned-1", status: "done", error: null },
      },
    ]);
    await openPinForm(pinned.id);
    const chip = await screen.findByTestId(`profile-apm-lock-status-${pinned.id}`);
    expect(chip.textContent).toContain("locked ✓ sha256:");
  });
});
