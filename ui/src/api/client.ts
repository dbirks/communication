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

/** An `application/problem+json` error response. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly detail: string;
  readonly type: string;

  constructor(body: components["schemas"]["Problem"]) {
    super(body.detail ? `${body.title}: ${body.detail}` : body.title);
    this.name = "ApiError";
    this.status = body.status;
    this.title = body.title;
    this.detail = body.detail ?? "";
    this.type = body.type;
  }
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

let csrfToken: string | null = null;

/** Remember the CSRF token from `GET /api/v1/me` (null on sign-out). */
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

function asProblem(status: number, value: unknown): components["schemas"]["Problem"] {
  if (value && typeof value === "object") {
    const candidate = value as Partial<components["schemas"]["Problem"]>;
    if (typeof candidate.title === "string") {
      return {
        type: candidate.type ?? "about:blank",
        title: candidate.title,
        status: typeof candidate.status === "number" ? candidate.status : status,
        detail: typeof candidate.detail === "string" ? candidate.detail : "",
      };
    }
  }
  return {
    type: "about:blank",
    title: `HTTP ${status}`,
    status,
    detail: typeof value === "string" ? value : "",
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

  if (!response.ok) throw new ApiError(asProblem(response.status, parsed));

  return parsed as T;
}
