/**
 * Manage → Secrets (redesign R7): the same three panels the project settings
 * page wires today — `SecretsPanel`, `SecretMountsPanel`,
 * `MaterializationsPanel` — with the same props and the same selected-secret
 * state, and nothing else.
 *
 * The wiring is the one `pages/ProjectSettings.tsx` has (`selected` holds the
 * Secret the audit reads, the mount panel gets the project's secret list and
 * its `{id, name}` repository list, the allowlist column gets the cached agent
 * profiles); the panels are imported, not rewritten, because their honesty
 * rules are the product's: no route returns a value, no digest is listed, and
 * a viewer sees metadata only.
 *
 * A project is required — secrets are project-scoped on the wire, so "All
 * projects" is not an answer here and the filter is labelled to say what it
 * picks. With no `?project=` the first project the caller belongs to is read,
 * which is what the old per-project settings URL always effectively showed.
 */
import { useState } from "react";
import { useSearchParams } from "react-router";
import { useAgentProfiles, useProjects, useRepositories, useSecrets } from "../../api/queries";
import type { Project, Secret } from "../../api/types";
import { ProblemBanner, Spinner } from "../../components/Feedback";
import { MaterializationsPanel, SecretMountsPanel, SecretsPanel } from "../../components/Secrets";
import { ProjectFilter } from "./ProjectFilter";
import { SectionHeader } from "./ManageTable";

export default function SecretsSection() {
  const projects = useProjects();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<Secret | null>(null);

  const items = projects.data?.items ?? [];
  const projectParam = searchParams.get("project") ?? "";
  const project = items.find((item) => item.id === projectParam) ?? items[0];

  const setProject = (projectId: string) => {
    const next = new URLSearchParams(searchParams);
    if (projectId) next.set("project", projectId);
    else next.delete("project");
    setSearchParams(next, { replace: true });
    // A secret belongs to one project; carrying a selection into another one
    // would read an audit trail that is not the project's.
    setSelected(null);
  };

  return (
    <div className="flex flex-col gap-[18px]" data-testid="manage-secrets">
      <SectionHeader title="Secrets" blurb="Credentials agents may use. Values are never shown." />

      <ProjectFilter
        projects={items}
        value={project?.id ?? ""}
        onChange={setProject}
        allLabel="Pick a project"
        testid="secrets-project-filter"
      />

      {projects.isPending && !projects.data ? <Spinner label="Loading secrets" /> : null}
      {projects.error ? (
        <ProblemBanner
          error={projects.error}
          fallback="Projects could not be loaded."
          subject="your projects"
          retry={{ onClick: () => void projects.refetch(), pending: projects.isFetching }}
        />
      ) : null}
      {projects.data && !project ? (
        <p className="text-[13.5px] text-muted" data-testid="manage-secrets-empty">
          No projects yet — secrets live in a project, so there is nothing to read.
        </p>
      ) : null}

      {project ? (
        <ProjectSecrets project={project} selected={selected} onSelect={setSelected} />
      ) : null}
    </div>
  );
}

/** The three panels, wired exactly as the project settings page wires them. */
export function ProjectSecrets({
  project,
  selected,
  onSelect,
}: {
  project: Project;
  selected: Secret | null;
  onSelect: (secret: Secret) => void;
}) {
  const secrets = useSecrets(project.id);
  const profiles = useAgentProfiles();
  const repos = useRepositories(project.id);

  return (
    <div className="flex flex-col gap-[16px]" data-testid={`manage-secrets-body-${project.slug}`}>
      <SecretsPanel
        project={project}
        profiles={profiles.data?.items}
        onSelect={onSelect}
        selectedId={selected?.id ?? null}
      />
      <SecretMountsPanel
        project={project}
        secrets={secrets.data?.secrets ?? []}
        repositories={(repos.data?.items ?? []).map((repo) => ({ id: repo.id, name: repo.name }))}
      />
      <MaterializationsPanel project={project} secret={selected} />
    </div>
  );
}
