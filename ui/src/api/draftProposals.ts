/**
 * Draft proposals — `POST /api/v1/assistant/draft-proposals` (ADR-0044).
 *
 * One real drafting operation for the assistant: the caller must already be
 * allowed to `PUT` the draft, the server asks the model for exactly one op
 * from a closed set, and **nothing is written server-side** — the response
 * is a proposal the UI previews and applies through the normal
 * version-checked `PUT /api/v1/drafts/{id}`.
 *
 * Contract facts (ADR-0044 §1–2, ADR-0014 problems):
 *  - `200 {op, node_ids, summary, version}` — `op` is one of the three
 *    closed-set operations; the op's node ids are exactly `node_ids`.
 *  - `403` — the caller may not `PUT` this draft.
 *  - `404` — unknown draft.
 *  - `409` `stale_draft_version` — the `version` sent does not match.
 *  - `422` `assistant_proposal_invalid` — the model output failed the
 *    structural check; `detail` names the reason, and the model is not
 *    re-asked.
 *  - `503` `assistant_not_configured` — no assistant broker on this server;
 *    the degraded code names it. A 503 that named a transient upstream cause
 *    instead is the retry line, not this one.
 *
 * The request/response types are hand-written here on purpose: the canvas
 * applies the op through `lib/pipeline/proposalOps`' `ProposalOp` (which
 * keeps `config` required on the insert ops), and `api/openapi.yaml`
 * documents the same wire contract (ADR-0044 §2) as
 * `AssistantDraftProposalRequest` / `AssistantDraftProposal`.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, apiFetch, assistantTransientErrorLine } from "./client";
import { assistantNotConfigured } from "./assistant";
import type { ProposalOp } from "../lib/pipeline/proposalOps";

/** The one route this module speaks. */
export const DRAFT_PROPOSALS_PATH = "/api/v1/assistant/draft-proposals";

/** The request: which draft, at which version, and what to ask for. */
export interface DraftProposalRequest {
  draft_id: string;
  version: number;
  instruction: string;
}

/**
 * The response: exactly one op (v1), the node ids the op touches or creates,
 * a human-readable summary for the preview caption, and the draft version
 * the proposal was made against.
 */
export interface DraftProposalResponse {
  op: ProposalOp;
  node_ids: string[];
  summary: string;
  version: number;
}

/** The problem codes a proposal request can carry. */
export type DraftProposalProblem =
  | "assistant_proposal_invalid"
  | "assistant_not_configured"
  | "stale_draft_version";

/**
 * What the UI should say when a proposal request fails — the mapping the
 * Studio box renders, straight off the problem body's `degraded` code (never
 * the bare status: a 503 that meant the upstream model was down is a transient
 * failure and gets the retry line, not the not-configured one).
 */
export function draftProposalErrorOf(error: unknown): string {
  if (!(error instanceof ApiError)) return "The assistant could not be reached.";
  if (assistantNotConfigured(error)) return "The assistant is not configured on this server.";
  const transient = assistantTransientErrorLine(error);
  if (transient) return transient;
  if (error.status === 409 || error.type.includes("stale_draft_version"))
    return "The draft changed — reload before asking.";
  if (error.status === 422 || error.type.includes("assistant_proposal_invalid"))
    return error.detail || "The assistant's proposal was invalid.";
  if (error.detail) return error.detail;
  return error.message;
}

export interface DraftProposalInput {
  draftId: string;
  version: number;
  instruction: string;
}

/**
 * `POST /api/v1/assistant/draft-proposals`. One proposal per question; the
 * result is held by the caller (the Studio box previews it, then Apply is
 * the ordinary draft `PUT`). No cache key — like `assistant/ask`, nothing
 * is stored server-side for a proposal.
 */
export function useDraftProposal() {
  return useMutation<DraftProposalResponse, ApiError, DraftProposalInput>({
    mutationFn: ({ draftId, version, instruction }) =>
      apiFetch<DraftProposalResponse>(DRAFT_PROPOSALS_PATH, {
        method: "POST",
        json: { draft_id: draftId, version, instruction },
      }),
  });
}
