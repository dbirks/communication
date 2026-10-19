/**
 * proposalOps.ts — ADR-0044's UI half: apply the assistant's draft proposal
 * with the same pure text→text graph ops a human gesture would use (ADR-0042).
 *
 * The server (`POST /api/v1/assistant/draft-proposals`) returns exactly one
 * op from a closed set and never writes. This module only dispatches the op
 * onto the graphDoc ops a human gesture in the inspector already uses — no
 * edge logic lives here:
 *
 *  - `insert_after`   → `insertAfter(text, after, {kind, id})` + `updateConfig`
 *  - `insert_on_edge` → `insertOnEdge(text, {from, to}, {kind, id})`
 *                       (without `acceptAmbiguity`: an ambiguous edge is
 *                       returned as-is so the UI shows its reasons) +
 *                       `updateConfig`
 *  - `update_prompt`  → `updateConfig(node, {prompt})`
 *
 * All ADR-0042 §4 safety predicates (guarded target, condition source,
 * scope-boundary and error-route refusals) are enforced by graphDoc itself;
 * a failed or ambiguous result is returned to the caller unchanged, and the
 * caller surfaces the reason and never previews.
 */
import { insertAfter, insertOnEdge, updateConfig, type OpResult } from "./graphDoc";

/** The closed operation set (ADR-0044 §2), exactly one op per proposal. */
export type ProposalOp =
  | { op: "insert_after"; after: string; kind: string; id: string; config: Record<string, unknown> }
  | {
      op: "insert_on_edge";
      from: string;
      to: string;
      kind: string;
      id: string;
      config: Record<string, unknown>;
    }
  | { op: "update_prompt"; node: string; prompt: string };

/**
 * Apply `op` to the draft YAML text. `ok` means the text is ready to preview
 * (highlight, Apply, Discard); an `error`/`ambiguous` result must be shown,
 * not applied.
 */
export function applyProposal(text: string, op: ProposalOp): OpResult {
  switch (op.op) {
    case "insert_after": {
      const inserted = insertAfter(text, op.after, { kind: op.kind, id: op.id });
      if (!inserted.ok) return inserted;
      return updateConfig(inserted.text, op.id, op.config);
    }
    case "insert_on_edge": {
      // Deliberately no `acceptAmbiguity`: a guarded/conditioned edge must
      // come back to the UI with its reasons, not be spliced blind.
      const inserted = insertOnEdge(
        text,
        { from: op.from, to: op.to },
        {
          kind: op.kind,
          id: op.id,
        },
      );
      if (!inserted.ok) return inserted;
      return updateConfig(inserted.text, op.id, op.config);
    }
    case "update_prompt":
      return updateConfig(text, op.node, { prompt: op.prompt });
  }
}
