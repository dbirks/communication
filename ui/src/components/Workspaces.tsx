/**
 * Workspaces — where a scope's edits live (ADR-0017).
 *
 * Two shapes, one data source:
 * - `WorkspacesPanel` on the project screen: every live + recent workspace.
 * - `WorkspaceWidget` beside a conversation: just that conversation's workspace.
 *
 * What the M3 API lets this screen say, and nothing more: state, scope, mode,
 * worker/volume identity, and per-repo `run_ref` / `base_commit` / `head_commit`
 * plus the modified-path manifest. **No host path** (`root_path`, `mirror_path`,
 * `admin_dir` are not serialized at all), **no restore/discard affordance**
 * (`10`'s workspace widget forbids one), and a `lost` workspace says its edits
 * are gone — cross-host rehydration (D-024) stays **Open**, so "resumed" would
 * be a lie (`10` J7).
 */
import { useState } from "react";
import { useWorkspaceRepoStatus, useWorkspaces } from "../api/queries";
import { shortVolume } from "../api/sandbox";
import type { Workspace, WorkspaceRepo } from "../api/types";
import { problemOf } from "../api/client";
import { Alert } from "./ds/Alert";
import { Button } from "./ds/Button";
import { Panel } from "./ds/Panel";
import { StatusChip } from "./ds/Row";
import { WORKSPACE_STATE, stateOf } from "./ds/states";
import { Spinner } from "./Feedback";
import { formatAge, formatTime, shortCommit, shortId } from "../lib/format";

/** Honest copy for `Workspace.lost_reason`, straight from the enum. */
const LOST_REASON_COPY: Record<string, string> = {
  volume_changed:
    "the storage root this workspace lived on is gone — the prior edits are lost and a rerun is required",
  path_missing:
    "the workspace directory is missing — the prior edits are lost and a rerun is required",
  different_worker:
    "this scope landed on a different worker, which cannot see the prior edits — a rerun is required",
};

function lostCopy(reason: string | null | undefined): string {
  return (reason && LOST_REASON_COPY[reason]) || "the prior edits are lost and a rerun is required";
}

