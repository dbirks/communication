/**
 * The one answer every screen under `/projects/:id` gives when the project
 * itself cannot be read.
 *
 * `GET /api/v1/projects/{id}` refuses a non-member a 404 that hides existence
 * (ADR-0014 § 3), and the sub-resource routes now answer the same way. Each
 * page used to decide that refusal for itself, which is how `/runs` came to
 * show a raw problem banner and `/pipelines` came to render the whole project
 * shell — rail, library, "not assigned to this project" chips — around a
 * project the reader cannot open. The shell is itself a leak: it confirms the
 * project exists and shows what is *not* in it.
 *
 * So the refusal is one component with one sentence, and `projectAccessRefused`
 * is one predicate: 404 (unknown or invisible) and 403 (a role that cannot
 * reach this particular surface) are both "you cannot open this project from
 * here", and neither is a banner quoting a server error.
 */
import { ApiError } from "../api/client";

/** The sentence the overview shows; every sibling shows the same one. */
export const PROJECT_UNAVAILABLE_COPY = "Project not found or you do not have access";

/** True when `error` is the API refusing this project to this caller. */
export function projectAccessRefused(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

export interface ProjectUnavailableProps {
  /** The section's own heading, so the page still says which screen it is. */
  heading: string;
  headingId: string;
  /** Test handle, one per page, so a test can tell the screens apart. */
  testid: string;
}

export function ProjectUnavailable({ heading, headingId, testid }: ProjectUnavailableProps) {
  return (
    <section aria-labelledby={headingId}>
      <h1 id={headingId} className="text-title-l font-bold">
        {heading}
      </h1>
      <p className="mt-2 text-st-failed-tag-fg" role="alert">
        <span aria-hidden="true">× </span>
        <span data-testid={testid}>{PROJECT_UNAVAILABLE_COPY}</span>
      </p>
    </section>
  );
}
