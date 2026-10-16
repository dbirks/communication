/**
 * Assistant v1 — the read-only broker behind Ctrl K (ADR-0034,
 * `docs/design/assistant-v1.md`).
 *
 * Two contract facts shape this module:
 *  - **Nothing is stored.** There is no transcript endpoint, so an answer has
 *    no cache key to live under: this is a plain mutation whose result the
 *    caller holds in its own (unmounted-with-the-panel) state.
 *  - **The failure is a code, not a modal.** The problem body carries
 *    `degraded`, and `assistant_not_configured` means the feature is absent on
 *    this deployment — the palette must fall back to jump-only, quietly.
 */
import { useMutation } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { components } from "./schema";

export type AssistantAsk = components["schemas"]["AssistantAsk"];
export type AssistantAnswer = components["schemas"]["AssistantAnswer"];
export type AssistantLink = components["schemas"]["AssistantLink"];
export type AssistantToolCall = components["schemas"]["AssistantToolCall"];
export type AssistantProblem = components["schemas"]["AssistantProblem"];

/** The one route this module speaks. */
export const ASSISTANT_ASK_PATH = "/api/v1/assistant/ask";

/** The degraded cause that means "this server has no assistant at all". */
export const ASSISTANT_NOT_CONFIGURED = "assistant_not_configured";

/** The `/projects/{id}…` family — the only routes that carry a project scope. */
const PROJECT_ROUTE = /^\/projects\/([^/?#]+)/;

/** The project a route is about, when it is about one. */
export function projectIdFromRoute(route: string): string | undefined {
  const match = PROJECT_ROUTE.exec(route);
  if (!match) return undefined;
  // A trailing sub-page (`/projects/{id}/runs`) shares the id; an empty
  // segment is not an id.
  return match[1].length > 0 ? match[1] : undefined;
}

/** The body for `askAssistant`: the question plus where it was asked. */
export function assistantAskBody(question: string, route: string): AssistantAsk {
  const context: NonNullable<AssistantAsk["context"]> = { route };
  const projectId = projectIdFromRoute(route);
  if (projectId) context.project_id = projectId;
  return { question, context };
}

/** `degraded` off any problem body (assistant route or not), else null. */
export function degradedOf(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as Partial<AssistantProblem> | null;
  if (!body || typeof body !== "object") return null;
  return typeof body.degraded === "string" ? body.degraded : null;
}

/** True when the server said the assistant is simply not configured. */
export function assistantNotConfigured(error: unknown): boolean {
  return degradedOf(error) === ASSISTANT_NOT_CONFIGURED;
}

export interface AssistantAskInput {
  question: string;
  /** The UI's current route; `project_id` is read off it when it carries one. */
  route: string;
}

/**
 * `POST /api/v1/assistant/ask`. One turn, arriving whole (v1 has no stream);
 * the caller renders `isPending` as "thinking…" and keeps the panel editable.
 */
export function useAssistantAsk() {
  return useMutation<AssistantAnswer, Error, AssistantAskInput>({
    mutationFn: ({ question, route }) =>
      apiFetch<AssistantAnswer>(ASSISTANT_ASK_PATH, {
        method: "POST",
        json: assistantAskBody(question, route),
      }),
  });
}
