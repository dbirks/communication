/**
 * The run-scoped journal feed (`GET /api/v1/runs/{runId}/events`).
 *
 * Same `domain_events` journal, same framing as the project and conversation
 * streams (`useEventStream` here is the shipped implementation, not a copy:
 * ADR-0014 § 5's gap-safety argument — `Last-Event-ID` replay, the monotonic
 * `global_seq` floor, the heartbeat comment — is one argument per journal, not
 * one per route). M4's addition is what the frames *do*: every event carries
 * the correlation members `run_id` / `node_execution_id` / `attempt_id`, so a
 * frame names the exact row an open Run Inspector must repaint, and the same
 * frame also invalidates the run subtree so the next read confirms it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { M2_EVENT_TYPES, M3_EVENT_TYPES, useEventStream, type EventStream } from "./events";
import { M4_RUN_EVENT_TYPES } from "../lib/pipeline/runEvents";
import { queryKeys } from "./queries";
import type { EventEnvelope } from "./types";

/**
 * What the run stream is subscribed to: M4's run/node/approval vocabulary,
 * plus the reused M2/M3 types the contract says arrive here when their
 * correlation ids name the run — an `agent.acp` attempt owns a conversation
 * (`conversation.*`, `agent.session.*`), and workspace/sandbox/artifact rows
 * carry `scope_kind: run` (docs/m4-contract.md § 2, route `/runs/{runId}/events`).
 */
export const RUN_STREAM_EVENT_TYPES = [
  ...M4_RUN_EVENT_TYPES,
  ...M3_EVENT_TYPES,
  ...M2_EVENT_TYPES,
] as const;

/**
 * One run's stream. Each frame invalidates the run's cache subtree (nodes,
 * tree, checkpoints hang under `["run", runId]`) and, when the frame is an
 * approval row, the project's attention list — the components additionally
 * *paint* the frame immediately through `projectRun` in
 * `lib/pipeline/runEvents`, which is why a chip moves before the refetch lands.
 */
export function useRunEvents(runId: string, projectId = ""): EventStream {
  const queryClient = useQueryClient();
  return useEventStream({
    url: runId ? `/api/v1/runs/${runId}/events` : "",
    types: RUN_STREAM_EVENT_TYPES,
    keys: [runId],
    onEvent: (event: EventEnvelope) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.run(event.run_id ?? runId) });
      const project = event.project_id ?? projectId;
      if (project && event.type.startsWith("approval.")) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.approvals(project) });
      }
    },
  });
}
