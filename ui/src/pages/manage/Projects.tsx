/**
 * Manage → Projects (redesign R7): the list the old `/projects` board was,
 * reduced to the four facts that say what a project *is* — its name, how many
 * repositories and people it holds, and the caller's role in it.
 *
 * The attention counts the board led with (decisions, stalled runs, live
 * threads) are Home's business and the project's own screens'; this section is
 * the configure surface, so its columns are the ones that answer "which project
 * do I need to configure?". The card grid is gone, not shrunk (CONTRACT "What
 * happens to the old app").
 *
 * The create form is the projects index's own form — same fields, same
 * `POST /api/v1/projects`, same 409 note, same test ids the Playwright journeys
 * fill — wearing the redesign's dialog (radius 18, `--shadow-modal`, a bottom
 * sheet below 768px). It opens on `?new=1`, which is where the rail's "+" tile
 * points (CONTRACT "Shell"), and on an account with nothing in it, where adding
 * one is the only action the screen has.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../api/client";
import { queryKeys, useCreateProject, useProjects } from "../../api/queries";
import type { MemberList, Project, RepositoryList } from "../../api/types";
import { FormError, ProblemBanner, Spinner } from "../../components/Feedback";
import { Field, Input, Textarea } from "../../components/ds/Field";
import { routes } from "../../lib/routes";
import { ManageTable, SectionHeader, SECTION_ACTION_CLASS } from "./ManageTable";
import type { ManageColumn, ManageRow } from "./ManageTable";

const COLUMNS: ManageColumn[] = [
  { key: "name", label: "Name" },
  { key: "repos", label: "Repositories" },
  { key: "people", label: "People" },
  { key: "role", label: "Your role" },
];

export default function ProjectsSection() {
  const projects = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const list = useMemo(() => projects.data?.items ?? [], [projects.data]);
  const loading = projects.isPending && !projects.data;

  /** `?new=1` is a linkable request to open the form (the rail's "+" tile). */
  const openByLink = searchParams.get("new") === "1";
  const [openedByHand, setOpenedByHand] = useState(false);
  const adding = !loading && (openByLink || openedByHand || list.length === 0);

  const closeForm = () => {
    setOpenedByHand(false);
    if (searchParams.get("new") === "1") {
      const next = new URLSearchParams(searchParams);
      next.delete("new");
      setSearchParams(next, { replace: true });
    }
  };

  return (
    <div className="flex flex-col gap-[18px]" data-testid="manage-projects">
      <SectionHeader
        title="Projects"
        blurb="Each project holds repositories, people and workflows."
        action={
          <button
            type="button"
            className={SECTION_ACTION_CLASS}
            data-testid="manage-new-project"
            aria-expanded={adding}
            aria-controls="create-project-form"
            onClick={() => (adding ? closeForm() : setOpenedByHand(true))}
          >
            {adding ? "Close" : "New project"}
          </button>
        }
      />

      {adding ? (
        <NewProjectDialog
          onClose={closeForm}
          onCreated={(project) => navigate(routes.manage("projects", project.id))}
        />
      ) : null}

      {loading ? <Spinner label="Loading projects" /> : null}
      {projects.error ? (
        <ProblemBanner
          error={projects.error}
          fallback="Projects could not be loaded."
          subject="your projects"
          retry={{ onClick: () => void projects.refetch(), pending: projects.isFetching }}
        />
      ) : null}

      {projects.data ? <ProjectsTable projects={list} testid="manage-projects-table" /> : null}
    </div>
  );
}

/** The four-column table. `useQueries` fans the two counts per project, keyed
 * exactly like the single-project hooks so the cache is shared, the same way
 * `pages/Workflows.tsx` fans its per-project reads. */
