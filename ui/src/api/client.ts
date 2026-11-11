/**
 * Minimal typed HTTP client for the Communication API (`api/openapi.yaml`).
 *
 * Contract rules implemented here:
 * - Same-origin requests with `credentials: "same-origin"` (session cookie).
 * - JSON request/response bodies.
 * - `X-CSRF-Token` (the token from `GET /api/v1/me`) on every mutation.
 * - `application/problem+json` bodies become a typed `ApiError`.
 * - The `X-Communication-Replica` response header is recorded for the UI badge.
 * - An assistant failure is read by its stable `degraded` cause (F-5): a raw
 *   `assistant: …` error string is never the words on screen.
 */
import type { components } from "./schema";
import { setReplicaName } from "./replica";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface ApiRequestInit extends Omit<RequestInit, "body"> {
  /** Value to JSON-serialise as the request body. */
  json?: unknown;
}

/**
 * A problem body plus the assistant's stable `degraded` cause when the server
 * named one — the assistant problem's extra member (`assistant_not_configured`,
 * `model_unreachable`, ...) that the UI branches on instead of the bare status.
 * The base `Problem` shape does not carry it (yet), so it is optional here.
 */
type ProblemBody = components["schemas"]["Problem"] & { degraded?: string | null };

/** An `application/problem+json` error response. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly type: string;
  /**
   * The stable cause the server named on the problem body — the assistant
   * problem's `degraded` member (`assistant_not_configured`, `model_unreachable`,
   * `model_timeout`, ...) — or null when the body carries none. The UI branches
   * on this code rather than on the bare status: a 503 that meant "the upstream
   * model is down" used to be read as "the assistant is not configured".
   */
  readonly degraded: string | null;
  /**
   * The parsed body as it arrived. RFC 9457 members aside, a conversation `409`
   * carries the live `control` (and sometimes `active_turn`) — see
   * `ConversationConflictProblem` in `api/openapi.yaml` — and ADR-0016 §9
   * obliges the UI to *adopt* that state instead of retrying blindly.
   */
  readonly body: unknown;

  constructor(body: ProblemBody, rawBody: unknown) {
    super(body.detail ? `${body.title}: ${body.detail}` : body.title);
    this.name = "ApiError";
    this.status = body.status;
    this.title = body.title;
    this.detail = body.detail ?? "";
    this.type = body.type;
    this.degraded = typeof body.degraded === "string" ? body.degraded : null;
    this.body = rawBody;
  }
}

/**
 * The extra members a conversation conflict `409` carries, or `null` when the
 * error is anything else (or a body-less network failure).
 */
export function conversationConflictOf(
  error: unknown,
): components["schemas"]["ConversationConflictProblem"] | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const body = error.body as Partial<components["schemas"]["ConversationConflictProblem"]> | null;
  if (!body || typeof body !== "object") return null;
  const control = body.control as components["schemas"]["ConversationControl"] | undefined;
  if (!control || typeof control.version !== "number") return null;
  return body as components["schemas"]["ConversationConflictProblem"];
}

/** `title` is stable per error type, so it makes a good fallback heading. */
export function problemOf(error: unknown): components["schemas"]["Problem"] {
  if (error instanceof ApiError) {
    return { type: error.type, title: error.title, status: error.status, detail: error.detail };
  }
  return {
    type: "about:blank",
    title: "Network error",
    status: 0,
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * The one sentence for every failure where the model did not answer because it,
 * or the endpoint serving it, is not there: the `model_unavailable` cause (this
 * deployment points at a model the endpoint does not have) and any upstream 5xx.
 *
 * Deployed finding (TODO rerun 18): a Collective 503 reached the thread as
 * `The assistant's model is unavailable right now — try again. llm-collective…
 * returned http 503 Your question was not sent — send it again.` — the endpoint's
 * own status line glued onto a sentence that already said what to do, with a
 * clause after it that contradicted it. The endpoint's words are an operator's
 * fact (the log and Settings → Operations → Models carry them), not a sentence;
 * this is the one a person reads, and nothing is ever appended to it.
 */
export const ASSISTANT_MODEL_UNAVAILABLE_LINE =
  "The assistant's model isn't available right now. Try again in a moment.";

/** The stable causes that mean the model was not there to answer. `upstream_*`
 * is the generic `code` spelling the non-assistant problem shapes use for the
 * same fact, so both members are read (see `problemCauseOf`). */
const UPSTREAM_UNAVAILABLE_CAUSES = new Set([
  "model_unavailable",
  "model_unreachable",
  "upstream_status",
  "upstream_unavailable",
]);

/**
 * The stable cause a problem names: the assistant's `degraded` member, or the
 * generic `code` member the other problem shapes carry. Null when the body named
 * neither.
 */
export function problemCauseOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.degraded) return error.degraded;
  const code = (error.body as { code?: unknown } | null)?.code;
  return typeof code === "string" && code !== "" ? code : null;
}

