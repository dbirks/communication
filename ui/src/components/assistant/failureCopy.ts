/**
 * The assistant's failure causes → the words a person reads, and where to go.
 *
 * Deployed finding 2026-11-11: `COMMUNICATION_ASSISTANT_MODEL` named a model the
 * LLM collective had offline, the endpoint answered 404 `model "…" is not
 * currently available`, and the ask died with `malformed_completion` — "the
 * model answered something broken", when the truth was "there is no model". The
 * server now names that cause `model_unavailable`
 * (`internal/assistant/model.go:modelUnavailableRefusal`); this file is the
 * reading of it: one sentence that says what is wrong, and the place an admin
 * can fix it.
 *
 * Kept apart from `api/client.ts`'s `assistantTransientErrorLine` in name only:
 * deployed finding 2026-11-11 (rerun 18) merged the two sentences. An upstream 5xx
 * and a model this deployment points at nothing are one fact on screen — the model
 * did not answer — and both send the person to the same place, so both read
 * `ASSISTANT_MODEL_UNAVAILABLE_LINE`, and nothing (least of all the endpoint's own
 * status line) is ever appended to it.
 */
import { degradedOf } from "../../api/assistant";
import { ASSISTANT_MODEL_UNAVAILABLE_LINE, isUpstreamModelUnavailable } from "../../api/client";
import { routes } from "../../lib/routes";

/** The `degraded` cause the broker answers with when the endpoint says THIS
 * model is not there (a 404, or an error envelope naming it `not currently
 * available` / `not found`). */
export const MODEL_UNAVAILABLE = "model_unavailable";

/** The Operations page's Models section: where an admin repoints the assistant
 * at a model that is up. */
export const MODEL_UNAVAILABLE_ROUTE = routes.ops();

/** What the thread shows for that cause.
 *
 * One sentence for a missing model AND for an upstream 5xx — see
 * `ASSISTANT_MODEL_UNAVAILABLE_LINE` in `api/client.ts`, which this line IS. The
 * model's own name and the endpoint's status line live in the server's `detail`
 * (and in the log, and on the Operations page); this line stays true for every
 * model and every gateway, which is why it repeats neither. Deployed finding
 * (rerun 18): the endpoint's `returned http 503` used to be glued onto the end of
 * the sentence a person read.
 *
 * Where the fix lives is said by the jump this line rides on — see
 * `failureLineRoute` and `MODEL_UNAVAILABLE_LINK_LABEL` — not by the sentence.
 */
export const MODEL_UNAVAILABLE_LINE = ASSISTANT_MODEL_UNAVAILABLE_LINE;

/**
 * The cause the ask route answers with when the deployment set no
 * `COMMUNICATION_ASSISTANT_*` triple at all (`assistantNotConfigured`'s code):
 * the feature is absent, and the question never left the browser
 * (ADR-0034's honest absence).
 */
export const ASSISTANT_NOT_CONFIGURED_LINE =
  "The assistant isn't configured on this server — your question was not sent.";

/** The degraded causes that mean “the turn ran out of its step budget”
 * (`assistant.FailCallCap` / `FailToolCap`). */
export const STEP_CAP_CAUSES: readonly string[] = ["model_call_cap_exceeded", "tool_cap_exceeded"];

/** The line for a step-cap turn: nothing was saved (ADR-0034 stores a failed
 * turn nowhere), and the ask can go again. The server's own cap phrasing —
 * "the turn reached the 12 completion cap" — is an internal number, not a
 * sentence, so it is not shown. */
export const STEP_CAP_LINE =
  "The assistant hit its step limit before answering — nothing was saved; send again.";

/** The label of the jump under the line — the nav's own words, not a route. */
export const MODEL_UNAVAILABLE_LINK_LABEL = "Settings → Operations → Models";

/** True when this failure says the model was not there to answer: the
 * `model_unavailable` cause, or an upstream 5xx (`model_unreachable`, a bare
 * `… returned http 503` detail). Both get the same one sentence and the same
 * jump, because from the person's seat they are the same fact — the answer that
 * did not come — and the Operations page is where an operator looks either way. */
export function isModelUnavailable(error: unknown): boolean {
  return isUpstreamModelUnavailable(error) || degradedOf(error) === MODEL_UNAVAILABLE;
}

/**
 * One failure line on screen: the sentence the person reads, plus the stable
 * cause behind it when the server named one. The cause travels with the line
 * because the copy is not the whole answer — a `model_unavailable` line is the
 * one failure whose fix lives on another page, so the surface that draws the
 * line also draws the jump.
 */
export interface FailureLine {
  text: string;
  /** The problem's `degraded` cause, or null when the failure named none. */
  cause: string | null;
}

/** Pair a rendered line with the cause that produced it. */
export function failureLineOf(error: unknown, text: string): FailureLine {
  return { text, cause: isModelUnavailable(error) ? MODEL_UNAVAILABLE : null };
}

/** The page an admin fixes this on, or null when no jump applies. */
export function failureLineRoute(cause: string | null): string | null {
  return cause === MODEL_UNAVAILABLE ? MODEL_UNAVAILABLE_ROUTE : null;
}
