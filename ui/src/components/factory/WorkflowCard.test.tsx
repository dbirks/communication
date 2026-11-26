/**
 * WorkflowCard — where a card links (scoped and unscoped), and what its state
 * line is allowed to claim. The `Open run` link is a second target inside the
 * card, so the card's own link must not cover it.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowCard, cardMetaLines, cardState, runLabel } from "./WorkflowCard";
import type { FactoryWorkflowItem } from "./factoryData";
import type { CrossProjectRunSummary } from "../../api/home";
import type { PipelineSummary } from "../../api/types";
import { projectFixture } from "../../test/fakes";

afterEach(cleanup);

const pipeline: PipelineSummary = {
  id: "01987b20-0000-7000-8000-abcdef012345",
  slug: "wf-1",
  display_name: "Workflow One",
  latest_revision_number: 3,
  revision_count: 3,
  archived: false,
};

function runWith(overrides: Partial<CrossProjectRunSummary> = {}): CrossProjectRunSummary {
  return {
    id: "01987b11-2b5b-7e4c-8f20-3d4e5f6a7b8c",
    project_id: projectFixture.id,
    pipeline_id: pipeline.id,
    pipeline_revision_id: "rev-1",
    revision_digest: "sha256:1",
    plan_digest: "sha256:2",
    status: "running",
    depth: 0,
    priority: 0,
    created_at: "2026-11-20T10:00:00Z",
    project_name: projectFixture.name,
    pipeline_slug: pipeline.slug,
    pipeline_display_name: pipeline.display_name,
    steps: [
      { node_id: "plan", kind: "agent.acp", state: "succeeded" },
      { node_id: "test", kind: "process.exec", state: "running" },
    ],
    ...overrides,
  };
}

function item(overrides: Partial<FactoryWorkflowItem> = {}): FactoryWorkflowItem {
  return {
    pipeline,
    steps: [
      { id: "trigger", label: "manual", kind: "trigger", state: "idle" },
      { id: "plan", label: "plan", kind: "agent", state: "idle" },
    ],
    triggerText: "when you start it",
    liveRuns: [],
    draftCount: 1,
    usedIn: [projectFixture.name],
    lastRunAt: null,
    ...overrides,
  };
}

function mount(itemValue: FactoryWorkflowItem, scope: string | null) {
  render(
    <MemoryRouter>
      <WorkflowCard item={itemValue} scope={scope} />
    </MemoryRouter>,
  );
  return screen.getByTestId(`workflow-card-${pipeline.id}`);
}

describe("WorkflowCard", () => {
  it("links to the unscoped editor and words the trigger and the drafts line", () => {
    mount(item(), null);
    const link = screen.getByTestId(`workflow-card-link-${pipeline.id}`);
    expect(link.getAttribute("href")).toBe(`/factory/${pipeline.id}`);
    expect(link.textContent).toBe("Workflow One");
    expect(screen.getByTestId(`workflow-card-trigger-${pipeline.id}`).textContent).toBe(
      "when you start it",
    );
    expect(screen.getByTestId(`workflow-card-meta-${pipeline.id}`).textContent).toBe(
      `1 draft · used in ${projectFixture.name}`,
    );
    expect(screen.getByTestId(`workflow-card-state-${pipeline.id}`).textContent).toBe("idle");
    expect(screen.queryByTestId("workflow-card-run")).toBeNull();
  });

  it("links to the scoped editor in a project scope, and says when it last ran", () => {
    mount(item({ lastRunAt: "2026-11-20T10:00:00Z" }), projectFixture.id);
    expect(screen.getByTestId(`workflow-card-link-${pipeline.id}`).getAttribute("href")).toBe(
      `/p/${projectFixture.id}/factory/${pipeline.id}`,
    );
    expect(screen.getByTestId(`workflow-card-meta-${pipeline.id}`).textContent).toMatch(
      /^1 draft · last ran \d+[smhd]$/,
    );
  });

  it("names the live run and its current step, and offers the run as its own link", () => {
    mount(item({ liveRuns: [runWith()] }), null);
    const state = screen.getByTestId(`workflow-card-state-${pipeline.id}`);
    expect(state.textContent).toBe(`● #${runLabel(runWith()).slice(1)} · test`);
    expect(state.className).toContain("text-st-running-tag-fg");
    const runLink = screen.getByTestId("workflow-card-run");
    expect(runLink.getAttribute("href")).toBe(`/runs/${runWith().id}`);
    // The accessible-card pattern: the card link is the overlay, the run link
    // sits above it rather than under it.
    expect(runLink.className).toContain("relative");
    expect(screen.getByTestId(`workflow-card-link-${pipeline.id}`).className).toContain(
      "after:absolute",
    );
  });

  it("reads an issue-started run by its issue number", () => {
    expect(runLabel(runWith({ trigger: { kind: "issue", ref: "acme/widgets#318" } }))).toBe("#318");
    expect(runLabel(runWith())).toBe(`#${runWith().id.slice(-8)}`);
  });

  it("says waiting, in the waiting token, for a run a gate holds", () => {
    mount(item({ liveRuns: [runWith({ status: "waiting_human" })] }), null);
    const state = screen.getByTestId(`workflow-card-state-${pipeline.id}`);
    expect(state.textContent).toBe("! waiting on you");
    expect(state.className).toContain("text-st-waiting-tag-fg");
  });

  it("drops the empty parts of the meta line", () => {
    expect(cardMetaLines({ draftCount: 0, usedIn: [], lastRunAt: null }, null)).toBe("");
    expect(cardMetaLines({ draftCount: 2, usedIn: [], lastRunAt: null }, null)).toBe("2 drafts");
    expect(
      cardMetaLines({ draftCount: 0, usedIn: [projectFixture.name], lastRunAt: null }, null),
    ).toBe(`used in ${projectFixture.name}`);
    // A project scope with no run yet says nothing rather than `last ran unknown`.
    expect(cardMetaLines({ draftCount: 0, usedIn: [], lastRunAt: null }, projectFixture.id)).toBe(
      "",
    );
  });

  it("keeps a runless card's state quiet", () => {
    expect(cardState(null).text).toBe("idle");
    expect(cardState(null).className).toBe("text-muted");
  });
});
