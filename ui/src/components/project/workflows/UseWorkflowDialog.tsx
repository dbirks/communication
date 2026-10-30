/**
 * `+ use a library workflow` — the project Workflows tab's library picker.
 *
 * Same dialog shape the repository page uses (`RepoWorkflows`' picker): 520px,
 * ink border, hard shadow, a searchable list of the org library, and ONE
 * `Use` verb that pins the workflow's latest PUBLISHED revision. The
 * difference is the scope the tab has: it was not opened from a repository,
 * so the use it creates is the whole-project one (ADR-0060's
 * `repository_id: null` — "every repo in it"), exactly what this tab's old
 * inline assign form posted. A repository-scoped use stays on the repo page,
 * where the repository is the context.
 *
 * Honesty rules:
 * - the pinned revision is always the newest PUBLISHED one — resolved through
 *   the digest→id route, never a floating "latest";
 * - a workflow already pinned to the whole project says `used in the project`
 *   instead of offering a write the store would answer `409`;
 * - a workflow the project already pins on some repositories says so, and
 *   stays on offer (a whole-project pin is a different, legal row);
 * - a refusal — the `409`, a `404` revision — stays inline; the dialog never
 *   closes over an unsaved intent, and one click never posts twice.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { Button } from "../../ds/Button";
import { Field, Input } from "../../ds/Field";
import { FormError, ProblemBanner, Spinner } from "../../Feedback";
import {
  pipelineQueryOptions,
  useAssignments,
  useCreateAssignment,
  useRevision,
  usePipelines,
} from "../../../api/pipelines";
import type { Pipeline, PipelineList, PipelineSummary } from "../../../api/types";

export interface UseWorkflowDialogProps {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** The project's name — the dialog context line, not an id. */
  projectName: string;
}

export function UseWorkflowDialog(props: UseWorkflowDialogProps) {
  if (!props.open) return null;
  return <UseWorkflowDialogBody {...props} />;
}

