/**
 * `/projects/:projectId/pipelines` — the project's pipeline assignments and
 * the pinned revision's definition, as a real route. Same blocks the
 * `/__m4-preview?source=live` seam proved (`PipelineLibrary`, `YamlView`,
 * `DefinitionGraph`); the run list links here because a run's shape comes from
 * the assignment, not from anything this page invents.
 *
 * Editing, publishing and channel rollout stay out of scope: `canCreate={false}`
 * and no draft form. Assigning *is* in scope: a maintainer may pin an unassigned
 * library pipeline's newest published revision to this project (`§ 7.2` W2),
 * which is the only way a run becomes startable here. The other write allowed
 * here is `§ 7.2` W8's Validate panel — a textarea and a button that turn
 * pasted YAML into the server's verdict, for org admins (the library role)
 * only, and no editor.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { Button } from "../components/ds/Button";
import { Field, Input } from "../components/ds/Field";
import { Panel } from "../components/ds/Panel";
import { FormError, ProblemBanner, Spinner } from "../components/Feedback";
import { DefinitionGraph } from "../components/m4/DefinitionGraph";
import {
  PipelineLibrary,
  type PipelineAssignmentFacts,
  type PipelineLibraryRow,
} from "../components/m4/PipelineLibrary";
import { YamlView } from "../components/m4/YamlView";
import { ValidatePanel } from "../components/m4/ValidatePanel";
import { useProjectRuns } from "../api/runs";
import {
  pipelineDraftsQueryOptions,
  pipelineQueryOptions,
  useAssignments,
  useCreateAssignment,
  useCreateSchedule,
  usePatchSchedule,
  usePipelines,
  useRevision,
  useSchedules,
} from "../api/pipelines";
import { useMe, useProject, useRepositories } from "../api/queries";
import { viewDraftSummary, viewPipeline, viewPipelineSummary } from "../api/m4view";
import { shortId } from "../api/names";
import {
  InputFieldControl,
  defaultValuesOf,
  inputProblemsOf,
  runInputFieldsOf,
  wireInputsOf,
  type InputValue,
} from "../components/m4/NewRunForm";
import { formatRemaining } from "../lib/format";
import type { DefinitionDocument } from "../lib/pipeline/definition";
import type { PipelineRevisionSummary, PipelineSummary } from "../lib/pipeline/contract";
import { shortDigest } from "../lib/pipeline/yamlPointer";
import { ProjectSectionNav } from "./ProjectRuns";

export default function ProjectPipelines() {
  const { projectId = "" } = useParams();
  const pipelines = usePipelines();
  const assignments = useAssignments(projectId);
  const runs = useProjectRuns(projectId);
  const me = useMe();
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
  const project = useProject(projectId);
  // Revision numbers live on the pipeline read, not on the assignment (which
  // carries only a digest), so the digest → r<N> map is built from the rows.
  const revisionNumbers = new Map<string, number>();
  rows.forEach((row) => {
    row.revisions.forEach((entry) => {
      if (!revisionNumbers.has(entry.revision_digest))
        revisionNumbers.set(entry.revision_digest, entry.revision_number);
    });
  });
  // The library cell for a project surface: its assignment to this project, not
  // a channel M4 does not have (`AssignmentCreate` has no channel member).
  function assignmentFor(pipelineId: string): PipelineAssignmentFacts | null {
    const entry = (assignments.data?.assignments ?? []).find(
      (candidate) => candidate.pipeline_id === pipelineId,
    );
    if (!entry) return null;
    return {
      revisionNumber: revisionNumbers.get(entry.pinned_revision_digest) ?? null,
      revisionDigest: entry.pinned_revision_digest,
      maxConcurrentRuns: entry.max_concurrent_runs,
      enabled: entry.enabled,
    };
  }
  // `01`: `assignment.create` is Maintainer+; an org admin with no explicit
  // membership is *reported* as maintainer by the project read, so `my_role`
  // alone is the whole gate — a viewer (or a read still in flight) sees nothing.
  const canAssign = project.data?.my_role === "maintainer";
  const assignedPipelineIds = new Set(
    (assignments.data?.assignments ?? []).map((assignment) => assignment.pipeline_id),
  );
  // A pipeline is assignable here when it has ever published (route 5's
  // summaries are newest-first, so the first `published` is the newest) and the
  // project has no assignment for it yet — one assignment per pipeline is the
  // store's UNIQUE, and the second POST is the 409 this form surfaces.
  const assignable: { pipeline: PipelineSummary; newest: PipelineRevisionSummary }[] = [];
  rows.forEach((row) => {
    if (assignedPipelineIds.has(row.pipeline.id)) return;
    const newest = row.revisions.find((entry) => entry.status === "published");
    if (newest) assignable.push({ pipeline: row.pipeline, newest });
  });
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
                assignmentFor={assignmentFor}
              />
            ) : null}
            {/* ADR-0032 "when to run": one block per ASSIGNED pipeline row —
                the schedule belongs to the assignment, so the block sits with
                the assignment, not in a separate panel a viewer has to visit. */}
            {(assignments.data?.assignments ?? []).map((assignment) => (
              <WhenToRun
                key={assignment.id}
                projectId={projectId}
                assignmentId={assignment.id}
                pinnedRevisionId={assignment.pinned_revision_id}
                slug={
                  rows.find((row) => row.pipeline.id === assignment.pipeline_id)?.pipeline.slug ??
                  shortId(assignment.pipeline_id)
                }
                canManage={canAssign}
              />
            ))}
            {assignable.length > 0 && canAssign ? (
              <div className="space-y-[6px]" data-testid="pipeline-assign-list">
                {assignable.map(({ pipeline, newest }) => (
                  <AssignPipelineRow
                    key={pipeline.id}
                    projectId={projectId}
                    pipeline={pipeline}
                    newest={newest}
                  />
                ))}
              </div>
            ) : null}
            <p className="font-mono text-[11px] text-faint" data-testid="project-pipeline-pin">
              {pin
                ? `pinned revision ${
                    revision.data
                      ? `r${revision.data.revision_number} · ${shortDigest(revision.data.revision_digest)} · `
                      : ""
                  }id ${shortId(pin)} — runs of this project stay on it until a maintainer re-assigns`
                : "no pipeline assignment is enabled for this project — there is nothing to run"}
            </p>
            {newestRun ? (
              <p
                className="font-mono text-[11px] text-faint"
                data-testid="project-pipeline-newest-run"
              >
                newest run {shortId(newestRun.id)} · {newestRun.status} ·{" "}
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
              layout="below"
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
        <ValidatePanel
          pipelines={(pipelines.data?.pipelines ?? []).map((pipeline) => ({
            id: pipeline.id,
            slug: pipeline.slug,
            displayName: pipeline.display_name,
          }))}
          canValidate={me.data?.is_org_admin === true}
          initialText={revision.data?.document_text ?? ""}
          headingId="project-pipeline-validate-heading"
        />
      </div>
    </div>
  );
}

