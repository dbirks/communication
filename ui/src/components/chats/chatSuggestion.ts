/**
 * Pure workflow-suggestion logic for Chats (redesign R3).
 *
 * Suggests running a project's assigned workflow when:
 * 1. The chat is linked to an issue (or the draft / last user message names `#<number>`).
 * 2. The project has an enabled assigned workflow with an issue trigger or an `issue` input.
 * 3. No run of that workflow has already been started from this chat.
 * 4. The suggestion was not dismissed for this conversation (persisted in localStorage
 *    under the same key pattern Conversation.tsx uses for workflow notes).
 */
import { handoffWorkflowOptions } from "../../api/handoff";
import type { IssueTrigger } from "../../api/useIssueTriggers";
import type { Assignment, Conversation, PipelineRevision, PipelineSummary } from "../../api/types";
import { isDefinitionDocument } from "../../lib/pipeline/definition";
import { defaultValuesOf, runInputFieldsOf } from "../m4/NewRunForm";

/** Same per-conversation dismissal key pattern as Conversation.tsx. */
export function workflowNoteDismissedKey(conversationId: string): string {
  return `communication.chat.workflow-note-dismissed.${conversationId}`;
}

export function isWorkflowSuggestionDismissed(conversationId: string): boolean {
  if (!conversationId) return false;
  try {
    return window.localStorage.getItem(workflowNoteDismissedKey(conversationId)) === "1";
  } catch {
    return false;
  }
}

export function dismissWorkflowSuggestion(conversationId: string): void {
  if (!conversationId) return;
  try {
    window.localStorage.setItem(workflowNoteDismissedKey(conversationId), "1");
  } catch {
    // Storage unavailable (private mode, quota): dismissal stays session-local.
  }
}

export interface SuggestionWorkflow {
  assignmentId: string;
  pipelineId: string;
  name: string;
  hasIssueTrigger?: boolean;
  hasIssueInput?: boolean;
  /** Name of the declared issue input if present (e.g. "issue"). */
  issueInputName?: string | null;
  /** Required inputs that the suggestion cannot automatically populate. */
  unfilledRequiredInputs?: string[];
  /** Top-level step names in definition order. */
  stepNames: string[];
  repositoryId?: string | null;
  /** True when a run of this workflow was already started from this chat. */
  alreadyStarted?: boolean;
}

export interface SuggestWorkflowArgs {
  conversation:
    | (Pick<Conversation, "id" | "title" | "linked_runs"> & {
        issue_number?: number | null;
      })
    | null
    | undefined;
  draftText: string;
  lastUserMessage: string;
  workflows: readonly SuggestionWorkflow[];
  /** Pipeline IDs of runs already started from this chat. */
  startedPipelineIds?: ReadonlySet<string>;
  /** Explicit dismissal override for pure tests (falls back to localStorage). */
  dismissed?: boolean;
}

export interface WorkflowSuggestionResult {
  assignmentId: string;
  pipelineId: string;
  name: string;
  subject: string;
  issueNumber: number;
  summary: string;
  issueInputName: string | null;
  needsDialog: boolean;
  repositoryId: string | null;
}

const ISSUE_REF_RE = /(?:^|[^&\w])#(\d+)\b/;

