/**
 * M4 run-side hooks — `docs/m4-contract.md` § 2 routes 22–33 + the scheduler
 * counters, against the frozen OpenAPI 0.4.0-m4 paths. Types are the generated
 * ones; see `pipelines.ts` for the shared house rules.
 *
 * Run lifecycle verbs are *requests with receipts*: `POST /cancel` answers
 * 200 for a request, and the run reaches `cancelled` only when every branch
 * is terminal (`09`'s state table). The mutations below therefore invalidate —
 * they never write a hoped-for status into the cache.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import { queryKeys } from "./queries";
import type {
  Attempt,
  NodeExecutionDetail,
  NodeExecutionList,
  Run,
  RunCheckpointList,
  RunConflictProblem,
  RunCreate,
  RunCreateResponse,
  RunRetryRequest,
  RunSummaryList,
  RunTree,
  SchedulerStatus,
} from "./types";

/* ------------------------------------------------------------------ reads */

/** `GET /api/v1/projects/{projectId}/runs` — newest first, child rows included. */
export function useProjectRuns(projectId: string) {
  return useQuery({
    queryKey: queryKeys.runs(projectId),
    queryFn: () => apiFetch<RunSummaryList>(`/api/v1/projects/${projectId}/runs`),
    enabled: projectId.length > 0,
  });
}

/** `GET /api/v1/runs/{runId}` — pinned identity, status, honest placement. */
export function useRun(runId: string) {
  return useQuery({
    queryKey: queryKeys.run(runId),
    queryFn: () => apiFetch<Run>(`/api/v1/runs/${runId}`),
    enabled: runId.length > 0,
  });
}

/** `GET /api/v1/runs/{runId}/nodes` — one row per node execution. */
export function useRunNodes(runId: string) {
  return useQuery({
    queryKey: queryKeys.runNodes(runId),
    queryFn: () => apiFetch<NodeExecutionList>(`/api/v1/runs/${runId}/nodes`),
    enabled: runId.length > 0,
  });
}

/** `GET /api/v1/runs/{runId}/nodes/{nodeExecutionId}` — attempts + checkpoint + CEL envelope. */
export function useRunNode(runId: string, nodeExecutionId: string) {
  return useQuery({
    queryKey: queryKeys.runNode(runId, nodeExecutionId),
    queryFn: () => apiFetch<NodeExecutionDetail>(`/api/v1/runs/${runId}/nodes/${nodeExecutionId}`),
    enabled: runId.length > 0 && nodeExecutionId.length > 0,
  });
}

/** `GET /api/v1/runs/{runId}/tree` — child runs through `pipeline_invocations`. */
export function useRunTree(runId: string) {
  return useQuery({
    queryKey: queryKeys.runTree(runId),
    queryFn: () => apiFetch<RunTree>(`/api/v1/runs/${runId}/tree`),
    enabled: runId.length > 0,
  });
}

/** `GET /api/v1/runs/{runId}/checkpoints` — the durable boundary records. */
export function useRunCheckpoints(runId: string) {
  return useQuery({
    queryKey: queryKeys.runCheckpoints(runId),
    queryFn: () => apiFetch<RunCheckpointList>(`/api/v1/runs/${runId}/checkpoints`),
    enabled: runId.length > 0,
  });
}

/** `GET /api/v1/attempts/{attemptId}` — never worker id, fencing token or lease. */
export function useAttempt(attemptId: string) {
  return useQuery({
    queryKey: queryKeys.attempt(attemptId),
    queryFn: () => apiFetch<Attempt>(`/api/v1/attempts/${attemptId}`),
    enabled: attemptId.length > 0,
  });
}

/** `GET /api/v1/system/scheduler` — "is the engine wedged?" telemetry. */
export function useSystemScheduler() {
  return useQuery({
    queryKey: queryKeys.scheduler,
    queryFn: () => apiFetch<SchedulerStatus>("/api/v1/system/scheduler"),
    refetchInterval: 15_000,
  });
}

/* -------------------------------------------------------------- mutations */

/**
 * `POST /api/v1/projects/{projectId}/runs` — idempotent per ADR-023 § 12:
 * pass `idempotencyKey` and the `Idempotency-Key` header carries it (the
 * header wins over the body member, so the body only fills in when absent).
 * A replayed click re-answers 200 with the stored run, never a second run.
 */
export function useCreateRun(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: { body: RunCreate; idempotencyKey?: string }) =>
      apiFetch<RunCreateResponse>(`/api/v1/projects/${projectId}/runs`, {
        method: "POST",
        headers: idempotencyKey ? { "idempotency-key": idempotencyKey } : undefined,
        json: idempotencyKey && !body.idempotency ? { ...body, idempotency: idempotencyKey } : body,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs(projectId) });
    },
  });
}

/** `POST /api/v1/runs/{runId}/pause` — in-flight attempts finish honestly. */
export function usePauseRun(runId: string) {
  return useRunAction<Run>(runId, "pause");
}

/** `POST /api/v1/runs/{runId}/resume` — `paused → queued`. */
export function useResumeRun(runId: string) {
  return useRunAction<Run>(runId, "resume");
}

/** `POST /api/v1/runs/{runId}/cancel` — a request, not proof of a stop. */
export function useCancelRun(runId: string) {
  return useRunAction<Run>(runId, "cancel");
}

/**
 * `POST /api/v1/runs/{runId}/retry` — targets default to every non-succeeded
 * terminal execution; `restore_checkpoint` nodes answer `409`
 * `checkpoint_unavailable` with *nothing* reset. A `run_not_retriable` `409`
 * names the run's current status (`RunConflictProblem`) for the caller to show.
 */
export function useRetryRun(runId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RunRetryRequest) =>
      apiFetch<Run>(`/api/v1/runs/${runId}/retry`, { method: "POST", json: body }),
    onSuccess: async (run) => {
      queryClient.setQueryData(queryKeys.run(run.id), run);
      await queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs(run.project_id) });
    },
  });
}

/** pause/resume/cancel share the shape: no body, the run back, the subtree dirty. */
function useRunAction<T>(runId: string, verb: "pause" | "resume" | "cancel") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<T>(`/api/v1/runs/${runId}/${verb}`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.run(runId) });
    },
  });
}

/** The `409` a run action answers with, read off the `ApiError` body. */
export function runConflictOf(error: unknown): RunConflictProblem | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<RunConflictProblem> | null;
  if (!body || typeof body !== "object" || typeof body.run_id !== "string") return null;
  return body as RunConflictProblem;
}
