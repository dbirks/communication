/**
 * `/p/:projectId/:repo` — the repository page, List view (design 3a).
 *
 * Header: mono breadcrumb (`Project / repo`), the repository's H1, the mono
 * `git_url · branch` line with its GitHub-access state (ADR-0061), and on the
 * right the segmented **List | Lanes** control (the choice remembered per
 * repo in lib/prefs; Lanes is a disabled segment until the 3b page exists —
 * no fake placeholder).
 *
 * Two columns (`minmax(0,1fr) 290px`, stacking below 1024px):
 * - left: the CHAT BOX (one line, ink border, hard shadow — Start creates a
 *   conversation BORN BOUND to this repository (ADR-0067) with the typed
 *   text as its first message and navigates to the thread) and ONE activity
 *   panel of runs and chats mixed, newest activity first, under filter chips
 *   (All · Runs · Chats · Mine);
 * - right: ASSISTANT NOTICED (rendered only from a real notes source — there
 *   is none yet, so today it renders nothing at all), WORKFLOWS · n (each
 *   row: trigger line + latest result + Run; triggers edited from the row
 *   menu, no inline STARTS WHEN box), and OPEN ISSUES · n (`Hand off`
 *   expands today's issue-run form inline).
 *
 * Gone from design 1e: WORK IN THIS REPO (workspaces move to the chat/run
 * side panels) and the inline STARTS WHEN boxes.
 *
 * Honest data, unchanged rules:
 * - the GitHub access line says what the repository row says (ADR-0061);
 * - activity runs are attributed by the run's own `repository_id`
 *   (ADR-0064/ADR-0060) when the server serves one, else through
 *   `assignment_id` → the assignment's repository; when neither read answers,
 *   the panel says plainly that it is showing the project's runs;
 * - chats are the server's answer (`?repository=` filter, ADR-0067), never a
 *   client-side guess;
 * - a run row shows a progress strip only when the run data really carries
 *   per-step states; the project list does not, so today none does;
 * - the issue list is GitHub's, read anonymously; a refused or spent read
 *   renders the upstream's own answer, never an invented list.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useAgentProfiles, useMe, useProject, useRepositories } from "../api/queries";
import { useProjectRuns } from "../api/runs";
import { useAssignments, usePipelines } from "../api/pipelines";
import { isGitHubRepository, useRepoIssues } from "../api/issues";
import type { Repository, RunSummary } from "../api/types";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ProjectUnavailable } from "../components/ProjectUnavailable";
import { NewRunForm } from "../components/m4/NewRunForm";
import { GitHubAccess, type GitHubAccessHandle } from "../components/repo/GitHubAccess";
import { RepoChatBox } from "../components/repo/RepoChatBox";
import { RepoViewToggle } from "../components/repo/RepoViewToggle";
import { buildActivityRows, RepoActivity } from "../components/repo/RepoActivity";
import { RepoIssuesPanel } from "../components/repo/RepoIssuesPanel";
import { RepoWorkflowPanel } from "../components/repo/RepoWorkflowPanel";
import { useRepoConversations } from "../components/repo/useRepoConversations";
import { AssistantNotes, type AssistantNote } from "../components/repo/AssistantNotes";
import { routes } from "../lib/routes";

/** The statuses after which a run is no longer "in progress" (the terminal
 * arms of `RunStatus`; `interrupted` stopped with the outcome unknown). */
const TERMINAL_RUN_STATUSES = new Set<string>(["completed", "failed", "cancelled", "interrupted"]);

/** Pipeline id → the workflow's own name (display name, else slug) — the only
 * names the wire gives a run or an assignment select. */
function useNameMap(): ReadonlyMap<string, string> {
  const pipelines = usePipelines();
  return useMemo(
    () =>
      new Map(
        (pipelines.data?.pipelines ?? []).map((pipeline) => [
          pipeline.id,
          pipeline.display_name || pipeline.slug,
        ]),
      ),
    [pipelines.data],
  );
}

/** The one repository this page reads: the `:repo` segment names it by id or by
 * the repository's own name (the human identifier the sidebar and the project
 * page use), so both resolve. */
