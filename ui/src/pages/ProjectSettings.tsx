/**
 * Project settings (J8): the secret surface, and nothing else.
 *
 * Members live on the project screen (shipped), so what lands here in M3 is the
 * SecretRef list, the mount declarations, and the materialization audit — i.e.
 * everything `docs/design/wireframes.md` §9 shows. Anything the M3 API has no
 * route for (an audit table, a sandbox policy editor) is *not* stubbed: a panel
 * that renders a client-side guess of a server fact is the failure mode
 * `docs/design/data-dependencies.md` §15 names.
 */
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import { useAgentProfiles, useProject, useRepositories, useSecrets } from "../api/queries";
import type { Project, Secret } from "../api/types";
import ProjectSectionNav from "../components/ProjectSectionNav";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { MaterializationsPanel, SecretMountsPanel, SecretsPanel } from "../components/Secrets";
import { WorkspacesPanel } from "../components/Workspaces";

function Settings({ project }: { project: Project }) {
  const secrets = useSecrets(project.id);
  const profiles = useAgentProfiles();
  const repos = useRepositories(project.id);
  const [selected, setSelected] = useState<Secret | null>(null);

  return (
    <div className="space-y-4">
      <SecretsPanel
        project={project}
        profiles={profiles.data?.items}
        onSelect={setSelected}
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

export default function ProjectSettings() {
  const { projectId = "" } = useParams<{ projectId: string }>();
  const project = useProject(projectId);

  if (project.isPending) return <Spinner label="Loading project settings" />;

  if (project.error instanceof ApiError && project.error.status === 404) {
    return (
      <section aria-labelledby="settings-missing-heading">
        <h1 id="settings-missing-heading" className="text-title-l font-bold">
          Settings
        </h1>
        <p className="mt-2 text-st-failed-tag-fg" role="alert">
          <span aria-hidden="true">× </span>
          <span data-testid="settings-not-found">Project not found or you do not have access</span>
        </p>
      </section>
    );
  }

  if (project.error || !project.data) {
    return (
      <section aria-labelledby="settings-error-heading">
        <h1 id="settings-error-heading" className="text-title-l font-bold">
          Settings
        </h1>
        <ProblemBanner error={project.error} fallback="The project could not be loaded." />
      </section>
    );
  }

  const data = project.data;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
      <ProjectSectionNav projectId={data.id} active="settings" />
      <div className="min-w-0 space-y-4">
        <header className="space-y-1">
          <p className="font-mono text-[11px] text-muted">
            <Link to={`/projects/${data.id}`} className="text-accent-text hover:text-ink">
              {data.name}
            </Link>
            <span aria-hidden="true"> / </span>
            <span>Settings</span>
          </p>
          <h1 id="settings-heading" className="text-title-l font-bold" data-testid="settings-title">
            Secrets &amp; workspaces — {data.name}
          </h1>
          <p className="text-[12.5px] text-muted">
            Your role: <span className="font-mono">{data.my_role}</span>. A viewer may read
            metadata; only a maintainer may create, rotate, revoke or place a secret.
          </p>
        </header>
        <Settings project={data} />
        <WorkspacesPanel projectId={data.id} />
      </div>
    </div>
  );
}
