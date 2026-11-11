/**
 * The SKILLS panel's attached-collections block (ADR-0084) against the fake
 * fetch, mounted through ProfileDetail the way the agents page does. The
 * claims tested are the ones the wire supports: the ordered rows with the
 * attributed skill counts, the reorder/remove/attach PATCH bodies (whole
 * list + version CAS token, ADR-0058), the publish-order note, the
 * `overridden by …` attribution from the lock summary, the empty state, and
 * the Pi warning — shown ONLY for the `pi` launcher, because spike A-1 is
 * open (docs/compatibility/APM.md).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import ProfileDetail from "./ProfileDetail";
import { mockFetch, requestsTo, meFixture, type RouteStub } from "../../test/fakes";
import type { AgentProfile } from "../../api/types";

const MATT_REF = "mattpocock/skills#v1.3.2";
const SHA = "63912a91d52c43946f974f2aaf661334a6116a82";
const PSTACK_TDD = `cursor/plugins/harness/pstack/claude-code/skills/tdd#${SHA}`;

const mattCollection = {
  id: "c-matt",
  slug: "matt-pocock-skills",
  name: "Matt Pocock skills",
  description: "The whole plugin set.",
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 1,
  latest_revision: {
    revision_id: "r-matt-1",
    revision: 1,
    status: "published",
    entries: [{ ref: MATT_REF, skills: ["tdd"] }],
    created_at: "2026-11-11T10:00:00Z",
  },
};

const pstackCollection = {
  id: "c-pstack",
  slug: "pstack-claude-code",
  name: "pstack (Claude Code)",
  description: "Per-skill pstack refs.",
  created_by: "u-1",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 2,
  latest_revision: {
    revision_id: "r-pstack-2",
    revision: 2,
    status: "published",
    entries: [{ ref: PSTACK_TDD }],
    created_at: "2026-11-11T10:00:00Z",
  },
};

const reviewDraft = {
  id: "c-review",
  slug: "review-conventions",
  name: "Review conventions",
  description: "The team's own instructions.",
  created_by: "migration:00033",
  created_at: "2026-11-11T10:00:00Z",
  updated_at: "2026-11-11T10:00:00Z",
  published_revisions: 0,
  latest_revision: {
    revision_id: "r-review-1",
    revision: 1,
    status: "draft",
    entries: [],
    created_at: "2026-11-11T10:00:00Z",
  },
};

function profileWith(overrides: Partial<AgentProfile>): AgentProfile {
  return {
    id: "01987a71-2222-7000-8000-abcdef012345",
    name: "Claude Code",
    launcher_id: "claude",
    permission_mode: "ask",
    created_at: "2026-10-14T18:00:00Z",
    version: 3,
    apm_collections: [],
    ...overrides,
  };
}

function mount(profile: AgentProfile, extra: RouteStub[] = []) {
  const { requests } = mockFetch([
    { path: "/api/v1/me", body: { ...meFixture, is_org_admin: true } },
    { path: "/api/v1/projects", body: { items: [] } },
    { path: "/api/v1/launchers", body: { launchers: [] } },
    {
      path: "/api/v1/system/sandbox",
      body: {
        workers: [],
        pinned_backend_version: "0.80.0",
        policy_digest: `sha256:${"cd".repeat(32)}`,
      },
    },
    {
      path: `/api/v1/agent-profiles/${profile.id}/usage`,
      body: { workflow_count: 0, step_count: 0, uses: [], truncated: false },
    },
    { path: `/api/v1/agent-profiles/${profile.id}/versions`, body: { items: [] } },
    {
      path: "/api/v1/apm-collections",
      body: { collections: [mattCollection, pstackCollection, reviewDraft], next_cursor: null },
    },
    {
      path: `/api/v1/agent-profiles/${profile.id}`,
      method: "PATCH",
      body: (n: number) => ({ ...profile, version: 3 + n }),
    },
    ...extra,
  ]);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProfileDetail
          profile={profile}
          canWrite
          launchers={[]}
          sandbox={null}
          apmOpen={false}
          onApmToggle={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return requests;
}

afterEach(cleanup);

describe("SKILLS panel — attached collections", () => {
  it("renders the ordered rows with the attributed skill counts and the order note", async () => {
    const profile = profileWith({
      apm_collections: [
        { collection_id: "c-matt", revision: 1 },
        { collection_id: "c-pstack", revision: 2 },
      ],
      apm_lock_digest: `sha256:${"1a".repeat(32)}`,
      apm_contents: {
        skills: ["tdd"],
        skill_refs: [{ skill: "tdd", from_ref: PSTACK_TDD }],
        truncated: false,
      },
    });
    mount(profile);
    // The names come from the library read; wait for it before counting rows.
    await screen.findByText("Matt Pocock skills");
    const list = screen.getByTestId(`agent-skills-list-${profile.id}`);
    const rows = within(list).getAllByTestId(/^agent-skills-row-/);
    expect(rows[0].textContent).toContain("①");
    expect(rows[0].textContent).toContain("Matt Pocock skills");
    expect(rows[0].textContent).toContain("· r1 ·");
    expect(rows[1].textContent).toContain("②");
    expect(rows[1].textContent).toContain("pstack (Claude Code)");
    expect(rows[1].textContent).toContain("1 skill");
    // The order rule, stated once under the list.
    expect(screen.getByTestId(`agent-skills-order-note-${profile.id}`).textContent).toBe(
      "Later collections win when two ship the same skill.",
    );
    // The lock's attribution: matt declared `tdd` but the later pstack ref
    // owns it — shown, not reinterpreted.
    const overridden = await screen.findByTestId(`agent-skills-overridden-c-matt-tdd`);
    expect(overridden.textContent).toContain("overridden by");
    expect(overridden.textContent).toContain(PSTACK_TDD);
    // The panel title is SKILLS and the old single-package row keeps its
    // "Extra package" label.
    expect(screen.getByTestId(`agent-apm-extra-label-${profile.id}`)).toBeDefined();
  });

  it("shows the empty state when no collections are attached", async () => {
    const profile = profileWith({ apm_collections: [] });
    mount(profile);
    const empty = await screen.findByTestId(`agent-skills-none-${profile.id}`);
    expect(empty.textContent).toBe("No skills attached.");
    expect(screen.queryByTestId(`agent-skills-order-note-${profile.id}`)).toBeNull();
  });

  it("warns about Pi staging only for the pi launcher", async () => {
    const pi = profileWith({
      launcher_id: "pi",
      apm_collections: [{ collection_id: "c-matt", revision: 1 }],
    });
    mount(pi);
    const warning = await screen.findByTestId(`agent-skills-pi-warning-${pi.id}`);
    expect(warning.textContent).toBe("Pi reads .agents/skills — staged, not yet verified for Pi.");

    cleanup();
    const claude = profileWith({ apm_collections: [{ collection_id: "c-matt", revision: 1 }] });
    mount(claude);
    await screen.findByTestId(`agent-skills-list-${claude.id}`);
    expect(screen.queryByTestId(`agent-skills-pi-warning-${claude.id}`)).toBeNull();
  });

  it("moving a row PATCHes the whole list in the new order with the version token", async () => {
    const pins = [
      { collection_id: "c-matt", revision: 1 },
      { collection_id: "c-pstack", revision: 2 },
    ];
    const profile = profileWith({ apm_collections: pins });
    const requests = mount(profile);
    const down = await screen.findByTestId("agent-skills-down-c-matt");
    fireEvent.click(down);
    await waitFor(() => {
      const [request] = requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH");
      expect(request).toBeDefined();
    });
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH")[0].body ?? "{}",
    ) as { apm_collections: unknown[]; version: number };
    expect(body.apm_collections).toEqual([
      { collection_id: "c-pstack", revision: 2 },
      { collection_id: "c-matt", revision: 1 },
    ]);
    expect(body.version).toBe(3);
  });

  it("removing a row PATCHes the remaining list", async () => {
    const profile = profileWith({
      apm_collections: [
        { collection_id: "c-matt", revision: 1 },
        { collection_id: "c-pstack", revision: 2 },
      ],
    });
    const requests = mount(profile);
    const remove = await screen.findByTestId("agent-skills-remove-c-pstack");
    fireEvent.click(remove);
    await waitFor(() => {
      const [request] = requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH");
      expect(request).toBeDefined();
    });
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH")[0].body ?? "{}",
    ) as { apm_collections: { collection_id: string }[] };
    expect(body.apm_collections.map((pin) => pin.collection_id)).toEqual(["c-matt"]);
  });

  it("the picker lists published collections and attaches the newest published revision", async () => {
    const profile = profileWith({ apm_collections: [{ collection_id: "c-matt", revision: 1 }] });
    const requests = mount(profile, [
      {
        path: "/api/v1/apm-collections/c-pstack",
        body: {
          collection: pstackCollection,
          revisions: [{ ...pstackCollection.latest_revision, created_by: "u-1" }],
        },
      },
    ]);
    fireEvent.click(await screen.findByTestId(`agent-skills-attach-${profile.id}`));
    const dialog = await screen.findByTestId("agent-skills-picker");
    // Only published collections are attachable — the empty draft is absent.
    expect(within(dialog).getByTestId("agent-skills-picker-row-c-pstack")).toBeDefined();
    expect(within(dialog).queryByTestId("agent-skills-picker-row-c-review")).toBeNull();
    // Search narrows by name.
    fireEvent.change(within(dialog).getByTestId("agent-skills-picker-search"), {
      target: { value: "pstack" },
    });
    expect(within(dialog).queryByTestId("agent-skills-picker-row-c-matt")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("agent-skills-picker-attach-c-pstack"));
    await waitFor(() => {
      const [request] = requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH");
      expect(request).toBeDefined();
    });
    const body = JSON.parse(
      requestsTo(requests, `/api/v1/agent-profiles/${profile.id}`, "PATCH")[0].body ?? "{}",
    ) as { apm_collections: { collection_id: string; revision: number }[] };
    expect(body.apm_collections).toEqual([
      { collection_id: "c-matt", revision: 1 },
      { collection_id: "c-pstack", revision: 2 },
    ]);
  });
});