/** The dirty manifest, read from the row the worker wrote at a unit boundary. */
function RepoStatus({ workspace, repo }: { workspace: Workspace; repo: WorkspaceRepo }) {
  const [open, setOpen] = useState(false);
  const status = useWorkspaceRepoStatus(open ? workspace.id : "", open ? repo.repository_id : "");

  return (
    <div className="mt-[2px] pl-[10px]" data-testid={`workspace-repo-${workspace.id}-${repo.name}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[12.5px] font-semibold">{repo.name}</span>
        <span
          className="font-mono text-[10.5px] text-muted"
          title="the only ref this scope may write"
        >
          ref: {repo.run_ref}
        </span>
        <span className="font-mono text-[10.5px] text-muted">
          base {shortCommit(repo.base_commit)} → head {shortCommit(repo.head_commit)}
        </span>
        <span className="font-mono text-[10.5px] text-ink-2">
          {(repo.modified_paths?.length ?? 0) === 0
            ? "clean"
            : `dirty: ${repo.modified_paths?.length} paths`}
        </span>
        {(repo.excluded_paths?.length ?? 0) > 0 ? (
          <span className="font-mono text-[10.5px] text-faint">
            {repo.excluded_paths?.length} excluded (materialized/APM paths, never staged)
          </span>
        ) : null}
        <Button
          variant="ghost"
          compact
          className="ml-auto"
          data-testid={`workspace-inspect-${workspace.id}-${repo.name}`}
          onClick={() => setOpen((current) => !current)}
        >
          {open ? "Hide manifest" : "Inspect workspace"}
        </Button>
      </div>
      {open ? (
        <div className="mt-1 rounded-[3px] border border-line bg-fill/50 px-[10px] py-2">
          {status.isPending ? <Spinner label="Loading the recorded manifest" /> : null}
          {status.error ? (
            <p className="font-mono text-[11px] text-st-failed-tag-fg" role="alert">
              ×{" "}
              {problemOf(status.error).detail ||
                "This checkout's manifest could not be read (a contributor role is required)."}
            </p>
          ) : null}
          {status.data ? (
            <div data-testid={`workspace-status-${workspace.id}-${repo.name}`}>
              <p className="text-[12.5px]">
                {status.data.dirty ? `dirty: ${status.data.modified_paths.length} paths` : "clean"}{" "}
                <span className="font-mono text-[10.5px] text-muted">
                  as recorded {formatAge(status.data.recorded_at)} ago (
                  {formatTime(status.data.recorded_at)}) — this is the worker's last recorded view,
                  not a live git status
                </span>
              </p>
              {(status.data.modified_paths?.length ?? 0) > 0 ? (
                <ul className="mt-1 max-h-32 overflow-auto space-y-[1px]">
                  {status.data.modified_paths.map((path) => (
                    <li key={path} className="font-mono text-[11px] text-ink-2">
                      {path}
                    </li>
                  ))}
                </ul>
              ) : null}
              {(status.data.excluded_paths?.length ?? 0) > 0 ? (
                <p className="mt-1 font-mono text-[10.5px] text-faint">
                  excluded: {status.data.excluded_paths?.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One workspace row + the findings its state carries. */
export function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const state = stateOf(WORKSPACE_STATE[workspace.state]);
  const needsAction = workspace.state === "quarantined" || workspace.state === "lost";
  return (
    <li data-testid={`workspace-row-${workspace.id}`}>
      <div className="flex flex-wrap items-center gap-[9px] rounded-[3px] border border-line bg-surface px-[10px] py-[6px]">
        <StatusChip
          state={state}
          label={workspace.state}
          labelProps={{ "data-testid": `workspace-state-${workspace.id}` }}
        />
        <span className="text-[12.5px] font-semibold">
          {workspace.scope_kind} · {workspace.workspace_mode}
        </span>
        <span className="font-mono text-[10.5px] text-muted">
          worker {shortId(workspace.worker_id)}
        </span>
        <span className="font-mono text-[10.5px] text-muted">
          volume {shortVolume(workspace.volume_id)}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-faint">
          {formatAge(workspace.created_at)} ago
        </span>
      </div>
      {workspace.state === "quarantined" ? (
        <Alert
          state="failed"
          label="QUARANTINED"
          barTone="strong"
          role="alert"
          testid={`workspace-quarantined-${workspace.id}`}
        >
          A security check failed in this workspace, so reuse is blocked and nothing here is
          auto-cleaned — deleting the evidence of a security failure is worse than the failure.
        </Alert>
      ) : null}
      {workspace.state === "lost" ? (
        <Alert
          state="interrupted"
          label="EDITS LOST"
          role="alert"
          testid={`workspace-lost-${workspace.id}`}
        >
          {lostCopy(workspace.lost_reason)}
        </Alert>
      ) : null}
      {needsAction ? null : (
        <p className="mt-[2px] pl-[10px] font-mono text-[10.5px] text-faint">
          created {formatTime(workspace.created_at)}
          {workspace.ready_at ? ` · ready ${formatTime(workspace.ready_at)}` : ""}
          {workspace.released_at ? ` · released ${formatTime(workspace.released_at)}` : ""}
        </p>
      )}
      <ul className="mt-[4px] space-y-[4px]">
        {workspace.repos.map((repo) => (
          <li key={repo.repository_id}>
            <RepoStatus workspace={workspace} repo={repo} />
          </li>
        ))}
        {workspace.repos.length === 0 ? (
          <li className="font-mono text-[11px] text-muted">no repositories attached yet</li>
        ) : null}
      </ul>
    </li>
  );
}

export interface WorkspacesPanelProps {
  projectId: string;
}

/** A project's live + recent workspaces (`GET /api/v1/projects/{id}/workspaces`). */
export function WorkspacesPanel({ projectId }: WorkspacesPanelProps) {
  const workspaces = useWorkspaces(projectId);
  const data = workspaces.data?.workspaces ?? [];
  const quarantined = data.filter((workspace) => workspace.state === "quarantined").length;

  return (
    <Panel
      id="workspaces"
      title="WORKSPACES"
      headingId="workspaces-heading"
      headingLevel={2}
      state={quarantined > 0 ? "failed" : undefined}
      meta={workspaces.data ? `${data.length} live or recent` : undefined}
    >
      <div className="space-y-3 p-[10px]">
        {workspaces.isPending ? <Spinner label="Loading workspaces" /> : null}
        {workspaces.error ? (
          <Alert state="failed" label="UNAVAILABLE" role="alert" testid="workspace-list-error">
            {problemOf(workspaces.error).detail || "Workspaces could not be read."} So the state of
            any in-progress edit is unknown: this is a read of what the worker recorded, and the
            worker is the only thing that knows what is on its volume.
          </Alert>
        ) : null}
        {workspaces.data ? (
          data.length === 0 ? (
            <p className="text-[12.5px] text-muted" data-testid="workspace-list-empty">
              No workspaces yet — one is prepared the first time a conversation or run needs a
              checkout.
            </p>
          ) : (
            <ul className="space-y-[8px]" data-testid="workspace-list">
              {data.map((workspace) => (
                <WorkspaceCard key={workspace.id} workspace={workspace} />
              ))}
            </ul>
          )
        ) : null}
        <p className="font-mono text-[10.5px] text-faint">
          refs and paths a machine produced; the checkout lives on one worker's volume, so no
          restore or discard is offered here (ADR-0017).
        </p>
      </div>
    </Panel>
  );
}

export interface WorkspaceWidgetProps {
  projectId: string;
  conversationId: string;
}

/**
 * The conversation's own workspace (`10`'s Workspace widget, `⟨T+workspace-widget⟩`):
 * what the agent is editing right now, with no host path and no git-mutating
 * affordance.
 */
export function WorkspaceWidget({ projectId, conversationId }: WorkspaceWidgetProps) {
  const workspaces = useWorkspaces(projectId);
  const mine = (workspaces.data?.workspaces ?? []).filter(
    (workspace) => workspace.conversation_id === conversationId,
  );
  const latest = mine[0];

  if (workspaces.isPending) {
    return (
      <p className="font-mono text-[11px] text-muted" role="status">
        · checking this conversation's workspace…
      </p>
    );
  }
  if (workspaces.error) {
    return (
      <p
        className="font-mono text-[11px] text-st-failed-tag-fg"
        role="alert"
        data-testid="workspace-widget-error"
      >
        × workspace status unavailable: {problemOf(workspaces.error).detail || "the read failed"}
      </p>
    );
  }
  if (!latest) {
    return (
      <p className="text-[12.5px] text-muted" data-testid="workspace-widget-empty">
        No workspace for this conversation yet — one is prepared when the agent first needs a
        checkout.
      </p>
    );
  }
  // WorkspaceCard is an <li>; the widget's host is a plain <div>, so it must
  // arrive wrapped in a list (an <li> without a <ul>/<ol> parent is an
  // a11y violation).
  return (
    <ul className="m-0 p-0" role="list">
      <WorkspaceCard workspace={latest} />
    </ul>
  );
}
