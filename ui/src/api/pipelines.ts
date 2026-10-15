/**
 * M4 definition-side hooks — `docs/m4-contract.md` § 2 routes 1–21, against
 * the frozen OpenAPI 0.4.0-m4 paths. Response/request types are the generated
 * ones (`schema.d.ts` renames in `./types`); the components' view models arrive
 * through `m4view.ts`, never from here.
 *
 * House rules from `queries.ts` apply: reads are keyed so one subtree
 * invalidation covers a screen; writes carry the CSRF header via `apiFetch`;
 * a `409` carries the truth the client must adopt (draft CAS), and the mutation
 * surfaces the parsed `ApiError.body` for the caller to render — the draft
 * equivalent of `adoptConflict`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { queryKeys } from "./queries";
import type {
  Assignment,
  AssignmentCreate,
  AssignmentList,
  AssignmentPatch,
  Draft,
  DraftConflictProblem,
  DraftCreate,
  DraftPublish,
  DraftPut,
  DraftSummaryList,
  Pipeline,
  PipelineCreate,
  PipelineList,
  PipelineRevision,
  PipelineRevisionSummaryList,
  PipelineUpdate,
  ValidateResponse,
} from "./types";

/* ------------------------------------------------------------------ reads */

/** Query options for `GET /api/v1/pipelines/{pipelineId}` — shared with the
 * library screen's `useQueries` fan (each row wants its own definition). */
export function pipelineQueryOptions(pipelineId: string) {
  return {
    queryKey: queryKeys.pipeline(pipelineId),
    queryFn: () => apiFetch<Pipeline>(`/api/v1/pipelines/${pipelineId}`),
    enabled: pipelineId.length > 0,
  } as const;
}

/** Query options for `GET /api/v1/pipelines/{pipelineId}/drafts`. */
export function pipelineDraftsQueryOptions(pipelineId: string) {
  return {
    queryKey: queryKeys.pipelineDrafts(pipelineId),
    queryFn: () => apiFetch<DraftSummaryList>(`/api/v1/pipelines/${pipelineId}/drafts`),
    enabled: pipelineId.length > 0,
  } as const;
}

/** `GET /api/v1/pipelines` — the org library, ordered by slug, no documents. */
export function usePipelines() {
  return useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: () => apiFetch<PipelineList>("/api/v1/pipelines"),
  });
}

/** `GET /api/v1/pipelines/{pipelineId}` — definition + revision summaries. */
export function usePipeline(pipelineId: string) {
  return useQuery(pipelineQueryOptions(pipelineId));
}

/** `GET /api/v1/pipelines/{pipelineId}/revisions` — summaries, newest first. */
export function usePipelineRevisions(pipelineId: string) {
  return useQuery({
    queryKey: queryKeys.pipelineRevisions(pipelineId),
    queryFn: () =>
      apiFetch<PipelineRevisionSummaryList>(`/api/v1/pipelines/${pipelineId}/revisions`),
    enabled: pipelineId.length > 0,
  });
}

/** `GET /api/v1/pipelines/{pipelineId}/drafts` — where uncommitted work lives. */
export function usePipelineDrafts(pipelineId: string) {
  return useQuery(pipelineDraftsQueryOptions(pipelineId));
}

/** `GET /api/v1/drafts/{draftId}` — the document plus the last validate body. */
export function useDraft(draftId: string) {
  return useQuery({
    queryKey: queryKeys.draft(draftId),
    queryFn: () => apiFetch<Draft>(`/api/v1/drafts/${draftId}`),
    enabled: draftId.length > 0,
  });
}

/** `GET /api/v1/revisions/{digestOrId}` — id or `sha256:…` digest alike. */
export function useRevision(digestOrId: string) {
  return useQuery({
    queryKey: queryKeys.revision(digestOrId),
    queryFn: () => apiFetch<PipelineRevision>(`/api/v1/revisions/${digestOrId}`),
    enabled: digestOrId.length > 0,
  });
}

/**
 * `GET /api/v1/revisions/{revisionId}/document?format=yaml` — the regenerated
 * canonical text (`text/yaml`): the bytes that re-canonicalize to the
 * revision's digest, not what the author typed (ADR-0021 § 5).
 */
export function useRevisionDocument(revisionId: string) {
  return useQuery({
    queryKey: [...queryKeys.revision(revisionId), "document"] as const,
    queryFn: () => apiFetch<string>(`/api/v1/revisions/${revisionId}/document?format=yaml`),
    enabled: revisionId.length > 0,
  });
}

/** `GET /api/v1/projects/{projectId}/assignments` — pins and effective ceilings. */
export function useAssignments(projectId: string) {
  return useQuery({
    queryKey: queryKeys.assignments(projectId),
    queryFn: () => apiFetch<AssignmentList>(`/api/v1/projects/${projectId}/assignments`),
    enabled: projectId.length > 0,
  });
}

/* -------------------------------------------------------------- mutations */

