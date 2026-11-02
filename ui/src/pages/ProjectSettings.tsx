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
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { ApiError, apiFetch } from "../api/client";
import {
  queryKeys,
  useAgentProfiles,
  useProject,
  useRepositories,
  useSecrets,
} from "../api/queries";
import type { Project, Secret } from "../api/types";
import ProjectSectionNav from "../components/ProjectSectionNav";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { MaterializationsPanel, SecretMountsPanel, SecretsPanel } from "../components/Secrets";
import { WorkspacesPanel } from "../components/Workspaces";
import { routes } from "../lib/routes";

function Settings({ project }: { project: Project }) {
  const secrets = useSecrets(project.id);
  const profiles = useAgentProfiles();
  const repos = useRepositories(project.id);
  const [selected, setSelected] = useState<Secret | null>(null);

  return (
    <div className="space-y-4">
      <AgentMailPanel project={project} />
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

/**
 * The ADR-0072 agent-mail switch. Off by default: until a maintainer turns
 * it on, no chat in this project can ask another repo's agent anything. The
 * write is the project's optimistic PATCH (stale `version` → 409, which is
 * surfaced as a refetch hint, never a silent overwrite).
 */
export function AgentMailPanel({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const enabled = project.agent_mail_enabled === true;
  const canManage = project.my_role === "maintainer";
  const patch = useMutation({
    mutationFn: (next: boolean) =>
      apiFetch<Project>(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        json: { agent_mail_enabled: next, version: project.version },
      }),
    onSuccess: async (fresh) => {
      setError(null);
      queryClient.setQueryData(queryKeys.project(project.id), fresh);
      await queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setError("The project changed beneath you — it was refetched; try again.");
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      } else {
        setError(err instanceof ApiError ? err.message : "The setting could not be saved.");
      }
    },
  });

  return (
    <section
      aria-labelledby="agent-mail-heading"
      className="rounded-[3px] border border-line-strong bg-surface p-3"
      data-testid="agent-mail-panel"
    >
      <h2
        id="agent-mail-heading"
        className="font-mono text-[10px] font-semibold uppercase tracking-[.04em] text-muted"
      >
        Agent mail
      </h2>
      <p className="mt-1 text-[12.5px] text-ink-2" data-testid="agent-mail-copy">
        Let a chat&#39;s agent ask the agent of another repository in this project a question. Asked
        agents answer read-only — letting one edit its repo needs a person to approve each change.
        Off by default.
      </p>
      <p className="mt-1 font-mono text-[11px]" data-testid="agent-mail-state">
        {enabled ? (
          <span className="text-st-done-tag-fg">
            <span aria-hidden="true">✓ </span>on — chats in this project may ask
          </span>
        ) : (
          <span className="text-muted">
            <span aria-hidden="true">· </span>off
          </span>
        )}
      </p>
      <label className="mt-2 inline-flex items-center gap-2 text-[12.5px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canManage || patch.isPending}
          onChange={(event) => patch.mutate(event.target.checked)}
          data-testid="agent-mail-toggle"
        />
        {patch.isPending ? "Saving…" : "Agent mail across repos"}
      </label>
      {!canManage ? (
        <p className="mt-1 text-[11.5px] text-faint" data-testid="agent-mail-locked">
          Only a project maintainer can change this.
        </p>
      ) : null}
      {error ? (
        <p
          className="mt-1 text-[12px] text-st-failed-tag-fg"
          role="alert"
          data-testid="agent-mail-error"
        >
          <span aria-hidden="true">× </span>
          {error}
        </p>
      ) : null}
    </section>
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
            <Link to={routes.project(data.id)} className="text-accent-text hover:text-ink">
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