/**
 * True when this failure says the model was not there — by its stable cause, or
 * by the endpoint's own status line in the detail (`… returned http 503`), which
 * is how an upstream 5xx reads when the body names no cause at all.
 */
export function isUpstreamModelUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const cause = problemCauseOf(error);
  if (cause && UPSTREAM_UNAVAILABLE_CAUSES.has(cause)) return true;
  return /\breturned http [45]\d\d\b/i.test(error.detail);
}

/**
 * The honest one-line answer for a failed assistant turn whose `degraded` cause
 * was a transient upstream failure: the broker already retried within its
 * budget (ADR-0023 § 7), so the endpoint was tried and failed — the caller should
 * try again, not be told the assistant is unconfigured. Returns null when the
 * cause is not transient; the caller keeps its own honest line.
 *
 * An unavailable model answers with `ASSISTANT_MODEL_UNAVAILABLE_LINE` and
 * NOTHING appended (deployed finding rerun 18); only a timeout — where the
 * server's own prose names the deadline that went off — still quotes its detail.
 */
export function assistantTransientErrorLine(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (isUpstreamModelUnavailable(error)) return ASSISTANT_MODEL_UNAVAILABLE_LINE;
  const degraded = error.degraded;
  if (degraded !== "model_timeout" && degraded !== "timeout" && degraded !== "upstream_timeout")
    return null;
  // F-5: the server's own detail is quoted only when it reads as a sentence.
  // A raw Go error string (`assistant: …`) is never put in front of a person.
  const detail = error.detail && !isRawAssistantErrorText(error.detail) ? ` ${error.detail}` : "";
  return `The assistant's model is unavailable right now — try again.${detail}`;
}

/**
 * One plain sentence per stable assistant failure cause (deployed finding F-5,
 * docs/testing/assistant-exercise-2026-11-11.md).
 *
 * A mid-turn refusal used to reach the thread as the server's own Go error
 * string — `assistant: request body carries secret-shaped material. … Your
 * question was not sent — send it again.` — which said nothing a person could
 * act on and, for a turn whose earlier tools had already run, said something
 * untrue. The `degraded` code is the stable contract (`assistant.Failed*` /
 * api/openapi.yaml's `AssistantProblem.degraded`), so the words are keyed off
 * the code and the raw detail never renders.
 *
 * `model_unavailable`, `assistant_not_configured` and the step caps keep their
 * existing lines (`failureCopy.ts`, `STEP_CAP_CAUSES`): those are the causes
 * whose fix lives somewhere other than the next ask.
 */
export const ASSISTANT_FAILURE_LINES: Record<string, string> = {
  secret_in_request:
    "That request carried something that looks like a secret, so it wasn't sent. Rephrase without credentials and try again.",
  secret_in_response: "The answer looked like it contained a secret, so it was withheld.",
  malformed_completion: "The model's answer didn't make sense, so it wasn't shown. Try again.",
  // The pre-rename spelling of the same cause, kept so an older replica's
  // answer still reads as a sentence.
  bad_model_response: "The model's answer didn't make sense, so it wasn't shown. Try again.",
  model_timeout: "The model took too long to answer. Try again.",
  // Same sentence for the two other spellings of "it did not answer in time".
  timeout: "The model took too long to answer. Try again.",
  upstream_timeout: "The model took too long to answer. Try again.",
};

