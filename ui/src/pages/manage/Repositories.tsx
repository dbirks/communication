/**
 * Manage → Repositories (redesign R7): every repository the caller can work in,
 * across all their projects or one of them.
 *
 * The repository route is per project (`GET /api/v1/projects/{id}/repos`), so
 * the index fans it out over the project list with `useQueries` — the same
 * pattern `pages/Workflows.tsx` uses for its per-project reads — keyed exactly
 * like `useRepositories` so the cache is shared rather than duplicated.
 *
 * STATUS is the one fact the repository wire carries about itself besides the
 * branch: the ADR-0061 GitHub credential (`credential`, derived from
 * `credential_secret_id` so a client can render it without resolving the
 * secret). Words and glyph are `components/repo/GitHubAccess.tsx`'s, kept
 * identical so the same state reads the same on both surfaces. A project whose
 * list could not be read contributes a line saying so; it never contributes an
 * empty result.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys, useProjects } from "../../api/queries";
import type { Repository, RepositoryList } from "../../api/types";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { AddRepositoryDialog } from "../../components/project/AddRepositoryDialog";
import { gitRemote } from "../../components/project/gitRemote";
import { routes } from "../../lib/routes";
import { ManageTable, SectionHeader, SECTION_ACTION_CLASS } from "./ManageTable";
import type { ManageColumn, ManageRow } from "./ManageTable";
import { ProjectFilter } from "./ProjectFilter";

const COLUMNS: ManageColumn[] = [
  { key: "name", label: "Repository" },
  { key: "project", label: "Project" },
  { key: "branch", label: "Default branch" },
  { key: "status", label: "Status" },
];

export default function RepositoriesSection() {
  const projects = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectParam = searchParams.get("project") ?? "";
  const [adding, setAdding] = useState(false);

  const items = projects.data?.items ?? [];
  const selected = projectParam ? items.find((item) => item.id === projectParam) : undefined;
  const scoped = selected ? [selected] : items;

  const rows = useRepositoryRows(scoped);
  const setProject = (projectId: string) => {
    const next = new URLSearchParams(searchParams);
    if (projectId) next.set("project", projectId);
    else next.delete("project");
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="flex flex-col gap-[18px]" data-testid="manage-repositories">
      <SectionHeader
        title="Repositories"
        blurb="Code the agents can work in."
        action={
          <button
            type="button"
            className={SECTION_ACTION_CLASS}
            data-testid="manage-add-repository"
            disabled={!selected}
            title={selected ? `Add a repository to ${selected.name}` : "Pick a project first"}
            onClick={() => selected && setAdding(true)}
          >
            Add repository
          </button>
        }
      />

      <ProjectFilter projects={items} value={projectParam} onChange={setProject} />

      {projects.isPending && !projects.data ? <Spinner label="Loading repositories" /> : null}
      {projects.error ? (
        <ProblemBanner
          error={projects.error}
          fallback="Projects could not be loaded."
          subject="your projects"
          retry={{ onClick: () => void projects.refetch(), pending: projects.isFetching }}
        />
      ) : null}

      {rows.unread.length > 0 ? (
        <p className="text-[12.5px] text-st-failed-tag-fg" role="alert" data-testid="repo-unread">
          <span aria-hidden="true">× </span>
          {rows.unread.length} project{rows.unread.length === 1 ? "" : "s"} could not be read
        </p>
      ) : null}

      <ManageTable
        columns={COLUMNS}
        rows={rows.rows}
        empty={
          selected
            ? "No repositories in this project yet."
            : "No repositories yet — add one to a project and it shows here."
        }
        testid="manage-repositories-table"
      />

      {rows.loading ? <Spinner label="Loading repositories" /> : null}

      {selected ? (
        <AddRepositoryDialog
          open={adding}
          onClose={() => setAdding(false)}
          projectId={selected.id}
        />
      ) : null}
    </div>
  );
}

/** One project's row set, plus the projects whose read failed (counted, never
 * silently missing) and whether any read is still in flight. */
export function useRepositoryRows(projects: readonly { id: string; name: string }[]): {
  rows: ManageRow[];
  unread: string[];
  loading: boolean;
} {
  const reads = useQueries({
    queries: projects.map((project) => ({
      queryKey: queryKeys.repos(project.id),
      queryFn: () => apiFetch<RepositoryList>(`/api/v1/projects/${project.id}/repos`),
    })),
  });

  const rows: ManageRow[] = [];
  const unread: string[] = [];
  let loading = false;
  projects.forEach((project, index) => {
    const read = reads[index];
    if (!read) return;
    if (read.isPending) loading = true;
    if (read.error) {
      unread.push(project.name);
      return;
    }
    for (const repo of read.data?.items ?? []) {
      rows.push(repositoryRow(project, repo));
    }
  });
  return { rows, unread, loading };
}

function repositoryRow(project: { id: string; name: string }, repo: Repository): ManageRow {
  const configured = repo.credential === "configured";
  return {
    id: repo.id,
    href: routes.repository(project.id, repo.name),
    cells: {
      name: (
        <span className="font-mono" title={repo.git_url}>
          {/* The recognisable remote stays visible; the full URL is in the
              accessible name, as `components/project/Repositories.tsx` does. */}
          <span aria-hidden="true">{repo.name}</span>
          <span className="sr-only">{`${repo.name} ${repo.git_url}`}</span>
        </span>
      ),
      project: project.name,
      branch: <span className="font-mono text-[12px]">{repo.default_branch}</span>,
      status: (
        <span
          className={`font-mono text-[11.5px] ${configured ? "text-st-done-tag-fg" : "text-muted"}`}
          data-testid={`repo-status-${repo.id}`}
          title={configured ? repo.git_url : gitRemote(repo.git_url)}
        >
          <span aria-hidden="true">{configured ? "✓ " : "· "}</span>
          {configured ? "credential" : "no credential"}
        </span>
      ),
    },
  };
}
