/**
 * The ADR-0052 button rule (handoff README, "Approval detail (4g) and phone
 * inbox"): the model returns `{label, intent, risk}` for each suggested action
 * and the UI maps risk → the locked ds button variant —
 * `refuse`/`destructive` → danger, `proceed` → primary, anything else
 * secondary. Labels stay free text; every action is confirmed by the human
 * before anything reaches the decide route (the model never decides).
 *
 * Pure on purpose so the mapping is unit-tested as a table, not as a side
 * effect of a component.
 */
import type { ButtonVariant } from "../ds/Button";

/** `ApprovalSummary.actions[].risk` (openapi `summarizeApproval`). */
export type SuggestedActionRisk = "proceed" | "refuse" | "destructive" | "other";

/** `ApprovalSummary.actions[].intent` (openapi `summarizeApproval`). */
export type SuggestedActionIntent = "approve" | "reject" | "request_changes" | "other";

/** One model-suggested action, as the `/summary` route serves it. */
export interface SuggestedAction {
  label: string;
  intent: SuggestedActionIntent;
  risk: SuggestedActionRisk;
}

/** The risk → variant table: red is reserved for refusing/destructive things. */
export function riskToVariant(risk: SuggestedActionRisk): ButtonVariant {
  switch (risk) {
    case "refuse":
    case "destructive":
      return "danger";
    case "proceed":
      return "primary";
    default:
      return "secondary";
  }
}

/**
 * The wire decision a confirmed action reaches the decide route with. The
 * decide body is a closed enum (`approved`/`rejected`); a change request is
 * carried by the note, not by a third member. `other` maps to `null`: the
 * label is not a decider word, so the confirm step must not guess — the human
 * chooses the decision there.
 */
export function actionDecision(intent: SuggestedActionIntent): "approved" | "rejected" | null {
  switch (intent) {
    case "approve":
      return "approved";
    case "reject":
    case "request_changes":
      return "rejected";
    default:
      return null;
  }
}