/** The line for a failed assistant turn that named no cause the map knows. */
export const ASSISTANT_FAILURE_DEFAULT_LINE = "The assistant could not answer. Try again.";

/**
 * The causes another surface already says in its own words, because their fix
 * is not a second ask: `assistant_not_configured` and `model_unavailable` name
 * the Operations page, the two step caps say nothing was saved, and
 * `model_unreachable` is the retry line of `assistantTransientErrorLine`. They
 * are excluded from the default above so a caller keeps those sentences.
 */
const ASSISTANT_CAUSES_SAID_ELSEWHERE = new Set([
  "assistant_not_configured",
  "model_unavailable",
  "model_call_cap_exceeded",
  "tool_cap_exceeded",
  "model_unreachable",
  // The same fact in the generic `code` spelling, and the bare-5xx shapes.
  "upstream_status",
  "upstream_unavailable",
  // The person's own words broke a stated rule (empty, over the length cap);
  // the server's detail IS the actionable sentence, so it is not hidden behind
  // a generic one.
  "question_invalid",
]);

/**
 * The sentence this error's stable cause earns: a mapped one where the map has
 * it, the plain default for any other cause the server named, and null when the
 * failure named no cause (a conflict on an approval card is not an assistant
 * breakdown) or named one said better elsewhere.
 */
export function assistantFailureLine(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const cause = error.degraded;
  if (!cause) return null;
  const mapped = ASSISTANT_FAILURE_LINES[cause];
  if (mapped) return mapped;
  return ASSISTANT_CAUSES_SAID_ELSEWHERE.has(cause) ? null : ASSISTANT_FAILURE_DEFAULT_LINE;
}

/**
 * True when a problem `detail` is a raw internal error string — the `assistant:
 * …` prefix a Go error carries (`assistant.Error()`, `ErrSecretInPrompt`) —
 * rather than a sentence written for a person. Such a string is never shown;
 * the copy above is what the person reads instead.
 */
export function isRawAssistantErrorText(text: string): boolean {
  return /^\s*(\[[^\]]*\]\s*)?assistant:/i.test(text);
}

let csrfToken: string | null = null;

/** Remember the CSRF token from `GET /api/v1/me` (null on sign-out). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function asProblem(status: number, value: unknown): ProblemBody {
  if (value && typeof value === "object") {
    const candidate = value as Partial<components["schemas"]["Problem"]> & { degraded?: unknown };
    if (typeof candidate.title === "string") {
      const degraded = typeof candidate.degraded === "string" ? candidate.degraded : null;
      return {
        type: candidate.type ?? "about:blank",
        title: candidate.title,
        status: typeof candidate.status === "number" ? candidate.status : status,
        detail: typeof candidate.detail === "string" ? candidate.detail : "",
        degraded,
      };
    }
  }
  return {
    type: "about:blank",
    title: `HTTP ${status}`,
    status,
    detail: typeof value === "string" ? value : "",
    degraded: null,
  };
}

/**
 * Fetch `path` against the same origin and return the parsed JSON body.
 * Throws `ApiError` for any non-2xx response.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const { json, ...requestInit } = init;
  // A JSON body means a mutation; the API has no GET with a body.
  const method = (init.method ?? (json === undefined ? "GET" : "POST")).toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (json !== undefined) headers.set("content-type", "application/json");
  if (MUTATION_METHODS.has(method) && csrfToken) headers.set("x-csrf-token", csrfToken);

  const response = await fetch(path, {
    ...requestInit,
    method,
    headers,
    credentials: "same-origin",
    body: json === undefined ? undefined : JSON.stringify(json),
  });

  setReplicaName(response.headers.get("x-communication-replica"));

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) throw new ApiError(asProblem(response.status, parsed), parsed);

  return parsed as T;
}
