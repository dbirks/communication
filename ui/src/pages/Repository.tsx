/**
 * `/p/:projectId/:repo` — the repository page, in one of two views that
 * share the header (design 3a List, design 3b Lanes — the choice remembered
 * per repo in lib/prefs via `RepoViewToggle`).
 *
 * Header: mono breadcrumb (`Project / repo`), the repository's H1, the mono
 * `git_url · branch` line with its GitHub-access state (ADR-0061), and on
 * the right the segmented **List | Lanes** control; in Lanes, a `New chat`
 * button opens today's chat box in a modal.
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
import { Link, useNavigate, useParams } from "react-router";
import { useAgentProfiles, useMe, useProject, useRepositories } from "../api/queries";
import { useProjectRuns } from "../api/runs";
import { useAssignments, usePipelines } from "../api/pipelines";
import { useProjectApprovals } from "../api/approvals";
import { isGitHubRepository, useRepoIssues } from "../api/issues";
import type { GitHubIssue } from "../api/issues";
import type { Approval, Assignment, Repository, RunSummary } from "../api/types";
import { ProblemBanner, Spinner } from "../components/Feedback";
import { ProjectUnavailable } from "../components/ProjectUnavailable";
import { Button } from "../components/ds/Button";
import { NewRunForm } from "../components/m4/NewRunForm";
import { GitHubAccess, type GitHubAccessHandle } from "../components/repo/GitHubAccess";
import { RepoChatBox } from "../components/repo/RepoChatBox";
import { RepoViewToggle } from "../components/repo/RepoViewToggle";
import { buildActivityRows, RepoActivity } from "../components/repo/RepoActivity";
import { RepoIssuesPanel } from "../components/repo/RepoIssuesPanel";
import { RepoWorkflowPanel } from "../components/repo/RepoWorkflowPanel";
import { RepoLanes, RepoWorkflowChips } from "../components/repo/RepoLanes";
import { useRepoConversations } from "../components/repo/useRepoConversations";
import { AssistantNotes, type AssistantNote } from "../components/repo/AssistantNotes";
import { openAssistantWorkflowDraft } from "../components/assistant/AssistantPopover";
import {
  chatPromptFor,
  handOffIssueNumbers,
  noteActionKind,
  noteActionLabel,
  runIdFor,
  useDismissAssistantNote,
  useRepoAssistantNotes,
  visibleAssistantNotes,
  workflowConversationIdFor,
  type AssistantNote as AssistantNoteRow,
} from "../api/notes";
import { useRepoView } from "../lib/prefs";
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
  // The List | Lanes choice (design 3a/3b), remembered per repo.
  const { view } = useRepoView(repositoryData?.name ?? "");
  // The lanes' `Approve` is a link onto an OBSERVED pending gate (ADR-0052's
  // approval route): the approvals read names it, or the card has only Open.
  const approvals = useProjectApprovals(id);

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
  // The one run-start form, opened from any workflow row's `Run` — and, in
  // Lanes, from a drop whose workflow has required inputs the issue cannot
  // fill; that route carries the issue in as the form's prefill (1k).
  const [runFormOpen, setRunFormOpen] = useState(false);
  const [runFormIssue, setRunFormIssue] = useState<GitHubIssue | null>(null);
  // The workflow row that opened the form (1k): the form carries its pin and
  // this repository instead of defaulting to the project's first assignment.
  const [runFormAssignment, setRunFormAssignment] = useState<Assignment | null>(null);
  // Lanes has no left-column chat box, so its header carries `New chat` —
  // the same RepoChatBox, in a modal.
  const [chatFormOpen, setChatFormOpen] = useState(false);

  // ASSISTANT NOTICED (ADR-0071): this user's notes about THIS repository.
  // The GET is also the server's generation trigger: it answers with whatever
  // is stored now and never waits for a model, so the first visit to a fresh
  // repository shows nothing and the notes are there on the next look. With no
  // notes the panel renders nothing at all — there are no rules here to fall
  // back to, which is the design's own refusal of them.
  const navigate = useNavigate();
  const notes = useRepoAssistantNotes(id, repositoryData?.id ?? "");
  const dismissNote = useDismissAssistantNote();
  // A `start_chat` note fills the chat box (and, in Lanes, opens the modal
  // that holds it); the person still presses `Start` — a model writing a
  // prompt has not been allowed to send one (ADR-0052's rule).
  const [chatPrefill, setChatPrefill] = useState<{ text: string } | null>(null);
  const noteRows = visibleAssistantNotes(notes.data?.notes);
  const noteById = new Map(noteRows.map((row) => [row.id, row]));
  const assistantNotes: readonly AssistantNote[] = noteRows.map((row) => {
    const label = noteActionLabel(row.action);
    return {
      id: row.id,
      text: row.text,
      // An action this build cannot perform renders no button: the note still
      // says what it said, and a note is never a link to follow.
      action: label ? { label, onSelect: () => actOnAssistantNote(row) } : undefined,
    };
  });

  /** Each note offers at most one kind, and every kind lands on a route this
   * page already owns — never on anything the note itself supplied. */
  function actOnAssistantNote(row: AssistantNoteRow) {
    switch (noteActionKind(row.action)) {
      case "start_chat":
        // A fresh object each time: the same words offered again still refill
        // a line the person may have cleared.
        setChatPrefill({ text: chatPromptFor(row.action) });
        if (view === "lanes") setChatFormOpen(true);
        break;
      case "hand_off": {
        const wanted = new Set(handOffIssueNumbers(row.action));
        const items = issues.data?.items ?? [];
        // The issue travels when this page can see it; the form is the
        // answer either way, and an issue GitHub no longer lists is not a
        // reason to leave the person with a button that does nothing.
        setRunFormAssignment(null);
        setRunFormIssue(items.find((issue) => wanted.has(issue.number)) ?? null);
        setRunFormOpen(true);
        break;
      }
      case "make_workflow": {
        const chat = workflowConversationIdFor(row.action);
        if (chat) openAssistantWorkflowDraft({ id: chat });
        break;
      }
      case "open_run": {
        const run = runIdFor(row.action);
        if (run) navigate(routes.run(run));
        break;
      }
      default:
        break;
    }
  }

  /** Dismissal is this user's, and it is instant: the row leaves the cache
   * before the 204 answers (`useDismissAssistantNote`). */
  function dismissAssistantNote(note: AssistantNote) {
    const row = noteById.get(note.id);
    if (row) dismissNote.mutate(row);
  }

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

  // Lanes data, computed plain like the rest below the early returns:
  // pending gates by run (first pending row wins — the list is pending-
  // first), the enabled pins the start menu reads, and the default agent
  // profile the seeded chat rides (RepoChatBox's own first-profile rule).
  const pendingGateByRun = new Map<string, Approval>();
  for (const approval of approvals.data?.approvals ?? []) {
    if (approval.state === "pending" && !pendingGateByRun.has(approval.run_id)) {
      pendingGateByRun.set(approval.run_id, approval);
    }
  }
  const enabledAssignments = usableAssignments.filter((assignment) => assignment.enabled);
  const profileDefaultId = profiles.data?.items?.[0]?.id ?? null;

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
        <div className="flex shrink-0 items-center gap-2">
          <RepoViewToggle repositoryName={repositoryData.name} />
          {/* Lanes mode has no left-column chat box — its New chat opens the
              same RepoChatBox in a modal (design 3b header). */}
          {view === "lanes" ? (
            <Button
              variant="primary"
              onClick={() => setChatFormOpen(true)}
              data-testid="repo-new-chat"
            >
              New chat
            </Button>
          ) : null}
        </div>
      </header>

      {view === "lanes" ? (
        /* Design 3b: the WORKFLOWS chip row over the four lanes. */
        <div className="min-w-0 space-y-4">
          <RepoWorkflowChips projectId={id} assignments={enabledAssignments} names={names} />
          <RepoLanes
            projectId={id}
            repositoryName={repositoryData.name}
            issues={issues}
            githubHosted={githubHosted}
            runs={repoRuns}
            conversations={conversations.data?.items ?? []}
            runsPending={runs.isPending}
            runsError={runs.error}
            onRetryRuns={() => void runs.refetch()}
            retryingRuns={runs.isFetching}
            chatsPending={conversations.isPending}
            chatsError={conversations.error}
            onRetryChats={() => void conversations.refetch()}
            retryingChats={conversations.isFetching}
            gateFor={(runId) => pendingGateByRun.get(runId) ?? null}
            assignments={enabledAssignments}
            names={names}
            profileDefaultId={profileDefaultId}
            profilesPending={profiles.isPending}
            onOpenRunForm={(issue, assignment) => {
              setRunFormAssignment(assignment);
              setRunFormIssue(issue);
              setRunFormOpen(true);
            }}
          />
        </div>
      ) : (
        /* The design's two columns: chat + activity left, side panel right;
           they stack below 1024px so a 390px viewport never scrolls sideways. */
        <div className="grid grid-cols-1 items-start gap-5 min-[1024px]:grid-cols-[minmax(0,1fr)_290px]">
          <div className="min-w-0 space-y-4">
            <RepoChatBox
              projectId={id}
              repositoryName={repositoryData.name}
              prefill={chatPrefill ?? undefined}
            />
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
            {/* Design 3a's side panel order: WORKFLOWS, OPEN ISSUES, and
                ASSISTANT NOTICED at the BOTTOM (rcn-review14, item 3). */}
            <RepoWorkflowPanel
              projectId={id}
              project={projectData}
              repository={repositoryData}
              runs={runs.data?.runs}
              runsPending={runs.isPending}
              runsError={runs.error}
              onRun={(assignment) => {
                setRunFormAssignment(assignment);
                setRunFormIssue(null);
                setRunFormOpen(true);
              }}
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
            <AssistantNotes notes={assistantNotes} onDismiss={dismissAssistantNote} />
          </div>
        </div>
      )}

      {runFormOpen ? (
        <RunFormModal
          projectId={id}
          issue={runFormIssue}
          assignment={runFormAssignment}
          repository={{ id: repositoryData.id, name: repositoryData.name }}
          onClose={() => setRunFormOpen(false)}
        />
      ) : null}
      {chatFormOpen ? (
        <ChatFormModal
          projectId={id}
          repositoryName={repositoryData.name}
          prefill={chatPrefill ?? undefined}
          onClose={() => setChatFormOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The page's one run-start form (3a, 1k): a raised modal over the current
 * page, carrying today's `NewRunForm` — same assignment select, same declared
 * inputs, same receipts; the 3b drop-to-Running route hands the form its
 * issue prefill (1k). `esc` closes and returns focus to the page.
 *
 * ONE modal (1k review): when the pinned revision declares `input_specs`,
 * the typed 1k form brings its own dialog chrome — the outer `Start a run`
 * shell steps down instead of wrapping a second modal with a second esc/×.
 * Opened from a row, the form carries that row's pin and this repository. */
function RunFormModal({
  projectId,
  issue,
  assignment,
  repository,
  onClose,
}: {
  projectId: string;
  issue: GitHubIssue | null;
  assignment: Assignment | null;
  repository: { id: string; name: string };
  onClose: () => void;
}) {
  const [formMode, setFormMode] = useState<"typed" | "freeform">("freeform");
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
  if (formMode === "typed") {
    // The typed form IS the modal — no second shell around it.
    return (
      <NewRunForm
        projectId={projectId}
        issue={issue ?? undefined}
        assignmentId={assignment?.id ?? null}
        repository={repository}
        onFormModeChange={setFormMode}
        onCancel={onClose}
      />
    );
  }
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
          <NewRunForm
            projectId={projectId}
            issue={issue ?? undefined}
            assignmentId={assignment?.id ?? null}
            repository={repository}
            onFormModeChange={setFormMode}
            onCancel={onClose}
          />
        </div>
      </div>
    </div>
  );
}

/** The Lanes header's `New chat` (3b): the same raised-modal shell as the
 * run form, carrying today's `RepoChatBox` — one line, profile chip,
 * `Start` creating a repo-bound conversation (ADR-0067) and navigating to
 * the thread. `esc` closes and returns focus to the page. */
function ChatFormModal({
  projectId,
  repositoryName,
  prefill,
  onClose,
}: {
  projectId: string;
  repositoryName: string;
  /** An assistant note's `start_chat` prompt (ADR-0071), same rule as the
   * List view's chat box: filled, never sent. */
  prefill?: { text: string };
  onClose: () => void;
}) {
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
        aria-labelledby="repo-chat-form-title"
        className="w-[540px] max-w-full rounded-[4px] border border-ink bg-surface shadow-(--shadow-raised)"
        data-testid="repo-new-chat-dialog"
      >
        <div className="flex items-center gap-2 border-b border-line px-4 py-3">
          <h2 id="repo-chat-form-title" className="min-w-0 flex-1 text-[15px] font-semibold">
            New chat in {repositoryName}
          </h2>
          <span aria-hidden="true" className="font-mono text-[11px] text-faint">
            esc
          </span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="icon-hit rounded-[3px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            data-testid="repo-new-chat-close"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="p-[10px]" data-testid="repo-new-chat-body">
          <RepoChatBox projectId={projectId} repositoryName={repositoryName} prefill={prefill} />
        </div>
      </div>
    </div>
  );
}

/** GitHub refused the read the way a hidden repository answers — the rule
 * lives with the panel that speaks it (`components/repo/RepoIssuesPanel`). */
