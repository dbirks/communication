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
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { queryKeys, type RefetchOptions } from "./queries";
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
  Project,
  Problem,
  PipelineCreate,
  PipelineList,
  PipelineRevision,
  PipelineRevisionSummaryList,
  PipelineSummary,
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
export function usePipelines(options: RefetchOptions = {}) {
  return useQuery({
    queryKey: queryKeys.pipelines,
    queryFn: () => apiFetch<PipelineList>("/api/v1/pipelines"),
    refetchInterval: options.refetchInterval,
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

/* ---------------------------------------------------------------- folders */

/** ADR-0049 § 8: the client-side group label for a `null`/empty `folder`.
 * The API serves `null` verbatim; only the UI names the group. */
export const UNFILED_FOLDER = "Unfiled";

/** The label the Workflows index and the sidebar render for a wire `folder`. */
export function folderLabel(folder: string | null | undefined): string {
  return folder && folder.length > 0 ? folder : UNFILED_FOLDER;
}

/** The distinct non-empty folder names of a pipeline list, alphabetically. */
export function distinctFolders(items: { folder?: string | null }[]): string[] {
  const names = new Set<string>();
  for (const item of items) {
    if (item.folder && item.folder.length > 0) names.add(item.folder);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * `PATCH /api/v1/pipelines/{pipelineId} { folder }` (ADR-0049 § 8): a name
 * files the row under that group; `null` clears it (Unfiled). The pipeline
 * read and the list row are patched in place so the index's groups and the
 * sidebar's counts move without a second round trip; the invalidation behind
 * them keeps any other reader honest.
 */
export function useMovePipelineFolder(pipelineId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (folder: string | null) =>
      apiFetch<Pipeline>(`/api/v1/pipelines/${pipelineId}`, {
        method: "PATCH",
        json: { folder },
      }),
    onSuccess: async (pipeline) => {
      const folder: string | null = pipeline.folder ?? null;
      queryClient.setQueryData(queryKeys.pipeline(pipeline.id), pipeline);
      const list = queryClient.getQueryData<PipelineList>(queryKeys.pipelines);
      if (list) {
        queryClient.setQueryData(queryKeys.pipelines, {
          ...list,
          pipelines: list.pipelines.map((row: PipelineSummary) =>
            row.id === pipeline.id ? { ...row, folder } : row,
          ),
        });
      }
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
/**
 * The pipeline a draft belongs to, recovered from the `Draft` body already
 * cached under its own key. `GET /drafts/{id}`, the `PUT` response and
 * `createDraft` all land there, so anything that can validate a draft has one
 * cached — and the validate response itself carries no `pipeline_id`.
 */
function cachedDraftPipelineId(queryClient: QueryClient, draftId: string): string {
  return queryClient.getQueryData<Draft>(queryKeys.draft(draftId))?.pipeline_id ?? "";
}

export function usePutDraft(draftId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DraftPut) =>
      apiFetch<Draft>(`/api/v1/drafts/${draftId}`, { method: "PUT", json: body }),
    onSuccess: async (draft) => {
      queryClient.setQueryData(queryKeys.draft(draft.id), draft);
      // The saved `version` is what the library's drafts column prints, so a
      // successful save has to roll that list too, not just the draft itself.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.pipelineDrafts(draft.pipeline_id),
      });
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
export function useValidateDraft(draftId: string, pipelineId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch<ValidateResponse>(`/api/v1/drafts/${draftId}/validate`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.draft(draftId) });
      // `valid`/`invalid` is the drafts list's status chip as much as the
      // editor's verdict line; the response has no pipeline id, so take the
      // one the caller passed, else the one the cached draft carries.
      const owner = pipelineId ?? cachedDraftPipelineId(queryClient, draftId);
      if (owner.length > 0) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.pipelineDrafts(owner) });
      }
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

/* ---------------------------------------------------------------- schedules */

/**
 * ADR-0032 "when to run" types. Aliased straight off the generated schema
 * (types.ts is another surface's file): the aliases below are the only place
 * a schedule type enters this module.
 */
import type { components } from "./schema";

export type Schedule = components["schemas"]["Schedule"];
export type ScheduleList = components["schemas"]["ScheduleList"];

/** Query options for `GET /api/v1/projects/{projectId}/schedules` — the same
 * key `useSchedules` reads, so the workflows index fan shares its cache with
 * the project page's schedules panel. */
export function schedulesQueryOptions(projectId: string, enabled = true) {
  return {
    queryKey: schedulesKey(projectId),
    queryFn: () => apiFetch<ScheduleList>(`/api/v1/projects/${projectId}/schedules`),
    enabled: enabled && projectId.length > 0,
  } as const;
}

/** Query options for `GET /api/v1/revisions/{digestOrId}` keyed by the digest
 * a pipeline's summary offers (route 13 resolves a digest or an id alike) —
 * the workflows index row needs the full record's `canonical_document` for
 * the step chain and `document_text` for Duplicate. */
export function revisionQueryOptions(revisionDigest: string) {
  return {
    queryKey: queryKeys.revision(revisionDigest),
    queryFn: () => apiFetch<PipelineRevision>(`/api/v1/revisions/${revisionDigest}`),
    enabled: revisionDigest.length > 0,
  } as const;
}

/* ----------------------------------------------------- workflows index (3a) */

/** The next free copy slug: `<slug>-copy`, then `<slug>-copy-2`, … (phase 4
 * client-side duplicate; a backend endpoint supersedes this in U6). */
export function suggestCopySlug(slug: string, taken: readonly string[]): string {
  const base = `${slug}-copy`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/**
 * Client-side `Duplicate` (gaps/library.md U1): the source pipeline is never
 * touched — the copy is a fresh logical definition (ADR-0002's logical
 * create) seeded with one draft holding the latest revision's regenerated
 * document. DRAFT ONLY pipelines duplicate the newest un-published draft's
 * text instead; a pipeline with neither has nothing honest to duplicate and
 * the mutation 404s to the row's error line.
 */
export function useDuplicatePipeline(existingSlugs: readonly string[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (pipelineId: string) => {
      const source = await apiFetch<Pipeline>(`/api/v1/pipelines/${pipelineId}`);
      const latest = source.revisions[0];
      let documentYaml: string;
      if (latest) {
        documentYaml = await apiFetch<string>(
          `/api/v1/revisions/${latest.revision_digest}/document?format=yaml`,
        );
      } else {
        const drafts = await apiFetch<DraftSummaryList>(`/api/v1/pipelines/${pipelineId}/drafts`);
        const open = [...drafts.drafts]
          .filter((draft) => draft.status !== "published")
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        if (!open) {
          const problem: Problem = {
            type: "https://communication.dev/errors/nothing-to-duplicate",
            title: "Nothing to duplicate",
            status: 422,
            detail: "This workflow has no published revision or open draft.",
          };
          throw new ApiError(problem, problem);
        }
        const draft = await apiFetch<Draft>(`/api/v1/drafts/${open.id}`);
        documentYaml = draft.document_yaml;
      }
      const slug = suggestCopySlug(source.slug, existingSlugs);
      const created = await apiFetch<Pipeline>("/api/v1/pipelines", {
        method: "POST",
        json: {
          slug,
          display_name: `${source.display_name} copy`,
          ...(source.description ? { description: source.description } : {}),
        },
      });
      const draft = await apiFetch<Draft>(`/api/v1/pipelines/${created.id}/drafts`, {
        method: "POST",
        json: { document_yaml: documentYaml },
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines });
      return { pipeline: created, draft, slug };
    },
  });
}

/**
 * The one derivation the workflows index rows share: which of the caller's
 * projects pin this pipeline, and which of those pins carry an enabled cron
 * (the trigger cell renders `cron <expr>` for those and `manual` for the
 * rest). The lists arrive from the page's shared fan — keyed exactly like
 * `useAssignments`/`schedulesQueryOptions` — so this stays pure.
 */
export interface WorkflowRowAssignment {
  project: Project;
  assignment: Assignment;
  /** The enabled schedule's normalized `cron_expr`, or null for `manual`. */
  cron: string | null;
}

export interface WorkflowRowFacts {
  assigned: WorkflowRowAssignment[];
  /** True when every assignment list the caller can see has arrived — a
   * project whose read failed or is pending never renders as "unassigned".
   * (A project with no *loaded* list is excluded from `assigned`, so an
   * honest `—` is only claimed when `resolved`.) */
  resolved: boolean;
}

export function workflowRowFacts(
  projects: Project[],
  assignmentLists: (AssignmentList | undefined)[],
  scheduleLists: (ScheduleList | undefined)[],
  pipelineId: string,
): WorkflowRowFacts {
  const assigned: WorkflowRowAssignment[] = [];
  let resolved = true;
  projects.forEach((project, index) => {
    const list = assignmentLists[index];
    if (!list) {
      resolved = false;
      return;
    }
    const assignment = list.assignments.find((candidate) => candidate.pipeline_id === pipelineId);
    if (!assignment) return;
    const schedules = scheduleLists[index]?.schedules ?? [];
    const cron =
      schedules.find((s) => s.assignment_id === assignment.id && s.enabled)?.cron_expr ?? null;
    assigned.push({ project, assignment, cron });
  });
  return { assigned, resolved };
}
export type ScheduleCreate = components["schemas"]["ScheduleCreate"];
export type SchedulePatch = components["schemas"]["SchedulePatch"];

/**
 * `GET /api/v1/projects/{projectId}/schedules` — Viewer+. Keyed under the
 * project subtree like assignments; the schedules of every assignment arrive
 * in one read and the screen groups them client-side.
 */
export function useSchedules(projectId: string) {
  return useQuery({
    queryKey: schedulesKey(projectId),
    queryFn: () => apiFetch<ScheduleList>(`/api/v1/projects/${projectId}/schedules`),
    enabled: projectId.length > 0,
  });
}

function schedulesKey(projectId: string) {
  // Same prefix discipline as queryKeys.assignments — ["project", id]
  // invalidation covers this subtree — spelled inline because queries.ts is
  // outside this module's edit surface.
  return ["project", projectId, "schedules"] as const;
}

/** `POST /api/v1/projects/{projectId}/schedules` — Maintainer+. */
export function useCreateSchedule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ScheduleCreate) =>
      apiFetch<Schedule>(`/api/v1/projects/${projectId}/schedules`, {
        method: "POST",
        json: body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: schedulesKey(projectId) });
    },
  });
}

/**
 * `PATCH /api/v1/schedules/{scheduleId}` — Maintainer+, optimistic on
 * `version`: a `409 schedule_version_stale` surfaces as the mutation's error
 * (ApiError with the parsed body) and the screen re-reads via invalidation.
 */
export function usePatchSchedule(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ scheduleId, body }: { scheduleId: string; body: SchedulePatch }) =>
      apiFetch<Schedule>(`/api/v1/schedules/${scheduleId}`, { method: "PATCH", json: body }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: schedulesKey(projectId) });
    },
  });
}
