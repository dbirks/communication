/**
 * Transient live-model failure (deadline or provider 5xx) signatures for the
 * lab suites that drive a live model.chat node.
 *
 * The product's own recovery path is the run page's Retry button, but the
 * suite may only take it for failures the provider can genuinely recover
 * from. Both signatures below are emitted verbatim by the model.chat adapter
 * (internal/worker/modelchat.go):
 *
 *   timeout arm  — `model.chat: no completion from <host> within <arm>
 *                  (the attempt's deadline arm, § 4 step 8)`
 *   5xx arm      — `model.chat: <host> returned http <502|503|504>: <body…>`
 *   transport arm— `model.chat: request to <host> failed: … connect:
 *                  connection refused` / `… connection reset by peer`
 *
 * What must NEVER match: 4xx (`<host> rejected the completion request
 * (http %d)`), auth, schema (invalid_output), rate limits (the distinct
 * `rate-limited the completion` arm), anything not from a model.chat node
 * (e.g. process.exec), and http 500 — only the 502/503/504 gateway-unavailable
 * band is transient here.
 *
 * Run `node e2e/tests/transient-model-failure.check.mjs` to exercise the
 * classification against real detail lines.
 */

/** The transient shape: the attempt's own provider deadline, or the provider
 * being temporarily unavailable (502/503/504, refused or reset connection). */
export type TransientModelFailure = "deadline" | "provider-unavailable" | null;

/** The attempt's own provider deadline elapsed with no completion. Matches
 * the adapter's real arm — `within 2m0s (the attempt's deadline arm, …)` —
 * and, as a superset, the older `within … the attempt's deadline` spacing the
 * first version of this signature required. */
export const TRANSIENT_MODEL_DEADLINE = /no completion from .* within .*the attempt's deadline/;

/** The provider was temporarily unavailable: it answered the completion
 * request with http 502/503/504, or the connection was refused/reset by it.
 * Anchored at the start of the attempt detail, which the adapter always
 * begins with `model.chat: ` — so a process.exec (or any other kind's) error
 * text that merely quotes such a line cannot match. */
export const TRANSIENT_PROVIDER_UNAVAILABLE =
  /^model\.chat: (?:\S+ returned http 50[234]\b|request to \S+ failed: .*(?:connection refused|connection reset by peer))/;

/**
 * Classify one failed node execution (its newest attempt's error_class and
 * detail) as a transient live-model failure (deadline or provider 5xx), or
 * null when it is anything else — which the suites must report as a product
 * finding, not paper over.
 */
export function classifyTransientModelFailure(
  kind: string,
  errorClass: string | null | undefined,
  detail: string | null | undefined,
): TransientModelFailure {
  if (kind !== "model.chat" || !detail) return null;
  if (TRANSIENT_MODEL_DEADLINE.test(detail)) return "deadline";
  if (errorClass === "infra" && TRANSIENT_PROVIDER_UNAVAILABLE.test(detail)) {
    return "provider-unavailable";
  }
  return null;
}
