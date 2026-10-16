/**
 * `/projects/:projectId/pipelines` — the project's pipeline assignments and
 * the pinned revision's definition, as a real route. Same blocks the
 * `/__m4-preview?source=live` seam proved (`PipelineLibrary`, `YamlView`,
 * `DefinitionGraph`); the run list links here because a run's shape comes from
 * the assignment, not from anything this page invents.
 *
 * Editing, publishing and channel rollout stay out of scope: `canCreate={false}`
 * and no draft form, so the page reads the library rather than pretending to
 * operate it.
 */
import { useMemo, useState } from "react";
import { useParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Panel } from "../components/ds/Panel";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import { PipelineLibrary, type PipelineLibraryRow } from "../components/m4/PipelineLibrary";
import { YamlView } from "../components/m4/YamlView";
import { useProjectRuns } from "../api/runs";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  useAssignments,
  usePipelines,
  useRevision,
} from "../api/pipelines";
import { viewDraftSummary, viewPipeline, viewPipelineSummary } from "../api/m4view";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import { shortDigest } from "../lib/pipeline/yamlPointer";
import { ProjectSectionNav } from "./ProjectRuns";

export default function ProjectPipelines() {
  const { projectId = "" } = useParams();
  const pipelines = usePipelines();
  const assignments = useAssignments(projectId);
  const runs = useProjectRuns(projectId);
  const ids = useMemo(
    () => (pipelines.data?.pipelines ?? []).map((pipeline) => pipeline.id),
    [pipelines.data],
  );
  // The list route carries neither revisions nor drafts: one `useQueries` fan,
  // keyed exactly like the single-read hooks (as the live preview does).
  const definitions = useQueries({ queries: ids.map(pipelineQueryOptions) });
  const draftsList = useQueries({ queries: ids.map(pipelineDraftsQueryOptions) });

  const rows: PipelineLibraryRow[] = [];
  definitions.forEach((entry, index) => {
    const definition = entry.data;
    if (!definition) return;
    const view = viewPipeline(definition);
    rows.push({
      pipeline: { ...viewPipelineSummary(definition), description: definition.description },
      latest: view.revisions[0] ?? null,
      revisions: view.revisions,
      drafts: (draftsList[index]?.data?.drafts ?? []).map(viewDraftSummary),
      // `channels` is M6 rollout vocabulary; the M4 wire serves none.
      channels: [],
    });
  });

  const pin =
    assignments.data?.assignments.find((assignment) => assignment.enabled)?.pinned_revision_id ??
    "";
  const revision = useRevision(pin);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const newestRun = runs.data?.runs?.[0] ?? null;

  return (
    <div
      className="grid min-h-full grid-cols-[minmax(14rem,17rem)_minmax(0,1fr)]"
      data-testid="project-pipelines"
    >
      <aside className="border-r border-line px-3 py-2">
        <ProjectSectionNav projectId={projectId} active="pipelines" />
      </aside>
      <div className="min-w-0 space-y-4 px-4 py-4">
        <h1 className="text-[19px] font-bold" id="project-pipelines-heading">
          Pipelines
        </h1>
        {pipelines.isPending ? <Spinner label="Loading pipelines" /> : null}
        {pipelines.isError ? (
          <ProblemBanner
            error={pipelines.error}
            fallback="The pipeline library could not be read."
          />
        ) : null}
        <Panel
          title="LIBRARY"
          headingId="project-pipeline-library-heading"
          headingLevel={2}
          meta={assignments.isError ? undefined : `${rows.length} definitions`}
        >
          <div className="space-y-[10px] p-[10px]">
            {assignments.isError ? (
              <ProblemBanner
                error={assignments.error}
                fallback="This project's assignments could not be read."
              />
            ) : null}
            {pipelines.data && rows.length === 0 ? (
              <p className="text-[12.5px] text-muted" data-testid="pipelines-empty">
                No pipelines yet — the library is empty, so this project cannot run anything.
              </p>
            ) : null}
            {rows.length > 0 ? (
              <PipelineLibrary
                rows={rows}
                canCreate={false}
                emptyCopy="nothing assigned to this project"
                headingId="project-pipeline-rows-heading"
              />
            ) : null}
            <p className="font-mono text-[11px] text-faint" data-testid="project-pipeline-pin">
              {pin
                ? `pinned revision ${pin} — runs of this project stay on it until a maintainer re-assigns`
                : "no pipeline assignment is enabled for this project — there is nothing to run"}
            </p>
            {newestRun ? (
              <p
                className="font-mono text-[11px] text-faint"
                data-testid="project-pipeline-newest-run"
              >
                newest run {newestRun.id} · {newestRun.status} ·{" "}
                {shortDigest(newestRun.revision_digest)}
              </p>
            ) : null}
          </div>
        </Panel>
        {revision.isError ? (
          <ProblemBanner error={revision.error} fallback="The pinned revision could not be read." />
        ) : null}
        {revision.data ? (
          <>
            <YamlView
              text={revision.data.document_text}
              label={`r${revision.data.revision_number} · ${revision.data.version_label} · ${shortDigest(revision.data.revision_digest)} · regenerated canonical`}
              headingId="project-pipeline-yaml-heading"
            />
            <DefinitionGraph
              document={revision.data.canonical_document as unknown as DefinitionDocument}
              label={`pinned r${revision.data.revision_number} · definition only, no run states`}
              selectedKey={selectedKey}
              onSelectKey={setSelectedKey}
              headingId="project-pipeline-graph-heading"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}
