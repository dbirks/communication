/**
 * "Hand to a workflow" (ADR-0053, artboard 5d): the pure pieces of the
 * dialog's write path and its honesty rules.
 *
 * - `handoffRunCreateBody` builds the exact `RunCreate` body the dialog POSTs:
 *   the assignment's pinned revision plus `source` (the thread, the editable
 *   summary and the chosen artifacts). `summary` and `artifact_ids` travel
 *   only when they carry something — an empty summary must not seed an empty
 *   `handoff_summary` input, and an empty `artifact_ids` must not be
 *   mistaken for a selection.
 * - the branch wording is answered from real data only: before the create
 *   from the thread's recorded workspace state (`workspace_repos`
 *   head/base, ADR-0017 D8/P8), after from the `201 base` member (ADR-0053
 *   § 3) — the dialog never claims the branch carries commits it has not
 *   observed.
 */
import { projectTranscript } from "./transcript";
import type { components } from "./schema";
import type { Assignment, EventEnvelope, RunCreate, Workspace } from "./types";

// `ui/src/api/types.ts` predates ADR-0053's `base` member; the dialog's
// boundary is new files only, so the two aliases live here instead of there.
export type RunSourceBase = components["schemas"]["RunSourceBase"];
export type RunSourceBaseRepo = components["schemas"]["RunSourceBaseRepo"];

export interface HandoffSource {
  conversationId: string;
  /** The editable summary; trimmed, omitted when empty. */
  summary?: string;
  /** Chosen artifact ids; omitted when none are chosen. */
  artifactIds?: string[];
  /**
   * Values for the pinned revision's declared `spec.inputs` (the dialog
   * collects them with the New run form's helpers); omitted when empty so a
   * run started from a thread with nothing to fill sends no `inputs` member.
   */
  inputs?: Record<string, unknown>;
}

/** The `RunCreate` body the handoff submits (assignment pin + `source`). */
export function handoffRunCreateBody(assignmentId: string, source: HandoffSource): RunCreate {
  const summary = (source.summary ?? "").trim();
  const artifactIds = (source.artifactIds ?? []).filter((id) => id !== "");
  const inputs = source.inputs ?? {};
  return {
    assignment_id: assignmentId,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    source: {
      conversation_id: source.conversationId,
      ...(summary !== "" ? { summary } : {}),
      ...(artifactIds.length > 0 ? { artifact_ids: artifactIds } : {}),
    },
  };
}

/** The stable, per-dialog-instance idempotency key (ADR-0023 § 12). */
export function handoffRunKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `handoff-${c.randomUUID()}`;
  return `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** One workflow-select row: an enabled assignment, labelled by the pipeline
 * it assigns and the revision it pins. */
export interface HandoffWorkflowOption {
  id: string;
  pinnedRevisionId: string;
  /** `<pipeline slug> · <version label or digest prefix>`. */
  label: string;
}

export function handoffWorkflowOptions(
  assignments: readonly Assignment[],
  slugs: readonly { id: string; slug: string }[],
): HandoffWorkflowOption[] {
  const slugById = new Map(slugs.map((pipeline) => [pipeline.id, pipeline.slug] as const));
  return assignments
    .filter((assignment) => assignment.enabled)
    .map((assignment) => ({
      id: assignment.id,
      pinnedRevisionId: assignment.pinned_revision_id,
      label: `${slugById.get(assignment.pipeline_id) ?? assignment.pipeline_id} · ${
        assignment.pinned_version_label ?? assignment.pinned_revision_digest.slice(0, 12)
      }`,
    }));
}

/** The thread's own workspace row (conversation scope, this conversation),
 * or null when the thread has no workspace yet. */
export function threadWorkspaceOf(
  workspaces: readonly Workspace[] | null | undefined,
  conversationId: string,
): Workspace | null {
  return (
    (workspaces ?? []).find(
      (workspace) =>
        workspace.scope_kind === "conversation" && workspace.conversation_id === conversationId,
    ) ?? null
  );
}

/** The pre-create honesty answer: does the recorded branch state carry
 * commits beyond the base (ADR-0053 § 3, from `workspace_repos`)? */
export function threadBranchCarriesCommits(workspace: Workspace | null): boolean {
  if (!workspace) return false;
  return workspace.repos.some(
    (repo) => (repo.head_commit ?? "") !== "" && repo.head_commit !== repo.base_commit,
  );
}

/** The CARRIES OVER panel's branch line, from recorded state only. */
export const CARRIES_BRANCH_COPY =
  "The branch becomes the run's base, including the committed edits.";
export const NO_COMMITS_COPY =
  "Branch has no commits yet — the run starts from the repository's default branch.";
/** Shown only while the workspace read is still pending (nothing observed yet). */
export const BRANCH_PENDING_COPY =
  "The base is answered from the workspace's recorded head commits — it arrives with the create response.";

/** One display line per repository from the `201 base` member. */
export function baseResultLine(repo: RunSourceBaseRepo): string {
  if (repo.mode === "thread_branch") {
    const commit = repo.base_commit ?? "";
    return `base: the thread branch, pinned at ${commit ? commit.slice(0, 12) : "the recorded head"}`;
  }
  return "base: the repository's default branch (no recorded commits beyond the base)";
}

/** One display line per row of the `201 base` member (name order, as sent). */
export function baseResultLines(base: RunSourceBase | null | undefined): string[] {
  return (base?.repositories ?? []).map(baseResultLine);
}

/**
 * The thread's last agent message — the summary's prefill. Folded through the
 * transcript projection, so streamed chunks of one turn merge exactly as the
 * page renders them; empty when the thread has no agent message yet.
 */
export function lastAgentMessageOf(events: readonly EventEnvelope[]): string {
  const items = projectTranscript(events).items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item.kind === "agent") return item.text;
  }
  return "";
}
