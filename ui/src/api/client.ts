/**
 * Minimal typed HTTP client for the Communication API (`api/openapi.yaml`).
 *
 * Contract rules implemented here:
 * - Same-origin requests with `credentials: "same-origin"` (session cookie).
 * - JSON request/response bodies.
 * - `X-CSRF-Token` (the token from `GET /api/v1/me`) on every mutation.
 * - `application/problem+json` bodies become a typed `ApiError`.
 * - The `X-Communication-Replica` response header is recorded for the UI badge.
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
 * The honest one-line answer for a failed assistant turn whose `degraded` cause
 * was a transient upstream failure: the broker already retried within its
 * budget (ADR-0023 § 7), so the endpoint was tried and failed — the caller should
 * try again, not be told the assistant is unconfigured. Returns null when the
 * cause is not transient; the caller keeps its own honest line.
 */
export function assistantTransientErrorLine(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const degraded = error.degraded;
  if (degraded !== "model_unreachable" && degraded !== "model_timeout") return null;
  const detail = error.detail ? ` ${error.detail}` : "";
  return `The assistant's model is unavailable right now — try again.${detail}`;
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