/** Find the first `#<number>` issue reference in candidate strings. */
export function extractIssueNumber(...texts: (string | null | undefined)[]): number | null {
  for (const raw of texts) {
    if (!raw) continue;
    const match = ISSUE_REF_RE.exec(raw);
    if (match) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  return null;
}

/** Top-level step names from a revision's canonical document, in definition order. */
export function stepNamesFromDocument(canonicalDocument: unknown): string[] {
  if (!isDefinitionDocument(canonicalDocument)) return [];
  return canonicalDocument.spec.nodes
    .map((node) => node.id.replace(/_/g, " ").trim())
    .filter((name) => name.length > 0);
}

/**
 * Derive candidate `SuggestionWorkflow` records from the project's assignments,
 * pipelines, issue triggers and loaded pinned revisions.
 */
export function buildSuggestionWorkflows({
  assignments,
  pipelines,
  issueTriggers,
  revisionsById,
}: {
  assignments: readonly Assignment[];
  pipelines: readonly Pick<PipelineSummary, "id" | "slug" | "display_name">[];
  issueTriggers: readonly IssueTrigger[];
  revisionsById: ReadonlyMap<string, PipelineRevision>;
}): SuggestionWorkflow[] {
  const options = handoffWorkflowOptions(assignments, pipelines);
  const pipelineById = new Map(pipelines.map((p) => [p.id, p]));
  const assignmentById = new Map(assignments.map((a) => [a.id, a]));
  const triggeredAssignmentIds = new Set(
    issueTriggers.filter((t) => t.enabled).map((t) => t.assignment_id),
  );

  return options.map((option) => {
    const assignment = assignmentById.get(option.id)!;
    const pipeline = pipelineById.get(assignment.pipeline_id);
    const revision = revisionsById.get(option.pinnedRevisionId);
    const specs = revision?.input_specs ?? [];
    const fields = revision ? (runInputFieldsOf(revision.canonical_document) ?? []) : [];
    const defaults = fields.length > 0 ? defaultValuesOf(fields) : {};

    const issueSpec = specs.find(
      (s) => s.type === "github_issue" || s.name.toLowerCase() === "issue",
    );
    const issueField = fields.find((f) => f.name.toLowerCase() === "issue");
    const issueInputName = issueSpec?.name ?? issueField?.name ?? null;
    const hasIssueInput = issueInputName !== null;
    const hasIssueTrigger = triggeredAssignmentIds.has(option.id);

    const unfilledRequiredInputs: string[] = [];
    if (specs.length > 0) {
      for (const spec of specs) {
        if (!spec.required) continue;
        if (spec.default !== undefined) continue;
        if (spec.name === "handoff_summary") continue;
        if (spec.name === issueInputName && spec.type !== "github_issue") continue;
        unfilledRequiredInputs.push(spec.name);
      }
    } else {
      for (const field of fields) {
        if (!field.required) continue;
        if (defaults[field.name] !== undefined) continue;
        if (field.name === "handoff_summary") continue;
        if (field.name === issueInputName) continue;
        unfilledRequiredInputs.push(field.name);
      }
    }

    return {
      assignmentId: option.id,
      pipelineId: assignment.pipeline_id,
      name: pipeline?.display_name || pipeline?.slug || assignment.pipeline_id,
      hasIssueTrigger,
      hasIssueInput,
      issueInputName,
      unfilledRequiredInputs,
      stepNames: revision ? stepNamesFromDocument(revision.canonical_document) : [],
      repositoryId: assignment.repository_id ?? null,
    };
  });
}

/**
 * Decide whether to show the workflow suggestion pill and return its data.
 * Pure over its inputs (plus localStorage dismissal when `dismissed` is omitted).
 */
export function suggestWorkflow({
  conversation,
  draftText,
  lastUserMessage,
  workflows,
  startedPipelineIds,
  dismissed,
}: SuggestWorkflowArgs): WorkflowSuggestionResult | null {
  if (!conversation) return null;
  const isDismissed =
    dismissed !== undefined ? dismissed : isWorkflowSuggestionDismissed(conversation.id);
  if (isDismissed) return null;

  const issueNumber =
    (typeof conversation.issue_number === "number" && conversation.issue_number > 0
      ? conversation.issue_number
      : null) ?? extractIssueNumber(draftText, lastUserMessage, conversation.title);
  if (issueNumber === null) return null;

  const linkedPipelineIds = new Set<string>(startedPipelineIds ?? []);
  for (const run of conversation.linked_runs ?? []) {
    const pid = (run as { pipeline_id?: unknown }).pipeline_id;
    if (typeof pid === "string" && pid) linkedPipelineIds.add(pid);
  }

  const candidate = workflows.find((wf) => {
    if (!wf.hasIssueTrigger && !wf.hasIssueInput) return false;
    if (wf.alreadyStarted) return false;
    if (linkedPipelineIds.has(wf.pipelineId)) return false;
    return true;
  });
  if (!candidate) return null;

  const summary = candidate.stepNames.slice(0, 3).join(" + ");

  return {
    assignmentId: candidate.assignmentId,
    pipelineId: candidate.pipelineId,
    name: candidate.name,
    subject: `#${issueNumber}`,
    issueNumber,
    summary,
    issueInputName: candidate.issueInputName ?? null,
    needsDialog: Boolean(
      candidate.unfilledRequiredInputs && candidate.unfilledRequiredInputs.length > 0,
    ),
    repositoryId: candidate.repositoryId ?? null,
  };
}
