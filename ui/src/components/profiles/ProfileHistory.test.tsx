/**
 * The profile version history panel (ADR-0058 part 2 = the UI): the newest-first
 * version list with the field-level diff against the predecessor, the read-only
 * snapshot drawer, and the confirm-then-restore write that lands a NEW version.
 * Against the fake fetch — no network in tests.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import ProfileHistory, { profileVersionDiff } from "./ProfileHistory";
import type { AgentProfileVersion } from "../../api/types";
import { mockFetch, requestsTo, type RouteStub } from "../../test/fakes";

const profileId = "01987a71-2222-7000-8000-abcdef012345";

const v1: AgentProfileVersion = {
  profile_id: profileId,
  version: 1,
  snapshot: { name: "Claude Code", launcher_id: "claude", permission_mode: "ask" },
  created_by: "01987a71-2222-7000-8000-abcdef012345",
  created_at: "2026-10-14T18:00:00Z",
};

const v2: AgentProfileVersion = {
  profile_id: profileId,
  version: 2,
  snapshot: {
    name: "Claude Code",
    launcher_id: "claude",
    permission_mode: "ask",
    apm_package_ref: "mattpocock/skills#v1.3.1",
    apm_target: "claude",
    apm_lock_digest: `sha256:${"1a".repeat(32)}`,
  },
  created_by: "01987a71-2222-7000-8000-abcdef012345",
  created_at: "2026-10-14T18:05:00Z",
};

const v3: AgentProfileVersion = {
  profile_id: profileId,
  version: 3,
  snapshot: { name: "Claude Code", launcher_id: "claude", permission_mode: "ask" },
  created_by: "01987a71-2222-7000-8000-abcdef012345",
  created_at: "2026-10-14T18:10:00Z",
};

function mount() {
  const stubs: RouteStub[] = [
    {
      path: `/api/v1/agent-profiles/${profileId}/versions`,
      method: "GET",
      body: { items: [v1, v2] },
    },
    {
      path: `/api/v1/agent-profiles/${profileId}/versions/1/restore`,
      method: "POST",
      body: v3,
    },
  ];
  const { requests } = mockFetch(stubs);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProfileHistory profileId={profileId} canWrite />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { requests, stubs };
}

afterEach(cleanup);

describe("ProfileHistory", () => {
  it("diffs a version against its predecessor and reads the first version as created", () => {
    expect(profileVersionDiff(v1.snapshot, v2.snapshot)).toEqual(["APM pin changed"]);
    expect(profileVersionDiff(null, v1.snapshot)).toEqual(["created"]);
    expect(profileVersionDiff(v2.snapshot, v2.snapshot)).toEqual(["no change"]);
  });

  it("renders the versions newest first, each with the field-level diff", async () => {
    mount();
    const v2row = await screen.findByTestId("profile-history-row-v2");
    const v1row = screen.getByTestId("profile-history-row-v1");
    expect(v2row.compareDocumentPosition(v1row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(v2row).getByTestId("profile-history-diff-v2").textContent).toContain(
      "APM pin changed",
    );
    expect(within(v1row).getByTestId("profile-history-diff-v1").textContent).toContain("created");
  });

  it("opens the read-only snapshot drawer for one version", async () => {
    mount();
    fireEvent.click(await screen.findByTestId("profile-history-view-v2"));
    expect(await screen.findByTestId("profile-history-drawer")).toBeTruthy();
  });

  it("confirms a restore, POSTs it, and shows the new version the restore landed", async () => {
    const { requests, stubs } = mount();
    const versionsStub = stubs.find(
      (candidate) =>
        candidate.path === `/api/v1/agent-profiles/${profileId}/versions` &&
        candidate.method === "GET",
    );
    expect(versionsStub).toBeDefined();
    // The restore lands version 3: the history the panel reads back afterwards
    // carries it, so the stub answers with the restored-to state before the
    // confirm POST triggers the invalidation refetch.
    versionsStub!.body = { items: [v1, v2, v3] };
    fireEvent.click(await screen.findByTestId("profile-history-restore-v1"));
    expect(screen.getByTestId("profile-history-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("profile-history-restore-submit"));
    await waitFor(() =>
      expect(
        requestsTo(requests, `/api/v1/agent-profiles/${profileId}/versions/1/restore`, "POST"),
      ).toHaveLength(1),
    );
    expect(await screen.findByTestId("profile-history-row-v3")).toBeTruthy();
  }, 20000);
});
