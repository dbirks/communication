import type { TurnSandbox } from "../../api/types";

/**
 * Whether what the wire returned is a verdict at all.
 *
 * `GET /api/v1/turns/{id}/sandbox` answers `200` for a turn whose journal holds
 * no sandbox event: the store's honest default is `stage: none`, `verified:
 * false`, no backend, no ids, no grants (`internal/store/postgres/m3api.go`).
 * That is an *absence*, and the shared panel's sentence for it — "Ran under
 * unknown enforcement WITHOUT a verified sandbox" — states a fact about how the
 * unit ran that nobody recorded. For a pipeline run's conversation it is a false
 * fact: the attempt's `sandbox.verified` row is journalled with an empty
 * `turn_id` (`AgentTurn.verifiedPayload`) and, because `sandbox.*` is not a
 * transcript type (`runTranscriptType`), with no `conversation_id` either — so
 * it reaches neither this page's stream nor the turn-keyed read. The page can
 * only say that no verdict was recorded here.
 */
export function sandboxVerdictRecorded(record: TurnSandbox | undefined): boolean {
  if (!record) return false;
  return (
    record.stage !== "none" ||
    record.verified ||
    record.enforcement != null ||
    record.workspace_id != null ||
    record.worker_id != null ||
    record.policy_digest != null ||
    (record.grants?.length ?? 0) > 0 ||
    (record.denied_what?.length ?? 0) > 0
  );
}