function findRepository(items: readonly Repository[], repoParam: string): Repository | null {
  const needle = repoParam.trim().toLowerCase();
  if (!needle) return null;
  return (
    items.find((item) => item.id === repoParam) ??
    items.find((item) => item.name.toLowerCase() === needle) ??
    null
  );
}

/** Issue number → the newest run that was started FROM that issue and has not
 * finished. The proof is the ADR-0056 pair the runs list really carries:
 * `trigger.kind = issue` plus `trigger.ref = owner/repo#<number>`, matched
 * against the `owner/repo` the issue list itself echoed. Both hands that
 * start an issue run record it: the trigger fire, and — since ADR-0064 — the
 * inline start from this very row (`RunCreate.issue`). A run that claims no
 * issue (`manual`, `schedule`, `thread`) never counts, whatever else it ran
 * with. */
function activeIssueRuns(
  runsData: { runs: RunSummary[] } | undefined,
  issuesData: { repository: string } | undefined,
): ReadonlyMap<number, RunSummary> {
  const map = new Map<number, RunSummary>();
  if (!runsData || !issuesData) return map;
  const prefix = `${issuesData.repository}#`;
  for (const run of runsData.runs) {
    const trigger = run.trigger;
    if (!trigger || trigger.kind !== "issue" || !trigger.ref) continue;
    if (!trigger.ref.startsWith(prefix)) continue;
    if (TERMINAL_RUN_STATUSES.has(run.status)) continue;
    const number = Number(trigger.ref.slice(prefix.length));
    if (!Number.isInteger(number) || number <= 0) continue;
    // The project list is newest-first: the first match is the newest run.
    if (!map.has(number)) map.set(number, run);
  }
  return map;
}

