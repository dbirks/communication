/**
 * NeedsYouCards: the empty sentence and the filled pale-waiting cards (the
 * gate's own title line, the project · age meta, the approval-page link).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYouCards } from "./NeedsYouCards";
import type { CrossProjectRunSummary } from "../../api/home";
import type { Approval } from "../../api/types";
import { projectFixture } from "../../test/fakes";

const run: CrossProjectRunSummary = {
  id: "01987a90-2222-7000-8000-bbbbbbbbbbbb",
  project_id: projectFixture.id,
  pipeline_id: "01987a90-4444-7000-8000-444444444444",
  pipeline_revision_id: "01987a90-5555-7000-8000-555555555555",
  revision_digest: "rev-digest",
  plan_digest: "plan-digest",
  status: "waiting_human",
  depth: 0,
  priority: 0,
  created_at: "2026-10-14T16:00:00Z",
  project_name: "Project One",
  pipeline_slug: "wf-1",
  pipeline_display_name: "Workflow One",
  steps: [],
};

const approval: Approval = {
  id: "01987a90-1111-7000-8000-aaaaaaaaaaaa",
  project_id: projectFixture.id,
  run_id: run.id,
  node_execution_id: "01987a90-3333-7000-8000-cccccccccccc",
  kind: "pipeline_gate",
  summary: "Approve the migration.\nThe loop starts after it.",
  artifact_refs: [],
  approver_roles: ["maintainer"],
  approver_user_ids: ["01987a70-9999-7000-8000-000000000001"],
  deadline_at: "2026-10-15T18:00:00Z",
  on_timeout: "fail",
  re_requested: false,
  state: "pending",
  version: 1,
  created_at: "2026-10-14T16:00:00Z",
};

afterEach(cleanup);

describe("NeedsYouCards", () => {
  it("says the one true sentence when nothing waits", () => {
    render(
      <MemoryRouter>
        <NeedsYouCards approvals={[]} runs={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("needs-you-empty").textContent).toBe("Nothing is waiting on you.");
  });

  it("draws one pale card per gate: the summary's first line, project · age, linking to the gate", () => {
    render(
      <MemoryRouter>
        <NeedsYouCards approvals={[approval]} runs={[run]} />
      </MemoryRouter>,
    );
    const card = screen.getByTestId(`needs-you-card-${approval.id}`);
    expect(card.getAttribute("href")).toBe(`/approvals/${approval.id}`);
    // The glyph + word rule: the title carries the "!", never colour alone.
    expect(card.textContent).toContain("! Approve the migration.");
    expect(card.textContent).toContain("Project One");
    // The body's second line stays off the card (the gate page holds it).
    expect(card.textContent).not.toContain("The loop starts after it.");
  });

  it("names an unknown run by its short id rather than inventing a project", () => {
    render(
      <MemoryRouter>
        <NeedsYouCards approvals={[approval]} runs={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId(`needs-you-card-${approval.id}`).textContent).toContain(
      "run #bbbbbbbb",
    );
  });
});
