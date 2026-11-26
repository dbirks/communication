/**
 * The profiles table of Manage → Agents & models: the columns, the name
 * link to the profile's sheet, the empty sentence, and the Skills / Used by
 * cells. No hooks — the table is pure data.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import ProfilesTable from "./ProfilesTable";
import type { AgentProfile } from "../../../api/types";
import type { Launcher, SystemSandbox } from "../../../lib/profiles";

const launchers: Launcher[] = [
  {
    id: "claude",
    display_name: "Claude Code",
    registered: true,
    workers_online: 1,
    capabilities: [
      {
        capability: "nono_required",
        result: "observed",
        observed_at: "2026-10-14T18:00:00Z",
        evidence: null,
      },
    ],
  },
];

const sandbox: SystemSandbox = {
  workers: [
    {
      worker_id: "worker-1",
      backend: "nono",
      backend_version: "0.80.0",
      enforcement: "required",
      verified: true,
    },
  ],
  pinned_backend_version: "0.80.0",
  policy_digest: "sha256:abc",
};

const profile = (overrides: Partial<AgentProfile> & { id: string }): AgentProfile => ({
  name: "Profile One",
  launcher_id: "claude",
  permission_mode: "ask",
  created_at: "2026-10-14T18:00:00Z",
  version: 1,
  ...overrides,
});

function renderTable(profiles: AgentProfile[]) {
  return render(
    <MemoryRouter>
      <ProfilesTable profiles={profiles} launchers={launchers} sandbox={sandbox} />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe("ProfilesTable", () => {
  it("prints the columns and the empty sentence when there are no profiles", () => {
    renderTable([]);
    expect(screen.getByTestId("profiles-table")).toBeTruthy();
    expect(screen.getByText("No agent profiles yet.")).toBeTruthy();
  });

  it("prints the columns and one row per profile with the name linked to the sheet", () => {
    renderTable([
      profile({
        id: "p-1",
        name: "Pinned Skills",
        model: "claude-opus-4",
        apm_contents: { skills: ["one", "two"] },
      }),
      profile({ id: "p-2", name: "Default Skills", model: null }),
    ]);
    for (const column of ["Name", "Harness", "Model", "Skills", "Used by"]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeTruthy();
    }
    const nameLink = screen.getByTestId("agent-name-p-1");
    expect(nameLink.getAttribute("href")).toBe("/manage/agents/p-1");
    expect(nameLink.className).toContain("font-semibold");
    expect(nameLink.className).toContain("no-underline");
    expect(nameLink.className).toContain("hover:underline");
    expect(screen.getByTestId("agent-name-p-2").getAttribute("href")).toBe("/manage/agents/p-2");
  });

  it("renders the launcher label, the sandbox chip, the model or default, the skills count and the Used by dash", () => {
    renderTable([
      profile({
        id: "p-1",
        name: "Pinned",
        model: "claude-opus-4",
        apm_contents: { skills: ["one", "two", "three"] },
      }),
      profile({
        id: "p-2",
        name: "Collections",
        model: null,
        apm_collections: [{ collection_id: "c-1", revision: 3 }],
      }),
    ]);
    // Harness cell: label + chip (both halves evidenced for claude here).
    expect(screen.getByTestId("agent-row-p-1").textContent).toContain("Claude");
    const chip = screen.getByTestId("profile-chip-p-1");
    expect(chip.textContent).toContain("sandbox required · verified");
    expect(chip.className).toContain("rounded-[6px]");
    // Model: pinned model, or "default" when the profile pins none.
    expect(screen.getByTestId("agent-row-p-1").textContent).toContain("claude-opus-4");
    expect(screen.getByTestId("agent-row-p-2").textContent).toContain("default");
    // Skills: the resolved count, or the attachment count.
    expect(screen.getByTestId("agent-row-p-1").textContent).toContain("3 skills");
    expect(screen.getByTestId("agent-row-p-2").textContent).toContain("1 collection");
    // Used by: the honest dash (no per-profile usage read).
    expect(screen.getByTestId("agent-row-p-1").textContent).toContain("—");
  });
});
