/**
 * `Use in a repo…` (design "Mental model": what "Assign to a project" became)
 * — pin this library workflow to one repository of a project, or to the whole
 * project (ADR-0060's `repository_id: null`, the legacy any-repo meaning), via
 * the existing assignment API. The pin is always the NEWEST PUBLISHED
 * revision: this dialog creates a use, it never picks a version (that is the
 * Used-in tab's `Update to rN`).
 *
 * Honesty rules inherited from the panel this replaces: a project's state is
 * only stated when its assignments list has actually arrived; a project that
 * already uses this workflow everywhere it could is filtered out of the
 * candidates and named in the "already used" line, not hidden; a `409`
 * (the store's one-row-per-(project, pipeline, repo) rule) keeps the server's
 * own words inline rather than being dressed up as a saved state.
 *
 * Dialog chrome follows `NewWorkflowDialog` (1c): 520px, ink border, hard
 * shadow, `role="dialog"`, Escape closes, focus returns to the opener.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys, useProjects, useRepositories } from "../../api/queries";
import { useCreateAssignment, useRevision } from "../../api/pipelines";
import type { Assignment, AssignmentList, Project } from "../../api/types";
import { routes } from "../../lib/routes";
import { shortDigest } from "../../lib/pipeline/yamlPointer";
import { Button } from "../ds/Button";
import { Field, Input, Select } from "../ds/Field";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import type { UsedInRevision } from "./UsedIn";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface UseInRepoDialogProps {
  open: boolean;
  onClose: () => void;
  pipelineId: string;
  /** The newest PUBLISHED revision — the one this dialog pins. Null when the
   * workflow has never published: there is nothing to use yet, and the
   * header's button is not offered at all in that case. */
  newestPublished: UsedInRevision | null;
  /** The pipeline's revision summaries (for the r-number in state lines). */
  revisions: UsedInRevision[];
  /** Called after a successful create (the page switches to the Used-in tab). */
  onAssigned: () => void;
}

export function UseInRepoDialog(props: UseInRepoDialogProps) {
  if (!props.open) return null;
  return <DialogBody {...props} />;
}

/** The revision a digest names, in the summaries — for honest state lines. */
function revisionNumberFor(
  revisions: UsedInRevision[],
  digest: string,
  versionLabel: string | null,
): string {
  const row = revisions.find((r) => r.revision_digest === digest || r.id === digest);
  return row ? `r${row.revision_number}` : (versionLabel ?? `@${shortDigest(digest)}`);
}

/** One arrived pin of this pipeline, in words: where it is used, the revision
 * it pins, and whether that is the newest. */
function pinStateLine(
  pin: Assignment,
  revisions: UsedInRevision[],
  newestPublished: UsedInRevision | null,
): string {
  const where = pin.repository_name ?? (pin.repository_id ? "a repo" : "whole project");
  const number = revisionNumberFor(
    revisions,
    pin.pinned_revision_digest,
    pin.pinned_version_label ?? null,
  );
  const age =
    newestPublished && newestPublished.revision_digest === pin.pinned_revision_digest
      ? "(newest)"
      : "(an older revision)";
  return `${where} pins ${number} ${age}${pin.enabled ? "" : " · disabled"}`;
}

