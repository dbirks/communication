/**
 * The profile detail's APM lock chip and FROM APM PACKAGE panel against the
 * fake fetch. The chip and the panel answer from the agent-profiles list, so
 * the test mounts the detail behind that read (like the agents page does) and
 * walks the lock flow: an unlocked pin in the list, a live lock status, a
 * resolve that finishes while the operator watches.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileDetail from "./ProfileDetail";
import { useAgentProfiles } from "../../api/queries";
import type { AgentProfile, Me, SystemSandbox } from "../../api/types";
import type { Launcher } from "../../lib/profiles";
import { claudeProfile, meFixture, mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const admin: Me = { ...meFixture, is_org_admin: true };

const unlockedProfile: AgentProfile = {
  ...claudeProfile,
  name: "Claude Code (unlocked skills)",
  apm_package_ref: "mattpocock/skills#v1.3.1",
  apm_target: "claude",
  apm_lock_digest: null,
};

const lockedProfile: AgentProfile = {
  ...unlockedProfile,
  name: "Claude Code (pinned skills)",
  apm_lock_digest: `sha256:${"1a".repeat(32)}`,
  apm_contents: {
    skills: ["ask-matt"],
    instructions: ["README.md"],
    mcp_servers: ["github"],
    truncated: false,
  },
};

const LIST_PATH = "/api/v1/agent-profiles";
const LOCK_PATH = `/api/v1/agent-profiles/${unlockedProfile.id}/apm/lock`;

const cap = (
  name: "acp_session" | "resume" | "permission_prompts" | "nono_required",
  result: "observed" | "not_supported" | "not_tested" = "not_tested",
) => ({
  capability: name,
  result,
  observed_at: result === "observed" ? "2026-10-14T18:00:00Z" : null,
  evidence: result === "observed" ? "docs/compatibility/SANDBOX.md" : null,
});

/** C5 fixture: claude is fully evidenced; the rest are not. */
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

/**
 * The agents page wires the list read into the detail; this harness reproduces
 * that edge without mounting the whole page.
 */
function LockFlow({ profile }: { profile: AgentProfile }) {
  const profiles = useAgentProfiles();
  const selected = profiles.data?.items.find((p) => p.id === profile.id) ?? profile;
  return (
    <ProfileDetail
      profile={selected}
      canWrite
      launchers={launcherFixture.launchers}
      sandbox={sandboxFixture}
      apmOpen
      onApmToggle={() => {}}
    />
  );
}

afterEach(cleanup);

describe("ProfileDetail — APM lock chip and contents", () => {
  it("refetches the agent-profiles list when the lock resolve finishes, then shows the digest and contents", async () => {
    vi.useFakeTimers();
    try {
      const stubs: RouteStub[] = [
        { path: "/api/v1/me", body: admin },
        { path: "/api/v1/users", body: { items: [] } },
        { path: "/api/v1/projects", body: { items: [] } },
        { path: "/api/v1/launchers", body: launcherFixture },
        { path: "/api/v1/system/sandbox", body: sandboxFixture },
        { path: LIST_PATH, method: "GET", body: { items: [unlockedProfile] } },
        {
          path: LOCK_PATH,
          method: "GET",
          body: { request_id: "req-unlocked-1", status: "queued" },
        },
        {
          path: LOCK_PATH,
          method: "POST",
          body: { request_id: "req-unlocked-1", status: "queued" },
        },
        {
          path: `/api/v1/agent-profiles/${unlockedProfile.id}/usage`,
          method: "GET",
          body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
        },
      ];
      const { requests } = mockFetch(stubs);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
      });
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/profiles/${unlockedProfile.id}`]}>
            <Routes>
              <Route path="/profiles/:id" element={<LockFlow profile={unlockedProfile} />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );

      // Let the mount's reads land while every clock is fake.
      for (let i = 0; i < 5; i += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      const detail = screen.getByTestId(`profile-detail-${unlockedProfile.id}`);
      // Unlocked pin: the honest "lock it" prompt, digest "—".
      expect(
        within(detail).getByTestId(`agent-apm-unlocked-${unlockedProfile.id}`).textContent,
      ).toContain("Lock the pin to see its contents");
      expect(within(detail).getByTestId(`agent-apm-digest-${unlockedProfile.id}`).textContent).toBe(
        "—",
      );
      const chip = screen.getByTestId(`profile-apm-lock-status-${unlockedProfile.id}`);
      expect(chip.textContent).toContain("queued");

      // The resolve lands: the status read moves to done, and the profiles
      // list — the read the chip and the panel answer from — must be refetched.
      const lockStub = stubs.find(
        (candidate) =>
          candidate.path === LOCK_PATH &&
          candidate.method === "GET" &&
          (candidate.body as { status?: string } | undefined)?.status === "queued",
      );
      expect(lockStub).toBeDefined();
      lockStub!.body = { request_id: "req-unlocked-1", status: "done", error: null };
      const listStub = stubs.find(
        (candidate) => candidate.path === LIST_PATH && candidate.method === "GET",
      );
      expect(listStub).toBeDefined();
      listStub!.body = { items: [lockedProfile] };

      const listGetsBeforeDone = requestsTo(requests, LIST_PATH, "GET").length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // Flush the invalidated list refetch so the new pin can paint.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // The agent-profiles list was refetched after the done transition.
      expect(requestsTo(requests, LIST_PATH, "GET").length).toBeGreaterThan(listGetsBeforeDone);

      // The chip now carries the profile's short digest.
      const doneChip = screen.getByTestId(`profile-apm-lock-status-${unlockedProfile.id}`);
      // shortDigest is 12 hex: `sha256:` + 64 hex, sliced to 12.
      expect(doneChip.textContent).toContain(`locked ✓ sha256:1a1a1a1a1a1a`);
      // The panel shows the digest and the skills the resolve reported.
      expect(within(detail).getByTestId(`agent-apm-digest-${unlockedProfile.id}`).textContent).toBe(
        "1a1a1a1a1a1a",
      );
      const contents = within(detail).getByTestId(`agent-apm-contents-${unlockedProfile.id}`);
      expect(contents.textContent).toContain("ask-matt");
      expect(contents.textContent).toContain("MCP SERVERS");
      // The "lock the pin" prompt is gone once the resolve is done.
      expect(within(detail).queryByTestId(`agent-apm-unlocked-${unlockedProfile.id}`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