/**
 * W2's missing step: pin a published library revision to this project.
 *
 * `AssignmentCreate` carries no channel member — channels are M6 rollout
 * vocabulary (`07` "Version rollout"; migration 00005: "NO stable/beta
 * channels"), so there is no channel select to render and no channel claim on
 * screen. The only body field with a choice is `max_concurrent_runs`, which
 * starts at the type's default of 1.
 *
 * The pin is the *id*, not the digest: route 5's summary carries no row uuid
 * (ADR-0021 § 5 makes `revision_digest` the resolvable identity), while route 18
 * rejects anything that is not a uuid. So the form resolves the newest published
 * digest through route 13 (`useRevision`) and posts the id that read returns —
 * the fetch is armed only while the form is open.
 */
function AssignPipelineRow({
  projectId,
  pipeline,
  newest,
}: {
  projectId: string;
  pipeline: PipelineSummary;
  newest: PipelineRevisionSummary;
}) {
  const [open, setOpen] = useState(false);
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const create = useCreateAssignment(projectId);
  const resolved = useRevision(open ? newest.revision_digest : "");

  function confirm() {
    const revisionId = resolved.data?.id;
    if (!revisionId) return;
    create.mutate({
      pipeline_id: pipeline.id,
      pinned_revision_id: revisionId,
      max_concurrent_runs: maxConcurrentRuns,
    });
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-[10px]">
        <span
          className="font-mono text-[11px] text-faint"
          data-testid={`assign-summary-${pipeline.slug}`}
        >
          {pipeline.slug} · r{newest.revision_number} · {shortDigest(newest.revision_digest)} not
          assigned to this project
        </span>
        <Button
          compact
          variant="secondary"
          data-testid={`assign-open-${pipeline.slug}`}
          onClick={() => setOpen(true)}
        >
          Assign to this project
        </Button>
      </div>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-[10px]"
      data-testid={`assign-form-${pipeline.slug}`}
      onSubmit={(event) => {
        event.preventDefault();
        confirm();
      }}
    >
      <div className="min-w-[18rem] flex-1 space-y-1">
        <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
          pinning
        </span>
        <span
          className="block rounded-[3px] border border-line bg-fill px-[10px] py-1 font-mono text-[12.5px] text-ink"
          data-testid={`assign-pinning-${pipeline.slug}`}
        >
          r{newest.revision_number} · {newest.version_label} · {shortDigest(newest.revision_digest)}
          {resolved.data ? ` · id ${resolved.data.id}` : " · resolving id…"}
        </span>
        <span className="block font-mono text-[10.5px] text-faint">
          newest published revision — an assignment pins an id, never a floating label
        </span>
      </div>
      <Field
        id={`assign-ceiling-${pipeline.slug}`}
        label="max concurrent runs"
        hint="1 is the wire default; the server caps it at 8"
        className="w-[12rem]"
      >
        <Input
          id={`assign-ceiling-${pipeline.slug}`}
          type="number"
          min={1}
          max={8}
          value={maxConcurrentRuns}
          onChange={(event) => setMaxConcurrentRuns(event.target.valueAsNumber || 1)}
          data-testid={`assign-ceiling-${pipeline.slug}`}
        />
      </Field>
      <Button
        type="submit"
        variant="primary"
        compact
        disabled={!resolved.data || create.isPending}
        data-testid={`assign-confirm-${pipeline.slug}`}
      >
        Confirm
      </Button>
      <Button
        compact
        variant="ghost"
        data-testid={`assign-cancel-${pipeline.slug}`}
        onClick={() => setOpen(false)}
      >
        Cancel
      </Button>
      {resolved.isPending ? <Spinner label="Resolving the revision id" /> : null}
      {resolved.isError ? (
        <ProblemBanner
          error={resolved.error}
          fallback="The newest published revision could not be read."
        />
      ) : null}
      {create.isError ? (
        <FormError error={create.error} testid={`assign-error-${pipeline.slug}`} />
      ) : null}
    </form>
  );
}