function DialogBody({
  open,
  onClose,
  pipelineId,
  newestPublished,
  revisions,
  onAssigned,
}: UseInRepoDialogProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [projectId, setProjectId] = useState("");
  const [repoId, setRepoId] = useState("");
  /** `true` once the reader picks "whole project" (ADR-0060 null). */
  const [wholeProject, setWholeProject] = useState(false);
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const [assigned, setAssigned] = useState<{ project: Project; repo: string } | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("input, button, select")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const projects = useProjects();
  const maintainerProjects = useMemo(
    () => (projects.data?.items ?? []).filter((p) => p.my_role === "maintainer"),
    [projects.data],
  );
  // One assignments read per maintainer project (same key as every other
  // assignments surface, so the caches are shared) — the pin bookkeeping the
  // candidate filter and the per-project state lines read.
  const assignmentLists = useQueries({
    queries: maintainerProjects.map((project) => ({
      queryKey: queryKeys.assignments(project.id),
      queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${project.id}/assignments`),
      enabled: open,
    })),
  });
  const states = maintainerProjects.map((project, index) => {
    const list = assignmentLists[index]?.data;
    return {
      project,
      loaded: list !== undefined,
      // Since ADR-0060 a project can hold several pins of one pipeline — one
      // per repository, plus optionally the whole-project one.
      pins: (list?.assignments ?? []).filter((a) => a.pipeline_id === pipelineId),
    };
  });

  // A (project, repo) pair is free when no arrived pin names this pipeline on
  // that repository (or project-wide, for the whole-project pick).
  const pinRepoIds = (projectIndex: number): { repoIds: Set<string>; wholeProject: boolean } => {
    const pins = states[projectIndex]?.pins ?? [];
    return {
      repoIds: new Set(pins.map((p) => p.repository_id).filter((id): id is string => !!id)),
      wholeProject: pins.some((p) => p.repository_id === null),
    };
  };
  const listsLoaded =
    maintainerProjects.length > 0 && assignmentLists.every((r) => r.data !== undefined);

  const chosenIndex = maintainerProjects.findIndex((p) => p.id === projectId);
  const repositories = useRepositories(projectId);
  const reposLoaded = projectId === "" || repositories.data !== undefined;
  const offeredRepos =
    chosenIndex >= 0 && repositories.data
      ? repositories.data.items.filter((repo) => !pinRepoIds(chosenIndex).repoIds.has(repo.id))
      : [];
  const offersWholeProject = chosenIndex >= 0 && !pinRepoIds(chosenIndex).wholeProject;

  // A candidate project still has at least one free (project, repo) pair.
  const candidates = maintainerProjects.filter((_project, index) => {
    const list = assignmentLists[index]?.data;
    if (!list) return false;
    const { repoIds, wholeProject: pinnedWhole } = pinRepoIds(index);
    if (!pinnedWhole) return true;
    // Every repository of the project already pinned → nothing left to add.
    const repos =
      maintainerProjects[index].id === projectId && repositories.data
        ? repositories.data.items
        : null;
    // Without the repo list arrived, a project whose only whole-project pin
    // arrived stays absent (loading is not "assignable").
    return repos !== null && repos.some((repo) => !repoIds.has(repo.id));
  });

  // Resolve the newest published revision digest → uuid (route 13); a pin
  // needs the id, and the summary carries none (ADR-0021 § 5).
  const resolvedRevision = useRevision(
    open && newestPublished ? newestPublished.revision_digest : "",
  );
  const create = useCreateAssignment(projectId);

  const canConfirm =
    projectId !== "" &&
    (wholeProject || repoId !== "") &&
    reposLoaded &&
    !!resolvedRevision.data?.id &&
    !create.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    const revisionId = resolvedRevision.data?.id;
    if (!revisionId || !canConfirm) return;
    create.mutate(
      {
        pipeline_id: pipelineId,
        pinned_revision_id: revisionId,
        max_concurrent_runs: maxConcurrentRuns,
        repository_id: wholeProject ? null : repoId,
      },
      {
        onSuccess: (assignment) => {
          const project = maintainerProjects.find((p) => p.id === assignment.project_id);
          setAssigned({
            project: project ?? maintainerProjects[0],
            repo: assignment.repository_name ?? "whole project",
          });
        },
      },
    );
  }

  // Known with no click spent: this reader cannot use a workflow anywhere.
  if (projects.data && maintainerProjects.length === 0) {
    return (
      <Chrome onClose={onClose} headingId="assign-no-project-heading" title="Use in a repo…">
        <p className="text-[12.5px]" data-testid="assign-no-maintainer">
          You maintain no project — a project maintainer can use this workflow from that{" "}
          <Link
            to="/"
            className="font-mono text-[11.5px] text-accent-text"
            data-testid="assign-projects-link"
          >
            project&apos;s Pipelines page
          </Link>
        </p>
      </Chrome>
    );
  }

  // Success: the row is a real thing now — say where, and offer the look.
  if (assigned) {
    return (
      <Chrome onClose={onClose} headingId="assign-success-heading" title="Used in a repo">
        <p className="text-[12.5px]" data-testid="assign-success-panel">
          <span data-testid="assign-success-label">
            {`Used in ${assigned.project.name} / ${assigned.repo}`}
          </span>
          <Link
            to={routes.workflowTab(pipelineId, "used-in")}
            className="ml-1 font-mono text-[11.5px] text-accent-text"
            data-testid="assign-start-run-link"
            onClick={() => {
              onAssigned();
              onClose();
            }}
          >
            — see the use
          </Link>
        </p>
      </Chrome>
    );
  }

  const nothingToAssign = open && listsLoaded && candidates.length === 0;

  return (
    <Chrome onClose={onClose} headingId="assign-form-heading" title="Use in a repo…">
      <form className="flex flex-col gap-[10px]" data-testid="assign-form" onSubmit={submit}>
        <p className="font-mono text-[10.5px] text-muted" data-testid="assign-pin-line">
          {newestPublished
            ? `pins the newest published revision · r${newestPublished.revision_number}`
            : "this workflow has never published — there is nothing to pin yet"}
        </p>
        {projects.isPending ? <Spinner label="Loading projects" /> : null}
        {projects.isError ? (
          <ProblemBanner error={projects.error} fallback="Your projects could not be read." />
        ) : null}
        {assignmentLists.some((result) => result.isPending) ? (
          <Spinner label="Checking which projects already use this workflow" />
        ) : null}
        {maintainerProjects.length > 0 ? (
          <ul
            className="divide-y divide-line border-y border-line"
            data-testid="assign-project-states"
          >
            {states.map(({ project, loaded, pins }) => (
              <li
                key={project.id}
                className="flex flex-wrap items-center gap-[6px] px-[2px] py-[7px]"
                data-testid={`assign-project-state-${project.id}`}
              >
                <span className="text-[12.5px] font-semibold">{project.name}</span>
                <span
                  className="font-mono text-[10.5px]"
                  data-testid={`assign-project-pin-${project.id}`}
                >
                  {pins.length > 0
                    ? pins.map((pin) => pinStateLine(pin, revisions, newestPublished)).join(" · ")
                    : loaded
                      ? "not used yet"
                      : "checking…"}
                </span>
                {pins.length === 0 && loaded && candidates.some((c) => c.id === project.id) ? (
                  <Button
                    variant="secondary"
                    compact
                    data-testid={`assign-pick-${project.id}`}
                    onClick={() => {
                      setProjectId(project.id);
                      setRepoId("");
                      setWholeProject(false);
                    }}
                  >
                    {projectId === project.id ? "picked — choose a repo below" : "Use here"}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {nothingToAssign ? (
          <p className="text-[12.5px]" data-testid="assign-every-project">
            Already used in every project you maintain —{" "}
            <Link
              to={routes.projects()}
              className="font-mono text-[11.5px] text-accent-text"
              data-testid="assign-projects-link"
            >
              your projects
            </Link>
          </p>
        ) : null}
        {!nothingToAssign && maintainerProjects.length > 0 ? (
          <Field
            id="assign-project-select"
            label="project"
            hint="projects you maintain that still have a free repo for this workflow"
          >
            <Select
              id="assign-project-select"
              value={projectId}
              onChange={(event) => {
                setProjectId(event.target.value);
                setRepoId("");
                setWholeProject(false);
              }}
              className="font-ui"
              data-testid="assign-project-select"
            >
              <option value="">— select a project —</option>
              {candidates.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        {!nothingToAssign && projectId !== "" ? (
          repositories.isPending ? (
            <Spinner label="Loading the project's repositories" />
          ) : (
            <Field
              id="assign-repo-select"
              label="repository"
              hint="one repo, or the whole project (every repo in it)"
            >
              <Select
                id="assign-repo-select"
                value={wholeProject ? "__whole__" : repoId}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "__whole__") {
                    setWholeProject(true);
                    setRepoId("");
                  } else {
                    setWholeProject(false);
                    setRepoId(value);
                  }
                }}
                className="font-ui"
                data-testid="assign-repo-select"
              >
                <option value="">— select a repository —</option>
                {offersWholeProject ? (
                  <option value="__whole__">whole project (every repo in it)</option>
                ) : null}
                {offeredRepos.map((repo) => (
                  <option key={repo.id} value={repo.id}>
                    {repo.name}
                  </option>
                ))}
              </Select>
            </Field>
          )
        ) : null}
        {!nothingToAssign ? (
          <Field
            id="assign-ceiling"
            label="max concurrent runs"
            hint="1 is the wire default; the server caps it at 8"
            className="w-[12rem]"
          >
            <Input
              id="assign-ceiling"
              type="number"
              min={1}
              max={8}
              value={maxConcurrentRuns}
              onChange={(event) => setMaxConcurrentRuns(event.target.valueAsNumber || 1)}
              data-testid="assign-ceiling"
            />
          </Field>
        ) : null}
        {!nothingToAssign ? (
          <div className="flex items-center gap-[8px]">
            <Button
              type="submit"
              variant="primary"
              compact
              disabled={!canConfirm}
              data-testid="assign-confirm"
            >
              {create.isPending ? "Using…" : "Confirm"}
            </Button>
            <Button variant="ghost" compact data-testid="assign-cancel" onClick={onClose}>
              Cancel
            </Button>
          </div>
        ) : null}
        {resolvedRevision.isPending && projectId && newestPublished ? (
          <Spinner label="Resolving the revision id" />
        ) : null}
        {resolvedRevision.isError ? (
          <ProblemBanner
            error={resolvedRevision.error}
            fallback="The newest published revision could not be read."
          />
        ) : null}
        {create.isError ? <FormError error={create.error} testid="assign-error" /> : null}
      </form>
    </Chrome>
  );
}

/** The 1c dialog chrome: 520px, ink border, hard shadow, titled heading row
 * with the `esc` affordance word. */
function Chrome({
  onClose,
  headingId,
  title,
  children,
}: {
  onClose: () => void;
  headingId: string;
  title: string;
  children: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="flex max-h-[calc(100vh-8rem)] w-[520px] max-w-full flex-col gap-[14px] overflow-auto rounded-[4px] border border-ink bg-surface p-[16px] shadow-(--shadow-raised)"
        data-testid="use-in-repo-dialog"
      >
        <div className="flex items-baseline justify-between">
          <span id={headingId} className="text-[13px] font-bold" role="heading" aria-level={2}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="font-mono text-[10px] text-faint hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
          >
            esc
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
