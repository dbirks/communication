import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import type { Project } from "../../api/types";

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
        Let a thread&#39;s agent ask the agent of another repository in this project a question.
        Asked agents answer read-only — letting one edit its repo needs a person to approve each
        change. Off by default.
      </p>
      <p className="mt-1 font-mono text-[11px]" data-testid="agent-mail-state">
        {enabled ? (
          <span className="text-st-done-tag-fg">
            <span aria-hidden="true">✓ </span>on — threads in this project may ask
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