/**
 * ADR-0032's "When to run" block for one assignment: its schedules with the
 * derived clock (`formatRemaining` reads `next_run_at` — "in 3h 20m" is the
 * whole question a schedule screen exists to answer), the enabled toggle,
 * and the link to the run the last fire created. The Add form is maintainer
 * only; a viewer sees the calendar, never its controls.
 */
function WhenToRun({
  projectId,
  assignmentId,
  pinnedRevisionId,
  slug,
  canManage,
}: {
  projectId: string;
  assignmentId: string;
  pinnedRevisionId: string;
  slug: string;
  canManage: boolean;
}) {
  const schedules = useSchedules(projectId);
  const mine = (schedules.data?.schedules ?? []).filter(
    (schedule) => schedule.assignment_id === assignmentId,
  );
  const patch = usePatchSchedule(projectId);
  const [adding, setAdding] = useState(false);
  if (mine.length === 0 && !canManage) return null;
  return (
    <div
      className="space-y-[6px] border-t border-line pt-2"
      data-testid={`schedules-block-${slug}`}
    >
      <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.04em] text-muted">
        when to run · {slug}
      </span>
      {schedules.isPending ? <Spinner label="Loading schedules" /> : null}
      {schedules.isError ? (
        <ProblemBanner error={schedules.error} fallback="The schedules could not be read." />
      ) : null}
      {mine.length === 0 && !schedules.isPending && !schedules.isError ? (
        <p className="text-[12.5px] text-muted" data-testid={`schedules-none-${slug}`}>
          Never scheduled — every run of this pipeline was started by a person.
        </p>
      ) : null}
      <ul className="space-y-[6px]">
        {mine.map((schedule) => (
          <li
            key={schedule.id}
            className="flex flex-wrap items-center gap-[10px]"
            data-testid={`schedule-row-${slug}`}
          >
            <code className="rounded-[3px] border border-line bg-fill px-[6px] py-[1px] font-mono text-[11.5px] text-ink">
              {schedule.cron_expr}
            </code>
            <span
              className="font-mono text-[11px] text-faint"
              data-testid={`schedule-next-${slug}`}
            >
              next {formatRemaining(schedule.next_run_at)}
            </span>
            {schedule.last_run_id ? (
              <Link
                to={`/projects/${projectId}/runs/${schedule.last_run_id}`}
                className="font-mono text-[11px] text-accent"
                data-testid={`schedule-last-run-${slug}`}
              >
                last run {shortId(schedule.last_run_id)}
              </Link>
            ) : (
              <span className="font-mono text-[11px] text-faint">never run</span>
            )}
            {canManage ? (
              <label className="flex items-center gap-[6px] font-mono text-[11px] text-ink">
                <input
                  type="checkbox"
                  className="size-3 accent-accent"
                  checked={schedule.enabled}
                  data-testid={`schedule-enabled-${slug}`}
                  onChange={(event) =>
                    patch.mutate({
                      scheduleId: schedule.id,
                      body: { version: schedule.version, enabled: event.target.checked },
                    })
                  }
                />
                {schedule.enabled ? "enabled" : "paused"}
              </label>
            ) : null}
          </li>
        ))}
      </ul>
      {patch.isError ? (
        <FormError error={patch.error} testid={`schedule-edit-error-${slug}`} />
      ) : null}
      {canManage ? (
        adding ? (
          <AddScheduleForm
            projectId={projectId}
            assignmentId={assignmentId}
            pinnedRevisionId={pinnedRevisionId}
            slug={slug}
            onDone={() => setAdding(false)}
          />
        ) : (
          <Button
            compact
            variant="secondary"
            data-testid={`schedule-open-${slug}`}
            onClick={() => setAdding(true)}
          >
            Add schedule
          </Button>
        )
      ) : null}
    </div>
  );
}