function UseWorkflowDialogBody({ projectId, projectName, onClose }: UseWorkflowDialogProps) {
  const pipelines = usePipelines();
  const assignments = useAssignments(projectId);
  const [picking, setPicking] = useState<PipelineSummary | null>(null);
  const [search, setSearch] = useState("");
  const [maxConcurrentRuns, setMaxConcurrentRuns] = useState(1);
  const containerRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  // Per-pipeline reads ride the shared list fan so the dialog never re-asks
  // for what the library index already served under the same key.
  const ids = (pipelines.data?.pipelines ?? []).map((pipeline) => pipeline.id);
  const definitionFan = useQueries({ queries: ids.map(pipelineQueryOptions) });

  const projectPins = assignments.data?.assignments ?? [];

  const resolved = useRevision(
    picking ? (digestOf(definitionFan, pipelines.data, picking) ?? "") : "",
  );
  const create = useCreateAssignment(projectId);
  const started = useRef<string | null>(null);

  // One click = one create: the revision resolve's arrival arms it, and the
  // guard keeps a re-render from firing a second POST.
  useEffect(() => {
    if (!picking || !resolved.data || create.isPending) return;
    const key = `${picking.id}:${resolved.data.id}`;
    if (started.current === key) return;
    started.current = key;
    create.mutate(
      {
        pipeline_id: picking.id,
        pinned_revision_id: resolved.data.id,
        max_concurrent_runs: maxConcurrentRuns,
      },
      { onSuccess: () => onClose() },
    );
  }, [picking, resolved.data, create, maxConcurrentRuns, onClose]);

  useLayoutEffect(() => {
    openerRef.current = document.activeElement;
    containerRef.current?.querySelector<HTMLElement>("input, button")?.focus();
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const container = containerRef.current;
      if (!container) return;
      const focusables = Array.from(
        container.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
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
  }, [onClose]);

  const query = search.trim().toLowerCase();
  const items = (pipelines.data?.pipelines ?? []).filter(
    (pipeline) =>
      !pipeline.archived &&
      (query === "" ||
        pipeline.slug.toLowerCase().includes(query) ||
        pipeline.display_name.toLowerCase().includes(query)),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4">
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-library-title"
        className="w-[520px] max-w-full rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="project-library-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="project-library-title" className="text-[15px] font-semibold">
              Use a library workflow
            </h2>
            <span
              className="block truncate font-mono text-[10.5px] text-muted"
              data-testid="project-library-context"
            >
              {`pinned to the latest revision · ${projectName} · every repository in the project`}
            </span>
          </div>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
        </div>
        <div className="flex max-h-[calc(100vh-12rem)] flex-col gap-[10px] overflow-y-auto px-4 py-4">
          <Field id="project-library-search" label="SEARCH">
            <Input
              id="project-library-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="filter the library…"
              data-testid="project-library-search"
            />
          </Field>
          <Field
            id="project-library-ceiling"
            label="max concurrent runs"
            hint="how many runs of this workflow may be in flight at once"
            className="w-[12rem]"
          >
            <Input
              id="project-library-ceiling"
              type="number"
              min={1}
              max={8}
              value={maxConcurrentRuns}
              onChange={(event) => setMaxConcurrentRuns(event.target.valueAsNumber || 1)}
              data-testid="project-library-ceiling"
            />
          </Field>
          {pipelines.isPending ? <Spinner label="Loading the library" /> : null}
          {pipelines.isError ? (
            <ProblemBanner
              error={pipelines.error}
              fallback="The workflow library could not be read."
            />
          ) : null}
          {!pipelines.isPending && !pipelines.isError && items.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="project-library-empty">
              The library has no workflow to use here.
            </p>
          ) : null}
          <ul className="divide-y divide-line" data-testid="project-library-list">
            {items.map((pipeline) => {
              const wholeProject = projectPins.some(
                (pin) => pin.pipeline_id === pipeline.id && !pin.repository_id,
              );
              const repos = projectPins
                .filter((pin) => pin.pipeline_id === pipeline.id && pin.repository_name)
                .map((pin) => pin.repository_name as string);
              return (
                <li
                  key={pipeline.id}
                  className="flex items-center gap-3 py-[8px]"
                  data-testid={`project-library-row-${pipeline.slug}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">
                      {pipeline.display_name || pipeline.slug}
                    </span>
                    <span className="block font-mono text-[10.5px] text-muted">
                      {pipeline.slug} · latest r{pipeline.latest_revision_number}
                      {repos.length > 0 ? ` · used in ${repos.join(", ")}` : ""}
                    </span>
                  </span>
                  {wholeProject ? (
                    <span
                      className="font-mono text-[10.5px] text-muted"
                      data-testid={`project-library-used-${pipeline.slug}`}
                    >
                      used in the project
                    </span>
                  ) : pipeline.latest_revision_number === 0 ? (
                    // Nothing published to pin — the honest absence, not a
                    // `Use` button that could only ever fail.
                    <span
                      className="font-mono text-[10.5px] text-muted"
                      data-testid={`project-library-unpublished-${pipeline.slug}`}
                    >
                      never published
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      compact
                      disabled={picking !== null}
                      onClick={() => setPicking(pipeline)}
                      data-testid={`project-library-use-${pipeline.slug}`}
                    >
                      {picking?.id === pipeline.id ? "Pinning…" : "Use"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
          {resolved.isPending && picking ? <Spinner label={`Reading ${picking.slug}`} /> : null}
          {resolved.isError ? (
            <ProblemBanner error={resolved.error} fallback="That workflow could not be read." />
          ) : null}
          {create.isError ? (
            <FormError error={create.error} testid="project-library-error" />
          ) : null}
          <div className="flex justify-end gap-2 border-t border-line pt-3">
            <Button variant="secondary" onClick={onClose} data-testid="project-library-cancel">
              Cancel
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The newest PUBLISHED revision's digest for a picked pipeline, read from the
 * shared per-pipeline fan (the list route serves no revisions). */
function digestOf(
  definitionFan: readonly { data?: Pipeline | undefined }[],
  list: PipelineList | undefined,
  picking: PipelineSummary,
): string | null {
  const index = (list?.pipelines ?? []).findIndex((pipeline) => pipeline.id === picking.id);
  if (index < 0) return null;
  const revisions = definitionFan[index]?.data?.revisions ?? [];
  return revisions.find((revision) => revision.status === "published")?.revision_digest ?? null;
}
