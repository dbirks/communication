/**
 * The Workflows index row (3a): the chip is the server's own summary, the
 * chain is the document's own node ids (scopes folded to one `loop: …` chip),
 * the assignment cell never claims "unassigned" while a read is in flight,
 * and the open-draft line names the real editor — no "by assistant".
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowRow, stepChain } from "./WorkflowRow";
import type { Assignment, DraftSummary, PipelineRevisionSummary, Project } from "../../api/types";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { projectFixture } from "../../test/fakes";
import { wireAssignmentList, wirePipeline } from "../../test/fixtures/m4/wire";
import { samplePipelineDocument } from "../../test/fixtures/m4/samplePipeline";

const pipeline = {
  id: wirePipeline.id,
  slug: wirePipeline.slug,
  display_name: wirePipeline.display_name,
};
const document = samplePipelineDocument as unknown as DefinitionDocument;
const revision: PipelineRevisionSummary = wirePipeline.revisions[0];
const draft: DraftSummary = {
  id: "01987b23-9999-7000-8000-abcdef012345",
  status: "valid",
  version: 12,
  updated_at: "2026-07-31T09:00:00Z",
  edited_by: "actor-1",
};
const assignment: Assignment = {
  ...wireAssignmentList.assignments[0],
  pipeline_id: wirePipeline.id,
};
const project: Project = projectFixture;

function textOf(testid: string): string {
  return screen.getByTestId(testid).textContent ?? "";
}

function mount(overrides: Partial<Parameters<typeof WorkflowRow>[0]> = {}) {
  const onDuplicate = vi.fn();
  const onOpen = vi.fn();
  render(
    <MemoryRouter>
      <WorkflowRow
        pipeline={pipeline}
        definitionReady
        revisions={[revision]}
        document={document}
        drafts={[draft]}
        nameOf={(id) => (id === "actor-1" ? "Ada Lovelace" : null)}
        assigned={[{ project, assignment, cron: null }]}
        assignmentsResolved
        canAuthor
        duplicating={false}
        onDuplicate={onDuplicate}
        onOpen={onOpen}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onDuplicate, onOpen };
}

afterEach(cleanup);

describe("stepChain", () => {
  it("lists top-level node ids in definition order and folds scopes to one loop chip", () => {
    expect(stepChain(document)).toEqual([
      { label: "plan", loop: false },
      { label: "approve", loop: false },
      { label: "loop: implement · test · review", loop: true },
      { label: "verdict", loop: false },
      { label: "publish_verified", loop: false },
      { label: "publish_needs_attention", loop: false },
    ]);
  });

  it("is empty for a document that has not arrived", () => {
    expect(stepChain(null)).toEqual([]);
  });
});

describe("WorkflowRow", () => {
  it("shows the published chip from the server summary: r-number and first six digest hex", () => {
    mount();
    expect(textOf(`workflow-revision-${pipeline.slug}`)).toContain(
      `PUBLISHED r${revision.revision_number} 3f2f3f`,
    );
    // The chain reads the document's own ids; the scope is one cell.
    expect(textOf(`workflow-chain-${pipeline.slug}-2`)).toContain(
      "loop: implement · test · review",
    );
  });

  it("shows `DRAFT ONLY` only once the definition arrived with zero revisions", () => {
    mount({ revisions: [], document: null });
    expect(textOf(`workflow-revision-${pipeline.slug}`)).toContain("DRAFT ONLY");
  });

  it("keeps the chip honest while the definition read is in flight", () => {
    mount({ definitionReady: false, revisions: [], document: null });
    expect(textOf(`workflow-revision-${pipeline.slug}`)).toContain("loading");
  });

  it("names the assigned project, and the trigger is `manual` with no enabled cron", () => {
    mount();
    expect(textOf(`workflow-assignments-${pipeline.slug}`)).toContain(project.name);
    expect(textOf(`workflow-trigger-${pipeline.slug}`)).toContain("manual");
  });

  it("renders `cron <expr>` when the owning project has an enabled schedule", () => {
    mount({ assigned: [{ project, assignment, cron: "0 6 * * 1" }] });
    expect(textOf(`workflow-trigger-${pipeline.slug}`)).toContain("cron 0 6 * * 1");
  });

  it("never claims unassigned while the fan is still settling", () => {
    mount({ assigned: [], assignmentsResolved: false });
    expect(textOf(`workflow-assignments-${pipeline.slug}`)).toContain("…");
    expect(textOf(`workflow-trigger-${pipeline.slug}`)).toContain("…");
  });

  it("says so, honestly, once the fan has settled with nothing", () => {
    mount({ assigned: [], assignmentsResolved: true });
    expect(textOf(`workflow-assignments-${pipeline.slug}`)).toContain(
      "not assigned to a project you can see",
    );
    expect(textOf(`workflow-trigger-${pipeline.slug}`)).toContain("—");
  });

  it("links the newest un-published draft with the real editor name", () => {
    mount();
    expect(textOf(`workflow-draft-${pipeline.slug}`)).toContain("draft v12 · by Ada Lovelace");
  });

  it("shows `no open draft` when every draft is published", () => {
    mount({ drafts: [{ ...draft, status: "published" }] });
    expect(textOf(`workflow-draft-${pipeline.slug}`)).toContain("no open draft");
  });

  it("offers Duplicate (library role only) and Open, and reports progress", () => {
    const { onDuplicate, onOpen } = mount();
    fireEvent.click(screen.getByTestId(`workflow-duplicate-${pipeline.slug}`));
    expect(onDuplicate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId(`workflow-open-${pipeline.slug}`));
    expect(onOpen).toHaveBeenCalledOnce();
    cleanup();
    mount({ canAuthor: false, duplicating: false });
    expect(screen.queryByTestId(`workflow-duplicate-${pipeline.slug}`)).toBeNull();
  });
});