/** The three cadences the wishlist named, spelled once here so the form
 * offers the truth rather than a blank text box: hourly, daily 09:00 UTC,
 * weekly Monday 09:00 UTC (ADR-0032 — cron is always UTC wall clock). */
const CRON_PRESETS: [string, string][] = [
  ["hourly", "0 * * * *"],
  ["daily 09:00 UTC", "0 9 * * *"],
  ["weekly Monday", "0 9 * * 1"],
];

/**
 * The Add-schedule form. The input fields are the ones `NewRunForm` builds
 * from the assignment's pinned revision (`runInputFieldsOf` +
 * `InputFieldControl`, shared deliberately so "what a run needs" has one
 * rendering); the server stays the authority — its `422` (invalid_cron or a
 * validate-style input refusal) surfaces inline through `FormError`.
 */
function AddScheduleForm({
  projectId,
  assignmentId,
  pinnedRevisionId,
  slug,
  onDone,
}: {
  projectId: string;
  assignmentId: string;
  pinnedRevisionId: string;
  slug: string;
  onDone: () => void;
}) {
  const [cron, setCron] = useState(CRON_PRESETS[0][1]);
  const [values, setValues] = useState<Record<string, InputValue>>({});
  const [showProblems, setShowProblems] = useState(false);
  const create = useCreateSchedule(projectId);
  const revision = useRevision(pinnedRevisionId);
  const repositories = useRepositories(projectId);
  const fields = useMemo(
    () => (revision.data ? runInputFieldsOf(revision.data.canonical_document) : null),
    [revision.data],
  );
  // Seed declared defaults once, like NewRunForm does — the schedule fires
  // what the form showed, so a hidden default is a lie about the cadence's
  // payload either way.
  const seeded = useRef(false);
  useEffect(() => {
    if (!fields || seeded.current) return;
    seeded.current = true;
    setValues((current) => (Object.keys(current).length ? current : defaultValuesOf(fields)));
  }, [fields]);
  const problems = fields ? inputProblemsOf(fields, values) : {};
  const blocked = Object.keys(problems).length > 0 || create.isPending || !revision.data;

  function submit(event: FormEvent) {
    event.preventDefault();
    setShowProblems(true);
    if (blocked) return;
    create.mutate(
      {
        assignment_id: assignmentId,
        cron_expr: cron.trim(),
        inputs: fields ? wireInputsOf(fields, values) : {},
        enabled: true,
      },
      { onSuccess: () => onDone() },
    );
  }

  return (
    <form
      className="space-y-[6px]"
      data-testid={`schedule-form-${slug}`}
      onSubmit={(event) => void submit(event)}
    >
      <Field id={`schedule-cron-${slug}`} label="cron (minute hour dom month dow, UTC)">
        <Input
          id={`schedule-cron-${slug}`}
          value={cron}
          onChange={(event) => setCron(event.target.value)}
          data-testid={`schedule-cron-${slug}`}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-[6px]" role="group" aria-label="cron presets">
        {CRON_PRESETS.map(([label, expr]) => (
          <Button
            key={expr}
            compact
            variant={cron === expr ? "primary" : "ghost"}
            data-testid={`schedule-preset-${expr.replace(/\*/g, "star").replace(/\s/g, "-")}`}
            onClick={() => setCron(expr)}
          >
            {label}
          </Button>
        ))}
      </div>
      {revision.isPending ? <Spinner label="Loading the pinned revision" /> : null}
      {revision.isError ? (
        <ProblemBanner error={revision.error} fallback="The pinned revision could not be read." />
      ) : null}
      {fields?.map((field) => (
        <InputFieldControl
          key={field.name}
          field={field}
          value={values[field.name]}
          repositories={(repositories.data?.items ?? []).map((repo) => repo.name)}
          repositoriesLoading={repositories.isPending}
          error={showProblems ? problems[field.name] : undefined}
          onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
        />
      ))}
      <div className="flex items-center gap-[6px]">
        <Button
          type="submit"
          variant="primary"
          compact
          disabled={blocked}
          data-testid={`schedule-confirm-${slug}`}
        >
          Add
        </Button>
        <Button compact variant="ghost" data-testid={`schedule-cancel-${slug}`} onClick={onDone}>
          Cancel
        </Button>
      </div>
      {create.isError ? <FormError error={create.error} testid={`schedule-error-${slug}`} /> : null}
    </form>
  );
}