export default function Repository() {
  const { projectId = "", repo = "" } = useParams<{ projectId: string; repo: string }>();
  const id = projectId ?? "";
  const name = repo ?? "";

  const project = useProject(id);
  const repos = useRepositories(id);
  const names = useNameMap();
  const assignments = useAssignments(id);
  const runs = useProjectRuns(id);
  const me = useMe();
  const profiles = useAgentProfiles();

  const repository = useMemo(
    () => findRepository(repos.data?.items ?? [], name),
    [repos.data, name],
  );
  const repositoryData = repository;
  const conversations = useRepoConversations(id, repositoryData?.name ?? "");

  // The GitHub-ness of this repository's remote is decided from the `git_url`
  // the payload already carries: a local/file remote never asks the issues
  // route (which would only answer `422 not_a_github_repository`).
  const githubHosted = repositoryData ? isGitHubRepository(repositoryData.git_url) : false;
  const issues = useRepoIssues(id, repositoryData?.id ?? "", "", githubHosted);
  // ADR-0061 § 6: the ISSUES refusal line opens the GitHub-access picker
  // rendered up in the header — one dialog, opened from where the refusal is.
  const ghAccess = useRef<GitHubAccessHandle | null>(null);
  // The OPEN ISSUES row expanded inline (the `Hand off` form) — one at a time.
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null);
  // The one run-start form, opened from any workflow row's `Run`.
  const [runFormOpen, setRunFormOpen] = useState(false);

  // ASSISTANT NOTICED has no notes backend yet: the assistant's notes will
  // arrive through their own read and be handed to `AssistantNotes` here.
  // With no source there is nothing to render — no placeholder, no rule.
  const assistantNotes: readonly AssistantNote[] = [];

  if (project.isPending) return <Spinner label="Loading project" />;
  if (project.error || !project.data) {
    return (
      <section aria-labelledby="repo-error-heading">
        <h1 id="repo-error-heading" className="text-title-l font-bold">
          Repository
        </h1>
        <div className="mt-2 max-w-[70ch]">
          <ProblemBanner
            error={project.error}
            fallback="The project could not be loaded."
            subject="the project this repository belongs to"
            hint="Nothing of the repository is drawn without its project — the read that failed is the one that names it."
            retry={{
              onClick: () => void project.refetch(),
              pending: project.isFetching,
              testid: "project-load-retry",
            }}
            back={{ to: routes.projects(), label: "← Projects", testid: "repo-back-to-projects" }}
          />
        </div>
      </section>
    );
  }
  const projectData = project.data;

  if (repos.isPending) return <Spinner label="Loading repositories" />;
  // The repositories read failing is not the page disappearing: the header the
  // design draws (the project's breadcrumb, the page's own H1) stays and the
  // panel quotes the server — the rule every other server-error screen follows
  // (design-landmark check `repo-failed-heading`, issue #24). The repository's
  // name is NOT said here: the read that would answer it is the one that failed.
  if (repos.error) {
    return (
      <div className="min-w-0 space-y-4" data-testid="repo-error-page">
        <header className="min-w-0 space-y-1" data-testid="repo-error-header">
          <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
            <Link to={routes.project(id)} data-testid="repo-breadcrumb">
              {projectData.name}
            </Link>
            <span aria-hidden="true" className="px-1.5">
              /
            </span>
          </nav>
          <h1 id="repo-load-error-heading" className="text-[22px] leading-[28px] font-semibold">
            Repository
          </h1>
        </header>
        <section aria-labelledby="repo-load-error-heading" className="min-w-0 space-y-3">
          <div className="max-w-[70ch]">
            <ProblemBanner
              error={repos.error}
              fallback="Repositories could not be loaded."
              subject={`the repositories of ${projectData.name}`}
              hint="The list of repositories could not be read, so this page cannot show one."
              retry={{
                onClick: () => void repos.refetch(),
                pending: repos.isFetching,
                testid: "repo-load-retry",
              }}
              back={{
                to: routes.project(id),
                label: `← ${projectData.name}`,
                testid: "repo-load-back-to-project",
              }}
            />
          </div>
        </section>
      </div>
    );
  }

  if (!repositoryData) {
    return (
      <div data-testid="repo-page">
        <ProjectUnavailable
          heading="Repository"
          headingId="repo-not-found-heading"
          label="Repository not found"
          testid="repo-not-found"
          copy="Repository not found or you do not have access"
          missing="Repository"
          hint="Check the name in the link, or go back to the project and pick a repository it does have."
          back={{
            to: routes.project(id),
            label: projectData.name,
            testid: "repo-breadcrumb",
          }}
          backButton={{
            label: `← ${projectData.name}`,
            testid: "repo-back-to-project",
          }}
        />
      </div>
    );
  }

  // ADR-0060: the assignments that cover this repository — this repo's own
  // pins plus the whole-project ones (`repository_id` null). They decide both
  // which workflows are startable from an issue and which runs are "this
  // repository's runs". Computed plain (no hook): the early returns above
  // would otherwise split the hook list between renders.
  const usableAssignments = (assignments.data?.assignments ?? []).filter(
    (assignment) =>
      assignment.repository_id === repositoryData.id ||
      assignment.repository_id == null ||
      assignment.repository_id === undefined,
  );

  // This repository's runs, in the order the evidence gets stronger: the
  // run's own `repository_id` (ADR-0064) answers first; unnamed runs ride
  // `assignment_id` → the assignment's repository (ADR-0060) while the
  // assignments read stands. With the assignments read failed, unnamed rows
  // stay shown and the panel says they are the PROJECT's runs.
  const attributable = !assignments.isError && !!assignments.data;
  const assignmentIds = new Set(usableAssignments.map((assignment) => assignment.id));
  const repoRuns = (runs.data?.runs ?? []).filter((run) => {
    if (run.depth !== 0) return false;
    if (run.repository_id === repositoryData.id) return true;
    if (run.repository_id != null && run.repository_id !== "") return false;
    return attributable ? !!(run.assignment_id && assignmentIds.has(run.assignment_id)) : true;
  });

  const activityRows = buildActivityRows(repoRuns, conversations.data?.items ?? []);

  const profileNames = new Map(
    (profiles.data?.items ?? []).map((profile) => [profile.id, profile.name]),
  );

  return (
    <div className="min-w-0 space-y-4" data-testid="repo-page">
      <header
        className="flex flex-col gap-2 min-[640px]:flex-row min-[640px]:flex-wrap min-[640px]:items-start min-[640px]:gap-x-4"
        data-testid="repo-header"
      >
        <div className="min-w-0 flex-1 space-y-1">
          <nav aria-label="Breadcrumb" className="font-mono text-[11px] text-muted">
            <Link to={routes.project(id)} data-testid="repo-breadcrumb">
              {projectData.name}
            </Link>
            <span aria-hidden="true" className="px-1.5">
              /
            </span>
            <span data-testid="repo-breadcrumb-repo">{repositoryData.name}</span>
          </nav>
          <h1 data-testid="repo-name" className="text-[22px] leading-[28px] font-semibold">
            {repositoryData.name}
          </h1>
          <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-muted">
            {/^https?:\/\//i.test(repositoryData.git_url.trim()) ? (
              <a
                href={repositoryData.git_url}
                target="_blank"
                rel="noreferrer"
                data-testid="repo-git-url"
                className="break-all underline"
              >
                {repositoryData.git_url}
              </a>
            ) : (
              <span className="break-all">{repositoryData.git_url}</span>
            )}
            <span aria-hidden="true">·</span>
            <span data-testid="repo-default-branch">{repositoryData.default_branch}</span>
          </div>
          <GitHubAccess ref={ghAccess} project={projectData} repository={repositoryData} />
        </div>
        <RepoViewToggle repositoryName={repositoryData.name} />
      </header>

      {/* The design's two columns: chat + activity left, side panel right;
          they stack below 1024px so a 390px viewport never scrolls sideways. */}
      <div className="grid grid-cols-1 items-start gap-5 min-[1024px]:grid-cols-[minmax(0,1fr)_290px]">
        <div className="min-w-0 space-y-4">
          <RepoChatBox projectId={id} repositoryName={repositoryData.name} />
          <RepoActivity
            rows={activityRows}
            nameFor={(pipelineId) => names.get(pipelineId) ?? null}
            profileNameFor={(agentProfileId) => profileNames.get(agentProfileId) ?? null}
            meId={me.data?.id ?? null}
            repositoryName={repositoryData.name}
            projectId={id}
            runsPending={runs.isPending}
            runsError={runs.error}
            onRetryRuns={() => void runs.refetch()}
            retryingRuns={runs.isFetching}
            chatsPending={conversations.isPending}
            chatsError={conversations.error}
            onRetryChats={() => void conversations.refetch()}
            retryingChats={conversations.isFetching}
            showProjectNote={repoRuns.length > 0 && !attributable}
          />
        </div>
        <div className="min-w-0 space-y-4">
          <AssistantNotes notes={assistantNotes} />
          <RepoWorkflowPanel
            projectId={id}
            project={projectData}
            repository={repositoryData}
            runs={runs.data?.runs}
            runsPending={runs.isPending}
            runsError={runs.error}
            onRun={() => setRunFormOpen(true)}
          />
          <RepoIssuesPanel
            repository={repositoryData}
            projectId={id}
            issues={issues}
            githubHosted={githubHosted}
            assignments={usableAssignments}
            names={names}
            activeRunsByIssue={activeIssueRuns(runs.data, issues.data)}
            expandedIssue={expandedIssue}
            onExpand={setExpandedIssue}
            canManageGitHub={projectData.my_role === "maintainer"}
            onAddGitHubAccess={() => ghAccess.current?.open()}
          />
        </div>
      </div>

      {runFormOpen ? <RunFormModal projectId={id} onClose={() => setRunFormOpen(false)} /> : null}
    </div>
  );
}

/** The page's one run-start form (3a): a raised modal over the current page,
 * carrying today's `NewRunForm` — same assignment select, same declared
 * inputs, same receipts. `esc` closes and returns focus to the page. */
function RunFormModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/25 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="repo-run-form-title"
        className="max-h-[calc(100vh-12rem)] w-[540px] max-w-full overflow-y-auto rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="repo-run-form"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="repo-run-form-title" className="min-w-0 flex-1 text-[15px] font-semibold">
            Start a run
          </h2>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="icon-hit rounded-[3px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="repo-run-form-close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="p-[10px]">
          <NewRunForm projectId={projectId} onCancel={onClose} />
        </div>
      </div>
    </div>
  );
}

/** GitHub refused the read the way a hidden repository answers — the rule
 * lives with the panel that speaks it (`components/repo/RepoIssuesPanel`). */
