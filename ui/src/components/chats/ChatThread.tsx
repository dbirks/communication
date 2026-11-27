/**
 * ChatThread — open chat thread view (redesign R3).
 *
 * Composes ChatHeader, PermissionWaitingLine, the scrollable message column
 * (ConversationTranscript + inline RunCards), WorkflowSuggestion above the
 * composer, ChatComposer, HandToWorkflowDialog, and ChatDetailsSheet.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { ApiError } from "../../api/client";
import { handoffRunCreateBody, handoffRunKey, lastAgentMessageOf } from "../../api/handoff";
import { isGitHubRepository } from "../../api/issues";
import {
  noteActionKind,
  noteActionLabel,
  runIdFor,
  useConversationAssistantNotes,
  useDismissAssistantNote,
  visibleAssistantNotes,
  workflowConversationIdFor,
  type AssistantNote as AssistantNoteRow,
} from "../../api/notes";
import { revisionQueryOptions, useAssignments, usePipelines } from "../../api/pipelines";
import { useConversation, useProject, useRepositories, useWorkspaces } from "../../api/queries";
import { useCreateRun, useProjectRuns } from "../../api/runs";
import { interruptedCopy, runLinkOf } from "../../api/transcript";
import { useIssueTriggers } from "../../api/useIssueTriggers";
import { shortId } from "../../lib/format";
import { routes } from "../../lib/routes";
import { FormError, ProblemBanner, Spinner } from "../Feedback";
import { openAssistantWorkflowDraft } from "../assistant/AssistantPopover";
import { PermissionWaitingLine } from "../conversation/AgentConversationPanel";
import { AssistantNote } from "../conversation/AssistantNote";
import { ChatDetailsSheet } from "../conversation/ChatDetailsSheet";
import { ConversationSidePanel } from "../conversation/ConversationSidePanel";
import { ConversationTranscript } from "../conversation/ConversationTranscript";
import { NO_BRANCH_YET, threadBranch } from "../conversation/threadBranch";
import { useConversationSession } from "../conversation/useConversationSession";
import { conversationRunHref, instanceLeaf } from "../Conversations";
import { Alert } from "../ds/Alert";
import { SoftButton } from "../ds/SoftButton";
import { TurnSandboxPanel } from "../Sandbox";
import { WorkspaceWidget } from "../Workspaces";
import HandToWorkflowDialog from "../threads/HandToWorkflowDialog";
import { ThreadArtifacts } from "../threads/ThreadArtifacts";
import { ChatComposer } from "./ChatComposer";
import { DRAFT_PR_PROMPT } from "./draftPr";
import { sandboxVerdictRecorded } from "./sandboxVerdict";
import { ChatHeader } from "./ChatHeader";
import { RunCard } from "./RunCard";
import { WorkflowSuggestion } from "./WorkflowSuggestion";
import {
  buildSuggestionWorkflows,
  dismissWorkflowSuggestion,
  isWorkflowSuggestionDismissed,
  suggestWorkflow,
} from "./chatSuggestion";

export interface ChatThreadProps {
  conversationId: string;
  scope: string | null;
  showBack?: boolean;
}

export function ChatThread({ conversationId, scope, showBack = false }: ChatThreadProps) {
  const navigate = useNavigate();
  // Read once via shared query key so we know projectId even in All scope.
  const conversationRead = useConversation(conversationId);
  const resolvedProjectId = scope ?? conversationRead.data?.project_id ?? "";

  const session = useConversationSession(conversationId, resolvedProjectId);
  const { conversation, data, activeTurn, transcript, described } = session;
  const projectId = data?.project_id ?? resolvedProjectId;

  const workspaces = useWorkspaces(projectId);
  const repositories = useRepositories(projectId);
  const project = useProject(projectId);
  const assignments = useAssignments(projectId);
  const pipelines = usePipelines();
  const issueTriggers = useIssueTriggers(projectId);
  const projectRuns = useProjectRuns(projectId);
  const createRun = useCreateRun(projectId);

  const [handoffOpen, setHandoffOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsSection, setDetailsSection] = useState<"details" | "artifacts">("details");
  const artifactsAnchorRef = useRef<HTMLDivElement | null>(null);
  const [startedRunIds, setStartedRunIds] = useState<string[]>([]);
  const [suggestionDismissed, setSuggestionDismissed] = useState(() =>
    isWorkflowSuggestionDismissed(conversationId),
  );
  const [draftPrConfirm, setDraftPrConfirm] = useState(false);
  const [draftPrError, setDraftPrError] = useState<string | null>(null);
  const [draftPrSent, setDraftPrSent] = useState(false);

  useEffect(() => {
    setStartedRunIds([]);
    setSuggestionDismissed(isWorkflowSuggestionDismissed(conversationId));
    setDraftPrConfirm(false);
    setDraftPrError(null);
    setDraftPrSent(false);
  }, [conversationId]);

  useEffect(() => {
    if (detailsOpen && detailsSection === "artifacts") {
      artifactsAnchorRef.current?.scrollIntoView?.({ block: "start" });
    }
  }, [detailsOpen, detailsSection]);

  const enabledAssignments = useMemo(
    () => (assignments.data?.assignments ?? []).filter((a) => a.enabled),
    [assignments.data],
  );
  const revisionResults = useQueries({
    queries: enabledAssignments.map((a) => revisionQueryOptions(a.pinned_revision_id)),
  });
  const revisionsById = useMemo(() => {
    const map = new Map<string, NonNullable<(typeof revisionResults)[number]["data"]>>();
    for (const res of revisionResults) {
      if (res.data) map.set(res.data.id, res.data);
    }
    return map;
  }, [revisionResults]);

  const suggestionWorkflows = useMemo(
    () =>
      buildSuggestionWorkflows({
        assignments: enabledAssignments,
        pipelines: pipelines.data?.pipelines ?? [],
        issueTriggers: issueTriggers.data?.issue_triggers ?? [],
        revisionsById,
      }),
    [enabledAssignments, pipelines.data, issueTriggers.data, revisionsById],
  );

  const startedPipelineIds = useMemo(() => {
    const ids = new Set<string>();
    const allRunIds = new Set<string>([
      ...(data?.linked_runs ?? []).map((r) => r.run_id),
      ...startedRunIds,
    ]);
    for (const run of projectRuns.data?.runs ?? []) {
      if (allRunIds.has(run.id)) ids.add(run.pipeline_id);
    }
    return ids;
  }, [data?.linked_runs, startedRunIds, projectRuns.data]);

  const lastUserMessage = useMemo(() => {
    for (let i = transcript.items.length - 1; i >= 0; i -= 1) {
      const item = transcript.items[i];
      if (item.kind === "user") return item.text;
    }
    return "";
  }, [transcript.items]);

  const suggestion = useMemo(
    () =>
      suggestWorkflow({
        conversation: data,
        draftText: session.prompt,
        lastUserMessage,
        workflows: suggestionWorkflows,
        startedPipelineIds,
        dismissed: suggestionDismissed,
      }),
    [
      data,
      session.prompt,
      lastUserMessage,
      suggestionWorkflows,
      startedPipelineIds,
      suggestionDismissed,
    ],
  );

  const participants = useMemo(() => {
    const ids: string[] = [];
    for (const event of session.events) {
      if (event.type !== "conversation.message.user") continue;
      const by = (event.payload as Record<string, unknown> | undefined)?.submitted_by;
      if (typeof by === "string" && by && !ids.includes(by)) ids.push(by);
    }
    return ids.map((id) => session.nameOf(id));
  }, [session.events, session.nameOf]);

  const chatNotes = useConversationAssistantNotes(conversationId);
  const dismissNote = useDismissAssistantNote();
  const noteRows = visibleAssistantNotes(chatNotes.data?.notes);
  const runLink = useMemo(() => runLinkOf(session.events), [session.events]);
  const apiRunLink = data?.run_link ?? null;

  const latestTurnId = activeTurn?.id ?? transcript.turns.at(-1)?.turnId ?? "";

  if (conversation.isPending) {
    return (
      <div
        data-testid="chat-thread"
        className="flex h-full min-h-0 flex-1 items-center justify-center bg-surface p-8"
      >
        <Spinner label="Loading chat" />
      </div>
    );
  }

  if (conversation.error instanceof ApiError && conversation.error.status === 404) {
    return (
      <div data-testid="chat-thread" className="flex h-full min-h-0 flex-col bg-surface p-8">
        <p role="alert" data-testid="conversation-not-found" className="text-st-failed-tag-fg">
          × Chat not found or you do not have access.
        </p>
      </div>
    );
  }

  if (conversation.error || !data) {
    return (
      <div data-testid="chat-thread" className="flex h-full min-h-0 flex-col bg-surface p-8">
        <ProblemBanner error={conversation.error} fallback="The chat could not be loaded." />
      </div>
    );
  }

  const wholeProject = data.repository_id === null;
  const repositoryName = wholeProject ? null : (data.repository_name ?? null);
  const threadWorkspace = (workspaces.data?.workspaces ?? []).find(
    (w) => w.conversation_id === conversationId,
  );
  const workspaceRepos = threadWorkspace?.repos ?? [];
  const worksInNote = workspaces.error
    ? "workspace unavailable"
    : !workspaces.data
      ? "workspace…"
      : repositoryName !== null && workspaceRepos.length === 0
        ? "workspace not prepared"
        : null;
  const threadBranchInfo = threadBranch(workspaceRepos, repositoryName);
  const threadBranchLabel = threadWorkspace ? threadBranchInfo.label : null;

  const linkedRunIds: string[] = [];
  for (const linked of data.linked_runs ?? []) {
    if (!linkedRunIds.includes(linked.run_id)) linkedRunIds.push(linked.run_id);
  }
  for (const runId of startedRunIds) {
    if (!linkedRunIds.includes(runId)) linkedRunIds.push(runId);
  }

  const pipelineNameForRun = (runId: string): string | undefined => {
    const run = (projectRuns.data?.runs ?? []).find((r) => r.id === runId);
    if (!run) return undefined;
    const p = (pipelines.data?.pipelines ?? []).find((pl) => pl.id === run.pipeline_id);
    return p?.display_name ?? p?.slug;
  };

  const handleRunSuggestion = () => {
    if (!suggestion) return;
    if (suggestion.needsDialog) {
      setHandoffOpen(true);
      return;
    }
    const repo = suggestion.repositoryId
      ? (repositories.data?.items ?? []).find((r) => r.id === suggestion.repositoryId)
      : undefined;
    const canPassIssue = Boolean(repo && isGitHubRepository(repo.git_url));
    const inputs = suggestion.issueInputName
      ? { [suggestion.issueInputName]: suggestion.issueNumber }
      : undefined;
    const body = {
      ...handoffRunCreateBody(suggestion.assignmentId, {
        conversationId,
        summary: lastAgentMessageOf(session.events),
        inputs,
      }),
      ...(canPassIssue ? { issue: { number: suggestion.issueNumber } } : {}),
    };
    createRun.mutate(
      { body, idempotencyKey: handoffRunKey() },
      {
        onSuccess: (response) => {
          setStartedRunIds((prev) =>
            prev.includes(response.run_id) ? prev : [...prev, response.run_id],
          );
          void session.conversation.refetch();
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 422) {
            setHandoffOpen(true);
          }
        },
      },
    );
  };

  const handleDismissSuggestion = () => {
    dismissWorkflowSuggestion(conversationId);
    setSuggestionDismissed(true);
  };

  const actOnChatNote = (row: AssistantNoteRow) => {
    switch (noteActionKind(row.action)) {
      case "make_workflow":
        openAssistantWorkflowDraft({
          id: workflowConversationIdFor(row.action) || row.scope_id,
          title: data.title ?? null,
        });
        break;
      case "open_run": {
        const run = runIdFor(row.action);
        if (run) navigate(routes.run(run));
        break;
      }
      default:
        break;
    }
  };

  const assistantNotes = (
    <>
      {noteRows.map((row) => {
        const label = noteActionLabel(row.action);
        const kind = noteActionKind(row.action);
        const actionable = kind === "make_workflow" || kind === "open_run";
        return (
          <AssistantNote
            key={row.id}
            testId={`assistant-note-${row.id}`}
            text={row.text}
            actions={
              label && actionable
                ? [{ id: kind ?? "note", label, onSelect: () => actOnChatNote(row) }]
                : []
            }
            onDismiss={() => dismissNote.mutate(row)}
          />
        );
      })}
    </>
  );

  const sendDraftPrPrompt = () => {
    setDraftPrError(null);
    session.sendMessage.mutate(
      { prompt: DRAFT_PR_PROMPT },
      {
        onSuccess: () => {
          setDraftPrConfirm(false);
          setDraftPrSent(true);
        },
        onError: (error) => {
          setDraftPrConfirm(false);
          setDraftPrSent(false);
          setDraftPrError(error instanceof Error ? error.message : String(error));
        },
      },
    );
  };

  const interrupted = described.status === "interrupted";

  return (
    <div data-testid="chat-thread" className="flex h-full min-h-0 flex-col bg-surface">
      <ChatHeader
        session={session}
        projectId={projectId}
        scope={scope}
        repositoryName={repositoryName}
        wholeProject={wholeProject}
        participants={participants}
        showBack={showBack}
        onOpenDetails={() => {
          setDetailsSection("details");
          setDetailsOpen(true);
        }}
        onOpenArtifacts={() => {
          setDetailsSection("artifacts");
          setDetailsOpen(true);
        }}
      />

      {(data.pending_permissions ?? []).some((p) => p.status === "pending") ? (
        <div className="shrink-0 border-b border-line-soft bg-st-waiting-pale-body px-[20px] py-[6px]">
          <PermissionWaitingLine session={session} />
        </div>
      ) : null}

      {/* A scrolling region must be reachable by keyboard (axe
          scrollable-region-focusable): a transcript of plain text has no
          focusable child, so the scroller itself takes focus. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto px-[20px] pt-[20px] pb-[12px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        data-capture-keep-scroll
        tabIndex={0}
        role="region"
        aria-label="Messages"
      >
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-[16px]">
          {interrupted ? (
            <Alert state="interrupted" testid="interrupted-notice" meta="you can send a new prompt">
              {interruptedCopy(described.record?.interruptReason ?? null)}
            </Alert>
          ) : null}

          <ConversationTranscript session={session} />

          {linkedRunIds.map((runId) => (
            <RunCard key={runId} runId={runId} workflowName={pipelineNameForRun(runId)} />
          ))}
        </div>
      </div>

      <ChatComposer
        session={session}
        onOpenWorkflow={() => setHandoffOpen(true)}
        aboveBox={
          suggestion ? (
            <WorkflowSuggestion
              suggestion={suggestion}
              busy={createRun.isPending}
              error={createRun.error}
              onRun={handleRunSuggestion}
              onDismiss={handleDismissSuggestion}
            />
          ) : undefined
        }
      />

      <HandToWorkflowDialog
        open={handoffOpen}
        onClose={() => setHandoffOpen(false)}
        conversation={{ id: conversationId, project_id: projectId, title: data.title }}
        onStarted={(runId) => {
          setStartedRunIds((prev) => (prev.includes(runId) ? prev : [...prev, runId]));
          void session.conversation.refetch();
        }}
      />

      <ChatDetailsSheet open={detailsOpen} onClose={() => setDetailsOpen(false)}>
        <ConversationSidePanel
          projectId={projectId}
          repoName={repositoryName}
          worksInNote={worksInNote}
          branch={threadBranchLabel === NO_BRANCH_YET ? NO_BRANCH_YET : threadBranchLabel}
          filesChanged={threadBranchInfo.filesChanged}
          agents={data.agents ?? null}
          turns={transcript.turns}
          links={data.linked_chats ?? null}
          workflowChat={{ id: conversationId, title: data.title ?? null }}
          workflowNoteDismissed={suggestionDismissed}
          onDismissWorkflowNote={handleDismissSuggestion}
          assistantNote={noteRows.length > 0 ? assistantNotes : undefined}
        />

        <div className="space-y-4 border-t border-line px-4 py-4">
          {data.origin !== "manual" && apiRunLink ? (
            <div className="space-y-1" data-testid="part-of-section">
              <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
                Part of
              </h3>
              <div className="space-y-[4px] font-mono text-[11px] text-ink">
                <Link
                  to={conversationRunHref(apiRunLink)}
                  className="text-accent-text hover:text-ink"
                  data-testid="part-of-run-link"
                >
                  Part of run {apiRunLink.run_title || shortId(apiRunLink.run_id)}
                </Link>
                <span className="block text-faint" data-testid="part-of-node">
                  node {apiRunLink.node_id || instanceLeaf(apiRunLink.node_instance_key)} ·
                  execution {shortId(apiRunLink.node_execution_id)} · attempt{" "}
                  {apiRunLink.attempt_number}
                </span>
              </div>
            </div>
          ) : data.origin !== "manual" && runLink ? (
            <div className="space-y-1" data-testid="part-of-section">
              <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
                Part of
              </h3>
              <div className="space-y-[4px] font-mono text-[11px] text-ink">
                <Link
                  to={routes.run(runLink.runId)}
                  className="text-accent-text hover:text-ink"
                  data-testid="part-of-run-link"
                >
                  Part of run {shortId(runLink.runId)}
                </Link>
                {runLink.nodeExecutionId ? (
                  <span className="block text-faint" data-testid="part-of-node">
                    node execution {shortId(runLink.nodeExecutionId)}
                    {runLink.attemptId ? " · attempt " : ""}
                    {runLink.attemptId ? (
                      <Link
                        to={routes.run(runLink.runId)}
                        className="text-accent-text hover:text-ink"
                        data-testid="part-of-attempt-link"
                      >
                        {shortId(runLink.attemptId)}
                      </Link>
                    ) : null}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}

          <div ref={artifactsAnchorRef} id="chat-details-artifacts" className="space-y-2">
            <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
              Artifacts
            </h3>
            <ThreadArtifacts projectId={projectId} conversationId={conversationId} />
            <Link
              to={routes.projectTab(projectId, "artifacts")}
              className="inline-block font-mono text-[11px] text-accent-text hover:text-ink"
              data-testid="artifacts-project-link"
            >
              See {project.data?.name ?? "project"}&apos;s artifacts →
            </Link>
          </div>

          <div className="space-y-2">
            <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
              Workspace
            </h3>
            <WorkspaceWidget projectId={projectId} conversationId={conversationId} />
            {latestTurnId ? (
              <TurnSandboxPanel turnId={latestTurnId} />
            ) : (
              <p className="text-[12.5px] text-muted">
                No turn yet, so nothing has launched and there is no enforcement to report.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
              Next
            </h3>
            <SoftButton
              variant="primary"
              onClick={() => {
                setDetailsOpen(false);
                setHandoffOpen(true);
              }}
              data-testid="hand-to-workflow"
            >
              Hand to a workflow…
            </SoftButton>
            {session.isController ? (
              <div className="space-y-2" data-testid="thread-draft-pr">
                <SoftButton
                  variant="secondary"
                  onClick={() => {
                    setDraftPrConfirm(true);
                    setDraftPrError(null);
                    setDraftPrSent(false);
                  }}
                  data-testid="thread-draft-pr-open"
                >
                  Open a draft PR from this branch
                </SoftButton>
                {draftPrConfirm ? (
                  <div
                    className="space-y-2 rounded-[8px] border border-line p-3"
                    data-testid="thread-draft-pr-confirm"
                  >
                    <p className="text-[12.5px] text-ink">
                      This asks the agent to push its branch and open a draft PR with the GitHub
                      token on its profile.
                    </p>
                    <div className="flex items-center justify-end gap-2">
                      <SoftButton variant="secondary" onClick={() => setDraftPrConfirm(false)}>
                        Cancel
                      </SoftButton>
                      <SoftButton
                        variant="primary"
                        onClick={sendDraftPrPrompt}
                        disabled={session.sendMessage.isPending}
                      >
                        {session.sendMessage.isPending ? "Sending…" : "Send"}
                      </SoftButton>
                    </div>
                  </div>
                ) : null}
                {draftPrSent ? (
                  <p className="text-[12.5px] text-muted" role="status">
                    Prompt sent — the agent&apos;s reply appears in the transcript.
                  </p>
                ) : null}
                {draftPrError ? <FormError error={draftPrError} /> : null}
              </div>
            ) : (
              <p className="text-[12.5px] text-muted">
                Open a draft PR from this branch — Take control to ask the agent.
              </p>
            )}
            {linkedRunIds.length > 0 ? (
              <div className="space-y-1">
                <span className="block font-mono text-[10.5px] font-semibold uppercase tracking-[.06em] text-muted">
                  Linked runs
                </span>
                {linkedRunIds.map((runId) => (
                  <Link
                    key={runId}
                    to={routes.run(runId)}
                    className="block font-mono text-[11.5px] text-accent-text hover:underline"
                  >
                    run {shortId(runId)}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </ChatDetailsSheet>
    </div>
  );
}

// Keep unused reference check clean if sandboxVerdictRecorded is referenced by callers.
void sandboxVerdictRecorded;
