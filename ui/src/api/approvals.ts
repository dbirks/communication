/**
 * M4 approval (durable gate) hooks — `docs/m4-contract.md` § 2 routes 34–36.
 * These are the pipeline gates (`approval_requests`), deliberately not M2's
 * ACP permission prompts (ADR-0023 § 9 keeps the two names apart).
 *
 * Two contract rules shape these mutations:
 *  - **Authorization is evaluated now** — a decider who lost access gets
 *    `403`/`409` + `approval.denied`, and the gate stays `pending`: a refusal
 *    is not a decision, so nothing is written into the cache on error.
 *  - **Exactly one decision** — a CAS miss is `409` `approval_already_decided`
 *    carrying the winner (`state`, `decision`, `decided_by`, `version`); the
 *    loser adopts the winner by re-reading, mirroring ADR-0016 § 9's argument
 *    for control conflicts.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";
import { queryKeys } from "./queries";
import type { Approval, ApprovalConflictProblem, ApprovalDecide, ApprovalList } from "./types";

/** `GET /api/v1/projects/{projectId}/approvals` — pending first, by deadline. */
export function useProjectApprovals(projectId: string) {
  return useQuery({
    queryKey: queryKeys.approvals(projectId),
    queryFn: () => apiFetch<ApprovalList>(`/api/v1/projects/${projectId}/approvals`),
    enabled: projectId.length > 0,
  });
}

/** `GET /api/v1/approvals/{approvalId}` — the full summary (the journal only carries its digest). */
export function useApproval(approvalId: string) {
  return useQuery({
    queryKey: queryKeys.approval(approvalId),
    queryFn: () => apiFetch<Approval>(`/api/v1/approvals/${approvalId}`),
    enabled: approvalId.length > 0,
  });
}

/**
 * `POST /api/v1/approvals/{approvalId}/decide` — `{decision, comments?, version}`;
 * `version` is the CAS token read off the gate. On success the returned gate
 * replaces the cached row (it carries the incremented version) and the run's
 * subtree is invalidated — a rejection is a business outcome downstream nodes
 * read, and a timeout nobody decided arrives on the stream instead.
 */
export function useDecideApproval(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ approvalId, body }: { approvalId: string; body: ApprovalDecide }) =>
      apiFetch<Approval>(`/api/v1/approvals/${approvalId}/decide`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async (approval) => {
      queryClient.setQueryData(queryKeys.approval(approval.id), approval);
      void queryClient.invalidateQueries({ queryKey: queryKeys.approvals(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(approval.run_id) });
      return approval;
    },
  });
}

/** The `409` `decide` answers with when someone else won the click. */
export function approvalConflictOf(error: unknown): ApprovalConflictProblem | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<ApprovalConflictProblem> | null;
  if (!body || typeof body !== "object") return null;
  if (typeof body.approval_id !== "string" || !body.approval) return null;
  return body as ApprovalConflictProblem;
}

/**
 * Adopt the winner a `409` carried: the loser's card must show the decided
 * gate, not a toast. The conflict body is a summary, not a full row, so the
 * row is *invalidated* (a re-read), and only the fields the body states
 * (state/decision/decider/version) are patched into a cached row meanwhile.
 */
export function adoptApprovalConflict(
  queryClient: ReturnType<typeof useQueryClient>,
  error: unknown,
): boolean {
  const conflict = approvalConflictOf(error);
  if (!conflict) return false;
  const winner = conflict.approval;
  if (!winner) return false;
  queryClient.setQueryData<Approval>(queryKeys.approval(conflict.approval_id), (current) =>
    current
      ? {
          ...current,
          state: winner.state,
          decision: winner.decision ?? null,
          decided_by: winner.decided_by ?? null,
          version: winner.version,
        }
      : current,
  );
  void queryClient.invalidateQueries({ queryKey: queryKeys.approval(conflict.approval_id) });
  return true;
}

/* ------------------------------------------------------------------ */
/* ADR-0052: the model's decider summary and free-text interpretation. */

/** `POST /approvals/{id}/summary` response — the model's two-sentence summary plus suggested actions. */
export type ApprovalSummary = components["schemas"]["ApprovalSummary"];

/** `POST /approvals/{id}/interpret` response — a PROPOSAL the human confirms. */
export type ApprovalInterpretation = components["schemas"]["ApprovalInterpretation"];

/**
 * `POST /api/v1/approvals/{approvalId}/summary` (ADR-0052). The model NEVER
 * decides: this is text a human reads, and the decider still calls `decide`.
 * The server caches the answer in memory keyed on the gate's `version`, so a
 * plain query is the right shape — the result is stable while the gate is
 * pending. With no assistant configured the route answers `503
 * assistant_not_configured` and the caller falls back to the gate's own
 * summary (see `assistantNotConfigured` in `./assistant`).
 */
export function useApprovalSummary(approvalId: string) {
  return useQuery({
    queryKey: queryKeys.approval(approvalId).concat("summary"),
    queryFn: () =>
      apiFetch<ApprovalSummary>(`/api/v1/approvals/${approvalId}/summary`, { method: "POST" }),
    enabled: approvalId.length > 0,
  });
}

/**
 * `POST /api/v1/approvals/{approvalId}/interpret` (ADR-0052). The approver
 * replies in their own words; the model restates the intent and PROPOSES a
 * decision plus a short note. The proposal is never sent anywhere — the UI
 * shows it and the human confirms by calling `decide` themselves.
 * `503 assistant_not_configured` when no endpoint model is set.
 */
export function useInterpretApproval(approvalId: string) {
  return useMutation({
    mutationFn: (text: string) =>
      apiFetch<ApprovalInterpretation>(`/api/v1/approvals/${approvalId}/interpret`, {
        method: "POST",
        json: { text },
      }),
  });
}

/**
 * The plan artifact's bytes as text. `/content` is role-gated by sensitivity
 * (ADR-0020) and streams the artifact's `media_type`, so the fetch is a plain
 * `apiFetch<string>` — `apiFetch` hands back the body verbatim when it is not
 * JSON, which is exactly what a markdown plan is.
 */
export function useArtifactContent(artifactId: string | null) {
  return useQuery({
    queryKey: queryKeys.artifact(artifactId ?? "").concat("content"),
    queryFn: () => apiFetch<string>(`/api/v1/artifacts/${artifactId}/content`),
    enabled: artifactId !== null && artifactId.length > 0,
  });
}