export function ProjectsTable({
  projects,
  testid,
}: {
  projects: readonly Project[];
  testid: string;
}) {
  const repos = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.repos(project.id),
      queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${project.id}/repos`),
    })),
  });
  const members = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.members(project.id),
      queryFn: () => apiFetch<MemberList>(`/api/v1/projects/${project.id}/members`),
    })),
  });

  const rows: ManageRow[] = projects.map((project, index) => ({
    id: project.id,
    href: routes.manage("projects", project.id),
    cells: {
      name: <span title={project.description || undefined}>{project.name}</span>,
      repos: <Count read={repos[index]} testid={`project-repos-${project.slug}`} />,
      people: <Count read={members[index]} testid={`project-people-${project.slug}`} />,
      role: <span className="font-mono text-[12px]">{project.my_role}</span>,
    },
  }));

  return (
    <ManageTable
      columns={COLUMNS}
      rows={rows}
      empty="No projects yet — a project is what repositories, people and workflows hang off."
      testid={testid}
    />
  );
}

/**
 * A count that is a read, not a guess: the project list carries no totals, so
 * each row asks the route that owns them. `…` while the read is in flight, `—`
 * when it was refused — never `0`, which would claim an empty project.
 */
function Count({
  read,
  testid,
}: {
  read: { data?: { items: unknown[] }; isPending: boolean; error: unknown } | undefined;
  testid: string;
}) {
  if (!read || read.isPending) {
    return (
      <span className="font-mono text-[12px] text-faint" data-testid={testid}>
        …
      </span>
    );
  }
  if (read.error) {
    return (
      <span className="font-mono text-[12px] text-faint" data-testid={testid} title="couldn't load">
        —
      </span>
    );
  }
  return (
    <span className="font-mono text-[12px]" data-testid={testid}>
      {read.data?.items.length ?? 0}
    </span>
  );
}

/**
 * The form the projects index has always carried, in the redesign's modal:
 * radius 18, `--shadow-modal`, `role="dialog"` labelled by its heading, Escape
 * closes, and a full-width bottom sheet below 768px (CONTRACT "Phone"). The
 * fields and their test ids are the old form's, byte for byte, because
 * `e2e/tests` fills them to seed a stack.
 */
export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (project: Project) => void;
}) {
  const create = useCreateProject();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(
      { name: trimmed, description: description.trim() || undefined },
      {
        onSuccess: (project) => {
          setName("");
          setDescription("");
          onCreated(project);
        },
      },
    );
  };

  const escape = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4 max-md:items-end max-md:p-0"
      data-testid="create-project-backdrop"
      onKeyDown={escape}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-project-heading"
        data-testid="create-project-dialog"
        className="w-[520px] max-w-full rounded-[14px] border border-line bg-surface p-[24px] shadow-(--shadow-modal) max-md:rounded-b-none max-md:p-[16px]"
      >
        <h2 id="create-project-heading" className="text-[18px] font-bold">
          New project
        </h2>
        <p className="mt-[4px] text-[13.5px] text-muted">
          A project owns repositories, people and workflows. The name sets its slug.
        </p>
        <form id="create-project-form" onSubmit={onSubmit} className="mt-[16px] space-y-3">
          <Field id="create-project-name" label="Name">
            <Input
              id="create-project-name"
              data-testid="create-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>
          <Field id="create-project-description" label="Description (optional)">
            <Textarea
              id="create-project-description"
              data-testid="create-project-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div className="flex items-center gap-[8px] pt-[4px]">
            <button
              type="submit"
              className={SECTION_ACTION_CLASS}
              data-testid="create-project-submit"
              disabled={create.isPending || !name.trim()}
            >
              {create.isPending ? "Creating…" : "Create project"}
            </button>
            <button
              type="button"
              onClick={onClose}
              data-testid="create-project-cancel"
              className="inline-flex h-[34px] cursor-pointer items-center rounded-[8px] border border-line-strong bg-surface px-[12px] text-[13px] font-semibold text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              Cancel
            </button>
          </div>
          {create.error instanceof ApiError && create.error.status === 409 ? (
            <p className="text-[12.5px] text-muted" data-testid="create-project-conflict">
              Pick a different name — the slug is taken.
            </p>
          ) : null}
          <FormError error={create.error} />
        </form>
      </div>
    </div>
  );
}