/** `POST /api/v1/pipelines` — logical definition only (library role). */
export function useCreatePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PipelineCreate) =>
      apiFetch<Pipeline>("/api/v1/pipelines", { method: "POST", json: body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
    },
  });
}

/** `PATCH /api/v1/pipelines/{pipelineId}` — metadata; never a revision (ADR-0002). */
export function useUpdatePipeline() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ pipelineId, body }: { pipelineId: string; body: PipelineUpdate }) =>
      apiFetch<Pipeline>(`/api/v1/pipelines/${pipelineId}`, { method: "PATCH", json: body }),
    onSuccess: async (pipeline) => {
      queryClient.setQueryData(queryKeys.pipeline(pipeline.id), pipeline);
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
    },
  });
}

/** `POST /api/v1/pipelines/{pipelineId}/drafts` — exactly one of document/clone. */
export function useCreateDraft(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftCreate) =>
      apiFetch<Draft>(`/api/v1/pipelines/${pipelineId}/drafts`, { method: "POST", json: body }),
    onSuccess: async (draft) => {
      queryClient.setQueryData(queryKeys.draft(draft.id), draft);
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineDrafts(pipelineId) });
    },
  });
}

/**
 * `PUT /api/v1/drafts/{draftId}` — compare-and-swap. A `version` miss is `409`
 * `stale_draft_version` carrying `current_version`; the caller re-reads rather
 * than guessing (the `DraftConflictProblem` body member below), never retries
 * over the top of it.
 */
export function usePutDraft(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftPut) =>
      apiFetch<Draft>(`/api/v1/drafts/${draftId}`, { method: "PUT", json: body }),
    onSuccess: async (draft) => {
      queryClient.setQueryData(queryKeys.draft(draft.id), draft);
    },
  });
}

/** `DELETE /api/v1/drafts/{draftId}` — unpublished drafts only. */
export function useDeleteDraft(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draftId: string) =>
      apiFetch<void>(`/api/v1/drafts/${draftId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineDrafts(pipelineId) });
    },
  });
}

/**
 * `POST /api/v1/drafts/{draftId}/validate` — the § 2.2 body comes back verbatim
 * and becomes the draft's stored `validation`; on `valid` the digests are the
 * ones `publish` will demand unchanged (`draft_changed_since_validation`).
 */
export function useValidateDraft(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ValidateResponse>(`/api/v1/drafts/${draftId}/validate`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
    },
  });
}

/**
 * `POST /api/v1/drafts/{draftId}/publish` — four gates, each its own `409`/`422`
 * (§ 2.2). On success the revision exists immutably (ADR-0002): the pipeline's
 * revision list and the library roll-up both changed.
 */
export function usePublishDraft(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftPublish) =>
      apiFetch<PipelineRevision>(`/api/v1/drafts/${draftId}/publish`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async (revision) => {
      queryClient.setQueryData(queryKeys.revision(revision.id), revision);
      await queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipeline(revision.pipeline_id) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
    },
  });
}

/** `POST /api/v1/revisions/{revisionId}/deprecate` — a signal, never a kill switch. */
export function useDeprecateRevision(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (revisionId: string) =>
      apiFetch<PipelineRevision>(`/api/v1/revisions/${revisionId}/deprecate`, {
        method: "POST",
      }),
    onSuccess: async (_revision, revisionId) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.revision(revisionId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipeline(pipelineId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineRevisions(pipelineId) });
    },
  });
}

/** `POST /api/v1/projects/{projectId}/assignments` — Maintainer+. */
export function useCreateAssignment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: AssignmentCreate) =>
      apiFetch<Assignment>(`/api/v1/projects/${projectId}/assignments`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.assignments(projectId) });
    },
  });
}

/**
 * `PATCH /api/v1/assignments/{assignmentId}` — re-pinning is explicit promotion,
 * effective at *new run creation only*; running runs keep their snapshot
 * (ADR-0002, `12` case 11), so no run cache is touched here.
 */
export function usePatchAssignment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assignmentId, body }: { assignmentId: string; body: AssignmentPatch }) =>
      apiFetch<Assignment>(`/api/v1/assignments/${assignmentId}`, {
        method: "PATCH",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.assignments(projectId) });
    },
  });
}

/** `DELETE /api/v1/assignments/{assignmentId}` — stops new runs, not live ones. */
export function useDeleteAssignment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assignmentId: string) =>
      apiFetch<void>(`/api/v1/assignments/${assignmentId}`, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.assignments(projectId) });
    },
  });
}

/**
 * The `409` a draft route carries beyond the `Problem` members — `current_version`
 * for `stale_draft_version`, `existing_revision_id` for `revision_already_published`.
 * The client recovers by re-reading; this reads the truth off the error, same
 * shape of argument as `conversationConflictOf`.
 */
export function draftConflictOf(error: unknown): DraftConflictProblem | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<DraftConflictProblem> | null;
  if (!body || typeof body !== "object") return null;
  if (typeof body.draft_id !== "string") return null;
  return body as DraftConflictProblem;
}
