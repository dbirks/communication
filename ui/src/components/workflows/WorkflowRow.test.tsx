/**
 * The Workflows index row (1b): the chip is the server's own summary, the
 * chain is the document's own node ids (scopes folded to one `loop: …` chip,
 * a draft-only row chaining from its newest open draft's own document), the
 * assignment cell never claims "unassigned" while a read is in flight, and
 * the row prints no draft line — `Edit` opens the workflow page.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoveToFolderDialog, WorkflowRow, stepChain } from "./WorkflowRow";
import { UNFILED_FOLDER } from "../../api/pipelines";
import type { Assignment, PipelineRevisionSummary, Project } from "../../api/types";
import type { DefinitionDocument } from "../../lib/pipeline/definition";
import { PIPELINE_TEMPLATES } from "../../lib/pipeline/templates";
import { mockFetch, projectFixture, requestsTo } from "../../test/fakes";
import {
  WIRE_PIPELINE_ID,
  wireAssignmentList,
  wirePipeline,
  wirePipelineList,
} from "../../test/fixtures/m4/wire";
import { samplePipelineDocument } from "../../test/fixtures/m4/samplePipeline";

const pipeline = {
  id: wirePipeline.id,
  slug: wirePipeline.slug,
  display_name: wirePipeline.display_name,
};
const document = samplePipelineDocument as unknown as DefinitionDocument;
const revision: PipelineRevisionSummary = wirePipeline.revisions[0];
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
        assigned={[{ project, assignment, cron: null }]}
        assignmentsResolved
        canAuthor
        duplicating={false}
        onDuplicate={onDuplicate}
        onOpen={onOpen}
        exportDocument={null}
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
  it("shows the published chip from the server summary: the r-number (the digest moved to the workflow page)", () => {
    mount();
    expect(textOf(`workflow-revision-${pipeline.slug}`)).toContain(`r${revision.revision_number}`);
    expect(textOf(`workflow-revision-${pipeline.slug}`)).not.toContain("3f2f3f");
    // The chain reads the document's own ids; the scope is one cell.
    expect(textOf(`workflow-chain-${pipeline.slug}-2`)).toContain(
      "loop: implement · test · review",
    );
  });

  it("shows `draft · not published` only once the definition arrived with zero revisions", () => {
    mount({ revisions: [], document: null });
    expect(textOf(`workflow-revision-${pipeline.slug}`)).toContain("draft · not published");
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

  it("says `Not used yet` once the fan has settled with nothing, and drops the trigger line", () => {
    mount({ assigned: [], assignmentsResolved: true });
    expect(textOf(`workflow-assignments-${pipeline.slug}`)).toContain("Not used yet");
    expect(screen.queryByTestId(`workflow-trigger-${pipeline.slug}`)).toBeNull();
  });

  it("prints no draft line — `Edit` opens the workflow page, which carries the open draft", () => {
    mount();
    expect(screen.queryByTestId(`workflow-draft-${pipeline.slug}`)).toBeNull();
  });

  it("derives the chain from the newest open draft's own document when there is no revision", () => {
    const plan = PIPELINE_TEMPLATES.find((template) => template.id === "plan-with-approval");
    mount({ revisions: [], document: null, openDraftDocument: plan?.documentYaml ?? null });
    // The sample document's own top-level ids, in definition order.
    expect(textOf(`workflow-chain-${pipeline.slug}-0`)).toContain("survey");
    expect(textOf(`workflow-chain-${pipeline.slug}-1`)).toContain("plan");
    expect(textOf(`workflow-chain-${pipeline.slug}-2`)).toContain("approve");
    expect(textOf(`workflow-chain-${pipeline.slug}-3`)).toContain("publish_plan");
  });

  it("stays honest with `—` while a draft-only row's document has not arrived", () => {
    mount({ revisions: [], document: null });
    expect(screen.queryByTestId(`workflow-chain-${pipeline.slug}-0`)).toBeNull();
  });

  it("offers Duplicate (library role only) and Open, and reports progress", () => {
    const { onDuplicate, onOpen } = mount();
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    fireEvent.click(screen.getByTestId(`workflow-duplicate-${pipeline.slug}`));
    expect(onDuplicate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId(`workflow-open-${pipeline.slug}`));
    expect(onOpen).toHaveBeenCalledOnce();
    cleanup();
    mount({ canAuthor: false, duplicating: false });
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    expect(screen.queryByTestId(`workflow-duplicate-${pipeline.slug}`)).toBeNull();
  });

  it("offers `Move to folder…` to authors only, wired to the row action", () => {
    const onMoveToFolder = vi.fn();
    mount({ onMoveToFolder });
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    fireEvent.click(screen.getByTestId(`workflow-move-folder-${pipeline.slug}`));
    expect(onMoveToFolder).toHaveBeenCalledOnce();
    cleanup();
    mount({ canAuthor: false, duplicating: false, onMoveToFolder });
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    expect(screen.queryByTestId(`workflow-move-folder-${pipeline.slug}`)).toBeNull();
  });

  it("omits `Use in a repo…` while no dialog exists, and offers it once one is wired", () => {
    mount();
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    expect(screen.queryByTestId(`workflow-menu-use-in-repo-${pipeline.slug}`)).toBeNull();
    cleanup();
    const onUseInRepo = vi.fn();
    mount({ onUseInRepo });
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    fireEvent.click(screen.getByTestId(`workflow-menu-use-in-repo-${pipeline.slug}`));
    expect(onUseInRepo).toHaveBeenCalledOnce();
  });

  it("offers `Export YAML` only when the row has a document to export", () => {
    mount();
    fireEvent.click(screen.getByTestId(`workflow-menu-${pipeline.slug}`));
    expect(screen.queryByTestId(`workflow-menu-export-yaml-${pipeline.slug}`)).toBeNull();
  });
});

describe("MoveToFolderDialog (ADR-0049 § 8)", () => {
  const folderRow = {
    id: WIRE_PIPELINE_ID,
    slug: pipeline.slug,
    display_name: pipeline.display_name,
    folder: null,
  };
  const patchPath = `/api/v1/pipelines/${WIRE_PIPELINE_ID}`;

  function mountDialog(overrides: { folders?: string[] } = {}) {
    const { fetchMock, requests } = mockFetch([
      { path: patchPath, method: "PATCH", body: { ...wirePipeline, folder: "Delivery" } },
      {
        path: "/api/v1/pipelines",
        body: { pipelines: [{ ...wirePipelineList.pipelines[0], folder: "Delivery" }] },
      },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <MoveToFolderDialog
            pipeline={folderRow}
            folders={overrides.folders ?? ["Delivery", "Ops"]}
            onClose={() => {}}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { fetchMock, requests };
  }

  it("files the row under the typed folder with one PATCH and nothing else", async () => {
    const { requests } = mountDialog();
    const input = (await screen.findByTestId("move-folder-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Delivery" } });
    fireEvent.click(screen.getByTestId("move-folder-submit"));
    await waitFor(() => {
      expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ folder: "Delivery" });
  });

  it("sends `folder: null` when the input is left empty (Unfiled)", async () => {
    const { requests } = mountDialog();
    await screen.findByTestId("move-folder-input");
    fireEvent.click(screen.getByTestId("move-folder-submit"));
    await waitFor(() => {
      expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ folder: null });
  });

  // #27: the index's folder list ends in the `Unfiled` GROUP label (the
  // sidebar's and the filter's own sentinel). Handed to the dialog as an
  // ordinary folder, it drew a second `Unfiled` chip that typed the word
  // "Unfiled" into the field and filed the row in a folder NAMED Unfiled.
  it("draws one Unfiled quick-pick when the caller's list carries the Unfiled group label", async () => {
    mountDialog({ folders: ["Delivery", "Ops", UNFILED_FOLDER] });
    const dialog = await screen.findByTestId("move-folder-dialog");
    expect(within(dialog).getAllByTestId("move-folder-option-unfiled")).toHaveLength(1);
    expect(
      within(dialog)
        .getAllByTestId(/^move-folder-option-/)
        .map((chip) => chip.textContent),
    ).toEqual(["Delivery", "Ops", "Unfiled"]);
  });

  it("the one Unfiled quick-pick unfiles: the write is `PATCH {folder:null}`, never the label", async () => {
    const { requests } = mountDialog({ folders: ["Delivery", "Ops", UNFILED_FOLDER] });
    const input = (await screen.findByTestId("move-folder-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Delivery" } });
    fireEvent.click(screen.getByTestId("move-folder-option-unfiled"));
    expect(input.value).toBe("");
    fireEvent.click(screen.getByTestId("move-folder-submit"));
    await waitFor(() => {
      expect(requestsTo(requests, patchPath, "PATCH")).toHaveLength(1);
    });
    const sent = JSON.parse(requestsTo(requests, patchPath, "PATCH")[0].body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({ folder: null });
  });

  it("offers the existing folders as chips and a clear-to-Unfiled chip", async () => {
    mountDialog();
    const input = (await screen.findByTestId("move-folder-input")) as HTMLInputElement;
    const dialog = screen.getByTestId("move-folder-dialog");
    expect(within(dialog).getByTestId("move-folder-option-delivery")).toBeTruthy();
    expect(within(dialog).getByTestId("move-folder-option-ops")).toBeTruthy();
    fireEvent.click(screen.getByTestId("move-folder-option-delivery"));
    expect(input.value).toBe("Delivery");
    fireEvent.click(screen.getByTestId("move-folder-option-unfiled"));
    expect(input.value).toBe("");
  });
});
